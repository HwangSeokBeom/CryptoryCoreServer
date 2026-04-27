import { ExchangeCapabilityError } from '../../core/exchange/errors';
import type {
  AssetHistoryEventType,
  AssetHistoryRecord,
  AssetHistorySourceType,
  ExchangeId,
  PortfolioSnapshot,
  QuoteCurrency,
} from '../../core/exchange/exchange.types';
import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import {
  getUserExchangeConnectionRecord,
  listUserVerifiedExchangeConnections,
  requireUserOwnedExchangeCredentials,
} from '../exchange-connections/user-exchange-credentials.service';
import { markExchangeConnectionSync } from '../../modules/private-account/exchange-connections.service';
import { logger } from '../../utils/logger';
import { classifyExchangeValidationError } from '../../modules/private-account/private-adapters/validation-error-classifier';

type PortfolioFailure = {
  exchange: ExchangeId;
  code: string;
  message: string;
  details: Record<string, unknown>;
};

type AssetPosition = {
  exchange: ExchangeId;
  exchangeName: string;
  quoteCurrency: QuoteCurrency;
  asset: string;
  quantity: number;
  availableQuantity: number;
  lockedQuantity: number;
  averageBuyPrice: number;
  averageBuyPriceKrw: number;
  currentPrice: number;
  currentPriceKrw: number;
  marketValue: number;
  marketValueKrw: number;
  pnlValue: number;
  pnlValueKrw: number;
  pnlPercent: number;
  isCashAsset: boolean;
  timestamp: number;
};

type ExchangePortfolioGroup = {
  exchange: ExchangeId;
  exchangeName: string;
  quoteCurrency: QuoteCurrency;
  assetCount: number;
  totalAssetValue: number;
  totalAssetValueKrw: number;
  totalPnlValue: number;
  totalPnlValueKrw: number;
  assets: AssetPosition[];
  fetchedAt: string;
};

export type PortfolioSummary = {
  requestedExchanges: ExchangeId[];
  connectedExchanges: ExchangeId[];
  partialSuccess: boolean;
  failures: PortfolioFailure[];
  totals: {
    estimatedTotalAssetValueKrw: number;
    estimatedTotalPnlValueKrw: number;
    estimatedTotalPnlPercent: number;
  };
  exchangeGroups: ExchangePortfolioGroup[];
  assets: AssetPosition[];
  generatedAt: string;
};

export type PortfolioRouteStatus =
  | 'ok'
  | 'no_connection'
  | 'connection_exists_but_unverified'
  | 'partial_data';

export type PortfolioRouteResponse<T> = {
  data: T;
  routeStatus: PortfolioRouteStatus;
  warningMessage?: string;
  partialFailureMessage?: string;
  unavailableReason?: string;
  privateStreamingStatus: 'live_stream_available' | 'live_stream_unavailable_polling_active';
  pollingFallbackRecommended: boolean;
};

export type PortfolioHistoryItem = AssetHistoryRecord & {
  id: string;
  assetSymbol: string;
  symbol: string;
  eventType: AssetHistoryEventType;
  price: number | null;
  occurredAt: string;
  source: string;
  sourceType: AssetHistorySourceType;
  isSynthetic: boolean;
  isVerifiedUserEvent: boolean;
};

const inFlightPortfolioOperations = new Map<string, Promise<unknown>>();
const MOCK_HISTORY_SOURCE_TYPES = new Set<AssetHistorySourceType>(['mock', 'seed', 'sample']);
const SYNTHETIC_HISTORY_SOURCE_TYPES = new Set<AssetHistorySourceType>(['synthetic_snapshot', 'snapshot_diff']);

function resolvePortfolioProvider(exchange: ExchangeId) {
  try {
    return exchangeProviderRegistry.getPortfolioProvider(exchange);
  } catch (error) {
    if (error instanceof ExchangeCapabilityError) {
      throw new AppError(501, `${exchange} portfolio provider is not implemented yet`);
    }
    throw error;
  }
}

