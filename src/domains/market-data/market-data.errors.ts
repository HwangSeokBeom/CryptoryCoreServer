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
  canonicalSymbol?: string;
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
      canonicalSymbol: params.metadata?.canonicalSymbol,
      message,
      userMessage,
      retryable,
      metadata: params.metadata,
      reason: params.reason ?? null,
    },
  );
}
