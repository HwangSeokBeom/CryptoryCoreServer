export function safeNumber(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortAsks(levels: Array<{ price: number; quantity: number }>, depth = 15) {
  return levels
    .filter((entry) => entry.price > 0 && entry.quantity >= 0)
    .sort((left, right) => left.price - right.price)
    .slice(0, depth);
}

export function sortBids(levels: Array<{ price: number; quantity: number }>, depth = 15) {
  return levels
    .filter((entry) => entry.price > 0 && entry.quantity >= 0)
    .sort((left, right) => right.price - left.price)
    .slice(0, depth);
}