function toOperationAppError(exchange: ExchangeId, error: unknown, fallbackMessage: string) {
  if (error instanceof AppError) {
    return error;
  }

  const classified = classifyExchangeValidationError(error);
  const statusCodeByCode: Record<string, number> = {
    invalid_credentials: 400,
    insufficient_permissions: 403,
    ip_not_whitelisted: 400,
    signature_error: 400,
    timeout: 504,
    rate_limited: 429,
    exchange_unavailable: 503,
    unsupported_exchange: 501,
    unknown_error: 502,
    verified: 200,
  };

  return new AppError(statusCodeByCode[classified.code] ?? 502, fallbackMessage, {
    code: classified.code,
    exchange,
    message: classified.message,
    details: classified.details,
  });
}

async function getPortfolioContext(userId: string, exchange: ExchangeId) {
  const credentials = await requireUserOwnedExchangeCredentials(userId, exchange);
  logger.debug(
    { domain: 'credentials', exchange, userId, source: 'user_connection', capabilityGroup: 'portfolio' },
    'Resolved user-owned private exchange credentials',
  );
  return { credentials };
}

function buildFailure(exchange: ExchangeId, error: unknown): PortfolioFailure {
  const classified = classifyExchangeValidationError(error);
  return {
    exchange,
    code: classified.code,
    message: classified.message,
    details: classified.details,
  };
}

function getKrwMultiplier(quoteCurrency: QuoteCurrency, usdKrwRate: number) {
  return quoteCurrency === 'USDT' ? usdKrwRate : 1;
}

function getPrivateStreamingStatus() {
  return env.ENABLE_PRIVATE_WS
    ? 'live_stream_available' as const
    : 'live_stream_unavailable_polling_active' as const;
}

function createRouteMeta(params: {
  routeStatus: PortfolioRouteStatus;
  warningMessage?: string;
  partialFailureMessage?: string;
  unavailableReason?: string;
}): Omit<PortfolioRouteResponse<unknown>, 'data'> {
  return {
    routeStatus: params.routeStatus,
    warningMessage: params.warningMessage,
    partialFailureMessage: params.partialFailureMessage,
    unavailableReason: params.unavailableReason,
    privateStreamingStatus: getPrivateStreamingStatus(),
    pollingFallbackRecommended: env.ENABLE_PRIVATE_WS === false,
  };
}

function buildEmptyPortfolioSnapshot(exchange: ExchangeId) {
  return {
    exchange,
    balances: [],
    positions: [],
    totalAsset: 0,
    totalAssetValue: 0,
    totalPnlValue: 0,
    totalPnlPercent: 0,
    cash: 0,
    availableAsset: 0,
    lockedAsset: 0,
    timestamp: Date.now(),
  };
}

function withSingleFlight<T>(key: string, operation: () => Promise<T>) {
  const existing = inFlightPortfolioOperations.get(key);
  if (existing) {
    logger.debug({ domain: 'portfolio', event: 'singleflight_join', key }, 'Joined in-flight portfolio request');
    return existing as Promise<T>;
  }

  const promise = operation().finally(() => {
    inFlightPortfolioOperations.delete(key);
  });
  inFlightPortfolioOperations.set(key, promise);
  return promise;
}

function resolveHistoryEventType(record: AssetHistoryRecord): AssetHistoryEventType {
  return record.eventType ?? record.type;
}

function resolveHistorySourceType(record: AssetHistoryRecord, eventType: AssetHistoryEventType): AssetHistorySourceType {
  if (record.sourceType) {
    return record.sourceType;
  }

  switch (eventType) {
    case 'trade':
      return 'fill';
    case 'deposit':
      return 'deposit';
    case 'withdrawal':
      return 'withdrawal';
    case 'transfer':
      return 'transfer';
    case 'airdrop':
      return 'airdrop';
    case 'fee':
      return 'fee';
    case 'adjustment':
      return 'adjustment';
    default:
      return 'unknown';
  }
}

function buildPortfolioHistoryId(record: AssetHistoryRecord, assetSymbol: string, eventType: AssetHistoryEventType) {
  const explicitId = typeof record.id === 'string' ? record.id.trim() : '';
  if (explicitId) {
    return explicitId;
  }

  return [
    record.exchange,
    assetSymbol,
    eventType,
    record.timestamp,
    record.amount,
    record.price ?? 'na',
    record.orderId ?? 'na',
  ].join(':');
}

