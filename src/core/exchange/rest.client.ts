import { logger } from '../../utils/logger';
import { DEFAULT_RETRY_POLICY, delay, getRetryDelay, type RetryPolicy } from './retry-policy';
import { ExchangeRequestError } from './errors';
import type { ExchangeId } from './exchange.types';

export interface RestRequestOptions extends Omit<RequestInit, 'body'> {
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
  json?: unknown;
  retryPolicy?: Partial<RetryPolicy>;
  timeoutMs?: number;
}

function buildUrl(baseUrl: string, path: string, query?: RestRequestOptions['query']) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export class RestClient {
  constructor(
    private readonly owner: ExchangeId | 'fx',
    private readonly baseUrl: string,
  ) {}

  async request<T>(path: string, options: RestRequestOptions = {}): Promise<T> {
    const policy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retryPolicy,
    };
    const url = buildUrl(this.baseUrl, path, options.query);

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            accept: 'application/json',
            ...(options.json ? { 'content-type': 'application/json' } : {}),
            ...(options.headers ?? {}),
          },
          body: options.json ? JSON.stringify(options.json) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const responseBody = await response.text();
          const retryable = policy.retryableStatusCodes.includes(response.status);
          if (retryable && attempt < policy.maxAttempts) {
            await delay(getRetryDelay(policy, attempt));
            continue;
          }

          throw new ExchangeRequestError(
            this.owner,
            response.status,
            url,
            `${this.owner} request failed with HTTP ${response.status}`,
            responseBody,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timeout);
        if (attempt >= policy.maxAttempts) {
          throw error;
        }

        logger.warn(
          { domain: 'exchange-rest', owner: this.owner, url, attempt, err: error },
          'Retrying exchange REST request',
        );
        await delay(getRetryDelay(policy, attempt));
      }
    }

    throw new ExchangeRequestError(this.owner, 500, url, 'Unexpected exchange request failure');
  }
}
