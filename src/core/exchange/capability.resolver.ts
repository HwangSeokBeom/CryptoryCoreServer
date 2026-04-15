import type { ExchangeCapability, ExchangeId } from './exchange.types';
import { EXCHANGE_METADATA } from './exchange.metadata';

export function supportsCapability(exchange: ExchangeId, capability: ExchangeCapability) {
  return EXCHANGE_METADATA[exchange].capabilities.includes(capability);
}

export function getCapabilities(exchange: ExchangeId) {
  return EXCHANGE_METADATA[exchange].capabilities;
}
