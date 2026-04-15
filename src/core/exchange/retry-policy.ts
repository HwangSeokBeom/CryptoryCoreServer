export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatusCodes: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 2_000,
  retryableStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
};

export async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRetryDelay(policy: RetryPolicy, attempt: number) {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(attempt - 1, 0), policy.maxDelayMs);
}
