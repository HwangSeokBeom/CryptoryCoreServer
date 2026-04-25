import { createPublicKey, verify as verifySignature } from 'crypto';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const APPLE_ISSUER = 'https://appleid.apple.com';
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

type JwksKey = {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
};

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtPayload = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
};

type VerifiedSocialToken = {
  provider: 'google' | 'apple';
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
};

const jwksCache = new Map<string, { keys: JwksKey[]; expiresAt: number }>();

function base64UrlDecode(input: string) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function decodeJson<T>(segment: string): T {
  try {
    return JSON.parse(base64UrlDecode(segment).toString('utf8')) as T;
  } catch {
    throw new AppError(401, '소셜 로그인 토큰을 해석할 수 없습니다', undefined, 'SOCIAL_TOKEN_MALFORMED');
  }
}

function decodeJwt(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppError(401, '소셜 로그인 토큰 형식이 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_MALFORMED');
  }

  return {
    header: decodeJson<JwtHeader>(parts[0]),
    payload: decodeJson<JwtPayload>(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecode(parts[2]),
  };
}

async function fetchJwks(url: string) {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new AppError(503, '소셜 로그인 검증 키를 가져올 수 없습니다', undefined, 'SOCIAL_JWKS_UNAVAILABLE');
  }

  const body = await response.json() as { keys?: JwksKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
  return keys;
}

function isAudienceAllowed(audience: string | string[] | undefined, allowedAudiences: string[]) {
  const audiences = Array.isArray(audience) ? audience : audience ? [audience] : [];
  return audiences.some((item) => allowedAudiences.includes(item));
}

function parseEmailVerified(value: boolean | string | undefined) {
  return value === true || value === 'true';
}

function assertTimeClaims(payload: JwtPayload) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSeconds) {
    throw new AppError(401, '소셜 로그인 토큰이 만료되었습니다', undefined, 'SOCIAL_TOKEN_EXPIRED');
  }
  if (payload.nbf && payload.nbf > nowSeconds + 60) {
    throw new AppError(401, '소셜 로그인 토큰을 아직 사용할 수 없습니다', undefined, 'SOCIAL_TOKEN_NOT_ACTIVE');
  }
}

async function verifyOidcToken(params: {
  token: string;
  provider: 'google' | 'apple';
  jwksUrl: string;
  allowedAudiences: string[];
  issuerAllowed: (issuer: string | undefined) => boolean;
}) {
  if (params.allowedAudiences.length === 0) {
    throw new AppError(
      500,
      '소셜 로그인 서버 설정이 누락되었습니다',
      { provider: params.provider, missing: params.provider === 'google' ? 'GOOGLE_IOS_CLIENT_ID' : 'APPLE_CLIENT_ID' },
      'SOCIAL_PROVIDER_CONFIG_MISSING',
    );
  }

  const decoded = decodeJwt(params.token);
  if (decoded.header.alg !== 'RS256' || !decoded.header.kid) {
    throw new AppError(401, '지원하지 않는 소셜 로그인 토큰입니다', undefined, 'SOCIAL_TOKEN_UNSUPPORTED');
  }

  const keys = await fetchJwks(params.jwksUrl);
  const jwk = keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    jwksCache.delete(params.jwksUrl);
    throw new AppError(401, '소셜 로그인 토큰 검증 키를 찾을 수 없습니다', undefined, 'SOCIAL_TOKEN_KEY_NOT_FOUND');
  }

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const validSignature = verifySignature(
    'RSA-SHA256',
    Buffer.from(decoded.signingInput),
    publicKey,
    decoded.signature,
  );
  if (!validSignature) {
    throw new AppError(401, '소셜 로그인 토큰 서명이 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_INVALID_SIGNATURE');
  }

  assertTimeClaims(decoded.payload);
  if (!params.issuerAllowed(decoded.payload.iss)) {
    throw new AppError(401, '소셜 로그인 토큰 발급자가 올바르지 않습니다', undefined, 'SOCIAL_TOKEN_INVALID_ISSUER');
  }
  if (!isAudienceAllowed(decoded.payload.aud, params.allowedAudiences)) {
    throw new AppError(
      403,
      '소셜 로그인 토큰 대상 앱이 올바르지 않습니다',
      { provider: params.provider },
      'SOCIAL_TOKEN_INVALID_AUDIENCE',
    );
  }
  if (!decoded.payload.sub) {
    throw new AppError(401, '소셜 로그인 토큰에 사용자 식별자가 없습니다', undefined, 'SOCIAL_TOKEN_MISSING_SUB');
  }

  const verified: VerifiedSocialToken = {
    provider: params.provider,
    sub: decoded.payload.sub,
    email: decoded.payload.email?.trim().toLowerCase(),
    emailVerified: parseEmailVerified(decoded.payload.email_verified),
    name: decoded.payload.name,
  };

  logger.info(
    {
      domain: 'auth',
      provider: params.provider,
      action: 'token_verified',
      email: verified.email,
      sub: verified.sub,
    },
    `[SocialAuthDebug] provider=${params.provider} action=token_verified email=${verified.email ?? 'none'} sub=${verified.sub}`,
  );

  return verified;
}

export async function verifyGoogleIdToken(idToken: string) {
  const verified = await verifyOidcToken({
    token: idToken,
    provider: 'google',
    jwksUrl: GOOGLE_JWKS_URL,
    allowedAudiences: env.GOOGLE_CLIENT_IDS,
    issuerAllowed: (issuer) => GOOGLE_ISSUERS.has(String(issuer)),
  });

  if (!verified.email || !verified.emailVerified) {
    throw new AppError(
      403,
      'Google 계정 이메일 검증이 필요합니다',
      { provider: 'google' },
      'GOOGLE_EMAIL_NOT_VERIFIED',
    );
  }

  return verified;
}

export async function verifyAppleIdentityToken(identityToken: string) {
  return verifyOidcToken({
    token: identityToken,
    provider: 'apple',
    jwksUrl: APPLE_JWKS_URL,
    allowedAudiences: env.APPLE_CLIENT_IDS,
    issuerAllowed: (issuer) => issuer === APPLE_ISSUER,
  });
}

export type { VerifiedSocialToken };
