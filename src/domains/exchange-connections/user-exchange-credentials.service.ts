import { prisma } from '../../config/database';
import type { ExchangeId, UserExchangeCredentials } from '../../core/exchange/exchange.types';
import { AppError } from '../../utils/errors';
import { decryptSecret } from '../../modules/private-account/exchange-connections.crypto';

export async function getUserExchangeConnectionRecord(userId: string, exchange: ExchangeId) {
  const connection = await prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange,
      },
    },
  });

  if (!connection) {
    throw new AppError(404, `${exchange} exchange connection is not connected`);
  }

  return connection;
}

export async function getUserExchangeCredentials(
  userId: string,
  exchange: ExchangeId,
): Promise<UserExchangeCredentials> {
  const connection = await getUserExchangeConnectionRecord(userId, exchange);
  return {
    exchange,
    apiKey: decryptSecret(connection.apiKeyEncrypted),
    secretKey: decryptSecret(connection.secretKeyEncrypted),
    passphrase: connection.passphraseEncrypted ? decryptSecret(connection.passphraseEncrypted) : null,
  };
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
