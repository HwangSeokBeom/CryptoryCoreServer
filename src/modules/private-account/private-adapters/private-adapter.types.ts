export type ExchangeConnectionValidationStatus = 'verified' | 'invalid' | 'placeholder';
export type ExchangeConnectionValidationMode = 'live_api' | 'syntactic' | 'placeholder';

export interface ExchangeConnectionCredentials {
  exchange: string;
  apiKey: string;
  secretKey: string;
  passphrase?: string | null;
}

export interface ExchangeConnectionValidationResult {
  status: ExchangeConnectionValidationStatus;
  mode: ExchangeConnectionValidationMode;
  canUsePrivateApi: boolean;
  message: string;
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
