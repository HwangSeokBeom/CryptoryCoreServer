import type { MarketStreamChannel, StreamSubscription } from './exchange.types';

export const STREAM_CHANNELS: MarketStreamChannel[] = ['tickers', 'orderbook', 'trades', 'candles'];

type ChannelSymbolExclusions =
  | Map<string, string>
  | Set<string>
  | Record<string, string>;

export interface StreamPlanSkippedSymbol {
  channel: MarketStreamChannel;
  symbol: string;
  reason: string;
}

export interface StreamSubscriptionPlan {
  activeChannels: MarketStreamChannel[];
  activeSubscriptionCount: number;
  totalResolvedSymbols: number;
  requestedByChannel: Record<MarketStreamChannel, string[]>;
  resolvedByChannel: Record<MarketStreamChannel, string[]>;
  skippedSymbols: StreamPlanSkippedSymbol[];
}

function createChannelSymbolRecord() {
  return {
    tickers: [] as string[],
    orderbook: [] as string[],
    trades: [] as string[],
    candles: [] as string[],
  };
}

function resolveExclusionReason(exclusions: ChannelSymbolExclusions | undefined, symbol: string) {
  if (!exclusions) {
    return null;
  }

  if (exclusions instanceof Map) {
    return exclusions.get(symbol) ?? null;
  }

  if (exclusions instanceof Set) {
    return exclusions.has(symbol) ? 'capability_excluded' : null;
  }

  return exclusions[symbol] ?? null;
}

export function buildStreamSubscriptionPlan(params: {
  subscriptions: StreamSubscription[];
  supportedSymbolsByChannel: Partial<Record<MarketStreamChannel, Iterable<string>>>;
  capabilityExclusionsByChannel?: Partial<Record<MarketStreamChannel, ChannelSymbolExclusions>>;
}) {
  const requestedByChannel = createChannelSymbolRecord();
  const resolvedByChannel = createChannelSymbolRecord();
  const skippedSymbols: StreamPlanSkippedSymbol[] = [];

  for (const subscription of params.subscriptions) {
    const channel = subscription.channel;
    const deduped = Array.from(new Set(subscription.symbols));
    requestedByChannel[channel].push(...deduped);
  }

  for (const channel of STREAM_CHANNELS) {
    requestedByChannel[channel] = Array.from(new Set(requestedByChannel[channel]));
    const supportedSymbols = new Set(params.supportedSymbolsByChannel[channel] ?? []);
    const exclusions = params.capabilityExclusionsByChannel?.[channel];

    for (const symbol of requestedByChannel[channel]) {
      if (!supportedSymbols.has(symbol)) {
        skippedSymbols.push({
          channel,
          symbol,
          reason: 'not_listed_on_exchange_market_universe',
        });
        continue;
      }

      const exclusionReason = resolveExclusionReason(exclusions, symbol);
      if (exclusionReason) {
        skippedSymbols.push({
          channel,
          symbol,
          reason: exclusionReason,
        });
        continue;
      }

      resolvedByChannel[channel].push(symbol);
    }
  }

  return {
    activeChannels: STREAM_CHANNELS.filter((channel) => resolvedByChannel[channel].length > 0),
    activeSubscriptionCount: params.subscriptions.length,
    totalResolvedSymbols: STREAM_CHANNELS.reduce((sum, channel) => sum + resolvedByChannel[channel].length, 0),
    requestedByChannel,
    resolvedByChannel,
    skippedSymbols,
  } satisfies StreamSubscriptionPlan;
}
