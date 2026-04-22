import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import type {
  ExchangeCapabilitySummary,
  ExchangeCredentialField,
  ExchangeId,
  ExchangePermissionGuide,
} from '../../modules/private-account/exchange-connections.contract';
import { AppError } from '../../utils/errors';
import { getTradingExchangeCapability } from '../trading/trading.capabilities';

export type ExchangeGuide = {
  exchange: ExchangeId;
  displayName: string;
  credentialFields: ExchangeCredentialField[];
  permissionGuides: ExchangePermissionGuide[];
  issueGuideSummary: string;
  apiGuideUrl: string;
  recommendedPermissions: string[];
  cautions: string[];
  requiresIpWhitelist: boolean;
  capabilities: ExchangeCapabilitySummary;
};

const EXCHANGE_GUIDES: Record<ExchangeId, Omit<ExchangeGuide, 'capabilities'>> = {
  upbit: {
    exchange: 'upbit',
    displayName: '업비트',
    credentialFields: [
      { key: 'apiKey', requestKey: 'accessKey', label: 'Access Key', required: true, masked: true },
      { key: 'secretKey', requestKey: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    permissionGuides: [
      { key: 'read_only', label: '조회 전용', description: '잔고와 체결 내역 조회에 필요한 최소 권한입니다.', requiredPermissions: ['자산 조회', '주문 조회'] },
      { key: 'trade_enabled', label: '주문 가능', description: '조회 전용 권한에 주문하기 권한을 추가합니다.', requiredPermissions: ['자산 조회', '주문 조회', '주문하기'] },
    ],
    issueGuideSummary: '업비트 고객센터의 Open API 안내를 따라 개발자 센터를 확인하고 Open API 관리 페이지에서 Key를 발급받습니다.',
    apiGuideUrl: 'https://support.upbit.com/hc/ko/articles/49411138468761-%EC%97%85%EB%B9%84%ED%8A%B8-API%EB%9E%80-%EB%AC%B4%EC%97%87%EC%9D%B8%EA%B0%80%EC%9A%94-%EC%96%B4%EB%96%BB%EA%B2%8C-%EC%8B%9C%EC%9E%91%ED%95%98%EB%82%98%EC%9A%94',
    recommendedPermissions: ['자산 조회', '주문 조회', '주문하기'],
    cautions: ['출금 권한은 활성화하지 않는 것을 권장합니다.', '주문 전용 키를 별도로 분리하는 것이 안전합니다.'],
    requiresIpWhitelist: false,
  },
  bithumb: {
    exchange: 'bithumb',
    displayName: '빗썸',
    credentialFields: [
      { key: 'apiKey', requestKey: 'accessKey', label: 'Connect Key', required: true, masked: true },
      { key: 'secretKey', requestKey: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    permissionGuides: [
      { key: 'read_only', label: '조회 전용', description: '잔고 및 주문 조회 권한만 허용합니다.', requiredPermissions: ['자산 조회', '주문 조회'] },
      { key: 'trade_enabled', label: '주문 가능', description: '조회 권한에 거래 권한을 추가합니다.', requiredPermissions: ['자산 조회', '주문 조회', '거래'] },
    ],
    issueGuideSummary: '빗썸 고객센터의 API 2.0 Key 발급 안내를 따라 API 관리 메뉴에서 Connect Key와 Secret Key를 발급받습니다.',
    apiGuideUrl: 'https://support.bithumb.com/hc/ko/articles/52815899880345',
    recommendedPermissions: ['자산 조회', '주문 조회', '거래'],
    cautions: ['출금 관련 권한은 비활성화 권장입니다.', 'IP 제한을 사용하는 경우 서버 IP를 함께 등록해야 합니다.'],
    requiresIpWhitelist: true,
  },
  coinone: {
    exchange: 'coinone',
    displayName: '코인원',
    credentialFields: [
      { key: 'apiKey', requestKey: 'accessToken', label: 'Access Token', required: true, masked: true },
      { key: 'secretKey', requestKey: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    permissionGuides: [
      { key: 'read_only', label: '조회 전용', description: '조회 권한으로 잔고와 주문 이력을 확인합니다.', requiredPermissions: ['조회'] },
      { key: 'trade_enabled', label: '주문 가능', description: '조회 권한에 주문 권한을 추가합니다.', requiredPermissions: ['조회', '주문'] },
    ],
    issueGuideSummary: '코인원 웹에서 Open API > API 관리 메뉴로 이동해 Access Token과 Secret Key를 발급받습니다.',
    apiGuideUrl: 'https://support.coinone.co.kr/support/solutions/articles/31000172450-%ED%8F%AC%ED%8A%B8%ED%8F%B4%EB%A6%AC%EC%98%A4-%ED%99%9C%EC%9A%A9%ED%95%98%EA%B8%B0',
    recommendedPermissions: ['조회', '주문'],
    cautions: ['출금 권한은 비권장입니다.', '토큰 재발급 시 기존 연결을 다시 검증해야 합니다.'],
    requiresIpWhitelist: false,
  },
  korbit: {
    exchange: 'korbit',
    displayName: '코빗',
    credentialFields: [
      { key: 'apiKey', requestKey: 'accessKey', label: 'API Key', required: true, masked: true },
      { key: 'secretKey', requestKey: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    permissionGuides: [
      { key: 'read_only', label: '조회 전용', description: '잔고 및 주문 조회 권한만 요구합니다.', requiredPermissions: ['잔고 조회', '주문 조회'] },
      { key: 'trade_enabled', label: '주문 가능', description: '조회 권한에 주문 권한을 추가합니다.', requiredPermissions: ['잔고 조회', '주문 조회', '주문'] },
    ],
    issueGuideSummary: '코빗은 개발자 콘솔이 종료되었으며, 현재는 내 계정의 API 관리 페이지에서 API Key를 생성합니다.',
    apiGuideUrl: 'https://exchange.korbit.co.kr/my/api',
    recommendedPermissions: ['잔고 조회', '주문 조회', '주문'],
    cautions: ['IP 허용 목록을 사용하는 경우 서버 출발지 IP를 등록해야 합니다.', '출금 권한은 비권장입니다.'],
    requiresIpWhitelist: true,
  },
  binance: {
    exchange: 'binance',
    displayName: '바이낸스',
    credentialFields: [
      { key: 'apiKey', requestKey: 'accessKey', label: 'API Key', required: true, masked: true },
      { key: 'secretKey', requestKey: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    permissionGuides: [
      { key: 'read_only', label: '조회 전용', description: 'Enable Reading 권한만으로 조회 기능을 사용할 수 있습니다.', requiredPermissions: ['Enable Reading'] },
      { key: 'trade_enabled', label: '주문 가능', description: '읽기 권한에 Spot 거래 권한을 추가합니다.', requiredPermissions: ['Enable Reading', 'Enable Spot & Margin Trading'] },
    ],
    issueGuideSummary: '바이낸스 API Management에서 API Key와 Secret Key를 발급하고 Spot 권한을 활성화합니다.',
    apiGuideUrl: 'https://www.binance.com/en/my/settings/api-management',
    recommendedPermissions: ['Enable Reading', 'Enable Spot & Margin Trading'],
    cautions: ['Withdrawals 권한은 활성화하지 않는 것을 권장합니다.', 'IP 화이트리스트 사용 시 서버 IP를 정확히 등록해야 합니다.'],
    requiresIpWhitelist: true,
  },
};

function hasCapability(exchange: ExchangeId, capability: string) {
  return EXCHANGE_METADATA[exchange].capabilities.includes(capability as never);
}

export function getExchangeCapabilitySummary(exchange: ExchangeId): ExchangeCapabilitySummary {
  const trading = getTradingExchangeCapability(exchange);
  return {
    canTestConnection: true,
    canReadPortfolio: hasCapability(exchange, 'portfolio:balances'),
    canReadOrderChance: trading.chance.supported,
    canPlaceOrder: hasCapability(exchange, 'trading:create-order'),
    canCancelOrder: hasCapability(exchange, 'trading:cancel-order'),
    canReadOpenOrders: trading.openOrders.supported,
    canReadFills: trading.fills.supported,
    canUsePrivateWebSocket: trading.privateWs.supported,
    privateWebSocketMode: trading.privateWs.mode,
    requiredPermissionScopes: {
      chance: trading.chance.requiredPermissionScope,
      openOrders: trading.openOrders.requiredPermissionScope,
      fills: trading.fills.requiredPermissionScope,
      privateWs: trading.privateWs.requiredPermissionScope,
    },
  };
}

export function getExchangeCredentialFields(exchange: ExchangeId) {
  const guide = EXCHANGE_GUIDES[exchange];
  if (!guide) {
    throw new AppError(404, '지원하지 않는 거래소 메타데이터입니다');
  }
  return guide.credentialFields;
}

export function getExchangeGuide(exchange: ExchangeId): ExchangeGuide {
  const guide = EXCHANGE_GUIDES[exchange];
  if (!guide) {
    throw new AppError(404, '지원하지 않는 거래소 메타데이터입니다');
  }
  return {
    ...guide,
    capabilities: getExchangeCapabilitySummary(exchange),
  };
}

export function getExchangePermissionGuides(exchange: ExchangeId) {
  const guide = EXCHANGE_GUIDES[exchange];
  if (!guide) {
    throw new AppError(404, '지원하지 않는 거래소 메타데이터입니다');
  }
  return guide.permissionGuides;
}

export function listExchangeGuides(): ExchangeGuide[] {
  return (Object.keys(EXCHANGE_GUIDES) as ExchangeId[]).map((exchange) => getExchangeGuide(exchange));
}
