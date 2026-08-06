import { describe, expect, it } from 'vitest';
import { getBestConcurrencyCount } from '~/utils/concurrency';

describe('getBestConcurrencyCount', () => {
  it.each([
    [0, 1],
    [1, 1],
    [2, 1],
    [5, 3],
    [6, 3],
    [12, 9],
  ])('maps %i proxies to %i workers', (proxyCount, expected) => {
    expect(getBestConcurrencyCount(proxyCount)).toBe(expected);
  });
});
