import { z } from 'zod';

export const exchangeIdSchema = z.enum(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);
export type ExchangeId = z.infer<typeof exchangeIdSchema>;

export const exchangeConnectionPermissionSchema = z.enum(['read_only', 'trade_enabled']);
export type ExchangeConnectionPermission = z.infer<typeof exchangeConnectionPermissionSchema>;

export const exchangeConnectionPurposeSchema = z.enum(['read_only', 'trading']);
export type ExchangeConnectionPurpose = z.infer<typeof exchangeConnectionPurposeSchema>;

export const exchangeConnectionStatusSchema = z.enum([
  'pending_verification',
  'active',
  'verification_failed',
  'invalid_credentials',
  'insufficient_scope',
  'ip_not_allowed',
  'temporarily_unreachable',
  'revoked',
  'reauth_required',
  'pending',
  'degraded',
  'invalid',
]);
export type ExchangeConnectionStatus = z.infer<typeof exchangeConnectionStatusSchema>;

export const exchangeConnectionAppCodeSchema = z.enum([
  'CONNECTION_VERIFIED',
  'INVALID_API_KEY',
  'INVALID_SECRET',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_SCOPE',
  'INSUFFICIENT_PERMISSION_READONLY_REQUIRED',
  'INSUFFICIENT_PERMISSION_TRADING_REQUIRED',
  'IP_NOT_ALLOWED',
  'IP_WHITELIST_REQUIRED',
  'SIGNATURE_INVALID',
  'UPSTREAM_TIMEOUT',
  'EXCHANGE_UNAVAILABLE',
  'EXCHANGE_API_UNAVAILABLE',
  'CONNECTION_VERIFICATION_FAILED',
  'UNKNOWN_VALIDATION_ERROR',
]);
export type ExchangeConnectionAppCode = z.infer<typeof exchangeConnectionAppCodeSchema>;

export const exchangeCredentialFieldSchema = z.object({
  key: z.string(),
  requestKey: z.string().optional(),
  label: z.string(),
  required: z.boolean(),
  masked: z.boolean().default(true),
  helpText: z.string().optional(),
});

export const exchangePermissionGuideSchema = z.object({
  key: exchangeConnectionPermissionSchema,
  label: z.string(),
  description: z.string(),
  requiredPermissions: z.array(z.string()),
});

export const exchangeCapabilitySummarySchema = z.object({
  canTestConnection: z.boolean(),
  canReadPortfolio: z.boolean(),
  canReadOrderChance: z.boolean().optional(),
  canPlaceOrder: z.boolean(),
  canCancelOrder: z.boolean(),
  canReadOpenOrders: z.boolean(),
  canReadFills: z.boolean(),
  canUsePrivateWebSocket: z.boolean().optional(),
  privateWebSocketMode: z.enum(['server_side_polling', 'unsupported']).optional(),
  requiredPermissionScopes: z.record(z.array(z.string())).optional(),
});

export const exchangeConnectionTestCodeSchema = z.enum([
  'verified',
  'invalid_credentials',
  'insufficient_permissions',
  'ip_not_whitelisted',
  'signature_error',
  'timeout',
  'rate_limited',
  'exchange_unavailable',
  'unsupported_exchange',
  'unknown_error',
]);

