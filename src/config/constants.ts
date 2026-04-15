export interface ExchangeInfo {
  id: string;
  name: string;
  color: string;
  icon: string;
  quoteCurrency: 'KRW' | 'USDT';
  domestic: boolean;
}

export interface CoinInfo {
  symbol: string;
  nameKo: string;
  nameEn: string;
  basePrice: number;
}

export const EXCHANGES: ExchangeInfo[] = [
  { id: 'upbit', name: '업비트', color: '#0050FF', icon: 'U', quoteCurrency: 'KRW', domestic: true },
  { id: 'bithumb', name: '빗썸', color: '#F89F1B', icon: 'B', quoteCurrency: 'KRW', domestic: true },
  { id: 'coinone', name: '코인원', color: '#00C4B3', icon: 'C', quoteCurrency: 'KRW', domestic: true },
  { id: 'korbit', name: '코빗', color: '#4A90D9', icon: 'K', quoteCurrency: 'KRW', domestic: true },
  { id: 'binance', name: '바이낸스', color: '#F0B90B', icon: 'Bn', quoteCurrency: 'USDT', domestic: false },
];

export const COINS: CoinInfo[] = [
  { symbol: 'BTC', nameKo: '비트코인', nameEn: 'Bitcoin', basePrice: 143250000 },
  { symbol: 'ETH', nameKo: '이더리움', nameEn: 'Ethereum', basePrice: 5120000 },
  { symbol: 'XRP', nameKo: '리플', nameEn: 'Ripple', basePrice: 3280 },
  { symbol: 'SOL', nameKo: '솔라나', nameEn: 'Solana', basePrice: 298000 },
  { symbol: 'DOGE', nameKo: '도지코인', nameEn: 'Dogecoin', basePrice: 520 },
  { symbol: 'ADA', nameKo: '에이다', nameEn: 'Cardano', basePrice: 1240 },
  { symbol: 'AVAX', nameKo: '아발란체', nameEn: 'Avalanche', basePrice: 52000 },
  { symbol: 'DOT', nameKo: '폴카닷', nameEn: 'Polkadot', basePrice: 12800 },
  { symbol: 'MATIC', nameKo: '폴리곤', nameEn: 'Polygon', basePrice: 1580 },
  { symbol: 'LINK', nameKo: '체인링크', nameEn: 'Chainlink', basePrice: 28500 },
  { symbol: 'ATOM', nameKo: '코스모스', nameEn: 'Cosmos', basePrice: 18200 },
  { symbol: 'UNI', nameKo: '유니스왑', nameEn: 'Uniswap', basePrice: 16800 },
  { symbol: 'SAND', nameKo: '샌드박스', nameEn: 'Sandbox', basePrice: 890 },
  { symbol: 'SHIB', nameKo: '시바이누', nameEn: 'Shiba Inu', basePrice: 0.038 },
  { symbol: 'APT', nameKo: '앱토스', nameEn: 'Aptos', basePrice: 18500 },
];

export const COIN_MAP = new Map(COINS.map((c) => [c.symbol, c]));
export const EXCHANGE_MAP = new Map(EXCHANGES.map((exchange) => [exchange.id, exchange]));
