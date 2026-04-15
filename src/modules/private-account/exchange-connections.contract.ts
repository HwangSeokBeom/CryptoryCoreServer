import { z } from 'zod';

export const exchangeIdSchema = z.enum(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);
export type ExchangeId = z.infer<typeof exchangeIdSchema>;

export const exchangeConnectionValidationDtoSchema = z.object({
  status: z.enum(['verified', 'invalid', 'placeholder']),
  mode: z.enum(['live_api', 'syntactic', 'placeholder']),
  canUsePrivateApi: z.boolean(),
  message: z.string(),
  checkedAt: z.string().datetime(),
});

export const exchangeConnectionDtoSchema = z.object({
  id: z.string(),
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  label: z.string().nullable(),
  apiKeyMasked: z.string(),
  hasSecretKey: z.boolean(),
  hasPassphrase: z.boolean(),
  validation: exchangeConnectionValidationDtoSchema,
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

export type ExchangeConnectionDto = z.infer<typeof exchangeConnectionDtoSchema>;
export type ExchangeConnectionListResponseDto = z.infer<typeof exchangeConnectionListResponseDtoSchema>;
export type ExchangeConnectionDeleteResponseDto = z.infer<typeof exchangeConnectionDeleteResponseDtoSchema>;
export type CreateExchangeConnectionRequest = z.infer<typeof createExchangeConnectionRequestSchema>;
export type UpdateExchangeConnectionRequest = z.infer<typeof updateExchangeConnectionRequestSchema>;

export function serializeExchangeConnectionDto(connection: {
  id: string;
  exchange: z.infer<typeof exchangeIdSchema>;
  exchangeName: string;
  label: string | null;
  apiKeyMasked: string;
  hasSecretKey: boolean;
  hasPassphrase: boolean;
  validation: {
    status: 'verified' | 'invalid' | 'placeholder';
    mode: 'live_api' | 'syntactic' | 'placeholder';
    canUsePrivateApi: boolean;
    message: string;
    checkedAt: string;
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
