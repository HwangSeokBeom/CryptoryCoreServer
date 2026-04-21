import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestClient } from '../src/core/exchange/rest.client';

describe('RestClient URL joining', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('preserves the /api/v3 base path when the request path starts with a slash', async () => {
    const client = new RestClient('coingecko', 'https://api.coingecko.com/api/v3');

    await client.request('/coins/list', {
      query: {
        include_platform: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.coingecko.com/api/v3/coins/list?include_platform=false',
      expect.any(Object),
    );
  });

  it('avoids duplicate slashes when both baseUrl and path contain separators', async () => {
    const client = new RestClient('coingecko', 'https://api.coingecko.com/api/v3/');

    await client.request('coins/markets', {
      query: {
        ids: 'bitcoin,ethereum',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.coingecko.com/api/v3/coins/markets?ids=bitcoin%2Cethereum',
      expect.any(Object),
    );
  });

  it('allows absolute URL paths to override the configured baseUrl', async () => {
    const client = new RestClient('coingecko', 'https://api.coingecko.com/api/v3');

    await client.request('https://example.com/custom/endpoint?foo=bar', {
      query: {
        baz: 'qux',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/custom/endpoint?foo=bar&baz=qux',
      expect.any(Object),
    );
  });
});
