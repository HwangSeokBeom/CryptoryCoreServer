const QUOTE_PREFIXES = ['KRW', 'USD', 'USDT', 'USDC', 'BTC', 'ETH'];

export function normalizeCoinSymbol(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('/')) {
    return normalized.split('/')[0].replace(/[^A-Z0-9]+/g, '');
  }

  const dashed = normalized.match(/^([A-Z0-9]+)-([A-Z0-9]+)$/);
  if (dashed) {
    const [, left, right] = dashed;
    return QUOTE_PREFIXES.includes(left) ? right : left;
  }

  return normalized.replace(/[^A-Z0-9]+/g, '');
}

export function isValidNormalizedCoinSymbol(value: string) {
  return /^[A-Z0-9]{1,20}$/.test(value);
}
