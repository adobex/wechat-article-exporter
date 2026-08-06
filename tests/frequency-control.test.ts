import { describe, expect, it, vi } from 'vitest';
import {
  FREQUENCY_CONTROL_RET,
  retryFrequencyControlledRequest,
  waitForFrequencyControlBackoff,
} from '../shared/utils/frequency-control';

function response(ret: number) {
  return { base_resp: { ret } };
}

describe('frequency-control retry', () => {
  it('waits through the configured backoff and returns the first successful retry', async () => {
    const requestPage = vi
      .fn()
      .mockResolvedValueOnce(response(FREQUENCY_CONTROL_RET))
      .mockResolvedValueOnce(response(FREQUENCY_CONTROL_RET))
      .mockResolvedValueOnce(response(0));
    const waits: number[] = [];
    const backoffs: Array<[number, number]> = [];

    const result = await retryFrequencyControlledRequest(requestPage, {
      backoffMs: [30, 60, 120],
      onBackoff: (delayMs, attempt) => backoffs.push([delayMs, attempt]),
      wait: async delayMs => {
        waits.push(delayMs);
      },
    });

    expect(result.base_resp.ret).toBe(0);
    expect(requestPage).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([30, 60]);
    expect(backoffs).toEqual([
      [30, 1],
      [60, 2],
    ]);
  });

  it('returns the final frequency-control response only after exhausting backoff', async () => {
    const requestPage = vi.fn().mockResolvedValue(response(FREQUENCY_CONTROL_RET));
    const waits: number[] = [];

    const result = await retryFrequencyControlledRequest(requestPage, {
      backoffMs: [30, 60, 120],
      wait: async delayMs => {
        waits.push(delayMs);
      },
    });

    expect(result.base_resp.ret).toBe(FREQUENCY_CONTROL_RET);
    expect(requestPage).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([30, 60, 120]);
  });

  it('supports immediate failover without retrying an interactive request', async () => {
    const requestPage = vi.fn().mockResolvedValue(response(FREQUENCY_CONTROL_RET));
    const wait = vi.fn();

    const result = await retryFrequencyControlledRequest(requestPage, {
      backoffMs: [],
      wait,
    });

    expect(result.base_resp.ret).toBe(FREQUENCY_CONTROL_RET);
    expect(requestPage).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('cancels a pending backoff without issuing another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const requestPage = vi.fn().mockResolvedValue(response(FREQUENCY_CONTROL_RET));
    const pending = retryFrequencyControlledRequest(requestPage, {
      backoffMs: [30_000],
      signal: controller.signal,
      wait: waitForFrequencyControlBackoff,
    });

    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestPage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