export const exchangeConnectionTestResultSchema = z.object({
  exchange: exchangeIdSchema,
  success: z.boolean(),
  status: z.enum(['verified', 'invalid', 'placeholder']),
  mode: z.enum(['live_api', 'syntactic', 'placeholder']),
  code: exchangeConnectionTestCodeSchema,
  appCode: exchangeConnectionAppCodeSchema.optional(),
  permission: exchangeConnectionPermissionSchema.optional(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  checkedAt: z.string().datetime(),
});

export const exchangeConnectionValidationDtoSchema = z.object({
  status: z.enum(['verified', 'invalid', 'placeholder']),
  mode: z.enum(['live_api', 'syntactic', 'placeholder']),
  canUsePrivateApi: z.boolean(),
  code: exchangeConnectionTestCodeSchema,
  appCode: exchangeConnectionAppCodeSchema.optional(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  checkedAt: z.string().datetime(),
});

export const exchangeConnectionOperationalDtoSchema = z.object({
  connectionStatus: exchangeConnectionStatusSchema,
  lastSyncAt: z.string().datetime().nullable(),
  lastErrorCode: exchangeConnectionTestCodeSchema.nullable(),
  lastErrorSummary: z.string().nullable(),
  failureReason: z.string().nullable(),
  isTestConnectionResult: z.boolean(),
});

export const exchangeConnectionDtoSchema = z.object({
  id: z.string(),
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  permission: exchangeConnectionPermissionSchema.default('read_only'),
  connectionPurpose: exchangeConnectionPurposeSchema.default('read_only'),
  permissionScope: z.array(z.string()).default(['read']),
  credentialStatus: exchangeConnectionStatusSchema.default('pending_verification'),
  nickname: z.string().nullable().optional(),
  status: z.enum(['connected', 'disconnected', 'validating', 'failed', 'maintenance', 'unknown']).default('unknown'),
  statusMessage: z.string().nullable().optional(),
  maskedCredentialSummary: z.string().nullable().optional(),
  lastValidatedAt: z.string().datetime().nullable().optional(),
  validationStatus: z.enum(['verified', 'invalid', 'placeholder']).optional(),
  appValidationCode: exchangeConnectionAppCodeSchema.optional(),
  label: z.string().nullable(),
  apiKeyMasked: z.string(),
  hasSecretKey: z.boolean(),
  hasPassphrase: z.boolean(),
  credentialFields: z.array(exchangeCredentialFieldSchema),
  permissionGuides: z.array(exchangePermissionGuideSchema).optional(),
  capabilities: exchangeCapabilitySummarySchema,
  validation: exchangeConnectionValidationDtoSchema,
  lastTestResult: exchangeConnectionTestResultSchema,
  operational: exchangeConnectionOperationalDtoSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const exchangeConnectionListResponseDtoSchema = z.object({
  items: z.array(exchangeConnectionDtoSchema),
  total: z.number().int().nonnegative(),
});

export const exchangeConnectionDeleteResponseDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  removedAt: z.string().datetime(),
});

const credentialEnvelopeSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  accessKey: z.string().trim().min(1).optional(),
  accessToken: z.string().trim().min(1).optional(),
  secretKey: z.string().trim().min(1).optional(),
  passphrase: z.string().trim().min(1).nullable().optional(),
});

function extractApiKey(value: {
  apiKey?: string;
  accessKey?: string;
  accessToken?: string;
  credentials?: z.infer<typeof credentialEnvelopeSchema>;
}) {
  return value.apiKey
    ?? value.accessKey
    ?? value.accessToken
    ?? value.credentials?.apiKey
    ?? value.credentials?.accessKey
    ?? value.credentials?.accessToken;
}

function extractSecretKey(value: {
  secretKey?: string;
  credentials?: z.infer<typeof credentialEnvelopeSchema>;
}) {
  return value.secretKey ?? value.credentials?.secretKey;
}

function extractPassphrase(value: {
  passphrase?: string | null;
  credentials?: z.infer<typeof credentialEnvelopeSchema>;
}) {
  return value.passphrase ?? value.credentials?.passphrase;
}

const createExchangeConnectionBaseSchema = z.object({
  exchange: exchangeIdSchema,
  label: z.string().trim().min(1).max(50).optional(),
  nickname: z.string().trim().min(1).max(50).optional(),
  permission: exchangeConnectionPermissionSchema.optional(),
  connectionPurpose: exchangeConnectionPurposeSchema.optional(),
  apiKey: z.string().trim().min(1).optional(),
  accessKey: z.string().trim().min(1).optional(),
  accessToken: z.string().trim().min(1).optional(),
  secretKey: z.string().trim().min(1).optional(),
  passphrase: z.string().trim().min(1).nullable().optional(),
  credentials: credentialEnvelopeSchema.optional(),
});

export const createExchangeConnectionRequestSchema = createExchangeConnectionBaseSchema
  .superRefine((value, ctx) => {
    if (!extractApiKey(value)?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentials'],
        message: 'apiKey, accessKey, or accessToken is required',
      });
    }
    if (!extractSecretKey(value)?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentials'],
        message: 'secretKey is required',
      });
    }
  })
  .transform((value) => ({
    exchange: value.exchange,
    label: value.label ?? value.nickname,
    permission: value.permission ?? (value.connectionPurpose === 'trading' ? 'trade_enabled' : 'read_only'),
    apiKey: extractApiKey(value)!,
    secretKey: extractSecretKey(value)!,
    passphrase: extractPassphrase(value) ?? undefined,
  }));

export const testExchangeConnectionRequestSchema = createExchangeConnectionRequestSchema;

