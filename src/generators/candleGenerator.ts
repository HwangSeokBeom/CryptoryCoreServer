export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function genCandleData(base: number, count = 60): CandleData[] {
  const data: CandleData[] = [];
  let price = base;
  for (let i = count; i >= 0; i--) {
    const open = price;
    const change = (Math.random() - 0.48) * price * 0.015;
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * price * 0.005;
    const low = Math.min(open, close) - Math.random() * price * 0.005;
    const vol = Math.round(Math.random() * 1000 + 100);
    data.push({ time: i, open, high, low, close, volume: vol });
    price = close;
  }
  return data;
}
