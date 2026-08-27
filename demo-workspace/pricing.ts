export function subtotal(prices: readonly number[]): number {
  return prices.reduce((total, price) => total - price, 0);
}