export const updateExchangeConnectionRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(50).nullable().optional(),
    nickname: z.string().trim().min(1).max(50).nullable().optional(),
    permission: exchangeConnectionPermissionSchema.optional(),
    connectionPurpose: exchangeConnectionPurposeSchema.optional(),
    apiKey: z.string().trim().min(1).optional(),
    accessKey: z.string().trim().min(1).optional(),
    accessToken: z.string().trim().min(1).optional(),
    secretKey: z.string().trim().min(1).optional(),
    passphrase: z.string().trim().min(1).nullable().optional(),
    credentials: credentialEnvelopeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasCredentialUpdate = Boolean(
      extractApiKey(value)
      || extractSecretKey(value)
      || extractPassphrase(value) !== undefined,
    );
    const hasMetadataUpdate =
      value.label !== undefined || value.nickname !== undefined || value.permission !== undefined;
    const hasPurposeUpdate = value.connectionPurpose !== undefined;
    if (!hasCredentialUpdate && !hasMetadataUpdate && !hasPurposeUpdate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one field must be provided',
      });
    }
  })
  .transform((value) => ({
    label: value.label ?? value.nickname,
    permission:
      value.permission
      ?? (value.connectionPurpose === 'trading'
        ? 'trade_enabled'
        : value.connectionPurpose === 'read_only'
          ? 'read_only'
          : undefined),
    apiKey: extractApiKey(value),
    secretKey: extractSecretKey(value),
    passphrase: extractPassphrase(value),
  }));

export type ExchangeCredentialField = z.infer<typeof exchangeCredentialFieldSchema>;
export type ExchangePermissionGuide = z.infer<typeof exchangePermissionGuideSchema>;
export type ExchangeCapabilitySummary = z.infer<typeof exchangeCapabilitySummarySchema>;
export type ExchangeConnectionTestCode = z.infer<typeof exchangeConnectionTestCodeSchema>;
export type ExchangeConnectionTestResult = z.infer<typeof exchangeConnectionTestResultSchema>;
export type ExchangeConnectionDto = z.infer<typeof exchangeConnectionDtoSchema>;
export type ExchangeConnectionListResponseDto = z.infer<typeof exchangeConnectionListResponseDtoSchema>;
export type ExchangeConnectionDeleteResponseDto = z.infer<typeof exchangeConnectionDeleteResponseDtoSchema>;
export type CreateExchangeConnectionRequest = z.infer<typeof createExchangeConnectionRequestSchema>;
export type TestExchangeConnectionRequest = z.infer<typeof testExchangeConnectionRequestSchema>;
export type UpdateExchangeConnectionRequest = z.infer<typeof updateExchangeConnectionRequestSchema>;

export function serializeExchangeConnectionTestResult(result: ExchangeConnectionTestResult) {
  return exchangeConnectionTestResultSchema.parse(result);
}

export function serializeExchangeConnectionDto(connection: {
  id: string;
  exchange: z.infer<typeof exchangeIdSchema>;
  exchangeName: string;
  permission: ExchangeConnectionPermission;
  connectionPurpose: ExchangeConnectionPurpose;
  permissionScope: string[];
  credentialStatus: ExchangeConnectionStatus;
  nickname: string | null;
  status: 'connected' | 'disconnected' | 'validating' | 'failed' | 'maintenance' | 'unknown';
  statusMessage: string | null;
  maskedCredentialSummary: string | null;
  lastValidatedAt: string | null;
  validationStatus?: 'verified' | 'invalid' | 'placeholder';
  appValidationCode?: ExchangeConnectionAppCode;
  label: string | null;
  apiKeyMasked: string;
  hasSecretKey: boolean;
  hasPassphrase: boolean;
  credentialFields: ExchangeCredentialField[];
  permissionGuides?: ExchangePermissionGuide[];
  capabilities: ExchangeCapabilitySummary;
  validation: {
    status: 'verified' | 'invalid' | 'placeholder';
    mode: 'live_api' | 'syntactic' | 'placeholder';
    canUsePrivateApi: boolean;
    code: ExchangeConnectionTestCode;
    appCode?: ExchangeConnectionAppCode;
    message: string;
    details?: Record<string, unknown>;
    checkedAt: string;
  };
  lastTestResult: ExchangeConnectionTestResult;
  operational: {
    connectionStatus: ExchangeConnectionStatus;
    lastSyncAt: string | null;
    lastErrorCode: ExchangeConnectionTestCode | null;
    lastErrorSummary: string | null;
    failureReason: string | null;
    isTestConnectionResult: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}) {
  return exchangeConnectionDtoSchema.parse({
    ...connection,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  });
}

export function serializeExchangeConnectionListResponse(items: ExchangeConnectionDto[]) {
  return exchangeConnectionListResponseDtoSchema.parse({
    items,
    total: items.length,
  });
}

export function serializeExchangeConnectionDeleteResponse(params: {
  exchange: z.infer<typeof exchangeIdSchema>;
  exchangeName: string;
  removedAt: Date;
}) {
  return exchangeConnectionDeleteResponseDtoSchema.parse({
    exchange: params.exchange,
    exchangeName: params.exchangeName,
    removedAt: params.removedAt.toISOString(),
  });
}