function normalizePortfolioHistoryRecords(params: {
  userId: string;
  exchange: ExchangeId;
  symbol?: string;
  limit?: number;
  records: AssetHistoryRecord[];
}): PortfolioHistoryItem[] {
  const filtered: PortfolioHistoryItem[] = [];
  let filteredMockCount = 0;
  let filteredSyntheticCount = 0;
  let filteredUnknownCount = 0;
  const sourceTypeCounts = new Map<string, number>();

  for (const record of params.records) {
    const eventType = resolveHistoryEventType(record);
    const assetSymbol = (record.assetSymbol ?? record.symbol ?? '').trim().toUpperCase();
    const sourceType = resolveHistorySourceType(record, eventType);
    sourceTypeCounts.set(sourceType, (sourceTypeCounts.get(sourceType) ?? 0) + 1);

    if (MOCK_HISTORY_SOURCE_TYPES.has(sourceType)) {
      filteredMockCount += 1;
      continue;
    }

    const isSynthetic = record.isSynthetic ?? SYNTHETIC_HISTORY_SOURCE_TYPES.has(sourceType);
    if (isSynthetic) {
      filteredSyntheticCount += 1;
      continue;
    }

    const isVerifiedUserEvent = record.isVerifiedUserEvent ?? sourceType !== 'unknown';
    const hasValidTimestamp = Number.isFinite(record.timestamp) && record.timestamp > 0;
    const hasValidAmount = Number.isFinite(record.amount) && record.amount !== 0;
    if (!assetSymbol || !hasValidTimestamp || !hasValidAmount || !isVerifiedUserEvent) {
      filteredUnknownCount += 1;
      continue;
    }

    filtered.push({
      ...record,
      id: buildPortfolioHistoryId(record, assetSymbol, eventType),
      assetSymbol,
      symbol: assetSymbol,
      eventType,
      type: eventType,
      price: typeof record.price === 'number' && Number.isFinite(record.price) ? record.price : null,
      occurredAt: record.occurredAt ?? new Date(record.timestamp).toISOString(),
      source: record.source ?? 'exchange_private_api',
      sourceType,
      isSynthetic: false,
      isVerifiedUserEvent: true,
    });
  }

  const returned = filtered
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, Math.max(params.limit ?? filtered.length, 0));

  logger.info(
    {
      domain: 'portfolio',
      event: 'portfolio_history_filter',
      userId: params.userId,
      exchange: params.exchange,
      symbol: params.symbol ?? null,
      rawCount: params.records.length,
      returnedCount: returned.length,
      filteredMockCount,
      filteredSyntheticCount,
      filteredUnknownCount,
      sourceTypeSummary: Object.fromEntries(sourceTypeCounts),
    },
    `[PortfolioHistoryDebug] rawCount=${params.records.length} returnedCount=${returned.length} filteredMockCount=${filteredMockCount} filteredSyntheticCount=${filteredSyntheticCount} filteredUnknownCount=${filteredUnknownCount}`,
  );

  return returned;
}

function toExchangeGroup(snapshot: PortfolioSnapshot, usdKrwRate: number): ExchangePortfolioGroup {
  const exchangeName = EXCHANGE_METADATA[snapshot.exchange].displayName;
  const quoteCurrency = EXCHANGE_METADATA[snapshot.exchange].quoteCurrency;
  const multiplier = getKrwMultiplier(quoteCurrency, usdKrwRate);
  const positionMap = new Map(snapshot.positions.map((position) => [position.symbol, position]));

  const assets: AssetPosition[] = snapshot.balances
    .filter((balance) => balance.free + balance.locked > 0)
    .map((balance) => {
      const position = positionMap.get(balance.asset);
      const quantity = position?.quantity ?? balance.free + balance.locked;
      const currentPrice = position?.currentPrice ?? (balance.asset === quoteCurrency ? 1 : 0);
      const averageBuyPrice = position?.averageBuyPrice ?? balance.averageBuyPrice ?? 0;
      const marketValue = position?.marketValue ?? quantity * currentPrice;
      const pnlValue = position?.pnlValue ?? marketValue - quantity * averageBuyPrice;

      return {
        exchange: snapshot.exchange,
        exchangeName,
        quoteCurrency,
        asset: balance.asset,
        quantity,
        availableQuantity: balance.free,
        lockedQuantity: balance.locked,
        averageBuyPrice,
        averageBuyPriceKrw: averageBuyPrice * multiplier,
        currentPrice,
        currentPriceKrw: currentPrice * multiplier,
        marketValue,
        marketValueKrw: marketValue * multiplier,
        pnlValue,
        pnlValueKrw: pnlValue * multiplier,
        pnlPercent: position?.pnlPercent ?? 0,
        isCashAsset: balance.asset === quoteCurrency,
        timestamp: position?.timestamp ?? snapshot.timestamp,
      };
    });

  return {
    exchange: snapshot.exchange,
    exchangeName,
    quoteCurrency,
    assetCount: assets.length,
    totalAssetValue: snapshot.totalAssetValue,
    totalAssetValueKrw: snapshot.totalAssetValue * multiplier,
    totalPnlValue: snapshot.totalPnlValue,
    totalPnlValueKrw: snapshot.totalPnlValue * multiplier,
    assets,
    fetchedAt: new Date(snapshot.timestamp).toISOString(),
  };
}

