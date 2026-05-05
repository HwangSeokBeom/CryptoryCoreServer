export type FeatureFlagEnvironment = Partial<Record<
  | 'APP_STORE_REVIEW_MODE'
  | 'FEATURE_ORDER_ENABLED'
  | 'FEATURE_TRADING_ENABLED'
  | 'FEATURE_TRANSFER_ENABLED'
  | 'FEATURE_DEPOSIT_WITHDRAW_ENABLED'
  | 'FEATURE_WALLET_ENABLED'
  | 'FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED'
  | 'FEATURE_MARKET_ENABLED'
  | 'FEATURE_CHART_ENABLED'
  | 'FEATURE_NEWS_ENABLED'
  | 'FEATURE_READ_ONLY_PORTFOLIO_ENABLED'
  | 'FEATURE_KIMCHI_PREMIUM_ENABLED'
  | 'FEATURE_COMMUNITY_CONTENT_ENABLED'
  | 'FEATURE_COIN_INFO_ENABLED'
  | 'FEATURE_MARKET_TRENDS_ENABLED'
  | 'FEATURE_MARKET_THEMES_ENABLED'
  | 'FEATURE_ANALYSIS_REFERENCE_DATA_ENABLED',
  string | boolean | undefined
>>;

export type FeatureFlags = {
  appStoreReviewMode: boolean;
  isMarketEnabled: boolean;
  isChartEnabled: boolean;
  isNewsEnabled: boolean;
  isReadOnlyPortfolioEnabled: boolean;
  isKimchiPremiumEnabled: boolean;
  isCommunityContentEnabled: boolean;
  isCoinInfoEnabled: boolean;
  isMarketTrendsEnabled: boolean;
  isMarketThemesEnabled: boolean;
  isAnalysisReferenceDataEnabled: boolean;
  isOrderEnabled: boolean;
  isTradingEnabled: boolean;
  isTransferEnabled: boolean;
  isDepositWithdrawEnabled: boolean;
  isWalletEnabled: boolean;
  isPrivateExchangeTradingAPIEnabled: boolean;
};

function readBoolean(value: string | boolean | undefined, defaultValue: boolean) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function calculateFeatureFlags(source: FeatureFlagEnvironment): FeatureFlags {
  const appStoreReviewMode = readBoolean(source.APP_STORE_REVIEW_MODE, false);

  const enabled = {
    isMarketEnabled: readBoolean(source.FEATURE_MARKET_ENABLED, true),
    isChartEnabled: readBoolean(source.FEATURE_CHART_ENABLED, true),
    isNewsEnabled: readBoolean(source.FEATURE_NEWS_ENABLED, true),
    isReadOnlyPortfolioEnabled: readBoolean(source.FEATURE_READ_ONLY_PORTFOLIO_ENABLED, true),
    isKimchiPremiumEnabled: readBoolean(source.FEATURE_KIMCHI_PREMIUM_ENABLED, true),
    isCommunityContentEnabled: readBoolean(source.FEATURE_COMMUNITY_CONTENT_ENABLED, true),
    isCoinInfoEnabled: readBoolean(source.FEATURE_COIN_INFO_ENABLED, true),
    isMarketTrendsEnabled: readBoolean(source.FEATURE_MARKET_TRENDS_ENABLED, true),
    isMarketThemesEnabled: readBoolean(source.FEATURE_MARKET_THEMES_ENABLED, true),
    isAnalysisReferenceDataEnabled: readBoolean(source.FEATURE_ANALYSIS_REFERENCE_DATA_ENABLED, true),
    isOrderEnabled: readBoolean(source.FEATURE_ORDER_ENABLED, true),
    isTradingEnabled: readBoolean(source.FEATURE_TRADING_ENABLED, true),
    isTransferEnabled: readBoolean(source.FEATURE_TRANSFER_ENABLED, true),
    isDepositWithdrawEnabled: readBoolean(source.FEATURE_DEPOSIT_WITHDRAW_ENABLED, true),
    isWalletEnabled: readBoolean(source.FEATURE_WALLET_ENABLED, true),
    isPrivateExchangeTradingAPIEnabled: readBoolean(source.FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED, true),
  };

  if (!appStoreReviewMode) {
    return {
      appStoreReviewMode,
      ...enabled,
    };
  }

  return {
    appStoreReviewMode,
    isMarketEnabled: true,
    isChartEnabled: true,
    isNewsEnabled: true,
    isReadOnlyPortfolioEnabled: true,
    isKimchiPremiumEnabled: true,
    isCommunityContentEnabled: true,
    isCoinInfoEnabled: true,
    isMarketTrendsEnabled: true,
    isMarketThemesEnabled: true,
    isAnalysisReferenceDataEnabled: true,
    isOrderEnabled: false,
    isTradingEnabled: false,
    isTransferEnabled: false,
    isDepositWithdrawEnabled: false,
    isWalletEnabled: false,
    isPrivateExchangeTradingAPIEnabled: false,
  };
}

export const featureFlags = calculateFeatureFlags({
  APP_STORE_REVIEW_MODE: process.env.APP_STORE_REVIEW_MODE,
  FEATURE_ORDER_ENABLED: process.env.FEATURE_ORDER_ENABLED,
  FEATURE_TRADING_ENABLED: process.env.FEATURE_TRADING_ENABLED,
  FEATURE_TRANSFER_ENABLED: process.env.FEATURE_TRANSFER_ENABLED,
  FEATURE_DEPOSIT_WITHDRAW_ENABLED: process.env.FEATURE_DEPOSIT_WITHDRAW_ENABLED,
  FEATURE_WALLET_ENABLED: process.env.FEATURE_WALLET_ENABLED,
  FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED: process.env.FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED,
  FEATURE_MARKET_ENABLED: process.env.FEATURE_MARKET_ENABLED,
  FEATURE_CHART_ENABLED: process.env.FEATURE_CHART_ENABLED,
  FEATURE_NEWS_ENABLED: process.env.FEATURE_NEWS_ENABLED,
  FEATURE_READ_ONLY_PORTFOLIO_ENABLED: process.env.FEATURE_READ_ONLY_PORTFOLIO_ENABLED,
  FEATURE_KIMCHI_PREMIUM_ENABLED: process.env.FEATURE_KIMCHI_PREMIUM_ENABLED,
  FEATURE_COMMUNITY_CONTENT_ENABLED: process.env.FEATURE_COMMUNITY_CONTENT_ENABLED,
  FEATURE_COIN_INFO_ENABLED: process.env.FEATURE_COIN_INFO_ENABLED,
  FEATURE_MARKET_TRENDS_ENABLED: process.env.FEATURE_MARKET_TRENDS_ENABLED,
  FEATURE_MARKET_THEMES_ENABLED: process.env.FEATURE_MARKET_THEMES_ENABLED,
  FEATURE_ANALYSIS_REFERENCE_DATA_ENABLED: process.env.FEATURE_ANALYSIS_REFERENCE_DATA_ENABLED,
});
