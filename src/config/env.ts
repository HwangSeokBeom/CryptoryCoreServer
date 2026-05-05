import 'dotenv/config';

import { z } from 'zod';

const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional());
const BOOLEAN_TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off', '']);
const booleanParseError = 'must be a boolean value: true/false, 1/0, yes/no, y/n, on/off';

function parseEnvBooleanValue(value: unknown, defaultValue?: boolean) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (BOOLEAN_TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE_VALUES.has(normalized)) {
    return false;
  }
  return value;
}

const envBoolean = (defaultValue: boolean) => z.preprocess(
  (value) => parseEnvBooleanValue(value, defaultValue),
  z.boolean({ invalid_type_error: booleanParseError }).default(defaultValue),
);

const optionalEnvBoolean = () => z.preprocess(
  (value) => parseEnvBooleanValue(value),
  z.boolean({ invalid_type_error: booleanParseError }).optional(),
);

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(10).optional(),
  JWT_ACCESS_SECRET: z.string().min(10).optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_WEB_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_IDS: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_IDS: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  APP_HOMEPAGE_URL: optionalUrl,
  TERMS_URL: optionalUrl,
  PRIVACY_POLICY_URL: optionalUrl,
  SUPPORT_URL: optionalUrl,
  ACCOUNT_DELETION_URL: optionalUrl,
  INVESTMENT_DISCLAIMER_URL: optionalUrl,
  COMMUNITY_POLICY_URL: optionalUrl,
  PORT: z.coerce.number().default(3000),
  PUBLIC_MARKET_API_PORT: z.coerce.number().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  USE_LIVE_DATA: envBoolean(false),
  PUBLIC_STREAMING_ENABLED: envBoolean(true),
  PRIVATE_STREAMING_ENABLED: envBoolean(true),
  ENABLE_PRIVATE_WS: optionalEnvBoolean(),
  ENABLE_POLLING_FALLBACK: envBoolean(true),
  USD_KRW_FALLBACK: z.coerce.number().default(1350),
  FX_BASE_URL: z.string().url().default('https://api.exchangerate.host'),
  FX_STALE_THRESHOLD_MS: z.coerce.number().default(300000),
  MARKET_DATA_STALE_THRESHOLD_MS: z.coerce.number().default(300000),
  FX_TIMESTAMP_SKEW_THRESHOLD_MS: z.coerce.number().default(30000),
  COINGECKO_API_BASE_URL: z.string().url().default('https://api.coingecko.com/api/v3'),
  COINGECKO_API_KEY: z.string().optional(),
  COINMARKETCAP_API_BASE_URL: z.string().url().default('https://pro-api.coinmarketcap.com'),
  NEWS_PROVIDER: z.enum(['cryptopanic', 'cryptocurrency_cv', 'newsapi']).default('cryptopanic'),
  CRYPTOPANIC_API_KEY: z.string().optional(),
  CRYPTOPANIC_API_BASE_URL: z.string().url().default('https://cryptopanic.com/api/v1'),
  CRYPTOCURRENCY_CV_API_BASE_URL: z.string().url().default('https://cryptocurrency.cv/api'),
  CRYPTOCURRENCY_CV_API_KEY: z.string().optional(),
  NEWSAPI_API_KEY: z.string().optional(),
  NEWSAPI_API_BASE_URL: z.string().url().default('https://newsapi.org/v2'),
  NEWS_RSS_FEEDS: z.string().optional(),
  NEWS_CACHE_TTL_SECONDS: z.coerce.number().default(900),
  MARKET_DATA_CACHE_TTL_SECONDS: z.coerce.number().default(1800),
  MARKET_DATA_PROVIDER: z.enum(['upbit', 'bithumb', 'mixed']).default('mixed'),
  CANDLE_CACHE_TTL_SECONDS: z.coerce.number().default(30),
  TICKER_CACHE_TTL_SECONDS: z.coerce.number().default(5),
  MARKET_COLLECTOR_ENABLED: envBoolean(false),
  MARKET_TRADE_COLLECTOR_ENABLED: envBoolean(false),
  MARKET_TREND_SNAPSHOT_ENABLED: envBoolean(false),
  MARKET_STARTUP_WARMUP_ENABLED: envBoolean(false),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FCM_ENABLED: envBoolean(false),
  FCM_DRY_RUN: envBoolean(false),
  PRICE_ALERT_WORKER_ENABLED: envBoolean(false),
  PRICE_ALERT_POLL_INTERVAL_MS: z.coerce.number().default(10000),
  PRICE_ALERT_REPEAT_COOLDOWN_SECONDS: z.coerce.number().default(600),
  SERVICE_TIMEZONE: z.string().default('Asia/Seoul'),
  DEFAULT_MARKET_CURRENCY: z.string().default('KRW'),
  TRANSLATION_PROVIDER: z.enum(['openai', 'papago', 'google']).optional(),
  TRANSLATION_API_BASE_URL: z.string().url().optional(),
  TRANSLATION_MODEL: z.string().default('gpt-4o-mini'),
  TRANSLATION_MAX_TEXT_LENGTH: z.coerce.number().default(4000),
  TRANSLATION_CACHE_TTL_SECONDS: z.coerce.number().default(2592000),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().default(8000),
  OPENAI_API_KEY: z.string().optional(),
  PAPAGO_CLIENT_ID: z.string().optional(),
  PAPAGO_CLIENT_SECRET: z.string().optional(),
  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),
  COINMARKETCAP_API_KEY: z.string().optional(),
  COINMARKETCAP_TIMEOUT_MS: z.coerce.number().default(5000),
  USDT_RATE_CACHE_TTL_SECONDS: z.coerce.number().default(300),
  USDT_COINMARKETCAP_ID: z.coerce.number().default(825),
  CRYPTOCOMPARE_API_KEY: z.string().optional(),
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
  APP_STORE_REVIEW_MODE: envBoolean(false),
  FEATURE_ORDER_ENABLED: optionalEnvBoolean(),
  FEATURE_TRADING_ENABLED: optionalEnvBoolean(),
  FEATURE_TRANSFER_ENABLED: optionalEnvBoolean(),
  FEATURE_DEPOSIT_WITHDRAW_ENABLED: optionalEnvBoolean(),
  FEATURE_WALLET_ENABLED: optionalEnvBoolean(),
  FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED: optionalEnvBoolean(),
  FEATURE_MARKET_ENABLED: optionalEnvBoolean(),
  FEATURE_CHART_ENABLED: optionalEnvBoolean(),
  FEATURE_NEWS_ENABLED: optionalEnvBoolean(),
  FEATURE_READ_ONLY_PORTFOLIO_ENABLED: optionalEnvBoolean(),
  FEATURE_KIMCHI_PREMIUM_ENABLED: optionalEnvBoolean(),
  FEATURE_COMMUNITY_CONTENT_ENABLED: optionalEnvBoolean(),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') {
    return;
  }

  if (!value.GOOGLE_IOS_CLIENT_ID && !value.GOOGLE_CLIENT_IDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GOOGLE_IOS_CLIENT_ID'],
      message: 'GOOGLE_IOS_CLIENT_ID is required in production for Google iOS social login',
    });
  }

  if (!value.APPLE_CLIENT_ID && !value.APPLE_CLIENT_IDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APPLE_CLIENT_ID'],
      message: 'APPLE_CLIENT_ID is required in production for Sign in with Apple',
    });
  }

  if (value.NEWS_PROVIDER === 'newsapi' && value.FEATURE_NEWS_ENABLED === true && !value.NEWSAPI_API_KEY?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NEWSAPI_API_KEY'],
      message: 'NEWSAPI_API_KEY is required in production when NEWS_PROVIDER=newsapi and FEATURE_NEWS_ENABLED=true',
    });
  }

  for (const key of [
    'APP_HOMEPAGE_URL',
    'TERMS_URL',
    'PRIVACY_POLICY_URL',
    'SUPPORT_URL',
    'ACCOUNT_DELETION_URL',
    'INVESTMENT_DISCLAIMER_URL',
    'COMMUNITY_POLICY_URL',
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
  GOOGLE_IOS_CLIENT_ID?: string;
  GOOGLE_WEB_CLIENT_ID?: string;
  GOOGLE_CLIENT_IDS: string[];
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_IDS: string[];
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  APP_HOMEPAGE_URL?: string;
  TERMS_URL?: string;
  PRIVACY_POLICY_URL?: string;
  SUPPORT_URL?: string;
  ACCOUNT_DELETION_URL?: string;
  INVESTMENT_DISCLAIMER_URL?: string;
  COMMUNITY_POLICY_URL?: string;
  PORT: number;
  PUBLIC_MARKET_API_PORT?: number;
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
  COINMARKETCAP_API_BASE_URL: string;
  NEWS_PROVIDER: 'cryptopanic' | 'cryptocurrency_cv' | 'newsapi';
  CRYPTOPANIC_API_KEY?: string;
  CRYPTOPANIC_API_BASE_URL: string;
  CRYPTOCURRENCY_CV_API_BASE_URL: string;
  CRYPTOCURRENCY_CV_API_KEY?: string;
  NEWSAPI_API_KEY?: string;
  NEWSAPI_API_BASE_URL: string;
  NEWS_RSS_FEEDS?: string;
  NEWS_CACHE_TTL_SECONDS: number;
  MARKET_DATA_CACHE_TTL_SECONDS: number;
  MARKET_DATA_PROVIDER: 'upbit' | 'bithumb' | 'mixed';
  CANDLE_CACHE_TTL_SECONDS: number;
  TICKER_CACHE_TTL_SECONDS: number;
  MARKET_COLLECTOR_ENABLED: boolean;
  MARKET_TRADE_COLLECTOR_ENABLED: boolean;
  MARKET_TREND_SNAPSHOT_ENABLED: boolean;
  MARKET_STARTUP_WARMUP_ENABLED: boolean;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  FCM_ENABLED: boolean;
  FCM_DRY_RUN: boolean;
  PRICE_ALERT_WORKER_ENABLED: boolean;
  PRICE_ALERT_POLL_INTERVAL_MS: number;
  PRICE_ALERT_REPEAT_COOLDOWN_SECONDS: number;
  SERVICE_TIMEZONE: string;
  DEFAULT_MARKET_CURRENCY: string;
  TRANSLATION_PROVIDER?: 'openai' | 'papago' | 'google';
  TRANSLATION_API_BASE_URL?: string;
  TRANSLATION_MODEL: string;
  TRANSLATION_MAX_TEXT_LENGTH: number;
  TRANSLATION_CACHE_TTL_SECONDS: number;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS: number;
  OPENAI_API_KEY?: string;
  PAPAGO_CLIENT_ID?: string;
  PAPAGO_CLIENT_SECRET?: string;
  GOOGLE_TRANSLATE_API_KEY?: string;
  COINMARKETCAP_API_KEY?: string;
  COINMARKETCAP_TIMEOUT_MS: number;
  USDT_RATE_CACHE_TTL_SECONDS: number;
  USDT_COINMARKETCAP_ID: number;
  CRYPTOCOMPARE_API_KEY?: string;
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
  APP_STORE_REVIEW_MODE: boolean;
  FEATURE_ORDER_ENABLED?: boolean;
  FEATURE_TRADING_ENABLED?: boolean;
  FEATURE_TRANSFER_ENABLED?: boolean;
  FEATURE_DEPOSIT_WITHDRAW_ENABLED?: boolean;
  FEATURE_WALLET_ENABLED?: boolean;
  FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED?: boolean;
  FEATURE_MARKET_ENABLED?: boolean;
  FEATURE_CHART_ENABLED?: boolean;
  FEATURE_NEWS_ENABLED?: boolean;
  FEATURE_READ_ONLY_PORTFOLIO_ENABLED?: boolean;
  FEATURE_KIMCHI_PREMIUM_ENABLED?: boolean;
  FEATURE_COMMUNITY_CONTENT_ENABLED?: boolean;
}

function parseCsvList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendUnique(values: string[], value?: string) {
  const normalized = value?.trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
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

  const googleClientIds = parseCsvList(parsed.data.GOOGLE_CLIENT_IDS ?? '');
  appendUnique(googleClientIds, parsed.data.GOOGLE_IOS_CLIENT_ID);
  appendUnique(googleClientIds, parsed.data.GOOGLE_WEB_CLIENT_ID);

  const appleClientIds = parseCsvList(parsed.data.APPLE_CLIENT_IDS ?? '');
  appendUnique(appleClientIds, parsed.data.APPLE_CLIENT_ID);

  return {
    DATABASE_URL: parsed.data.DATABASE_URL,
    REDIS_URL: parsed.data.REDIS_URL,
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: parsed.data.JWT_EXPIRES_IN,
    JWT_ACCESS_EXPIRES_IN: parsed.data.JWT_ACCESS_EXPIRES_IN ?? parsed.data.JWT_EXPIRES_IN,
    JWT_REFRESH_EXPIRES_IN: parsed.data.JWT_REFRESH_EXPIRES_IN,
    GOOGLE_IOS_CLIENT_ID: parsed.data.GOOGLE_IOS_CLIENT_ID,
    GOOGLE_WEB_CLIENT_ID: parsed.data.GOOGLE_WEB_CLIENT_ID,
    GOOGLE_CLIENT_IDS: googleClientIds,
    APPLE_CLIENT_ID: parsed.data.APPLE_CLIENT_ID,
    APPLE_CLIENT_IDS: appleClientIds,
    APPLE_TEAM_ID: parsed.data.APPLE_TEAM_ID,
    APPLE_KEY_ID: parsed.data.APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: parsed.data.APPLE_PRIVATE_KEY,
    APP_HOMEPAGE_URL: parsed.data.APP_HOMEPAGE_URL,
    TERMS_URL: parsed.data.TERMS_URL,
    PRIVACY_POLICY_URL: parsed.data.PRIVACY_POLICY_URL,
    SUPPORT_URL: parsed.data.SUPPORT_URL,
    ACCOUNT_DELETION_URL: parsed.data.ACCOUNT_DELETION_URL,
    INVESTMENT_DISCLAIMER_URL: parsed.data.INVESTMENT_DISCLAIMER_URL,
    COMMUNITY_POLICY_URL: parsed.data.COMMUNITY_POLICY_URL,
    PORT: parsed.data.PUBLIC_MARKET_API_PORT ?? parsed.data.PORT,
    PUBLIC_MARKET_API_PORT: parsed.data.PUBLIC_MARKET_API_PORT,
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
    COINMARKETCAP_API_BASE_URL: parsed.data.COINMARKETCAP_API_BASE_URL,
    NEWS_PROVIDER: parsed.data.NEWS_PROVIDER,
    CRYPTOPANIC_API_KEY: parsed.data.CRYPTOPANIC_API_KEY,
    CRYPTOPANIC_API_BASE_URL: parsed.data.CRYPTOPANIC_API_BASE_URL,
    CRYPTOCURRENCY_CV_API_BASE_URL: parsed.data.CRYPTOCURRENCY_CV_API_BASE_URL,
    CRYPTOCURRENCY_CV_API_KEY: parsed.data.CRYPTOCURRENCY_CV_API_KEY,
    NEWSAPI_API_KEY: parsed.data.NEWSAPI_API_KEY,
    NEWSAPI_API_BASE_URL: parsed.data.NEWSAPI_API_BASE_URL,
    NEWS_RSS_FEEDS: parsed.data.NEWS_RSS_FEEDS,
    NEWS_CACHE_TTL_SECONDS: parsed.data.NEWS_CACHE_TTL_SECONDS,
    MARKET_DATA_CACHE_TTL_SECONDS: parsed.data.MARKET_DATA_CACHE_TTL_SECONDS,
    MARKET_DATA_PROVIDER: parsed.data.MARKET_DATA_PROVIDER,
    CANDLE_CACHE_TTL_SECONDS: parsed.data.CANDLE_CACHE_TTL_SECONDS,
    TICKER_CACHE_TTL_SECONDS: parsed.data.TICKER_CACHE_TTL_SECONDS,
    MARKET_COLLECTOR_ENABLED: parsed.data.MARKET_COLLECTOR_ENABLED,
    MARKET_TRADE_COLLECTOR_ENABLED: parsed.data.MARKET_TRADE_COLLECTOR_ENABLED,
    MARKET_TREND_SNAPSHOT_ENABLED: parsed.data.MARKET_TREND_SNAPSHOT_ENABLED,
    MARKET_STARTUP_WARMUP_ENABLED: parsed.data.MARKET_STARTUP_WARMUP_ENABLED,
    FIREBASE_PROJECT_ID: parsed.data.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: parsed.data.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: parsed.data.FIREBASE_PRIVATE_KEY,
    FCM_ENABLED: parsed.data.FCM_ENABLED,
    FCM_DRY_RUN: parsed.data.FCM_DRY_RUN,
    PRICE_ALERT_WORKER_ENABLED: parsed.data.PRICE_ALERT_WORKER_ENABLED,
    PRICE_ALERT_POLL_INTERVAL_MS: parsed.data.PRICE_ALERT_POLL_INTERVAL_MS,
    PRICE_ALERT_REPEAT_COOLDOWN_SECONDS: parsed.data.PRICE_ALERT_REPEAT_COOLDOWN_SECONDS,
    SERVICE_TIMEZONE: parsed.data.SERVICE_TIMEZONE,
    DEFAULT_MARKET_CURRENCY: parsed.data.DEFAULT_MARKET_CURRENCY,
    TRANSLATION_PROVIDER: parsed.data.TRANSLATION_PROVIDER,
    TRANSLATION_API_BASE_URL: parsed.data.TRANSLATION_API_BASE_URL,
    TRANSLATION_MODEL: parsed.data.LLM_MODEL ?? parsed.data.TRANSLATION_MODEL,
    TRANSLATION_MAX_TEXT_LENGTH: parsed.data.TRANSLATION_MAX_TEXT_LENGTH,
    TRANSLATION_CACHE_TTL_SECONDS: parsed.data.TRANSLATION_CACHE_TTL_SECONDS,
    LLM_API_KEY: parsed.data.LLM_API_KEY,
    LLM_MODEL: parsed.data.LLM_MODEL,
    LLM_TIMEOUT_MS: parsed.data.LLM_TIMEOUT_MS,
    OPENAI_API_KEY: parsed.data.OPENAI_API_KEY ?? parsed.data.LLM_API_KEY,
    PAPAGO_CLIENT_ID: parsed.data.PAPAGO_CLIENT_ID,
    PAPAGO_CLIENT_SECRET: parsed.data.PAPAGO_CLIENT_SECRET,
    GOOGLE_TRANSLATE_API_KEY: parsed.data.GOOGLE_TRANSLATE_API_KEY,
    COINMARKETCAP_API_KEY: parsed.data.COINMARKETCAP_API_KEY,
    COINMARKETCAP_TIMEOUT_MS: parsed.data.COINMARKETCAP_TIMEOUT_MS,
    USDT_RATE_CACHE_TTL_SECONDS: parsed.data.USDT_RATE_CACHE_TTL_SECONDS,
    USDT_COINMARKETCAP_ID: parsed.data.USDT_COINMARKETCAP_ID,
    CRYPTOCOMPARE_API_KEY: parsed.data.CRYPTOCOMPARE_API_KEY,
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
    APP_STORE_REVIEW_MODE: parsed.data.APP_STORE_REVIEW_MODE,
    FEATURE_ORDER_ENABLED: parsed.data.FEATURE_ORDER_ENABLED,
    FEATURE_TRADING_ENABLED: parsed.data.FEATURE_TRADING_ENABLED,
    FEATURE_TRANSFER_ENABLED: parsed.data.FEATURE_TRANSFER_ENABLED,
    FEATURE_DEPOSIT_WITHDRAW_ENABLED: parsed.data.FEATURE_DEPOSIT_WITHDRAW_ENABLED,
    FEATURE_WALLET_ENABLED: parsed.data.FEATURE_WALLET_ENABLED,
    FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED: parsed.data.FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED,
    FEATURE_MARKET_ENABLED: parsed.data.FEATURE_MARKET_ENABLED,
    FEATURE_CHART_ENABLED: parsed.data.FEATURE_CHART_ENABLED,
    FEATURE_NEWS_ENABLED: parsed.data.FEATURE_NEWS_ENABLED,
    FEATURE_READ_ONLY_PORTFOLIO_ENABLED: parsed.data.FEATURE_READ_ONLY_PORTFOLIO_ENABLED,
    FEATURE_KIMCHI_PREMIUM_ENABLED: parsed.data.FEATURE_KIMCHI_PREMIUM_ENABLED,
    FEATURE_COMMUNITY_CONTENT_ENABLED: parsed.data.FEATURE_COMMUNITY_CONTENT_ENABLED,
  };
}

export const env = loadEnv();
