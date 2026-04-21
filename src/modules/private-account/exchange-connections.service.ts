import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { EXCHANGE_MAP } from '../../config/constants';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from './exchange-connections.crypto';
import {
  serializeExchangeConnectionDeleteResponse,
  serializeExchangeConnectionDto,
  serializeExchangeConnectionTestResult,
  type CreateExchangeConnectionRequest,
  type ExchangeConnectionTestCode,
  type ExchangeConnectionTestResult,
  type ExchangeId,
  type TestExchangeConnectionRequest,
  type UpdateExchangeConnectionRequest,
} from './exchange-connections.contract';
import { getExchangeConnectionValidator } from './private-adapters/validator.registry';
import type {
  ExchangeConnectionCredentials,
  ExchangeConnectionValidationResult,
} from './private-adapters/private-adapter.types';
import {
  sanitizeSensitiveDetails,
  sanitizeSensitiveText,
} from '../../domains/security/credential-security.service';
import {
  getExchangeCapabilitySummary,
  getExchangeCredentialFields,
} from '../../domains/exchange-metadata/exchange-metadata.service';

type ExchangeConnectionRecord = Awaited<ReturnType<typeof prisma.exchangeConnection.findFirst>>;

function assertSupportedExchange(exchange: string): ExchangeId {
  const exchangeInfo = EXCHANGE_MAP.get(exchange);
  if (!exchangeInfo) {
    throw new AppError(400, '지원하지 않는 거래소입니다');
  }

  return exchange as ExchangeId;
}

async function validateConnection(params: ExchangeConnectionCredentials) {
  const validator = getExchangeConnectionValidator(params.exchange);
  return validator.validate(params);
}

async function findConnectionByIdentifier(userId: string, identifier: string) {
  if (EXCHANGE_MAP.has(identifier)) {
    return prisma.exchangeConnection.findUnique({
      where: {
        userId_exchange: {
          userId,
          exchange: identifier,
        },
      },
    });
  }

  return prisma.exchangeConnection.findFirst({
    where: {
      id: identifier,
      userId,
    },
  });
}

function toOperationalStatus(validation: ExchangeConnectionValidationResult) {
  return validation.status === 'verified'
    ? 'active'
    : validation.status === 'invalid'
      ? 'invalid'
      : 'pending';
}

function toVerificationDetails(details: Record<string, unknown> | undefined) {
  return sanitizeSensitiveDetails(details) as Prisma.InputJsonValue | undefined;
}

function toLastErrorCode(validation: ExchangeConnectionValidationResult): ExchangeConnectionTestCode | null {
  return validation.canUsePrivateApi ? null : validation.code;
}

function toLastErrorSummary(validation: ExchangeConnectionValidationResult) {
  return validation.canUsePrivateApi ? null : sanitizeSensitiveText(validation.message);
}

function toTestResult(exchange: ExchangeId, validation: ExchangeConnectionValidationResult): ExchangeConnectionTestResult {
  return serializeExchangeConnectionTestResult({
    exchange,
    success: validation.canUsePrivateApi,
    status: validation.status,
    mode: validation.mode,
    code: validation.code,
    message: sanitizeSensitiveText(validation.message) ?? validation.message,
    details: sanitizeSensitiveDetails(validation.details),
    checkedAt: validation.checkedAt,
  });
}

async function createVerificationHistory(params: {
  tx?: Prisma.TransactionClient;
  exchangeConnectionId?: string | null;
  userId: string;
  exchange: ExchangeId;
  validation: ExchangeConnectionValidationResult;
}) {
  const client = params.tx ?? prisma;
  await client.exchangeConnectionVerification.create({
    data: {
      exchangeConnectionId: params.exchangeConnectionId ?? null,
      userId: params.userId,
      exchange: params.exchange,
      status: params.validation.status,
      code: params.validation.code,
      message: sanitizeSensitiveText(params.validation.message) ?? params.validation.message,
      details: toVerificationDetails(params.validation.details),
      checkedAt: new Date(params.validation.checkedAt),
    },
  });
}

function ensureConnectionRecord(connection: ExchangeConnectionRecord) {
  if (!connection) {
    throw new AppError(404, '거래소 연결을 찾을 수 없습니다');
  }

  return connection;
}

