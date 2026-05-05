import type { ExchangeId, ExchangeCapability } from './exchange.types';

export type UpstreamOwner = ExchangeId | 'fx' | 'coingecko' | 'coinmarketcap' | 'translation' | 'news';

export class ExchangeCapabilityError extends Error {
  constructor(
    public readonly exchange: ExchangeId,
    public readonly capability: ExchangeCapability,
    message = `Capability ${capability} is not supported by ${exchange}`,
  ) {
    super(message);
    this.name = 'ExchangeCapabilityError';
  }
}

export class ExchangeAuthError extends Error {
  constructor(
    public readonly exchange: ExchangeId,
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeAuthError';
  }
}

export class ExchangeRequestError extends Error {
  constructor(
    public readonly exchange: UpstreamOwner,
    public readonly statusCode: number,
    public readonly requestUrl: string,
    message: string,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'ExchangeRequestError';
  }
}

type ExchangeMarketDataErrorKind =
  | 'malformed_payload'
  | 'unsupported_symbol'
  | 'temporarily_unavailable'
  | 'rate_limited';

class ExchangeMarketDataError extends Error {
  constructor(
    public readonly exchange: UpstreamOwner,
    public readonly kind: ExchangeMarketDataErrorKind,
    message: string,
    public readonly statusCode?: number,
    public readonly symbol?: string,
    public readonly responseBody?: string,
  ) {
    super(message);
  }
}

export class ExchangeMalformedPayloadError extends ExchangeMarketDataError {
  constructor(
    exchange: UpstreamOwner,
    message: string,
    statusCode?: number,
    symbol?: string,
    responseBody?: string,
  ) {
    super(exchange, 'malformed_payload', message, statusCode, symbol, responseBody);
    this.name = 'ExchangeMalformedPayloadError';
  }
}

export class ExchangeUnsupportedSymbolError extends ExchangeMarketDataError {
  constructor(
    exchange: UpstreamOwner,
    message: string,
    statusCode?: number,
    symbol?: string,
    responseBody?: string,
  ) {
    super(exchange, 'unsupported_symbol', message, statusCode, symbol, responseBody);
    this.name = 'ExchangeUnsupportedSymbolError';
  }
}

export class ExchangeTemporaryUnavailableError extends ExchangeMarketDataError {
  constructor(
    exchange: UpstreamOwner,
    message: string,
    statusCode?: number,
    symbol?: string,
    responseBody?: string,
  ) {
    super(exchange, 'temporarily_unavailable', message, statusCode, symbol, responseBody);
    this.name = 'ExchangeTemporaryUnavailableError';
  }
}

export class ExchangeRateLimitError extends ExchangeMarketDataError {
  constructor(
    exchange: UpstreamOwner,
    message: string,
    statusCode?: number,
    symbol?: string,
    responseBody?: string,
  ) {
    super(exchange, 'rate_limited', message, statusCode, symbol, responseBody);
    this.name = 'ExchangeRateLimitError';
  }
}

export class StaleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleDataError';
  }
}
