export const FREQUENCY_CONTROL_RET = 200013;
export const FREQUENCY_CONTROL_BACKOFF_MS = [30_000, 60_000, 120_000] as const;

interface FrequencyControlResponse {
  base_resp: {
    ret: number;
  };
}

interface FrequencyControlRetryOptions {
  backoffMs?: readonly number[];
  onBackoff?: (delayMs: number, attempt: number) => void;
  signal?: AbortSignal;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason || new DOMException('The operation was aborted', 'AbortError');
}

export function waitForFrequencyControlBackoff(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const abortSignal = signal;
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      if (abortSignal) reject(abortReason(abortSignal));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryFrequencyControlledRequest<T extends FrequencyControlResponse>(
  requestPage: () => Promise<T>,
  options: FrequencyControlRetryOptions = {}
): Promise<T> {
  const backoffMs = options.backoffMs || FREQUENCY_CONTROL_BACKOFF_MS;
  const wait = options.wait || waitForFrequencyControlBackoff;

  for (const [index, delayMs] of backoffMs.entries()) {
    const response = await requestPage();
    if (response.base_resp.ret !== FREQUENCY_CONTROL_RET) return response;
    options.onBackoff?.(delayMs, index + 1);
    await wait(delayMs, options.signal);
  }

  return requestPage();
}