function mapConnection(connection: NonNullable<ExchangeConnectionRecord>) {
  const exchange = assertSupportedExchange(connection.exchange);
  const exchangeInfo = EXCHANGE_MAP.get(exchange);
  const apiKey = decryptSecret(connection.apiKeyEncrypted);
  const secretKey = decryptSecret(connection.secretKeyEncrypted);
  const passphrase = connection.passphraseEncrypted
    ? decryptSecret(connection.passphraseEncrypted)
    : null;
  const testResult = toTestResult(exchange, {
    status: connection.validationStatus as ExchangeConnectionValidationResult['status'],
    mode: connection.validationMode as ExchangeConnectionValidationResult['mode'],
    code: (connection.validationCode as ExchangeConnectionValidationResult['code'] | null) ?? 'unknown_error',
    canUsePrivateApi: connection.canUsePrivateApi,
    message:
      sanitizeSensitiveText(connection.validationMessage) ??
      (connection.canUsePrivateApi ? `${exchange} 연결이 확인되었습니다.` : '연결 검증 결과가 없습니다.'),
    details:
      connection.validationDetails && typeof connection.validationDetails === 'object'
        ? sanitizeSensitiveDetails(connection.validationDetails as Record<string, unknown>)
        : undefined,
    checkedAt: (connection.lastValidatedAt ?? connection.updatedAt).toISOString(),
  });

  return serializeExchangeConnectionDto({
    id: connection.id,
    exchange,
    exchangeName: exchangeInfo?.name ?? connection.exchange,
    label: connection.label,
    apiKeyMasked: maskSecret(apiKey),
    hasSecretKey: Boolean(secretKey),
    hasPassphrase: Boolean(passphrase),
    credentialFields: getExchangeCredentialFields(exchange),
    capabilities: getExchangeCapabilitySummary(exchange),
    validation: {
      status: testResult.status,
      mode: testResult.mode,
      canUsePrivateApi: connection.canUsePrivateApi,
      code: testResult.code,
      message: testResult.message,
      details: testResult.details,
      checkedAt: testResult.checkedAt,
    },
    lastTestResult: testResult,
    operational: {
      connectionStatus: connection.connectionStatus as 'pending' | 'active' | 'degraded' | 'invalid',
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      lastErrorCode: (connection.lastErrorCode as ExchangeConnectionTestCode | null) ?? null,
      lastErrorSummary: sanitizeSensitiveText(connection.lastErrorSummary) ?? null,
      failureReason: sanitizeSensitiveText(connection.failureReason) ?? null,
      isTestConnectionResult: connection.isTestConnectionResult,
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  });
}

function buildConnectionUpdate(validation: ExchangeConnectionValidationResult) {
  return {
    validationStatus: validation.status,
    validationMode: validation.mode,
    validationCode: validation.code,
    validationMessage: sanitizeSensitiveText(validation.message) ?? validation.message,
    validationDetails: toVerificationDetails(validation.details),
    canUsePrivateApi: validation.canUsePrivateApi,
    connectionStatus: toOperationalStatus(validation),
    lastValidatedAt: new Date(validation.checkedAt),
    isTestConnectionResult: validation.canUsePrivateApi,
    lastErrorCode: toLastErrorCode(validation),
    lastErrorSummary: toLastErrorSummary(validation),
    failureReason: toLastErrorSummary(validation),
  };
}

function mergeCredentials(
  exchange: ExchangeId,
  existing: NonNullable<ExchangeConnectionRecord>,
  input: UpdateExchangeConnectionRequest,
): ExchangeConnectionCredentials {
  return {
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
}

export async function listExchangeConnections(userId: string) {
  const connections = await prisma.exchangeConnection.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  return connections.map((connection) => mapConnection(connection));
}

export async function getExchangeConnection(userId: string, identifier: string) {
  const connection = ensureConnectionRecord(await findConnectionByIdentifier(userId, identifier));
  return mapConnection(connection);
}

export async function testExchangeConnection(
  userId: string,
  input: TestExchangeConnectionRequest,
) {
  const exchange = assertSupportedExchange(input.exchange);
  const validation = await validateConnection({
    exchange,
    apiKey: input.apiKey,
    secretKey: input.secretKey,
    passphrase: input.passphrase ?? null,
  });

  await createVerificationHistory({
    userId,
    exchange,
    validation,
  });

  return toTestResult(exchange, validation);
}

export async function createExchangeConnection(userId: string, input: CreateExchangeConnectionRequest) {
  const exchange = assertSupportedExchange(input.exchange);
  const existing = await prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange,
      },
    },
  });

  if (existing) {
    throw new AppError(409, '해당 거래소 연결이 이미 존재합니다');
  }

  const validation = await validateConnection({
    exchange,
    apiKey: input.apiKey,
    secretKey: input.secretKey,
    passphrase: input.passphrase ?? null,
  });

  logger.info(
    { domain: 'exchange-connection', userId, exchange, operation: 'create' },
    'Creating exchange connection',
  );

  const connection = await prisma.$transaction(async (tx) => {
    const created = await tx.exchangeConnection.create({
      data: {
        userId,
        exchange,
        label: input.label ?? null,
        apiKeyEncrypted: encryptSecret(input.apiKey),
        secretKeyEncrypted: encryptSecret(input.secretKey),
        passphraseEncrypted: input.passphrase ? encryptSecret(input.passphrase) : null,
        ...buildConnectionUpdate(validation),
      },
    });

    await createVerificationHistory({
      tx,
      exchangeConnectionId: created.id,
      userId,
      exchange,
      validation,
    });

    return created;
  });

  return mapConnection(connection);
}

