import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { EXCHANGE_MAP } from '../../config/constants';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  createFingerprint,
  decryptSecret,
  encryptSecret,
  maskAccessKey,
} from './exchange-connections.crypto';
import {
  serializeExchangeConnectionDeleteResponse,
  serializeExchangeConnectionDto,
  serializeExchangeConnectionTestResult,
  type ExchangeConnectionAppCode,
  type ExchangeConnectionPermission,
  type ExchangeConnectionPurpose,
  type ExchangeConnectionStatus,
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
  getExchangePermissionGuides,
} from '../../domains/exchange-metadata/exchange-metadata.service';

type ExchangeConnectionRecord = Awaited<ReturnType<typeof prisma.exchangeConnection.findFirst>>;
const inFlightExchangeConnectionReads = new Map<string, Promise<unknown>>();

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

function withSingleFlight<T>(key: string, operation: () => Promise<T>) {
  const existing = inFlightExchangeConnectionReads.get(key);
  if (existing) {
    logger.debug({ domain: 'exchange-connection', event: 'singleflight_join', key }, 'Joined in-flight exchange connection request');
    return existing as Promise<T>;
  }

  const promise = operation().finally(() => {
    inFlightExchangeConnectionReads.delete(key);
  });
  inFlightExchangeConnectionReads.set(key, promise);
  return promise;
}

function toConnectionPurpose(permission: ExchangeConnectionPermission): ExchangeConnectionPurpose {
  return permission === 'trade_enabled' ? 'trading' : 'read_only';
}

function toPermissionFromPurpose(purpose: string | null | undefined): ExchangeConnectionPermission | null {
  if (purpose === 'trading') return 'trade_enabled';
  if (purpose === 'read_only') return 'read_only';
  return null;
}

function readRequestedPermission(
  details: Record<string, unknown> | null | undefined,
  connectionPurpose?: string | null,
): ExchangeConnectionPermission {
  const purposePermission = toPermissionFromPurpose(connectionPurpose);
  if (purposePermission) return purposePermission;
  return details?.requestedPermission === 'trade_enabled' ? 'trade_enabled' : 'read_only';
}

function toPermissionScope(permission: ExchangeConnectionPermission) {
  return permission === 'trade_enabled' ? ['read', 'trade'] : ['read'];
}

function readPermissionScope(value: Prisma.JsonValue | null | undefined, permission: ExchangeConnectionPermission) {
  if (Array.isArray(value)) {
    const scope = value.filter((item): item is string => typeof item === 'string');
    if (scope.length > 0) {
      return scope;
    }
  }

  return toPermissionScope(permission);
}

function toClientFacingValidationCode(
  code: ExchangeConnectionTestCode,
  permission: ExchangeConnectionPermission,
  details?: Record<string, unknown>,
): ExchangeConnectionAppCode {
  const rawMessage = String(details?.rawMessage ?? '').toLowerCase();

  switch (code) {
    case 'verified':
      return 'CONNECTION_VERIFIED';
    case 'invalid_credentials':
      if (/secret|signature/i.test(rawMessage)) {
        return 'INVALID_SECRET';
      }
      if (/api|access|token/i.test(rawMessage)) {
        return 'INVALID_API_KEY';
      }
      return 'INVALID_CREDENTIALS';
    case 'insufficient_permissions':
      return permission === 'trade_enabled' ? 'INSUFFICIENT_SCOPE' : 'INSUFFICIENT_PERMISSION_READONLY_REQUIRED';
    case 'ip_not_whitelisted':
      return 'IP_NOT_ALLOWED';
    case 'signature_error':
      return 'SIGNATURE_INVALID';
    case 'timeout':
      return 'UPSTREAM_TIMEOUT';
    case 'exchange_unavailable':
    case 'rate_limited':
      return 'EXCHANGE_UNAVAILABLE';
    case 'unsupported_exchange':
    case 'unknown_error':
    default:
      return 'CONNECTION_VERIFICATION_FAILED';
  }
}

