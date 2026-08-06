export function getBestConcurrencyCount(proxyCount: number): number {
  return proxyCount > 5 ? proxyCount - 3 : Math.max(proxyCount - 2, 1);
}
