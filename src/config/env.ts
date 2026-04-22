import 'dotenv/config';

import { z } from 'zod';

const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional());

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(10).optional(),
  JWT_ACCESS_SECRET: z.string().min(10).optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  GOOGLE_CLIENT_IDS: z.string().default('142113558371-t5s22ri6gjl5aur76s81910gf2hb8p09.apps.googleusercontent.com'),
  APPLE_CLIENT_IDS: z.string().default('com.hwb.Cryptory'),
  APP_HOMEPAGE_URL: optionalUrl,
  TERMS_URL: optionalUrl,
  PRIVACY_POLICY_URL: optionalUrl,
  SUPPORT_URL: optionalUrl,
  ACCOUNT_DELETION_URL: optionalUrl,
  INVESTMENT_DISCLAIMER_URL: optionalUrl,
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  USE_LIVE_DATA: z.coerce.boolean().default(false),
  PUBLIC_STREAMING_ENABLED: z.coerce.boolean().default(true),
  PRIVATE_STREAMING_ENABLED: z.coerce.boolean().default(true),
  ENABLE_PRIVATE_WS: z.coerce.boolean().optional(),
  ENABLE_POLLING_FALLBACK: z.coerce.boolean().default(true),
  USD_KRW_FALLBACK: z.coerce.number().default(1350),
  FX_BASE_URL: z.string().url().default('https://api.exchangerate.host'),
  FX_STALE_THRESHOLD_MS: z.coerce.number().default(300000),
  MARKET_DATA_STALE_THRESHOLD_MS: z.coerce.number().default(300000),
  FX_TIMESTAMP_SKEW_THRESHOLD_MS: z.coerce.number().default(30000),
  COINGECKO_API_BASE_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  COINGECKO_API_KEY: z.string().optional(),
  EXCHANGE_RATE_API_KEY: z.string().optional(),
  EXCHANGE_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  EXCHANGE_CONNECTION_ENCRYPTION_KEY: z.string().optional(),
  UPBIT_ACCESS_KEY: z.string().optional(),
  UPBIT_SECRET_KEY: z.string().optional(),
  BITHUMB_API_KEY: z.string().optional(),
  BITHUMB_SECRET_KEY: z.string().optional(),
  COINONE_ACCESS_TOKEN: z.string().optional(),
  COINONE_SECRET_KEY: z.string().optional(),
  KORBIT_API_KEY: z.string().optional(),
  KORBIT_SECRET_KEY: z.string().optional(),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_SECRET_KEY: z.string().optional(),
  UPBIT_API_BASE_URL: z.string().url().optional(),
  UPBIT_REST_BASE_URL: z.string().url().optional(),
  UPBIT_WS_URL: z.string().url().optional(),
  UPBIT_PUBLIC_WS_URL: z.string().url().optional(),
  UPBIT_PRIVATE_WS_URL: z.string().url().optional(),
  BITHUMB_API_BASE_URL: z.string().url().optional(),
  BITHUMB_REST_BASE_URL: z.string().url().optional(),
  BITHUMB_WS_URL: z.string().url().optional(),
  BITHUMB_PUBLIC_WS_URL: z.string().url().optional(),
  BITHUMB_PRIVATE_WS_URL: z.string().url().optional(),
  COINONE_API_BASE_URL: z.string().url().optional(),
  COINONE_REST_BASE_URL: z.string().url().optional(),
  COINONE_WS_URL: z.string().url().optional(),
  COINONE_PUBLIC_WS_URL: z.string().url().optional(),
  COINONE_PRIVATE_WS_URL: z.string().url().optional(),
  KORBIT_API_BASE_URL: z.string().url().optional(),
  KORBIT_REST_BASE_URL: z.string().url().optional(),
  KORBIT_WS_URL: z.string().url().optional(),
  KORBIT_PUBLIC_WS_URL: z.string().url().optional(),
  KORBIT_PRIVATE_WS_URL: z.string().url().optional(),
  BINANCE_PUBLIC_API_BASE_URL: z.string().url().optional(),
  BINANCE_PRIVATE_API_BASE_URL: z.string().url().optional(),
  BINANCE_WS_BASE_URL: z.string().url().optional(),
  BINANCE_API_BASE_URL: z.string().url().optional(),
  BINANCE_REST_BASE_URL: z.string().url().optional(),
  BINANCE_WS_URL: z.string().url().optional(),
  BINANCE_PUBLIC_WS_URL: z.string().url().optional(),
  BINANCE_PRIVATE_WS_URL: z.string().url().optional(),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') {
    return;
  }

  for (const key of [
    'APP_HOMEPAGE_URL',
    'TERMS_URL',
    'PRIVACY_POLICY_URL',
    'SUPPORT_URL',
    'ACCOUNT_DELETION_URL',
    'INVESTMENT_DISCLAIMER_URL',
  ] as const) {
    if (!value[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required in production for app review readiness`,
      });
    }
  }
});

export interface Env {
  DATABASE_URL: string;
  REDIS_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  JWT_ACCESS_EXPIRES_IN: string;
  JWT_REFRESH_EXPIRES_IN: string;
  GOOGLE_CLIENT_IDS: string[];
  APPLE_CLIENT_IDS: string[];
  APP_HOMEPAGE_URL?: string;
  TERMS_URL?: string;
  PRIVACY_POLICY_URL?: string;
  SUPPORT_URL?: string;
  ACCOUNT_DELETION_URL?: string;
  INVESTMENT_DISCLAIMER_URL?: string;
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  USE_LIVE_DATA: boolean;
  PUBLIC_STREAMING_ENABLED: boolean;
  PRIVATE_STREAMING_ENABLED: boolean;
  ENABLE_PRIVATE_WS: boolean;
  ENABLE_POLLING_FALLBACK: boolean;
  USD_KRW_FALLBACK: number;
  FX_BASE_URL: string;
  FX_STALE_THRESHOLD_MS: number;
  MARKET_DATA_STALE_THRESHOLD_MS: number;
  FX_TIMESTAMP_SKEW_THRESHOLD_MS: number;
  COINGECKO_API_BASE_URL: string;
  COINGECKO_API_KEY?: string;
  EXCHANGE_RATE_API_KEY?: string;
  EXCHANGE_CREDENTIAL_ENCRYPTION_KEY?: string;
  EXCHANGE_CONNECTION_ENCRYPTION_KEY?: string;
  UPBIT_ACCESS_KEY?: string;
  UPBIT_SECRET_KEY?: string;
  BITHUMB_API_KEY?: string;
  BITHUMB_SECRET_KEY?: string;
  COINONE_ACCESS_TOKEN?: string;
  COINONE_SECRET_KEY?: string;
  KORBIT_API_KEY?: string;
  KORBIT_SECRET_KEY?: string;
  BINANCE_API_KEY?: string;
  BINANCE_SECRET_KEY?: string;
  UPBIT_API_BASE_URL?: string;
  UPBIT_REST_BASE_URL?: string;
  UPBIT_WS_URL?: string;
  UPBIT_PUBLIC_WS_URL?: string;
  UPBIT_PRIVATE_WS_URL?: string;
  BITHUMB_API_BASE_URL?: string;
  BITHUMB_REST_BASE_URL?: string;
  BITHUMB_WS_URL?: string;
  BITHUMB_PUBLIC_WS_URL?: string;
  BITHUMB_PRIVATE_WS_URL?: string;
  COINONE_API_BASE_URL?: string;
  COINONE_REST_BASE_URL?: string;
  COINONE_WS_URL?: string;
  COINONE_PUBLIC_WS_URL?: string;
  COINONE_PRIVATE_WS_URL?: string;
  KORBIT_API_BASE_URL?: string;
  KORBIT_REST_BASE_URL?: string;
  KORBIT_WS_URL?: string;
  KORBIT_PUBLIC_WS_URL?: string;
  KORBIT_PRIVATE_WS_URL?: string;
  BINANCE_PUBLIC_API_BASE_URL?: string;
  BINANCE_PRIVATE_API_BASE_URL?: string;
  BINANCE_WS_BASE_URL?: string;
  BINANCE_API_BASE_URL?: string;
  BINANCE_REST_BASE_URL?: string;
  BINANCE_WS_URL?: string;
  BINANCE_PUBLIC_WS_URL?: string;
  BINANCE_PRIVATE_WS_URL?: string;
}

function parseCsvList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const jwtSecret = parsed.data.JWT_SECRET ?? parsed.data.JWT_ACCESS_SECRET;
  if (!jwtSecret) {
    console.error('Invalid environment variables: JWT_SECRET or JWT_ACCESS_SECRET is required');
    process.exit(1);
  }

  return {
    DATABASE_URL: parsed.data.DATABASE_URL,
    REDIS_URL: parsed.data.REDIS_URL,
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: parsed.data.JWT_EXPIRES_IN,
    JWT_ACCESS_EXPIRES_IN: parsed.data.JWT_ACCESS_EXPIRES_IN ?? parsed.data.JWT_EXPIRES_IN,
    JWT_REFRESH_EXPIRES_IN: parsed.data.JWT_REFRESH_EXPIRES_IN,
    GOOGLE_CLIENT_IDS: parseCsvList(parsed.data.GOOGLE_CLIENT_IDS),
    APPLE_CLIENT_IDS: parseCsvList(parsed.data.APPLE_CLIENT_IDS),
    APP_HOMEPAGE_URL: parsed.data.APP_HOMEPAGE_URL,
    TERMS_URL: parsed.data.TERMS_URL,
    PRIVACY_POLICY_URL: parsed.data.PRIVACY_POLICY_URL,
    SUPPORT_URL: parsed.data.SUPPORT_URL,
    ACCOUNT_DELETION_URL: parsed.data.ACCOUNT_DELETION_URL,
    INVESTMENT_DISCLAIMER_URL: parsed.data.INVESTMENT_DISCLAIMER_URL,
    PORT: parsed.data.PORT,
    NODE_ENV: parsed.data.NODE_ENV,
    USE_LIVE_DATA: parsed.data.USE_LIVE_DATA,
    PUBLIC_STREAMING_ENABLED: parsed.data.PUBLIC_STREAMING_ENABLED,
    PRIVATE_STREAMING_ENABLED: parsed.data.ENABLE_PRIVATE_WS ?? parsed.data.PRIVATE_STREAMING_ENABLED,
    ENABLE_PRIVATE_WS: parsed.data.ENABLE_PRIVATE_WS ?? parsed.data.PRIVATE_STREAMING_ENABLED,
    ENABLE_POLLING_FALLBACK: parsed.data.ENABLE_POLLING_FALLBACK,
    USD_KRW_FALLBACK: parsed.data.USD_KRW_FALLBACK,
    FX_BASE_URL: parsed.data.FX_BASE_URL,
    FX_STALE_THRESHOLD_MS: parsed.data.FX_STALE_THRESHOLD_MS,
    MARKET_DATA_STALE_THRESHOLD_MS: parsed.data.MARKET_DATA_STALE_THRESHOLD_MS,
    FX_TIMESTAMP_SKEW_THRESHOLD_MS: parsed.data.FX_TIMESTAMP_SKEW_THRESHOLD_MS,
    COINGECKO_API_BASE_URL: parsed.data.COINGECKO_API_BASE_URL,
    COINGECKO_API_KEY: parsed.data.COINGECKO_API_KEY,
    EXCHANGE_RATE_API_KEY: parsed.data.EXCHANGE_RATE_API_KEY,
    EXCHANGE_CREDENTIAL_ENCRYPTION_KEY:
      parsed.data.EXCHANGE_CREDENTIAL_ENCRYPTION_KEY ?? parsed.data.EXCHANGE_CONNECTION_ENCRYPTION_KEY,
    EXCHANGE_CONNECTION_ENCRYPTION_KEY: parsed.data.EXCHANGE_CONNECTION_ENCRYPTION_KEY,
    UPBIT_ACCESS_KEY: parsed.data.UPBIT_ACCESS_KEY,
    UPBIT_SECRET_KEY: parsed.data.UPBIT_SECRET_KEY,
    BITHUMB_API_KEY: parsed.data.BITHUMB_API_KEY,
    BITHUMB_SECRET_KEY: parsed.data.BITHUMB_SECRET_KEY,
    COINONE_ACCESS_TOKEN: parsed.data.COINONE_ACCESS_TOKEN,
    COINONE_SECRET_KEY: parsed.data.COINONE_SECRET_KEY,
    KORBIT_API_KEY: parsed.data.KORBIT_API_KEY,
    KORBIT_SECRET_KEY: parsed.data.KORBIT_SECRET_KEY,
    BINANCE_API_KEY: parsed.data.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: parsed.data.BINANCE_SECRET_KEY,
    UPBIT_API_BASE_URL: parsed.data.UPBIT_API_BASE_URL,
    UPBIT_REST_BASE_URL: parsed.data.UPBIT_REST_BASE_URL,
    UPBIT_WS_URL: parsed.data.UPBIT_WS_URL,
    UPBIT_PUBLIC_WS_URL: parsed.data.UPBIT_PUBLIC_WS_URL,
    UPBIT_PRIVATE_WS_URL: parsed.data.UPBIT_PRIVATE_WS_URL,
    BITHUMB_API_BASE_URL: parsed.data.BITHUMB_API_BASE_URL,
    BITHUMB_REST_BASE_URL: parsed.data.BITHUMB_REST_BASE_URL,
    BITHUMB_WS_URL: parsed.data.BITHUMB_WS_URL,
    BITHUMB_PUBLIC_WS_URL: parsed.data.BITHUMB_PUBLIC_WS_URL,
    BITHUMB_PRIVATE_WS_URL: parsed.data.BITHUMB_PRIVATE_WS_URL,
    COINONE_API_BASE_URL: parsed.data.COINONE_API_BASE_URL,
    COINONE_REST_BASE_URL: parsed.data.COINONE_REST_BASE_URL,
    COINONE_WS_URL: parsed.data.COINONE_WS_URL,
    COINONE_PUBLIC_WS_URL: parsed.data.COINONE_PUBLIC_WS_URL,
    COINONE_PRIVATE_WS_URL: parsed.data.COINONE_PRIVATE_WS_URL,
    KORBIT_API_BASE_URL: parsed.data.KORBIT_API_BASE_URL,
    KORBIT_REST_BASE_URL: parsed.data.KORBIT_REST_BASE_URL,
    KORBIT_WS_URL: parsed.data.KORBIT_WS_URL,
    KORBIT_PUBLIC_WS_URL: parsed.data.KORBIT_PUBLIC_WS_URL,
    KORBIT_PRIVATE_WS_URL: parsed.data.KORBIT_PRIVATE_WS_URL,
    BINANCE_PUBLIC_API_BASE_URL: parsed.data.BINANCE_PUBLIC_API_BASE_URL,
    BINANCE_PRIVATE_API_BASE_URL: parsed.data.BINANCE_PRIVATE_API_BASE_URL,
    BINANCE_WS_BASE_URL: parsed.data.BINANCE_WS_BASE_URL,
    BINANCE_API_BASE_URL: parsed.data.BINANCE_API_BASE_URL,
    BINANCE_REST_BASE_URL: parsed.data.BINANCE_REST_BASE_URL,
    BINANCE_WS_URL: parsed.data.BINANCE_WS_URL,
    BINANCE_PUBLIC_WS_URL: parsed.data.BINANCE_PUBLIC_WS_URL,
    BINANCE_PRIVATE_WS_URL: parsed.data.BINANCE_PRIVATE_WS_URL,
  };
}

export const env = loadEnv();