async function executePortfolioOperation<T>(
  userId: string,
  exchange: ExchangeId,
  fallbackMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    await markExchangeConnectionSync(userId, exchange, { success: true });
    return result;
  } catch (error) {
    const appError = toOperationAppError(exchange, error, fallbackMessage);
    await markExchangeConnectionSync(userId, exchange, {
      success: false,
      failureCode: typeof appError.details?.code === 'string' ? appError.details.code : 'unknown_error',
      failureReason:
        typeof appError.details?.message === 'string' ? appError.details.message : appError.message,
    });
    throw appError;
  }
}

export async function getPortfolioSnapshot(userId: string, exchange: ExchangeId) {
  const provider = resolvePortfolioProvider(exchange);
  return withSingleFlight(`snapshot:${userId}:${exchange}`, () =>
    executePortfolioOperation(userId, exchange, '자산 스냅샷 조회에 실패했습니다.', async () =>
      provider.getPortfolioSnapshot(await getPortfolioContext(userId, exchange)),
    ),
  );
}

export async function getAggregatedPortfolioSummary(
  userId: string,
  exchange?: ExchangeId,
): Promise<PortfolioSummary> {
  const verifiedConnections = await listUserVerifiedExchangeConnections(userId);
  const requestedExchanges = exchange
    ? [exchange]
    : verifiedConnections.map((connection) => connection.exchange as ExchangeId);

  const hasRequestedVerifiedConnection = !exchange
    || verifiedConnections.some((connection) => connection.exchange === exchange);

  if (requestedExchanges.length === 0 || !hasRequestedVerifiedConnection) {
    return {
      requestedExchanges,
      connectedExchanges: [],
      partialSuccess: false,
      failures: [],
      totals: {
        estimatedTotalAssetValueKrw: 0,
        estimatedTotalPnlValueKrw: 0,
        estimatedTotalPnlPercent: 0,
      },
      exchangeGroups: [],
      assets: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const usdKrwRate = (await exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate()).rate;
  const results = await Promise.allSettled(
    requestedExchanges.map(async (requestedExchange) => ({
      exchange: requestedExchange,
      snapshot: await getPortfolioSnapshot(userId, requestedExchange),
    })),
  );

  const exchangeGroups: ExchangePortfolioGroup[] = [];
  const failures: PortfolioFailure[] = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const requestedExchange = requestedExchanges[index];
    if (!requestedExchange) {
      continue;
    }

    if (result?.status === 'fulfilled') {
      exchangeGroups.push(toExchangeGroup(result.value.snapshot, usdKrwRate));
      continue;
    }

    failures.push(buildFailure(requestedExchange, result.reason));
  }

  if (exchange && exchangeGroups.length === 0 && failures[0]) {
    const failure = failures[0];
    throw new AppError(502, '자산 조회에 실패했습니다.', failure);
  }

  const assets = exchangeGroups.flatMap((group) => group.assets);
  const estimatedTotalAssetValueKrw = exchangeGroups.reduce((sum, group) => sum + group.totalAssetValueKrw, 0);
  const estimatedTotalPnlValueKrw = exchangeGroups.reduce((sum, group) => sum + group.totalPnlValueKrw, 0);
  const totalCostKrw = assets.reduce((sum, asset) => {
    if (asset.isCashAsset) {
      return sum;
    }
    return sum + asset.quantity * asset.averageBuyPriceKrw;
  }, 0);

  return {
    requestedExchanges,
    connectedExchanges: exchangeGroups.map((group) => group.exchange),
    partialSuccess: failures.length > 0 && exchangeGroups.length > 0,
    failures,
    totals: {
      estimatedTotalAssetValueKrw,
      estimatedTotalPnlValueKrw,
      estimatedTotalPnlPercent: totalCostKrw > 0 ? (estimatedTotalPnlValueKrw / totalCostKrw) * 100 : 0,
    },
    exchangeGroups,
    assets,
    generatedAt: new Date().toISOString(),
  };
}

export async function getAssetHistory(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  const provider = resolvePortfolioProvider(exchange);
  if (!provider.getAssetHistory) {
    throw new AppError(501, `${exchange} asset history is unsupported`);
  }

  return withSingleFlight(`history:${userId}:${exchange}:${symbol ?? '*'}:${limit ?? 50}`, () =>
    executePortfolioOperation(userId, exchange, '자산 변동 내역 조회에 실패했습니다.', async () => {
      const records = await provider.getAssetHistory!(symbol, limit, await getPortfolioContext(userId, exchange));
      return normalizePortfolioHistoryRecords({
        userId,
        exchange,
        symbol,
        limit,
        records,
      });
    }),
  );
}

async function classifyConnectionState(userId: string, exchange: ExchangeId) {
  try {
    const connection = await getUserExchangeConnectionRecord(userId, exchange);
    return connection.canUsePrivateApi ? 'verified' as const : 'unverified' as const;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) {
      return 'missing' as const;
    }
    throw error;
  }
}

