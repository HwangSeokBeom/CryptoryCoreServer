import { ExchangeCapabilityError } from '../../core/exchange/errors';
import type { ExchangeId, PortfolioSnapshot, QuoteCurrency } from '../../core/exchange/exchange.types';
import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { AppError } from '../../utils/errors';
import {
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
  return executePortfolioOperation(userId, exchange, '자산 스냅샷 조회에 실패했습니다.', async () =>
    provider.getPortfolioSnapshot(await getPortfolioContext(userId, exchange)),
  );
}

export async function getAggregatedPortfolioSummary(
  userId: string,
  exchange?: ExchangeId,
): Promise<PortfolioSummary> {
  const requestedExchanges = exchange
    ? [exchange]
    : (await listUserVerifiedExchangeConnections(userId)).map((connection) => connection.exchange as ExchangeId);

  if (requestedExchanges.length === 0) {
    return {
      requestedExchanges: [],
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

  return executePortfolioOperation(userId, exchange, '자산 변동 내역 조회에 실패했습니다.', async () =>
    provider.getAssetHistory!(symbol, limit, await getPortfolioContext(userId, exchange)),
  );
}
