import { createHmac } from 'crypto';

function buildSignaturePayload(
  method: string,
  path: string,
  timestamp: number,
  payload?: Record<string, unknown>,
) {
  const query = new URLSearchParams();
  if (payload) {
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
  }

  return `${timestamp}${method.toUpperCase()}${path}${query.toString() ? `?${query.toString()}` : ''}`;
}

export class KorbitHmacSigner {
  createHeaders(params: {
    apiKey: string;
    secretKey: string;
    method: string;
    path: string;
    payload?: Record<string, unknown>;
  }) {
    const timestamp = Date.now();
    const message = buildSignaturePayload(params.method, params.path, timestamp, params.payload);
    const signature = createHmac('sha256', params.secretKey).update(message).digest('hex');

    return {
      'content-type': 'application/json',
      'X-KAPI-KEY': params.apiKey,
      'X-KAPI-TIMESTAMP': String(timestamp),
      'X-KAPI-SIGNATURE': signature,
    };
  }
}
