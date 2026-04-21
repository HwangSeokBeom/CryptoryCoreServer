import { createHmac } from 'crypto';

type QueryValue = string | number | boolean | undefined | null;

function toQueryString(params: Record<string, QueryValue>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    search.append(key, String(value));
  }
  return search.toString();
}

export class BinanceSigner {
  createSignedRequest(params: {
    apiKey: string;
    secretKey: string;
    query?: Record<string, QueryValue>;
  }) {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const payload = {
      ...(params.query ?? {}),
      timestamp,
      recvWindow,
    };
    const queryString = toQueryString(payload);
    const signature = createHmac('sha256', params.secretKey).update(queryString).digest('hex');

    return {
      headers: {
        'X-MBX-APIKEY': params.apiKey,
      },
      query: {
        ...payload,
        signature,
      },
    };
  }
}
