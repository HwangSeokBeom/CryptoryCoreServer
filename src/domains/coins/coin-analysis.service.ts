import type { ExchangeId } from '../../core/exchange/exchange.types';
import { getCandlesWithMeta } from '../market-data/market-data.service';
import { logger } from '../../utils/logger';
import { normalizeCoinSymbol } from './coin-symbol';

export type AnalysisTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '2h';
export type AnalysisDirection = 'bearish' | 'neutral' | 'bullish';

export type CoinAnalysisIndicator = {
  key: string;
  label: string;
  state: AnalysisDirection;
  valueText: string;
  description: string;
};

export type CoinAnalysisResponse = {
  symbol: string;
  timeframe: AnalysisTimeframe;
  summary: {
    status: AnalysisDirection;
    label: string;
    score: number;
    bullishCount: number;
    bearishCount: number;
    neutralCount: number;
  };
  indicators: CoinAnalysisIndicator[];
  source: {
    type: 'server_analysis';
    fallbackUsed: boolean;
  };
  asOf: string;
};

type CandleLike = {
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  timestamp?: number | null;
  closeTime?: number | null;
  openTime?: number | null;
};

export const ANALYSIS_TIMEFRAMES: AnalysisTimeframe[] = ['1m', '5m', '15m', '30m', '1h', '2h'];

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getClose(candle: CandleLike) {
  return toFiniteNumber(candle.close);
}

