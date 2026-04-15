import type { ExchangeId, ExchangeCapability } from './exchange.types';

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
    public readonly exchange: ExchangeId | 'fx',
    public readonly statusCode: number,
    public readonly requestUrl: string,
    message: string,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'ExchangeRequestError';
  }
}

export class StaleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleDataError';
  }
}
