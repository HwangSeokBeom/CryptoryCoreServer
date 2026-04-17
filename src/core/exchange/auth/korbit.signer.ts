import { createHmac } from 'crypto';

export class KorbitHmacSigner {
  createSignedRequest(params: {
    apiKey: string;
    secretKey: string;
    payload?: Record<string, unknown>;
  }) {
    const timestamp = Date.now();
    const signedPayload = new URLSearchParams();
    for (const [key, value] of Object.entries(params.payload ?? {})) {
      if (value === undefined || value === null) continue;
      signedPayload.append(key, String(value));
    }
    signedPayload.append('timestamp', String(timestamp));
    const message = signedPayload.toString();
    const signature = createHmac('sha256', params.secretKey).update(message).digest('hex');

    return {
      payload: Object.fromEntries(signedPayload.entries()),
      headers: {
        'X-KAPI-KEY': params.apiKey,
      },
      signature,
    };
  }

  createHeaders(params: {
    apiKey: string;
    secretKey: string;
    payload?: Record<string, unknown>;
  }) {
    return this.createSignedRequest(params).headers;
  }
}
