import { createHmac, randomUUID } from 'crypto';

export class CoinoneSigner {
  createHeaders(params: {
    accessToken: string;
    secretKey: string;
    payload?: Record<string, unknown>;
  }) {
    const payload = {
      ...(params.payload ?? {}),
      access_token: params.accessToken,
      nonce: randomUUID(),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const signature = createHmac('sha512', params.secretKey)
      .update(encodedPayload)
      .digest('hex');

    return {
      'content-type': 'application/json',
      'X-COINONE-PAYLOAD': encodedPayload,
      'X-COINONE-SIGNATURE': signature,
    };
  }
}
