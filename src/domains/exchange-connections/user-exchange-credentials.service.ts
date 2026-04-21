import { prisma } from '../../config/database';
import type { ExchangeId, UserExchangeCredentials } from '../../core/exchange/exchange.types';
import type { ExchangeCredentialSource } from '../../config/exchange.credentials';
import {
  getMissingExchangeCredentialError,
  resolveServerExchangeCredentials,
} from '../../config/exchange.credentials';
import { AppError } from '../../utils/errors';
import { decryptSecret } from '../../modules/private-account/exchange-connections.crypto';

async function findUserExchangeConnectionRecord(userId: string, exchange: ExchangeId) {
  return prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange,
      },
    },
  });
}

function toUserExchangeCredentials(connection: {
  apiKeyEncrypted: string;
  secretKeyEncrypted: string;
  passphraseEncrypted: string | null;
}, exchange: ExchangeId): UserExchangeCredentials {
  return {
    exchange,
    apiKey: decryptSecret(connection.apiKeyEncrypted),
    secretKey: decryptSecret(connection.secretKeyEncrypted),
    passphrase: connection.passphraseEncrypted ? decryptSecret(connection.passphraseEncrypted) : null,
  };
}

export async function getUserExchangeConnectionRecord(userId: string, exchange: ExchangeId) {
  const connection = await findUserExchangeConnectionRecord(userId, exchange);
  if (!connection) {
    throw new AppError(404, `${exchange} exchange connection is not connected`);
  }

  return connection;
}

export async function requireUserOwnedExchangeCredentials(
  userId: string,
  exchange: ExchangeId,
): Promise<UserExchangeCredentials> {
  const connection = await getUserExchangeConnectionRecord(userId, exchange);
  if (!connection.canUsePrivateApi) {
    throw new AppError(400, `${exchange} exchange connection must be verified before using private APIs`);
  }

  return toUserExchangeCredentials(connection, exchange);
}

export async function getStoredUserExchangeCredentials(
  userId: string,
  exchange: ExchangeId,
): Promise<UserExchangeCredentials> {
  const connection = await getUserExchangeConnectionRecord(userId, exchange);
  return toUserExchangeCredentials(connection, exchange);
}

export async function resolveRuntimeExchangeCredentials(
  userId: string,
  exchange: ExchangeId,
): Promise<{ source: ExchangeCredentialSource; credentials: UserExchangeCredentials }> {
  const connection = await findUserExchangeConnectionRecord(userId, exchange);
  if (connection) {
    return {
      source: 'user_connection',
      credentials: toUserExchangeCredentials(connection, exchange),
    };
  }

  const envCredentials = resolveServerExchangeCredentials(exchange);
  if (envCredentials) {
    return {
      source: 'server_env',
      credentials: envCredentials,
    };
  }

  throw getMissingExchangeCredentialError(exchange);
}

export async function getUserExchangeCredentials(
  userId: string,
  exchange: ExchangeId,
): Promise<UserExchangeCredentials> {
  const resolved = await resolveRuntimeExchangeCredentials(userId, exchange);
  return resolved.credentials;
}

export async function getUserExchangeCredentialSource(
  userId: string,
  exchange: ExchangeId,
): Promise<ExchangeCredentialSource> {
  const connection = await findUserExchangeConnectionRecord(userId, exchange);
  if (connection) {
    return 'user_connection';
  }

  if (resolveServerExchangeCredentials(exchange)) {
    return 'server_env';
  }

  throw getMissingExchangeCredentialError(exchange);
}

export async function listUserConnectedExchanges(userId: string) {
  const connections = await prisma.exchangeConnection.findMany({
    where: {
      userId,
      canUsePrivateApi: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  return connections.map((connection) => connection.exchange as ExchangeId);
}

export async function listUserVerifiedExchangeConnections(userId: string) {
  return prisma.exchangeConnection.findMany({
    where: {
      userId,
      canUsePrivateApi: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });
}
