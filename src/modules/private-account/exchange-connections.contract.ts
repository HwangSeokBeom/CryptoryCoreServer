import { z } from 'zod';

export const exchangeIdSchema = z.enum(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);
export type ExchangeId = z.infer<typeof exchangeIdSchema>;

export const exchangeCredentialFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  masked: z.boolean().default(true),
});

export const exchangeCapabilitySummarySchema = z.object({
  canTestConnection: z.boolean(),
  canReadPortfolio: z.boolean(),
  canPlaceOrder: z.boolean(),
  canCancelOrder: z.boolean(),
  canReadOpenOrders: z.boolean(),
  canReadFills: z.boolean(),
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
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  checkedAt: z.string().datetime(),
});

export const exchangeConnectionValidationDtoSchema = z.object({
  status: z.enum(['verified', 'invalid', 'placeholder']),
  mode: z.enum(['live_api', 'syntactic', 'placeholder']),
  canUsePrivateApi: z.boolean(),
  code: exchangeConnectionTestCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  checkedAt: z.string().datetime(),
});

export const exchangeConnectionOperationalDtoSchema = z.object({
  connectionStatus: z.enum(['pending', 'active', 'degraded', 'invalid']),
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
  label: z.string().nullable(),
  apiKeyMasked: z.string(),
  hasSecretKey: z.boolean(),
  hasPassphrase: z.boolean(),
  credentialFields: z.array(exchangeCredentialFieldSchema),
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

export const createExchangeConnectionRequestSchema = z.object({
  exchange: exchangeIdSchema,
  label: z.string().trim().min(1).max(50).optional(),
  apiKey: z.string().trim().min(3),
  secretKey: z.string().trim().min(3),
  passphrase: z.string().trim().min(1).optional(),
});

export const testExchangeConnectionRequestSchema = createExchangeConnectionRequestSchema;

export const updateExchangeConnectionRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(50).nullable().optional(),
    apiKey: z.string().trim().min(3).optional(),
    secretKey: z.string().trim().min(3).optional(),
    passphrase: z.string().trim().min(1).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one field must be provided',
  });

export type ExchangeCredentialField = z.infer<typeof exchangeCredentialFieldSchema>;
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
  label: string | null;
  apiKeyMasked: string;
  hasSecretKey: boolean;
  hasPassphrase: boolean;
  credentialFields: ExchangeCredentialField[];
  capabilities: ExchangeCapabilitySummary;
  validation: {
    status: 'verified' | 'invalid' | 'placeholder';
    mode: 'live_api' | 'syntactic' | 'placeholder';
    canUsePrivateApi: boolean;
    code: ExchangeConnectionTestCode;
    message: string;
    details?: Record<string, unknown>;
    checkedAt: string;
  };
  lastTestResult: ExchangeConnectionTestResult;
  operational: {
    connectionStatus: 'pending' | 'active' | 'degraded' | 'invalid';
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
