import { AppError } from '../../utils/errors';
import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import type { CanonicalMarketMetadata, ExchangeId } from '../../core/exchange/exchange.types';

export type MarketDataTarget = 'candles' | 'orderbook' | 'trades' | 'summary';
export type MarketDataErrorCode = 'MARKET_DATA_UNSUPPORTED' | 'MARKET_DATA_UNAVAILABLE';

export type MarketDataErrorBody = {
  success: false;
  code: MarketDataErrorCode;
  target: MarketDataTarget;
  exchange: ExchangeId;
  marketId?: string;
  canonicalMarketId?: string;
  canonicalSymbol?: string;
  candlesSupported?: boolean;
  graphSupported?: boolean;
  supportedIntervals?: string[];
  message: string;
  userMessage: string;
  retryable: boolean;
  metadata?: CanonicalMarketMetadata;
  reason?: string | null;
};

export class MarketDataAvailabilityError extends AppError {
  constructor(
    statusCode: number,
    public readonly body: Omit<MarketDataErrorBody, 'success'>,
  ) {
    super(statusCode, body.message, body as unknown as Record<string, unknown>);
    this.name = 'MarketDataAvailabilityError';
  }
}

export function createMarketDataErrorBody(error: MarketDataAvailabilityError): MarketDataErrorBody {
  return {
    success: false,
    ...error.body,
  };
}

export function buildMarketDataError(params: {
  code: MarketDataErrorCode;
  target: MarketDataTarget;
  exchange: ExchangeId;
  metadata?: CanonicalMarketMetadata;
  reason?: string | null;
  retryable?: boolean;
  statusCode?: number;
}) {
  const normalizedReason = classifyMarketDataReason(params);
  const retryable = params.retryable ?? params.code === 'MARKET_DATA_UNAVAILABLE';
  const targetLabel = params.target === 'candles'
    ? 'candles'
    : params.target === 'orderbook'
      ? 'orderbook'
      : params.target === 'trades'
        ? 'trades'
        : 'summary';
  const unsupported = params.code === 'MARKET_DATA_UNSUPPORTED';
  const exchangeName = EXCHANGE_METADATA[params.exchange].displayName;
  const message = unsupported
    ? `${params.exchange} ${targetLabel} are not supported for this market`
    : `${params.exchange} ${targetLabel} are temporarily unavailable`;
  const userTarget = params.target === 'candles'
    ? '차트 데이터'
    : params.target === 'orderbook'
      ? '호가 데이터'
      : params.target === 'trades'
        ? '체결 데이터'
        : '요약 데이터';
  const userMessage = unsupported
    ? `${exchangeName} ${userTarget}는 이 마켓에서 지원되지 않아요.`
    : `${exchangeName} ${userTarget}가 일시적으로 제공되지 않고 있어요.`;

  return new MarketDataAvailabilityError(
    params.statusCode ?? (unsupported ? 400 : 503),
    {
      code: params.code,
      target: params.target,
      exchange: params.exchange,
      marketId: params.metadata?.marketId,
      canonicalMarketId: params.metadata?.canonicalMarketId,
      canonicalSymbol: params.metadata?.canonicalSymbol,
      candlesSupported: params.metadata?.candlesSupported,
      graphSupported: params.metadata?.graphSupported,
      supportedIntervals: params.metadata?.supportedIntervals ?? [],
      message,
      userMessage,
      retryable,
      metadata: params.metadata,
      reason: normalizedReason,
    },
  );
}

function classifyMarketDataReason(params: {
  code: MarketDataErrorCode;
  target: MarketDataTarget;
  metadata?: CanonicalMarketMetadata;
  reason?: string | null;
}) {
  const rawReason = params.reason?.trim() ?? '';
  const normalized = rawReason.toLowerCase();

  if (params.code === 'MARKET_DATA_UNSUPPORTED') {
    if (params.metadata?.candlesSupported === false) {
      if (params.metadata.unsupportedReason === 'quote_like_symbol') {
        return 'synthetic_quote_only';
      }
      return params.metadata.unsupportedReason ?? 'provider_not_supported';
    }

    if (normalized.includes('interval_mapping_not_found') || normalized.includes('invalid interval')) {
      return 'interval_not_supported';
    }

    if (
      normalized.includes('market_data_unsupported')
      || normalized.includes('invalid symbol')
      || normalized.includes('not supported')
    ) {
      return 'market_not_supported';
    }

    return rawReason || 'market_not_supported';
  }

  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'provider_timeout';
  }
  if (normalized.includes('429') || normalized.includes('rate limit') || normalized.includes('too_many_requests')) {
    return 'provider_rate_limited';
  }
  if (normalized.includes('503') || normalized.includes('service unavailable') || normalized.includes('upstream_503')) {
    return 'provider_down';
  }
  if (normalized.includes('malformed')) {
    return 'provider_malformed';
  }

  return rawReason || 'provider_unavailable';
}
