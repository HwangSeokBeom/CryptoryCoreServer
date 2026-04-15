const PREMIUMS: Record<string, number> = {
  upbit: 1.035,
  bithumb: 1.032,
  coinone: 1.028,
  korbit: 1.025,
  binance: 1.0,
};

export function genPrice(base: number, exchangeId: string, variance = 0.002): number {
  const premium = PREMIUMS[exchangeId] ?? 1;
  const r = 1 + (Math.random() - 0.5) * variance * 2;
  return Math.round(base * premium * r * 100) / 100;
}

export function genChange(): number {
  return (Math.random() - 0.45) * 10;
}

export function genVolume(base: number): number {
  return Math.round(base * (0.5 + Math.random()) * 1_000_000);
}
