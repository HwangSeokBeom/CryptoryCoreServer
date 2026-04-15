import { prisma } from '../../config/database';
import { EXCHANGE_MAP } from '../../config/constants';
import { logger } from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { decryptSecret, encryptSecret, maskSecret } from './exchange-connections.crypto';
import {
  serializeExchangeConnectionDeleteResponse,
  serializeExchangeConnectionDto,
  type ExchangeId,
  type CreateExchangeConnectionRequest,
  type UpdateExchangeConnectionRequest,
} from './exchange-connections.contract';
import { getExchangeConnectionValidator } from './private-adapters/validator.registry';

type ExchangeConnectionRecord = {
  id: string;
  exchange: string;
  label: string | null;
  apiKeyEncrypted: string;
  secretKeyEncrypted: string;
  passphraseEncrypted: string | null;
  validationStatus: string;
  validationMode: string;
  validationMessage: string | null;
  canUsePrivateApi: boolean;
  lastValidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function assertSupportedExchange(exchange: string) {
  const exchangeInfo = EXCHANGE_MAP.get(exchange);
  if (!exchangeInfo) {
    throw new AppError(400, '지원하지 않는 거래소입니다');
  }

  return exchangeInfo;
}

async function validateConnection(params: {
  exchange: string;
  apiKey: string;
  secretKey: string;
  passphrase?: string | null;
}) {
  const validator = getExchangeConnectionValidator(params.exchange);
  return validator.validate({
    exchange: params.exchange,
    apiKey: params.apiKey,
    secretKey: params.secretKey,
    passphrase: params.passphrase ?? null,
  });
}

function mapConnection(connection: ExchangeConnectionRecord) {
  const exchangeInfo = EXCHANGE_MAP.get(connection.exchange);
  const apiKey = decryptSecret(connection.apiKeyEncrypted);
  const secretKey = decryptSecret(connection.secretKeyEncrypted);
  const passphrase = connection.passphraseEncrypted
    ? decryptSecret(connection.passphraseEncrypted)
    : null;

  return serializeExchangeConnectionDto({
    id: connection.id,
    exchange: connection.exchange as ExchangeId,
    exchangeName: exchangeInfo?.name ?? connection.exchange,
    label: connection.label,
    apiKeyMasked: maskSecret(apiKey),
    hasSecretKey: Boolean(secretKey),
    hasPassphrase: Boolean(passphrase),
    validation: {
      status: connection.validationStatus as 'verified' | 'invalid' | 'placeholder',
      mode: connection.validationMode as 'live_api' | 'syntactic' | 'placeholder',
      canUsePrivateApi: connection.canUsePrivateApi,
      message: connection.validationMessage ?? 'Validation has not been executed yet.',
      checkedAt: (connection.lastValidatedAt ?? connection.updatedAt).toISOString(),
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  });
}

export async function listExchangeConnections(userId: string) {
  const connections = await prisma.exchangeConnection.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  return connections.map((connection) => mapConnection(connection));
}

export async function createExchangeConnection(
  userId: string,
  input: CreateExchangeConnectionRequest,
) {
  const exchangeInfo = assertSupportedExchange(input.exchange);
  const existing = await prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange: input.exchange,
      },
    },
  });

  if (existing) {
    throw new AppError(409, '해당 거래소 연결이 이미 존재합니다');
  }

  logger.info(
    { domain: 'private-account', userId, exchange: input.exchange, operation: 'create-exchange-connection' },
    'Creating private exchange connection',
  );

  const validation = await validateConnection(input);

  const connection = await prisma.exchangeConnection.create({
    data: {
      userId,
      exchange: input.exchange,
      label: input.label ?? null,
      apiKeyEncrypted: encryptSecret(input.apiKey),
      secretKeyEncrypted: encryptSecret(input.secretKey),
      passphraseEncrypted: input.passphrase ? encryptSecret(input.passphrase) : null,
      validationStatus: validation.status,
      validationMode: validation.mode,
      validationMessage: validation.message,
      canUsePrivateApi: validation.canUsePrivateApi,
      lastValidatedAt: new Date(validation.checkedAt),
    },
  });

  logger.info(
    {
      domain: 'private-account',
      userId,
      exchange: input.exchange,
      operation: 'create-exchange-connection',
      validationStatus: validation.status,
      validationMode: validation.mode,
      canUsePrivateApi: validation.canUsePrivateApi,
    },
    'Private exchange connection created',
  );

  return mapConnection(connection);
}

export async function updateExchangeConnection(
  userId: string,
  exchange: string,
  input: UpdateExchangeConnectionRequest,
) {
  assertSupportedExchange(exchange);
  const existing = await prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange,
      },
    },
  });

  if (!existing) {
    throw new AppError(404, '거래소 연결을 찾을 수 없습니다');
  }

  const mergedCredentials = {
    exchange,
    apiKey: input.apiKey ?? decryptSecret(existing.apiKeyEncrypted),
    secretKey: input.secretKey ?? decryptSecret(existing.secretKeyEncrypted),
    passphrase:
      input.passphrase !== undefined
        ? input.passphrase
        : existing.passphraseEncrypted
          ? decryptSecret(existing.passphraseEncrypted)
          : null,
  };

  logger.info(
    { domain: 'private-account', userId, exchange, operation: 'update-exchange-connection' },
    'Updating private exchange connection',
  );

  const validation = await validateConnection(mergedCredentials);
  const connection = await prisma.exchangeConnection.update({
    where: { id: existing.id },
    data: {
      label: input.label !== undefined ? input.label : existing.label,
      apiKeyEncrypted:
        input.apiKey !== undefined ? encryptSecret(input.apiKey) : existing.apiKeyEncrypted,
      secretKeyEncrypted:
        input.secretKey !== undefined ? encryptSecret(input.secretKey) : existing.secretKeyEncrypted,
      passphraseEncrypted:
        input.passphrase !== undefined
          ? input.passphrase
            ? encryptSecret(input.passphrase)
            : null
          : existing.passphraseEncrypted,
      validationStatus: validation.status,
      validationMode: validation.mode,
      validationMessage: validation.message,
      canUsePrivateApi: validation.canUsePrivateApi,
      lastValidatedAt: new Date(validation.checkedAt),
    },
  });

  logger.info(
    {
      domain: 'private-account',
      userId,
      exchange,
      operation: 'update-exchange-connection',
      validationStatus: validation.status,
      validationMode: validation.mode,
      canUsePrivateApi: validation.canUsePrivateApi,
    },
    'Private exchange connection updated',
  );

  return mapConnection(connection);
}

export async function removeExchangeConnection(userId: string, exchange: string) {
  const exchangeInfo = assertSupportedExchange(exchange);
  const existing = await prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange,
      },
    },
  });

  if (!existing) {
    throw new AppError(404, '거래소 연결을 찾을 수 없습니다');
  }

  logger.info(
    { domain: 'private-account', userId, exchange, operation: 'delete-exchange-connection' },
    'Removing private exchange connection',
  );

  await prisma.exchangeConnection.delete({ where: { id: existing.id } });

  return serializeExchangeConnectionDeleteResponse({
    exchange: exchange as ExchangeId,
    exchangeName: exchangeInfo.name,
    removedAt: new Date(),
  });
}
