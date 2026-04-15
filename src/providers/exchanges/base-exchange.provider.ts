import { getExchangeConfig } from '../../config/exchange.config';
import { ExchangeCapabilityError } from '../../core/exchange/errors';
import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import { RestClient } from '../../core/exchange/rest.client';
import type {
  ExchangeCapability,
  ExchangeId,
  ExchangeMetadata,
} from '../../core/exchange/exchange.types';

export abstract class BaseExchangeProvider {
  readonly metadata: ExchangeMetadata;
  protected readonly restClient: RestClient;

  constructor(readonly exchange: ExchangeId) {
    this.metadata = EXCHANGE_METADATA[exchange];
    this.restClient = new RestClient(exchange, getExchangeConfig(exchange).restBaseUrl);
  }

  supports(capability: ExchangeCapability) {
    return this.metadata.capabilities.includes(capability);
  }

  protected assertCapability(capability: ExchangeCapability) {
    if (!this.supports(capability)) {
      throw new ExchangeCapabilityError(this.exchange, capability);
    }
  }
}