export async function updateExchangeConnection(
  userId: string,
  identifier: string,
  input: UpdateExchangeConnectionRequest,
) {
  const existing = ensureConnectionRecord(await findConnectionByIdentifier(userId, identifier));
  const exchange = assertSupportedExchange(existing.exchange);
  const mergedCredentials = mergeCredentials(exchange, existing, input);
  const validation = await validateConnection(mergedCredentials);

  logger.info(
    { domain: 'exchange-connection', userId, exchange, operation: 'update' },
    'Updating exchange connection',
  );

  const connection = await prisma.$transaction(async (tx) => {
    const updated = await tx.exchangeConnection.update({
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
        ...buildConnectionUpdate(validation),
      },
    });

    await createVerificationHistory({
      tx,
      exchangeConnectionId: updated.id,
      userId,
      exchange,
      validation,
    });

    return updated;
  });

  return mapConnection(connection);
}

export async function removeExchangeConnection(userId: string, identifier: string) {
  const existing = ensureConnectionRecord(await findConnectionByIdentifier(userId, identifier));
  const exchange = assertSupportedExchange(existing.exchange);
  const exchangeInfo = EXCHANGE_MAP.get(exchange);

  logger.info(
    { domain: 'exchange-connection', userId, exchange, operation: 'delete' },
    'Removing exchange connection',
  );

  await prisma.exchangeConnection.delete({ where: { id: existing.id } });

  return serializeExchangeConnectionDeleteResponse({
    exchange,
    exchangeName: exchangeInfo?.name ?? exchange,
    removedAt: new Date(),
  });
}

export async function validateStoredExchangeConnection(userId: string, identifier: string) {
  const existing = ensureConnectionRecord(await findConnectionByIdentifier(userId, identifier));
  const exchange = assertSupportedExchange(existing.exchange);
  const validation = await validateConnection({
    exchange,
    apiKey: decryptSecret(existing.apiKeyEncrypted),
    secretKey: decryptSecret(existing.secretKeyEncrypted),
    passphrase: existing.passphraseEncrypted ? decryptSecret(existing.passphraseEncrypted) : null,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const connection = await tx.exchangeConnection.update({
      where: { id: existing.id },
      data: buildConnectionUpdate(validation),
    });

    await createVerificationHistory({
      tx,
      exchangeConnectionId: connection.id,
      userId,
      exchange,
      validation,
    });

    return connection;
  });

  return mapConnection(updated);
}

export async function markExchangeConnectionSync(
  userId: string,
  exchange: string,
  params: { success: boolean; failureCode?: string | null; failureReason?: string | null },
) {
  try {
    await prisma.exchangeConnection.update({
      where: {
        userId_exchange: {
          userId,
          exchange,
        },
      },
      data: {
        connectionStatus: params.success ? 'active' : 'degraded',
        lastSyncAt: params.success ? new Date() : undefined,
        lastErrorCode: params.success ? null : params.failureCode ?? 'unknown_error',
        lastErrorSummary: params.success ? null : sanitizeSensitiveText(params.failureReason) ?? 'Exchange sync failed',
        failureReason: params.success ? null : sanitizeSensitiveText(params.failureReason) ?? 'Exchange sync failed',
      },
    });
  } catch (error) {
    logger.debug(
      { domain: 'exchange-connection', userId, exchange, operation: 'mark-sync', err: error },
      'Skipping exchange sync marker update',
    );
  }
}
