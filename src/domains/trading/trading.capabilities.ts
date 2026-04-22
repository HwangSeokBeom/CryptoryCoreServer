import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import type { ExchangeId } from '../../core/exchange/exchange.types';

export type TradingFeature = 'chance' | 'openOrders' | 'fills' | 'privateWs';
export type TradingPermission = 'read' | 'trade';
export type TradingSupportStatus = 'supported' | 'not_supported' | 'not_implemented';

type TradingFeatureCapability = {
  supported: boolean;
  status: TradingSupportStatus;
  requiredPermission: TradingPermission;
  requiredPermissionScope: TradingPermission[];
  requiredExchangePermissions: string[];
  notes?: string;
};

export type TradingExchangeCapability = {
  exchange: ExchangeId;
  chance: TradingFeatureCapability;
  openOrders: TradingFeatureCapability;
  fills: TradingFeatureCapability;
  privateWs: TradingFeatureCapability & {
    mode: 'server_side_polling' | 'unsupported';
    channels: Array<'orders' | 'fills' | 'portfolio'>;
  };
};

const PERMISSIONS: Record<ExchangeId, Record<TradingFeature, string[]>> = {
  upbit: {
    chance: ['자산 조회', '주문 조회', '주문하기'],
    openOrders: ['주문 조회'],
    fills: ['주문 조회'],
    privateWs: ['자산 조회', '주문 조회'],
  },
  bithumb: {
    chance: ['자산 조회', '주문 조회', '거래'],
    openOrders: ['주문 조회'],
    fills: ['주문 조회'],
    privateWs: ['자산 조회', '주문 조회'],
  },
  coinone: {
    chance: ['주문'],
    openOrders: ['주문조회'],
    fills: ['주문조회'],
    privateWs: ['조회', '주문조회'],
  },
  korbit: {
    chance: ['주문'],
    openOrders: ['주문 조회'],
    fills: ['주문 조회'],
    privateWs: ['잔고 조회', '주문 조회'],
  },
  binance: {
    chance: ['Enable Reading', 'Enable Spot & Margin Trading'],
    openOrders: ['Enable Reading'],
    fills: ['Enable Reading'],
    privateWs: ['Enable Reading'],
  },
};

function hasCapability(exchange: ExchangeId, capability: string) {
  return EXCHANGE_METADATA[exchange].capabilities.includes(capability as never);
}

function buildCapability(
  exchange: ExchangeId,
  feature: TradingFeature,
  capability: string,
  requiredPermission: TradingPermission,
  notes?: string,
): TradingFeatureCapability {
  const supported = hasCapability(exchange, capability);
  return {
    supported,
    status: supported ? 'supported' : 'not_supported',
    requiredPermission,
    requiredPermissionScope: requiredPermission === 'trade' ? ['read', 'trade'] : ['read'],
    requiredExchangePermissions: PERMISSIONS[exchange][feature],
    notes,
  };
}

export function getTradingExchangeCapability(exchange: ExchangeId): TradingExchangeCapability {
  const privateWsSupported =
    hasCapability(exchange, 'stream:private:orders') || hasCapability(exchange, 'stream:private:assets');

  return {
    exchange,
    chance: buildCapability(
      exchange,
      'chance',
      'trading:order-chance',
      'trade',
      exchange === 'coinone' || exchange === 'korbit'
        ? 'Canonical chance endpoint is not implemented for this exchange.'
        : undefined,
    ),
    openOrders: buildCapability(exchange, 'openOrders', 'trading:list-open-orders', 'read'),
    fills: buildCapability(exchange, 'fills', 'trading:list-fills', 'read'),
    privateWs: {
      supported: privateWsSupported,
      status: privateWsSupported ? 'supported' : 'not_supported',
      requiredPermission: 'read',
      requiredPermissionScope: ['read'],
      requiredExchangePermissions: PERMISSIONS[exchange].privateWs,
      mode: privateWsSupported ? 'server_side_polling' : 'unsupported',
      channels: privateWsSupported ? ['orders', 'fills', 'portfolio'] : [],
      notes: privateWsSupported
        ? 'Server private websocket accepts client subscriptions and polls private REST providers.'
        : 'Private trading websocket is not supported for this exchange.',
    },
  };
}

export function getTradingFeatureCapability(exchange: ExchangeId, feature: TradingFeature) {
  return getTradingExchangeCapability(exchange)[feature];
}