function toClientConnectionStatus(params: {
  validationStatus: ExchangeConnectionValidationResult['status'];
  canUsePrivateApi: boolean;
  connectionStatus: string;
  code: ExchangeConnectionTestCode;
}) {
  if (params.canUsePrivateApi) {
    return 'connected' as const;
  }
  if (
    params.validationStatus === 'placeholder'
    || params.connectionStatus === 'pending'
    || params.connectionStatus === 'pending_verification'
  ) {
    return 'validating' as const;
  }
  if (
    params.code === 'exchange_unavailable'
    || params.code === 'timeout'
    || params.connectionStatus === 'degraded'
    || params.connectionStatus === 'temporarily_unreachable'
  ) {
    return 'maintenance' as const;
  }
  if (
    params.validationStatus === 'invalid'
    || [
      'invalid',
      'verification_failed',
      'invalid_credentials',
      'insufficient_scope',
      'ip_not_allowed',
      'revoked',
      'reauth_required',
    ].includes(params.connectionStatus)
  ) {
    return 'failed' as const;
  }
  return 'unknown' as const;
}

function toOperationalStatus(validation: ExchangeConnectionValidationResult): ExchangeConnectionStatus {
  if (validation.status === 'verified') {
    return 'active';
  }

  if (validation.status === 'placeholder') {
    return 'pending_verification';
  }

  switch (validation.code) {
    case 'invalid_credentials':
    case 'signature_error':
      return 'invalid_credentials';
    case 'insufficient_permissions':
      return 'insufficient_scope';
    case 'ip_not_whitelisted':
      return 'ip_not_allowed';
    case 'timeout':
    case 'rate_limited':
    case 'exchange_unavailable':
      return 'temporarily_unreachable';
    case 'unsupported_exchange':
    case 'unknown_error':
    case 'verified':
    default:
      return 'verification_failed';
  }
}

function toRuntimeFailureStatus(failureCode: string | null | undefined): ExchangeConnectionStatus {
  switch (failureCode) {
    case 'invalid_credentials':
    case 'signature_error':
      return 'reauth_required';
    case 'insufficient_permissions':
      return 'insufficient_scope';
    case 'ip_not_whitelisted':
      return 'ip_not_allowed';
    case 'timeout':
    case 'rate_limited':
    case 'exchange_unavailable':
      return 'temporarily_unreachable';
    default:
      return 'verification_failed';
  }
}

function normalizeFailureCode(failureCode: string | null | undefined): ExchangeConnectionTestCode {
  switch (failureCode) {
    case 'invalid_credentials':
    case 'insufficient_permissions':
    case 'ip_not_whitelisted':
    case 'signature_error':
    case 'timeout':
    case 'rate_limited':
    case 'exchange_unavailable':
    case 'unsupported_exchange':
      return failureCode;
    case 'INSUFFICIENT_SCOPE':
      return 'insufficient_permissions';
    case 'IP_NOT_ALLOWED':
      return 'ip_not_whitelisted';
    case 'EXCHANGE_UNAVAILABLE':
      return 'exchange_unavailable';
    default:
      return 'unknown_error';
  }
}

function toVerificationDetails(
  details: Record<string, unknown> | undefined,
  permission: ExchangeConnectionPermission,
) {
  return sanitizeSensitiveDetails({
    ...(details ?? {}),
    requestedPermission: permission,
    connectionPurpose: toConnectionPurpose(permission),
    permissionScope: toPermissionScope(permission),
    withdrawPermissionAllowed: false,
  }) as Prisma.InputJsonValue | undefined;
}

function toLastErrorCode(validation: ExchangeConnectionValidationResult): ExchangeConnectionTestCode | null {
  return validation.canUsePrivateApi ? null : validation.code;
}

function toLastErrorSummary(validation: ExchangeConnectionValidationResult) {
  return validation.canUsePrivateApi ? null : sanitizeSensitiveText(validation.message);
}

