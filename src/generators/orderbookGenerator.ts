export interface OrderEntry {
  price: number;
  qty: number;
}

export interface OrderbookData {
  asks: OrderEntry[];
  bids: OrderEntry[];
}

export function genOrderbook(price: number, depth = 10): OrderbookData {
  const asks: OrderEntry[] = [];
  const bids: OrderEntry[] = [];
  for (let i = 1; i <= depth; i++) {
    asks.push({
      price: price * (1 + i * 0.001),
      qty: Math.random() * 5 + 0.1,
    });
    bids.push({
      price: price * (1 - i * 0.001),
      qty: Math.random() * 5 + 0.1,
    });
  }
  return { asks: asks.reverse(), bids };
}