function getVolume(candle: CandleLike) {
  return toFiniteNumber(candle.volume);
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateRsi(closes: number[], period = 14) {
  if (closes.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;
  const slice = closes.slice(-(period + 1));
  for (let index = 1; index < slice.length; index += 1) {
    const delta = slice[index] - slice[index - 1];
    if (delta >= 0) {
      gains += delta;
    } else {
      losses += Math.abs(delta);
    }
  }

  if (gains === 0 && losses === 0) {
    return 50;
  }
  if (losses === 0) {
    return 100;
  }

  const relativeStrength = gains / losses;
  return 100 - (100 / (1 + relativeStrength));
}

function labelFromThreshold(value: number | null, bearishBelow: number, bullishAbove: number): AnalysisDirection {
  if (value === null) {
    return 'neutral';
  }
  if (value <= bearishBelow) {
    return 'bearish';
  }
  if (value >= bullishAbove) {
    return 'bullish';
  }
  return 'neutral';
}

function labelForState(state: AnalysisDirection) {
  if (state === 'bullish') {
    return '상승 신호';
  }
  if (state === 'bearish') {
    return '하락 신호';
  }
  return '중립';
}

function formatPercent(value: number | null) {
  return value === null ? '데이터 부족' : `${value.toFixed(2)}%`;
}

function formatNumber(value: number | null) {
  return value === null ? '데이터 부족' : value.toFixed(2);
}

function summarize(indicators: CoinAnalysisIndicator[]) {
  const bearishCount = indicators.filter((indicator) => indicator.state === 'bearish').length;
  const neutralCount = indicators.filter((indicator) => indicator.state === 'neutral').length;
  const bullishCount = indicators.filter((indicator) => indicator.state === 'bullish').length;
  const score = bullishCount - bearishCount;
  const status: AnalysisDirection = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';

  return {
    status,
    label: labelForState(status),
    score,
    bullishCount,
    bearishCount,
    neutralCount,
  };
}

function neutralResponse(symbol: string, timeframe: AnalysisTimeframe, reason: string): CoinAnalysisResponse {
  const indicators: CoinAnalysisIndicator[] = [
    {
      key: 'recent_price_change',
      label: '최근 가격 변화',
      state: 'neutral',
      valueText: '데이터 부족',
      description: reason,
    },
  ];
  const response: CoinAnalysisResponse = {
    symbol,
    timeframe,
    summary: summarize(indicators),
    indicators,
    source: {
      type: 'server_analysis',
      fallbackUsed: true,
    },
    asOf: new Date().toISOString(),
  };
  logger.info(
    {
      domain: 'coin-analysis',
      symbol: response.symbol,
      timeframe: response.timeframe,
      fallbackUsed: response.source.fallbackUsed,
      indicatorCount: response.indicators.length,
    },
    `[CoinAnalysis] symbol=${response.symbol} timeframe=${response.timeframe} fallbackUsed=${response.source.fallbackUsed} indicatorCount=${response.indicators.length}`,
  );
  return response;
}

async function loadCandles(symbol: string, timeframe: AnalysisTimeframe) {
  const exchanges: ExchangeId[] = ['upbit', 'binance'];
  for (const exchange of exchanges) {
    try {
      const response = await getCandlesWithMeta(exchange, { symbol }, timeframe, 80);
      const candles = response.items
        .map((item) => item as CandleLike)
        .filter((item) => getClose(item) !== null);
      if (candles.length > 0) {
        return candles;
      }
    } catch (error) {
      logger.warn({ domain: 'coin-analysis', exchange, symbol, timeframe, err: error }, 'Analysis candle lookup failed');
    }
  }
  return [];
}

export async function getCoinAnalysis(symbolInput: string, timeframe: AnalysisTimeframe): Promise<CoinAnalysisResponse> {
  const symbol = normalizeCoinSymbol(symbolInput);
  const candles = await loadCandles(symbol, timeframe);
  if (candles.length < 5) {
    return neutralResponse(symbol, timeframe, '최근 캔들 데이터가 부족합니다.');
  }

  const closes = candles.map(getClose).filter((value): value is number => value !== null);
  const volumes = candles.map(getVolume).filter((value): value is number => value !== null);
  const firstClose = closes[0] ?? null;
  const lastClose = closes[closes.length - 1] ?? null;
  const recentChangePercent = firstClose && lastClose ? ((lastClose - firstClose) / firstClose) * 100 : null;
  const shortAverage = average(closes.slice(-7));
  const longAverage = average(closes.slice(-25));
  const movingAverageSpread = shortAverage !== null && longAverage ? ((shortAverage - longAverage) / longAverage) * 100 : null;
  const recentVolumeAverage = average(volumes.slice(-7));
  const previousVolumeAverage = average(volumes.slice(-21, -7));
  const volumeChangePercent = recentVolumeAverage !== null && previousVolumeAverage
    ? ((recentVolumeAverage - previousVolumeAverage) / previousVolumeAverage) * 100
    : null;
  const rsi = calculateRsi(closes);

  const indicators: CoinAnalysisIndicator[] = [
    {
      key: 'recent_price_change',
      label: '최근 가격 변화',
      state: labelFromThreshold(recentChangePercent, -1, 1),
      valueText: formatPercent(recentChangePercent),
      description: '최근 캔들 구간의 종가 변화율입니다.',
    },
    {
      key: 'moving_average_spread',
      label: '이동평균 차이',
      state: labelFromThreshold(movingAverageSpread, -0.5, 0.5),
      valueText: formatPercent(movingAverageSpread),
      description: '단기 평균과 장기 평균의 차이를 백분율로 계산한 값입니다.',
    },
    {
      key: 'volume_change',
      label: '거래량 변화',
      state: labelFromThreshold(volumeChangePercent, -10, 10),
      valueText: formatPercent(volumeChangePercent),
      description: '최근 평균 거래량과 이전 평균 거래량의 차이입니다.',
    },
    {
      key: 'rsi_14',
      label: 'RSI 14',
      state: rsi === null ? 'neutral' : rsi >= 60 ? 'bullish' : rsi <= 40 ? 'bearish' : 'neutral',
      valueText: formatNumber(rsi),
      description: '최근 종가 기준의 14기간 RSI 참고 값입니다.',
    },
  ];

  const updatedAtMs = candles
    .map((item) => toFiniteNumber(item.closeTime) ?? toFiniteNumber(item.timestamp) ?? toFiniteNumber(item.openTime))
    .filter((value): value is number => value !== null)
    .at(-1);

  const response: CoinAnalysisResponse = {
    symbol,
    timeframe,
    summary: summarize(indicators),
    indicators,
    source: {
      type: 'server_analysis',
      fallbackUsed: false,
    },
    asOf: updatedAtMs ? new Date(updatedAtMs).toISOString() : new Date().toISOString(),
  };
  logger.info(
    {
      domain: 'coin-analysis',
      symbol: response.symbol,
      timeframe: response.timeframe,
      fallbackUsed: response.source.fallbackUsed,
      indicatorCount: response.indicators.length,
    },
    `[CoinAnalysis] symbol=${response.symbol} timeframe=${response.timeframe} fallbackUsed=${response.source.fallbackUsed} indicatorCount=${response.indicators.length}`,
  );
  return response;
}