function toTestResult(
  exchange: ExchangeId,
  validation: ExchangeConnectionValidationResult,
  permission: ExchangeConnectionPermission,
): ExchangeConnectionTestResult {
  return serializeExchangeConnectionTestResult({
    exchange,
    success: validation.canUsePrivateApi,
    status: validation.status,
    mode: validation.mode,
    code: validation.code,
    appCode: toClientFacingValidationCode(validation.code, permission, validation.details),
    permission,
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
  permission: ExchangeConnectionPermission;
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
      details: toVerificationDetails(params.validation.details, params.permission),
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
  const permission = readRequestedPermission(
    connection.validationDetails && typeof connection.validationDetails === 'object'
      ? (connection.validationDetails as Record<string, unknown>)
      : undefined,
    connection.connectionPurpose,
  );
  const connectionPurpose = toConnectionPurpose(permission);
  const permissionScope = readPermissionScope(connection.permissionScope, permission);
  const apiKeyMasked = connection.apiKeyMasked || '********';
  const credentialStatus = connection.connectionStatus as ExchangeConnectionStatus;
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
  }, permission);
  const status = toClientConnectionStatus({
    validationStatus: testResult.status,
    canUsePrivateApi: connection.canUsePrivateApi,
    connectionStatus: connection.connectionStatus,
    code: testResult.code,
  });

  return serializeExchangeConnectionDto({
    id: connection.id,
    exchange,
    exchangeName: exchangeInfo?.name ?? connection.exchange,
    permission,
    connectionPurpose,
    permissionScope,
    credentialStatus,
    nickname: connection.label,
    status,
    statusMessage: sanitizeSensitiveText(connection.validationMessage)
      ?? sanitizeSensitiveText(connection.lastErrorSummary)
      ?? null,
    maskedCredentialSummary: apiKeyMasked,
    lastValidatedAt: connection.lastValidatedAt?.toISOString() ?? null,
    validationStatus: testResult.status,
    appValidationCode: testResult.appCode,
    label: connection.label,
    apiKeyMasked,
    hasSecretKey: Boolean(connection.secretKeyEncrypted),
    hasPassphrase: Boolean(connection.passphraseEncrypted),
    credentialFields: getExchangeCredentialFields(exchange),
    permissionGuides: getExchangePermissionGuides(exchange),
    capabilities: getExchangeCapabilitySummary(exchange),
    validation: {
      status: testResult.status,
      mode: testResult.mode,
      canUsePrivateApi: connection.canUsePrivateApi,
      code: testResult.code,
      appCode: testResult.appCode,
      message: testResult.message,
      details: testResult.details,
      checkedAt: testResult.checkedAt,
    },
    lastTestResult: testResult,
    operational: {
      connectionStatus: credentialStatus,
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

function buildConnectionUpdate(
  validation: ExchangeConnectionValidationResult,
  permission: ExchangeConnectionPermission,
) {
  return {
    validationStatus: validation.status,
    validationMode: validation.mode,
    validationCode: validation.code,
    validationMessage: sanitizeSensitiveText(validation.message) ?? validation.message,
    validationDetails: toVerificationDetails(validation.details, permission),
    canUsePrivateApi: validation.canUsePrivateApi,
    connectionStatus: toOperationalStatus(validation),
    connectionPurpose: toConnectionPurpose(permission),
    permissionScope: toPermissionScope(permission),
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
  permission: ExchangeConnectionPermission,
): ExchangeConnectionCredentials {
  return {
    exchange,
    apiKey: input.apiKey ?? decryptSecret(existing.apiKeyEncrypted),
    secretKey: input.secretKey ?? decryptSecret(existing.secretKeyEncrypted),
    permission,
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
    permission: input.permission,
  });

  await createVerificationHistory({
    userId,
    exchange,
    permission: input.permission,
    validation,
  });

  return toTestResult(exchange, validation, input.permission);
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
    permission: input.permission,
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
        apiKeyMasked: maskAccessKey(input.apiKey),
        apiKeyFingerprint: createFingerprint(input.apiKey),
        ...buildConnectionUpdate(validation, input.permission),
      },
    });

    await createVerificationHistory({
      tx,
      exchangeConnectionId: created.id,
      userId,
      exchange,
      permission: input.permission,
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
  const existingPermission = readRequestedPermission(
    existing.validationDetails && typeof existing.validationDetails === 'object'
      ? (existing.validationDetails as Record<string, unknown>)
      : undefined,
    existing.connectionPurpose,
  );
  const permission = input.permission ?? existingPermission;
  const credentialsChanged = input.apiKey !== undefined || input.secretKey !== undefined || input.passphrase !== undefined;
  const permissionChanged = input.permission !== undefined && input.permission !== existingPermission;

  if (!credentialsChanged && !permissionChanged) {
    const updated = await prisma.exchangeConnection.update({
      where: { id: existing.id },
      data: {
        label: input.label !== undefined ? input.label : existing.label,
      },
    });
    return mapConnection(updated);
  }

  const mergedCredentials = mergeCredentials(exchange, existing, input, permission);
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
        apiKeyMasked:
          input.apiKey !== undefined ? maskAccessKey(input.apiKey) : existing.apiKeyMasked,
        apiKeyFingerprint:
          input.apiKey !== undefined ? createFingerprint(input.apiKey) : existing.apiKeyFingerprint,
        secretKeyEncrypted:
          input.secretKey !== undefined ? encryptSecret(input.secretKey) : existing.secretKeyEncrypted,
        passphraseEncrypted:
          input.passphrase !== undefined
            ? input.passphrase
              ? encryptSecret(input.passphrase)
              : null
            : existing.passphraseEncrypted,
        ...buildConnectionUpdate(validation, permission),
      },
    });

    await createVerificationHistory({
      tx,
      exchangeConnectionId: updated.id,
      userId,
      exchange,
      permission,
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
  const permission = readRequestedPermission(
    existing.validationDetails && typeof existing.validationDetails === 'object'
      ? (existing.validationDetails as Record<string, unknown>)
      : undefined,
    existing.connectionPurpose,
  );
  const apiKey = decryptSecret(existing.apiKeyEncrypted);
  const secretKey = decryptSecret(existing.secretKeyEncrypted);
  const validation = await validateConnection({
    exchange,
    apiKey,
    secretKey,
    passphrase: existing.passphraseEncrypted ? decryptSecret(existing.passphraseEncrypted) : null,
    permission,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const connection = await tx.exchangeConnection.update({
      where: { id: existing.id },
      data: {
        apiKeyMasked: maskAccessKey(apiKey),
        apiKeyFingerprint: createFingerprint(apiKey),
        ...buildConnectionUpdate(validation, permission),
      },
    });

    await createVerificationHistory({
      tx,
      exchangeConnectionId: connection.id,
      userId,
      exchange,
      permission,
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
    const failureCode = normalizeFailureCode(params.failureCode);
    const result = await prisma.exchangeConnection.updateMany({
      where: {
        userId,
        exchange,
      },
      data: {
        connectionStatus: params.success ? 'active' : toRuntimeFailureStatus(failureCode),
        lastSyncAt: params.success ? new Date() : undefined,
        lastErrorCode: params.success ? null : failureCode,
        lastErrorSummary: params.success ? null : sanitizeSensitiveText(params.failureReason) ?? 'Exchange sync failed',
        failureReason: params.success ? null : sanitizeSensitiveText(params.failureReason) ?? 'Exchange sync failed',
      },
    });

    if (result.count === 0) {
      logger.debug(
        { domain: 'exchange-connection', userId, exchange, operation: 'mark-sync', event: 'connection-not-found' },
        'Skipping exchange sync marker update for missing connection',
      );
    }
  } catch (error) {
    logger.debug(
      { domain: 'exchange-connection', userId, exchange, operation: 'mark-sync', err: error },
      'Skipping exchange sync marker update',
    );
  }
}
