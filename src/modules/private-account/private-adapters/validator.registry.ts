import { getExchangeConfig } from '../../../config/exchange.config';
import { BinanceSigner } from '../../../core/exchange/auth/binance.signer';
import { JwtHmacSigner } from '../../../core/exchange/auth/jwt-hmac.signer';
import { CoinoneSigner } from '../../../core/exchange/auth/coinone.signer';
import { KorbitHmacSigner } from '../../../core/exchange/auth/korbit.signer';
import { RestClient } from '../../../core/exchange/rest.client';
import { classifyExchangeValidationError } from './validation-error-classifier';
import type {
  ExchangeConnectionCredentials,
  ExchangeConnectionValidationResult,
  ExchangeConnectionValidator,
} from './private-adapter.types';

class LiveExchangeConnectionValidator implements ExchangeConnectionValidator {
  constructor(
    public readonly exchange: string,
    private readonly validateLiveApi: (credentials: ExchangeConnectionCredentials) => Promise<void>,
  ) {}

  async validate(credentials: ExchangeConnectionCredentials): Promise<ExchangeConnectionValidationResult> {
    if (!credentials.apiKey.trim() || !credentials.secretKey.trim()) {
      return {
        status: 'invalid',
        mode: 'syntactic',
        code: 'invalid_credentials',
        canUsePrivateApi: false,
        message: 'apiKey and secretKey are required',
        checkedAt: new Date().toISOString(),
      };
    }

    try {
      await this.validateLiveApi(credentials);
      return {
        status: 'verified',
        mode: 'live_api',
        code: 'verified',
        canUsePrivateApi: true,
        message: `${this.exchange} private API credentials verified successfully.`,
        details: {
          verifiedAgainst: this.exchange,
        },
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const classified = classifyExchangeValidationError(error);
      return {
        status: 'invalid',
        mode: 'live_api',
        code: classified.code,
        canUsePrivateApi: false,
        message: classified.message,
        details: classified.details,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

class PlaceholderExchangeConnectionValidator implements ExchangeConnectionValidator {
  constructor(public readonly exchange: string) {}

  async validate(credentials: ExchangeConnectionCredentials): Promise<ExchangeConnectionValidationResult> {
    if (!credentials.apiKey.trim() || !credentials.secretKey.trim()) {
      return {
        status: 'invalid',
        mode: 'syntactic',
        code: 'invalid_credentials',
        canUsePrivateApi: false,
        message: 'apiKey and secretKey are required',
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'placeholder',
      mode: 'placeholder',
      code: 'unsupported_exchange',
      canUsePrivateApi: false,
      message: `Credentials stored for ${this.exchange}, but a live private adapter is not implemented yet.`,
      details: {
        exchange: this.exchange,
      },
      checkedAt: new Date().toISOString(),
    };
  }
}

async function validateUpbit(credentials: ExchangeConnectionCredentials) {
  const signer = new JwtHmacSigner();
  const client = new RestClient('upbit', getExchangeConfig('upbit').restBaseUrl);
  await client.request('/v1/accounts', {
    headers: signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
    }),
  });
}

async function validateBithumb(credentials: ExchangeConnectionCredentials) {
  const signer = new JwtHmacSigner();
  const client = new RestClient('bithumb', getExchangeConfig('bithumb').restBaseUrl);
  await client.request('/v1/accounts', {
    headers: signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      includeTimestamp: true,
    }),
  });
}

async function validateCoinone(credentials: ExchangeConnectionCredentials) {
  const signer = new CoinoneSigner();
  const client = new RestClient('coinone', getExchangeConfig('coinone').restBaseUrl);
  const signed = signer.createSignedRequest({
    accessToken: credentials.apiKey,
    secretKey: credentials.secretKey,
  });
  const response = await client.request<{ result?: string; error_msg?: string; errorCode?: string }>('/v2.1/account/balance/all', {
    method: 'POST',
    headers: signed.headers,
    json: signed.payload,
  });
  if (String(response.result ?? '').toLowerCase() !== 'success') {
    throw new Error(String(response.error_msg ?? response.errorCode ?? 'Coinone validation failed'));
  }
}

async function validateKorbit(credentials: ExchangeConnectionCredentials) {
  const signer = new KorbitHmacSigner();
  const client = new RestClient('korbit', getExchangeConfig('korbit').restBaseUrl);
  const signed = signer.createSignedRequest({
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
  });
  await client.request('/v2/balance', {
    headers: signed.headers,
    query: {
      ...signed.payload,
      signature: signed.signature,
    },
  });
}

async function validateBinance(credentials: ExchangeConnectionCredentials) {
  const signer = new BinanceSigner();
  const client = new RestClient('binance', getExchangeConfig('binance').restBaseUrl);
  const signed = signer.createSignedRequest({
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
  });
  await client.request('/api/v3/account', {
    headers: signed.headers,
    query: signed.query,
  });
}

const validators = new Map<string, ExchangeConnectionValidator>([
  ['upbit', new LiveExchangeConnectionValidator('upbit', validateUpbit)],
  ['bithumb', new LiveExchangeConnectionValidator('bithumb', validateBithumb)],
  ['coinone', new LiveExchangeConnectionValidator('coinone', validateCoinone)],
  ['korbit', new LiveExchangeConnectionValidator('korbit', validateKorbit)],
  ['binance', new LiveExchangeConnectionValidator('binance', validateBinance)],
]);

export function getExchangeConnectionValidator(exchange: string) {
  return validators.get(exchange) ?? new PlaceholderExchangeConnectionValidator(exchange);
}
