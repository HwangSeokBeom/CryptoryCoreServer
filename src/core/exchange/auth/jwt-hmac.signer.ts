import { createHash, createHmac, randomUUID } from 'crypto';

function base64UrlEncode(input: Buffer | string) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signJwt(secret: string, payload: Record<string, unknown>) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();

  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

function toQueryString(params?: Record<string, unknown>) {
  if (!params) return '';
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => search.append(key, String(item)));
      continue;
    }
    search.append(key, String(value));
  }

  return search.toString();
}

export interface JwtHmacSignerParams {
  accessKey: string;
  secretKey: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export class JwtHmacSigner {
  createAuthorizationHeader(params: JwtHmacSignerParams) {
    const queryString = toQueryString(params.query ?? params.body);
    const payload: Record<string, unknown> = {
      access_key: params.accessKey,
      nonce: randomUUID(),
    };

    if (queryString) {
      payload.query_hash = createHash('sha512').update(queryString, 'utf8').digest('hex');
      payload.query_hash_alg = 'SHA512';
    }

    const token = signJwt(params.secretKey, payload);
    return { Authorization: `Bearer ${token}` };
  }
}
