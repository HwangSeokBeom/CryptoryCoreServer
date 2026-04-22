export type ExchangeConnectionValidationStatus = 'verified' | 'invalid' | 'placeholder';
export type ExchangeConnectionValidationMode = 'live_api' | 'syntactic' | 'placeholder';
export type ExchangeConnectionValidationCode =
  | 'verified'
  | 'invalid_credentials'
  | 'insufficient_permissions'
  | 'ip_not_whitelisted'
  | 'signature_error'
  | 'timeout'
  | 'rate_limited'
  | 'exchange_unavailable'
  | 'unsupported_exchange'
  | 'unknown_error';

export interface ExchangeConnectionCredentials {
  exchange: string;
  apiKey: string;
  secretKey: string;
  passphrase?: string | null;
  permission?: 'read_only' | 'trade_enabled';
}

export interface ExchangeConnectionValidationResult {
  status: ExchangeConnectionValidationStatus;
  mode: ExchangeConnectionValidationMode;
  code: ExchangeConnectionValidationCode;
  canUsePrivateApi: boolean;
  message: string;
  details?: Record<string, unknown>;
  checkedAt: string;
}

export interface ExchangeConnectionValidator {
  readonly exchange: string;
  validate(credentials: ExchangeConnectionCredentials): Promise<ExchangeConnectionValidationResult>;
}

export interface PrivateAccountDataProviderInfo {
  source: 'database-placeholder' | 'exchange-private-adapter';
  description: string;
  supportsLiveExchangeData: boolean;
}
