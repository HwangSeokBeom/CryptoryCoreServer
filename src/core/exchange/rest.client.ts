import { logger } from '../../utils/logger';
import { sanitizeSensitiveText } from '../../domains/security/credential-security.service';
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

export type RestResponseMeta = {
  owner: ExchangeId | 'fx' | 'coingecko';
  path: string;
  requestUrl: string;
  statusCode: number;
  responseSnippet: string | null;
};

export type RestResponseWithMeta<T> = {
  data: T;
  meta: RestResponseMeta;
};

function isAbsoluteUrl(path: string) {
  try {
    const parsed = new URL(path);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function applyQuery(url: URL, query?: RestRequestOptions['query']) {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      url.searchParams.delete(key);
      value.forEach((item) => url.searchParams.append(key, String(item)));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function joinPathname(basePathname: string, requestPathname: string) {
  const normalizedBase = basePathname.replace(/\/+$/g, '');
  const normalizedRequest = requestPathname.replace(/^\/+/g, '');
  if (!normalizedBase && !normalizedRequest) {
    return '/';
  }
  if (!normalizedBase) {
    return `/${normalizedRequest}`;
  }
  if (!normalizedRequest) {
    return normalizedBase.startsWith('/') ? normalizedBase : `/${normalizedBase}`;
  }
  const combined = `${normalizedBase}/${normalizedRequest}`.replace(/\/{2,}/g, '/');
  return combined.startsWith('/') ? combined : `/${combined}`;
}

function toRelativeUrl(path: string) {
  const normalizedPath = path.trim();
  const relativeBase = normalizedPath.startsWith('/') ? 'https://relative.local' : 'https://relative.local/';
  return new URL(normalizedPath || '.', relativeBase);
}

function buildUrl(baseUrl: string, path: string, query?: RestRequestOptions['query']) {
  if (isAbsoluteUrl(path)) {
    const url = new URL(path);
    applyQuery(url, query);
    return url.toString();
  }

  const url = new URL(baseUrl);
  const relativeUrl = toRelativeUrl(path);
  url.pathname = joinPathname(url.pathname, relativeUrl.pathname);
  url.search = relativeUrl.search;
  url.hash = relativeUrl.hash;
  applyQuery(url, query);
  return url.toString();
}

function sanitizeUrlForLogs(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function isSensitiveQueryKey(key: string) {
  return /(signature|token|secret|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|jwt|nonce)/i.test(key);
}

function sanitizeUrlWithQueryForLogs(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return sanitizeSensitiveText(url.toString());
  } catch {
    return sanitizeSensitiveText(rawUrl);
  }
}

function buildUrlLogContext(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return {
      url: rawUrl,
      requestHost: url.host,
      requestPath: url.pathname,
    };
  } catch {
    return {
      url: rawUrl,
      requestHost: null,
      requestPath: null,
    };
  }
}

function buildQueryPreview(rawUrl: string, maxEntries = 6) {
  try {
    const url = new URL(rawUrl);
    const entries = Array.from(url.searchParams.entries()).slice(0, maxEntries);
    if (entries.length === 0) {
      return null;
    }

    return entries
      .map(([key, value]) => {
        const preview = isSensitiveQueryKey(key)
          ? '[REDACTED]'
          : sanitizeSensitiveText(value.length > 120 ? `${value.slice(0, 120)}...` : value);
        return `${key}=${preview}`;
      })
      .join('&');
  } catch {
    return null;
  }
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

function buildResponseSnippet(body: unknown) {
  if (body === undefined || body === null) {
    return null;
  }

  const raw =
    typeof body === 'string'
      ? body
      : JSON.stringify(Array.isArray(body) ? body.slice(0, 2) : body);

  const snippet = raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
  return sanitizeSensitiveText(snippet);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function isExchangeRequestError(error: unknown): error is ExchangeRequestError {
  return error instanceof ExchangeRequestError;
}

export class RestClient {
  constructor(
    private readonly owner: ExchangeId | 'fx' | 'coingecko',
    private readonly baseUrl: string,
  ) {}

  async request<T>(path: string, options: RestRequestOptions = {}): Promise<T> {
    const response = await this.requestDetailed<T>(path, options);
    return response.data;
  }

  async requestDetailed<T>(path: string, options: RestRequestOptions = {}): Promise<RestResponseWithMeta<T>> {
    const policy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retryPolicy,
    };
    const url = buildUrl(this.baseUrl, path, options.query);
    const logUrl = sanitizeUrlForLogs(url);
    const debugUrl = sanitizeUrlWithQueryForLogs(url);
    const queryPreview = buildQueryPreview(url);
    const urlLogContext = buildUrlLogContext(logUrl);
    const formBody = buildFormBody(options.form);

    if (queryPreview) {
      logger.debug(
        {
          domain: 'exchange-rest',
          owner: this.owner,
          path,
          url: logUrl,
          requestUrlWithQuery: debugUrl,
          queryPreview,
        },
        'Prepared exchange REST request with query parameters',
      );
    }

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
          const responseSnippet = buildResponseSnippet(responseBody);
          const retryable = policy.retryableStatusCodes.includes(response.status);
          if (retryable && attempt < policy.maxAttempts) {
            const retryDelayMs = parseRetryAfter(response.headers.get('retry-after')) ?? getRetryDelay(policy, attempt);
            logger.warn(
              {
                domain: 'exchange-rest',
                owner: this.owner,
                ...urlLogContext,
                attempt,
                upstreamStatus: response.status,
                responseSnippet,
                retry: true,
                retryDelayMs,
              },
              'Retrying exchange REST request after upstream failure',
            );
            await delay(retryDelayMs);
            continue;
          }

          logger.warn(
            {
              domain: 'exchange-rest',
              owner: this.owner,
              ...urlLogContext,
              attempt,
              upstreamStatus: response.status,
              responseSnippet,
              retry: false,
            },
            'Exchange REST request failed',
          );

          throw new ExchangeRequestError(
            this.owner,
            response.status,
            logUrl,
            `${this.owner} request failed with HTTP ${response.status}`,
            responseBody,
          );
        }

        const data = await parseResponseBody<T>(response);
        return {
          data,
          meta: {
            owner: this.owner,
            path,
            requestUrl: logUrl,
            statusCode: response.status,
            responseSnippet: buildResponseSnippet(data),
          },
        };
      } catch (error) {
        clearTimeout(timeout);
        if (isAbortError(error)) {
          logger.warn(
            {
              domain: 'exchange-rest',
              event: 'upstream_exchange_timeout',
              owner: this.owner,
              ...urlLogContext,
              timeoutMs: options.timeoutMs ?? 10_000,
              attempt,
            },
            'Exchange REST request timed out',
          );
          error = new ExchangeRequestError(
            this.owner,
            504,
            logUrl,
            `${this.owner} request timed out`,
          );
        }
        if (isExchangeRequestError(error) && !policy.retryableStatusCodes.includes(error.statusCode)) {
          throw error;
        }

        if (attempt >= policy.maxAttempts) {
          throw error;
        }

        logger.warn(
          { domain: 'exchange-rest', owner: this.owner, ...urlLogContext, attempt, retry: true, err: error },
          'Retrying exchange REST request',
        );
        await delay(getRetryDelay(policy, attempt));
      }
    }

    throw new ExchangeRequestError(this.owner, 500, logUrl, 'Unexpected exchange request failure');
  }
}
