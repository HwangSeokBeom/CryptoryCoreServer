import { logger } from '../../utils/logger';
import { DEFAULT_RETRY_POLICY, delay, getRetryDelay, type RetryPolicy } from './retry-policy';
import { ExchangeRequestError } from './errors';
import type { ExchangeId } from './exchange.types';

export interface RestRequestOptions extends Omit<RequestInit, 'body'> {
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined>;
  json?: unknown;
  form?: Record<string, string | number | boolean | undefined>;
  retryPolicy?: Partial<RetryPolicy>;
  timeoutMs?: number;
}

function buildUrl(baseUrl: string, path: string, query?: RestRequestOptions['query']) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        value.forEach((item) => url.searchParams.append(key, String(item)));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function buildFormBody(form?: RestRequestOptions['form']) {
  if (!form) return undefined;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  return params.toString();
}

function parseRetryAfter(retryAfter: string | null) {
  if (!retryAfter) return null;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = new Date(retryAfter).getTime();
  if (!Number.isNaN(retryAt)) {
    return Math.max(retryAt - Date.now(), 0);
  }

  return null;
}

async function parseResponseBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
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
    const formBody = buildFormBody(options.form);

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            accept: 'application/json',
            ...(options.json ? { 'content-type': 'application/json' } : {}),
            ...(formBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            ...(options.headers ?? {}),
          },
          body: options.json ? JSON.stringify(options.json) : formBody,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const responseBody = await response.text();
          const retryable = policy.retryableStatusCodes.includes(response.status);
          if (retryable && attempt < policy.maxAttempts) {
            const retryDelayMs = parseRetryAfter(response.headers.get('retry-after')) ?? getRetryDelay(policy, attempt);
            logger.warn(
              {
                domain: 'exchange-rest',
                owner: this.owner,
                url,
                attempt,
                upstreamStatus: response.status,
                retry: true,
                retryDelayMs,
              },
              'Retrying exchange REST request after upstream failure',
            );
            await delay(retryDelayMs);
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

        return await parseResponseBody<T>(response);
      } catch (error) {
        clearTimeout(timeout);
        if (attempt >= policy.maxAttempts) {
          throw error;
        }

        logger.warn(
          { domain: 'exchange-rest', owner: this.owner, url, attempt, retry: true, err: error },
          'Retrying exchange REST request',
        );
        await delay(getRetryDelay(policy, attempt));
      }
    }

    throw new ExchangeRequestError(this.owner, 500, url, 'Unexpected exchange request failure');
  }
}
