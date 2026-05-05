import { env } from '../../../config/env';
import { ExchangeRequestError } from '../../../core/exchange/errors';
import { RestClient } from '../../../core/exchange/rest.client';
import { logger } from '../../../utils/logger';

export type CoinMarketCapFailureReason =
  | 'coinmarketcap_api_key_missing'
  | 'coinmarketcap_rate_limited'
  | 'coinmarketcap_auth_failed'
  | 'coinmarketcap_timeout'
  | 'coinmarketcap_unavailable'
  | 'coinmarketcap_malformed_response'
  | 'coinmarketcap_price_missing';

export type CoinMarketCapQuote = {
  symbol: 'USDT';
  name: string;
  convert: 'KRW';
  price: number;
  providerUpdatedAt: string;
};

type CmcAsset = {
  id?: number | string | null;
  name?: string | null;
  symbol?: string | null;
  slug?: string | null;
  last_updated?: string | null;
  quote?: Record<string, {
    price?: number | string | null;
    last_updated?: string | null;
  } | undefined> | null;
};

type CmcQuotesResponse = {
  data?: CmcAsset[] | Record<string, CmcAsset | CmcAsset[] | undefined>;
  status?: {
    timestamp?: string | null;
    error_code?: number | null;
    error_message?: string | null;
  };
};

type CmcShape = {
  responseKeys: string[];
  dataKeys: string[];
  quoteKeys: string[];
};

export class CoinMarketCapProviderError extends Error {
  constructor(
    public readonly reason: CoinMarketCapFailureReason,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'CoinMarketCapProviderError';
  }
}

function toFinitePositiveNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function flattenAssets(data: CmcQuotesResponse['data']) {
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== 'object') {
    return [];
  }
  return Object.values(data).flatMap((value) => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  });
}

function responseShape(response: CmcQuotesResponse): CmcShape {
  const responseKeys = Object.keys(response ?? {});
  const data = response.data;
  const dataKeys = data && typeof data === 'object' ? Object.keys(data) : [];
  const assets = flattenAssets(data);
  const quoteKeys = [...new Set(assets.flatMap((asset) => Object.keys(asset.quote ?? {})))];
  return { responseKeys, dataKeys, quoteKeys };
}

function selectUsdtAsset(assets: CmcAsset[], preferredId: number) {
  return assets.find((asset) => Number(asset.id) === preferredId)
    ?? assets.find((asset) =>
      asset.symbol?.toUpperCase() === 'USDT'
      && (
        asset.slug?.toLowerCase() === 'tether'
        || asset.name?.toLowerCase().includes('tether')
      ))
    ?? assets.find((asset) => asset.symbol?.toUpperCase() === 'USDT')
    ?? null;
}

function classifyRequestError(error: unknown): CoinMarketCapProviderError {
  if (error instanceof CoinMarketCapProviderError) {
    return error;
  }

  if (error instanceof ExchangeRequestError) {
    if (error.statusCode === 429) {
      return new CoinMarketCapProviderError('coinmarketcap_rate_limited', 'CoinMarketCap rate limited the request', error.statusCode);
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new CoinMarketCapProviderError('coinmarketcap_auth_failed', 'CoinMarketCap authentication failed', error.statusCode);
    }
    if (error.statusCode === 504) {
      return new CoinMarketCapProviderError('coinmarketcap_timeout', 'CoinMarketCap request timed out', error.statusCode);
    }
    return new CoinMarketCapProviderError('coinmarketcap_unavailable', 'CoinMarketCap request failed', error.statusCode);
  }

  return new CoinMarketCapProviderError('coinmarketcap_unavailable', 'CoinMarketCap request failed');
}

export class CoinMarketCapProvider {
  private readonly client: RestClient;

  constructor(
    private readonly config = {
      baseUrl: env.COINMARKETCAP_API_BASE_URL,
      apiKey: env.COINMARKETCAP_API_KEY,
      timeoutMs: env.COINMARKETCAP_TIMEOUT_MS,
      usdtId: env.USDT_COINMARKETCAP_ID,
    },
  ) {
    this.client = new RestClient('coinmarketcap', config.baseUrl);
  }

  async getUsdtKrwQuote(): Promise<CoinMarketCapQuote> {
    if (!this.config.apiKey?.trim()) {
      throw new CoinMarketCapProviderError('coinmarketcap_api_key_missing', 'CoinMarketCap API key is missing');
    }

    try {
      const response = await this.client.request<CmcQuotesResponse>('/v2/cryptocurrency/quotes/latest', {
        query: {
          id: this.config.usdtId,
          convert: 'KRW',
        },
        headers: {
          'X-CMC_PRO_API_KEY': this.config.apiKey,
        },
        timeoutMs: this.config.timeoutMs,
        retryPolicy: {
          maxAttempts: 1,
        },
      });

      const shape = responseShape(response);
      logger.debug(
        {
          domain: 'coinmarketcap',
          responseKeys: shape.responseKeys,
          dataKeys: shape.dataKeys,
          quoteKeys: shape.quoteKeys,
        },
        `[CMC] response keys=${shape.responseKeys.join(',')} dataKeys=${shape.dataKeys.join(',')} quoteKeys=${shape.quoteKeys.join(',')}`,
      );

      const asset = selectUsdtAsset(flattenAssets(response.data), this.config.usdtId);
      const price = toFinitePositiveNumber(asset?.quote?.KRW?.price);
      logger.debug(
        { domain: 'usdt-rate', priceExists: price !== null, source: 'coinmarketcap' },
        `[USDT_RATE] parsed priceExists=${price !== null} source=coinmarketcap`,
      );
      if (!asset) {
        throw new CoinMarketCapProviderError('coinmarketcap_malformed_response', 'CoinMarketCap USDT/KRW quote is missing');
      }
      if (price === null) {
        logger.warn(
          { domain: 'usdt-rate', reason: 'coinmarketcap_price_missing', dataKeys: shape.dataKeys, quoteKeys: shape.quoteKeys },
          `[USDT_RATE] price missing reason=coinmarketcap_price_missing dataKeys=${shape.dataKeys.join(',')}`,
        );
        throw new CoinMarketCapProviderError('coinmarketcap_price_missing', 'CoinMarketCap USDT/KRW price is missing');
      }

      return {
        symbol: 'USDT',
        name: asset.name?.trim() || 'Tether USDt',
        convert: 'KRW',
        price,
        providerUpdatedAt: asset.quote?.KRW?.last_updated ?? asset.last_updated ?? response.status?.timestamp ?? new Date().toISOString(),
      };
    } catch (error) {
      const classified = classifyRequestError(error);
      logger.warn(
        {
          domain: 'coinmarketcap',
          providerStatus: classified.reason === 'coinmarketcap_rate_limited' ? 'rate_limited' : classified.reason,
          status: classified.statusCode,
          reason: classified.reason,
        },
        `[CMC] request failed status=${classified.statusCode ?? 'unknown'} reason=${classified.reason}`,
      );
      throw classified;
    }
  }
}

export const coinMarketCapProvider = new CoinMarketCapProvider();