export async function getPortfolioSnapshotRouteResponse(
  userId: string,
  exchange: ExchangeId,
): Promise<PortfolioRouteResponse<PortfolioSnapshot | ReturnType<typeof buildEmptyPortfolioSnapshot>>> {
  try {
    return {
      data: await getPortfolioSnapshot(userId, exchange),
      ...createRouteMeta({ routeStatus: 'ok' }),
    };
  } catch (error) {
    const connectionState = await classifyConnectionState(userId, exchange);
    if (connectionState === 'missing') {
      return {
        data: buildEmptyPortfolioSnapshot(exchange),
        ...createRouteMeta({
          routeStatus: 'no_connection',
          warningMessage: '거래소 연결이 없어 polling fallback 상태로 표시합니다.',
          unavailableReason: 'no_connection',
        }),
      };
    }

    if (connectionState === 'unverified') {
      return {
        data: buildEmptyPortfolioSnapshot(exchange),
        ...createRouteMeta({
          routeStatus: 'connection_exists_but_unverified',
          warningMessage: '거래소 연결은 저장되었지만 아직 검증되지 않았습니다.',
          unavailableReason: 'connection_exists_but_unverified',
        }),
      };
    }

    throw error;
  }
}

export async function getAssetHistoryRouteResponse(
  userId: string,
  exchange: ExchangeId,
  symbol?: string,
  limit?: number,
): Promise<PortfolioRouteResponse<PortfolioHistoryItem[]>> {
  try {
    return {
      data: await getAssetHistory(userId, exchange, symbol, limit),
      ...createRouteMeta({ routeStatus: 'ok' }),
    };
  } catch (error) {
    const connectionState = await classifyConnectionState(userId, exchange);
    if (connectionState === 'missing') {
      return {
        data: [],
        ...createRouteMeta({
          routeStatus: 'no_connection',
          warningMessage: '거래소 연결이 없어 자산 이력 대신 빈 응답을 반환합니다.',
          unavailableReason: 'no_connection',
        }),
      };
    }

    if (connectionState === 'unverified') {
      return {
        data: [],
        ...createRouteMeta({
          routeStatus: 'connection_exists_but_unverified',
          warningMessage: '거래소 연결은 존재하지만 아직 검증되지 않아 자산 이력을 불러오지 못했습니다.',
          unavailableReason: 'connection_exists_but_unverified',
        }),
      };
    }

    throw error;
  }
}
