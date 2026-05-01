# API Contracts

All REST responses use one envelope:

```json
{
  "success": true,
  "data": {}
}
```

Errors use:

```json
{
  "success": false,
  "error": "message",
  "code": "MACHINE_READABLE_CODE",
  "details": {}
}
```

`code` and `details` are optional, but auth endpoints return them for validation and duplicate-resource cases.

## Auth And Account Routes

Session responses keep the legacy `token` field as an alias of `accessToken`.

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-id",
      "email": "user@example.com",
      "nickname": "tester",
      "authProvider": "email",
      "createdAt": "2026-04-21T00:00:00.000Z",
      "updatedAt": "2026-04-21T00:00:00.000Z"
    },
    "token": "access.jwt",
    "accessToken": "access.jwt",
    "refreshToken": "session-id.random-secret",
    "tokenType": "Bearer",
    "expiresIn": "7d",
    "refreshTokenExpiresAt": "2026-05-21T00:00:00.000Z",
    "sessionId": "session-id"
  }
}
```

- `POST /api/v1/auth/register` and `POST /auth/register`: creates an email account and returns a Cryptory access/refresh session.
- `POST /api/v1/auth/login`: verifies email/password and returns a Cryptory access/refresh session.
- `POST /api/v1/auth/social/google`: accepts `{ "idToken": "..." }` or `{ "idToken": "...", "accessToken": "..." }`; the server verifies Google RS256 ID token signature, `iss`, `aud`, `exp`, `sub`, and verified email, then maps `provider=google + sub` to a Cryptory user/session.
- `POST /api/v1/auth/social/apple`: accepts `{ "identityToken": "...", "authorizationCode": "...", "fullName": "...", "email": "..." }`; the server verifies Apple RS256 identity token signature, `iss`, `aud`, `exp`, and `sub`, then maps `provider=apple + sub` to a Cryptory user/session. Apple email may only be present on first login, so existing `provider+sub` identity is the primary re-login key.
- `POST /api/v1/auth/refresh` and `POST /auth/refresh`: accepts `{ "refreshToken": "..." }`, checks the DB-stored SHA-256 hash for the session, rejects expired/revoked/tampered tokens with explicit 401 codes, rotates the refresh token, and returns a fresh access token.
- `POST /api/v1/auth/logout` and `POST /auth/logout`: accepts `{ "refreshToken": "..." }` without requiring a valid access token and revokes that session. `{ "logoutAll": true }` requires access auth and revokes all user sessions.
- `GET /api/v1/auth/me`: access-token protected profile endpoint.
- `GET /api/v1/auth/session`: access-token protected session restore check. If the access token has a session id, the session must still exist, not be expired, and not be revoked.
- `DELETE /api/v1/auth/account`: access-token protected account deletion. It deletes refresh sessions, social identity links, exchange connections, orders, holdings, favorites, and the user row, allowing later re-registration/re-linking.
- `GET /api/v1/openapi.json`: OpenAPI 3.0 contract for the social login routes and response schemas. This server does not bundle Swagger UI, but the JSON can be loaded into Swagger UI, Postman, or Xcode tooling.

Access token failures and refresh token failures are intentionally separate. Expired access tokens return `ACCESS_TOKEN_EXPIRED` so the client can try `/auth/refresh`; refresh failures such as `REFRESH_TOKEN_EXPIRED`, `REFRESH_TOKEN_REVOKED`, or `REFRESH_TOKEN_INVALID` are the point where the app should move to logged-out state.

Social account mapping policy:

- Existing `AuthIdentity(provider, providerAccountId)` wins.
- If no identity exists and the provider supplies a verified email, Cryptory links to an existing user with that email.
- If no identity exists and no verified email is available, the server rejects the login with `SOCIAL_EMAIL_REQUIRED`.
- New social users receive initial holdings like email signups and get a Cryptory access/refresh session after provider verification.

Social login provider configuration:

- `GOOGLE_IOS_CLIENT_ID=142113558371-t5s22ri6gjl5aur76s81910gf2hb8p09.apps.googleusercontent.com`
- `APPLE_CLIENT_ID=com.hwb.Cryptory`
- Optional legacy/multi-audience envs: `GOOGLE_CLIENT_IDS`, `GOOGLE_WEB_CLIENT_ID`, `APPLE_CLIENT_IDS`
- `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` are only needed if the server later exchanges Apple authorization codes with a generated client secret. Current identityToken verification does not require them.

Social login error codes:

- `400 GOOGLE_ID_TOKEN_REQUIRED` or `APPLE_IDENTITY_TOKEN_REQUIRED`: required token field is missing.
- `401 SOCIAL_TOKEN_MALFORMED`, `SOCIAL_TOKEN_EXPIRED`, `SOCIAL_TOKEN_INVALID_SIGNATURE`, or related token verification failures.
- `403 SOCIAL_TOKEN_INVALID_AUDIENCE`: token `aud` does not match the configured iOS app client id.
- `403 GOOGLE_EMAIL_NOT_VERIFIED`: Google ID token did not contain a verified email.
- `500 SOCIAL_PROVIDER_CONFIG_MISSING`: required server env is missing.

iOS Sign in with Apple checklist:

- Apple Developer Portal에서 Bundle ID `com.hwb.Cryptory`에 Sign In with Apple capability 활성화.
- Xcode Target Signing & Capabilities에 Sign In with Apple 추가.
- entitlements에 `com.apple.developer.applesignin` 포함.
- provisioning profile 재생성/갱신.
- Simulator가 아니라 실제 기기에서도 Apple 로그인 테스트.

## App Review And Legal Config

- `GET /api/v1/app/config`
- `GET /api/v1/legal/config`

These public endpoints expose `appName`, legal/support URLs, account route contracts, social login client ids, and app-review readiness. Production startup requires all public legal/support URL env vars to be set to valid URLs: `APP_HOMEPAGE_URL`, `TERMS_URL`, `PRIVACY_POLICY_URL`, `SUPPORT_URL`, `ACCOUNT_DELETION_URL`, and `INVESTMENT_DISCLAIMER_URL`.

## Security

- User exchange credentials are stored only through DB encrypted fields backed by `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`.
- Exchange credential encryption uses versioned AES-256-GCM envelopes. The encryption key material must live outside the DB and must not fall back to JWT secrets.
- API key list/detail responses never return plaintext credentials. They expose only `apiKeyMasked`, `connectionPurpose`, `permissionScope`, and status metadata.
- Read-only connections are blocked from server-side trading/order APIs before any exchange request is sent.
- Logs and error responses redact API keys, secrets, tokens, signatures, authorization headers, query hashes, and nonce-like values.
- Runtime private credential resolution order is `user exchange connection -> formal server env variables`.
- Provider auth/signing is handled only inside provider or validator code.
- Binance is public-reference-only. Private trading and private portfolio are intentionally unsupported.

## Exchange Status

| Exchange | Public REST | Private Trading | Portfolio | Public WS | Private WS | Polling Fallback | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Upbit | Done | Done | Done | Done | Partial | Done | Private WS session orchestration is not wired to user-facing routes yet. HTTP APIs use live private REST. |
| Bithumb | Done | Done | Done | Done | Pending | Done | Private REST uses JWT HMAC signing with live validation. |
| Coinone | Done | Done | Done | Done | Pending | Done | `GET/DELETE /trading/orders/:exchange/:orderId` requires `symbol` query for provider lookup. |
| Korbit | Done | Done | Done | Done | Pending | Done | `GET/DELETE /trading/orders/:exchange/:orderId` requires `symbol` query for provider lookup. |
| Binance | Done | Unsupported | Unsupported | Done | Unsupported | Done | Reference market source for kimchi premium only. |

## Public Market Routes

## Informational Public Routes

Canonical client paths are root-level routes. `/api/v1/news`, `/api/v1/coins`, and `/api/v1/market`
are compatibility aliases only; clients should not probe `/api/v1` first and then fall back to root.

- `GET /news`
- `GET /news/:newsId`
- `GET /coins/:symbol/info`
- `GET /coins/:symbol/analysis?timeframe=1m|5m|15m|30m|1h|2h`
- `GET /coins/:symbol/community`
- `POST /coins/:symbol/community` (requires access token)
- `POST /coins/:symbol/votes` (requires access token; accepts `bullish` or `bearish`)
- `GET /market/trends`
- `GET /market/themes`

All successful responses use `{ "success": true, "data": ... }`. Provider failures should return a
200 response with null-safe fallback fields when a meaningful informational shell can still be built.
The informational APIs must not include buy/sell/recommendation/investment-advice wording in response
copy.

Coin symbols are normalized before lookup, so `DRIFT/KRW`, `KRW-DRIFT`, and `drift` all resolve to
`DRIFT`.

### `GET /coins/:symbol/info`

```json
{
  "success": true,
  "data": {
    "symbol": "DRIFT",
    "displaySymbol": "DRIFT/KRW",
    "name": "Drift",
    "logoUrl": "https://...",
    "provider": "coingecko",
    "providerId": "drift-protocol",
    "description": "...",
    "homepageUrl": "https://...",
    "explorerUrl": "https://...",
    "market": {
      "price": 86.8,
      "priceCurrency": "KRW",
      "priceChangePercent24h": 2.97,
      "high24h": 86.8,
      "low24h": 86.8,
      "volume24h": 78770000000,
      "tradeValue24h": 78770000000,
      "marketCap": null,
      "marketCapRank": null,
      "circulatingSupply": null,
      "totalSupply": null,
      "maxSupply": null,
      "ath": null,
      "atl": null,
      "asOf": "2026-05-01T15:24:04.697Z"
    },
    "source": {
      "metadata": "coingecko",
      "market": "market_snapshot",
      "fallbackUsed": false
    }
  }
}
```

### `GET /coins/:symbol/analysis`

```json
{
  "success": true,
  "data": {
    "symbol": "DRIFT",
    "timeframe": "1h",
    "summary": {
      "status": "neutral",
      "label": "중립",
      "score": 0,
      "bullishCount": 0,
      "bearishCount": 0,
      "neutralCount": 1
    },
    "indicators": [
      {
        "key": "recent_price_change",
        "label": "최근 가격 변화",
        "state": "neutral",
        "valueText": "데이터 부족",
        "description": "최근 캔들 데이터가 부족합니다."
      }
    ],
    "source": {
      "type": "server_analysis",
      "fallbackUsed": true
    },
    "asOf": "2026-05-01T15:24:04.697Z"
  }
}
```

### `GET /coins/:symbol/community`

```json
{
  "success": true,
  "data": {
    "symbol": "DRIFT",
    "vote": {
      "bullishCount": 0,
      "bearishCount": 0,
      "participantCount": 0,
      "myVote": null
    },
    "items": [],
    "nextCursor": null
  }
}
```

### `GET /news`

```json
{
  "success": true,
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```

News item fields are null-safe: `source`, `url`, `thumbnailUrl`, `symbols`, and `category` are always
present on returned items.

### `GET /market/trends`

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalMarketCap": null,
      "volume24h": 78770000000,
      "btcDominance": null,
      "ethDominance": null,
      "fearGreedIndex": null,
      "altcoinIndex": null
    },
    "movers": {
      "topGainers": [],
      "topLosers": [],
      "topVolume": []
    },
    "series": {
      "marketCap": [],
      "volume": []
    },
    "source": {
      "primary": "market_snapshot",
      "fallbackUsed": true
    },
    "asOf": "2026-05-01T15:24:04.697Z"
  }
}
```

Base paths:

- `GET /market/markets`
- `GET /market/symbols`
- `GET /market/tickers`
- `GET /market/base-snapshot`
- `GET /market/snapshot`
- `GET /market/sparkline`
- `GET /market/orderbook`
- `GET /market/trades`
- `GET /market/candles`
- `GET /charts/candles`
- `GET /kimchi-premium`
- `GET /kimchi-premium/comparable-symbols`
- `GET /kimchi-premium/snapshot`
- `GET /kimchi-premium/batch`

### Market Identity Contract

- Every market, ticker, and candle response must expose enough data to distinguish `symbol` from exchange market identity.
- `unique identity = exchange + marketId`
- `canonicalSymbol` is for icon/asset metadata mapping only.
- `symbol` is a helper display/code field and is not unique.
- Detail requests should prefer `marketId` when available. Active detail/ticker routes accept `marketId` together with `exchange`.
- The canonical examples and client integration rules live in [market-api-contract.md](./market-api-contract.md).

### `GET /market/markets`

Query:

- `exchange?: upbit | bithumb | coinone | korbit | binance`

Behavior:

- Returns the exchange's full tradable provider market universe.
- Registry metadata is used only for canonical naming and display metadata.
- `kimchiComparable` is metadata on each market row. It does not filter the market universe.

Example response:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "symbol": "BTC",
        "exchangeSymbol": "KRW-BTC",
        "market": "BTC/KRW",
        "baseCurrency": "BTC",
        "quoteCurrency": "KRW",
        "rawSymbol": "KRW-BTC",
        "tradable": true,
        "capabilities": {
          "tickers": true,
          "orderbook": true,
          "trades": true,
          "candles": true
        },
        "kimchiComparable": true,
        "kimchiComparisonReason": "COMPARABLE",
        "registryMapped": true,
        "nameKo": "비트코인",
        "nameEn": "Bitcoin"
      }
    ],
    "meta": {
      "exchanges": ["upbit"],
      "requestedMarketCount": 237,
      "providerMarketCount": 237,
      "normalizedSymbolCount": 237,
      "returnedCount": 237,
      "registryMappedCount": 15,
      "registryUnmappedCount": 222,
      "droppedSymbols": [],
      "droppedReasonsSummary": {},
      "sourceOfTruth": "provider_market_universe",
      "appliedLimit": null,
      "totalAvailableCount": 237
    }
  }
}
```

### `GET /market/tickers`

Query:

- `exchange?: upbit | bithumb | coinone | korbit | binance`
- `symbol?: BTC | ETH | ...`
- `limit?: number`

Freshness fields are attached to every item.
`current`, `percent`, `sparkline`, `sparklinePoints`, and `sparklineSource` are included so the client can render the row without waiting for a second chart join.
By default the endpoint resolves the provider's full tradable market universe. If `limit` is used, the response keeps `meta.appliedLimit` and `meta.totalAvailableCount` so the truncation is explicit.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "symbol": "BTC",
        "exchangeSymbol": "KRW-BTC",
        "market": "BTC/KRW",
        "baseCurrency": "BTC",
        "quoteCurrency": "KRW",
        "rawSymbol": "KRW-BTC",
        "tradable": true,
        "capabilities": {
          "tickers": true,
          "orderbook": true,
          "trades": true,
          "candles": true
        },
        "kimchiComparable": true,
        "kimchiComparisonReason": "COMPARABLE",
        "registryMapped": true,
        "price": 100000000,
        "change24h": 1.25,
        "volume24h": 1234,
        "high24h": 101000000,
        "low24h": 98000000,
        "timestamp": 1712345678000,
        "current": 100000000,
        "percent": 1.25,
        "previousPrice24h": 98765432.1,
        "sparkline": [98765432.1, 100000000],
        "sparklinePoints": [
          { "price": 98765432.1, "timestamp": 1712259278000 },
          { "price": 100000000, "timestamp": 1712345678000 }
        ],
        "sparklineSource": "derived_change24h",
        "sourceTimestamp": 1712345678000,
        "stale": false,
        "staleAgeMs": 420
      }
    ],
    "meta": {
      "exchanges": ["upbit"],
      "requestedMarketCount": 237,
      "providerMarketCount": 237,
      "normalizedSymbolCount": 237,
      "returnedCount": 100,
      "registryMappedCount": 15,
      "registryUnmappedCount": 222,
      "droppedSymbols": [
        { "exchange": "upbit", "symbol": "SOME", "reason": "missing_from_provider_snapshot" }
      ],
      "droppedReasonsSummary": {
        "missing_from_provider_snapshot": 1
      },
      "sourceOfTruth": "provider_market_universe",
      "appliedLimit": 100,
      "totalAvailableCount": 236
    }
  }
}
```

### `GET /market/base-snapshot`

Query:

- `exchange`: required, `upbit | bithumb | coinone | korbit | binance`
- `scope?`: `full | visible | top | symbols`, defaults to `full` unless `symbols` is present
- `symbols?`: comma-separated symbols. Exchange-form aliases such as `KRW-BTC` are normalized to canonical symbols.
- `limit?`: optional response limit for non-symbol scopes

Policy:

- This is the fastest market first-paint endpoint. It returns base row fields only and never waits for graph or kimchi hydration.
- It reads the prepared exchange market snapshot and public ticker projection. When `symbols` is provided and the prepared projection does not have a usable current price, the server performs a targeted ticker hydration for those symbols only.
- `rejectedSymbols` are malformed or wildcard-like inputs. `unsupportedSymbols` are canonical symbols that are not in the selected exchange universe.
- `currentPrice`, `tradePrice`, `currentPriceSource`, and `updatedAt` are the canonical order-header price fields for this endpoint.
- Clients should render rows from this response immediately, then call `/market/sparkline` and `/kimchi-premium/batch` for visible or representative symbols.

```json
{
  "success": true,
  "data": {
    "selectedExchange": "upbit",
    "sourceExchange": "upbit",
    "scope": "symbols",
    "requestedSymbols": ["BTC", "ETH"],
    "acceptedSymbols": ["BTC", "ETH"],
    "rejectedSymbols": [],
    "unsupportedSymbols": [],
    "items": [
      {
        "selectedExchange": "upbit",
        "sourceExchange": "upbit",
        "symbol": "BTC",
        "marketId": "KRW-BTC",
        "displaySymbol": "BTC/KRW",
        "displayName": "비트코인",
        "currentPrice": 100000000,
        "tradePrice": 100000000,
        "currentPriceSource": "provider_snapshot",
        "change24h": 1.25,
        "volume24h": 1234,
        "updatedAt": 1712345678000,
        "freshnessMs": 220,
        "marketStatus": "live",
        "status": "success",
        "representative": true,
        "kimchiComparable": true
      }
    ],
    "status": "success",
    "partial": false,
    "cacheHit": true,
    "total": 1,
    "elapsedMs": 42
  }
}
```

### `GET /market/snapshot`

Query:

- `exchange`: required, `upbit | bithumb | coinone | korbit | binance`
- `scope?`: `full | top | symbols`, defaults to `top`
- `symbols?`: comma-separated canonical symbols. When present, only listed symbols are returned in `items`; unlisted symbols move into `partialFailures`.
- `limit?`: optional. On `top`, defaults to a light first-screen window. On `full`, omitting `limit` returns the full listed universe.

Policy:

- The endpoint is snapshot-cache-first and optimized for first paint / polling fallback.
- The server refreshes exchange listing universes and market rows in the background. Request-time reads do not fan out to exchange APIs unless the cache is still cold.
- `items` are always scoped to the exchange's canonical listed market universe. Unlisted symbols are excluded from `items`.
- The response never promotes one bad symbol into a route-level `500`.
- `status` is one of `success | partial_success | failure`.
- `partialFailures` uses stable codes such as `UNSUPPORTED_SYMBOL`, `SYMBOL_MAPPING_NOT_FOUND`, `PARTIAL_DATA`, `SNAPSHOT_STALE`, and `ALL_PROVIDERS_FAILED`.
- Item shape keeps the websocket-aligned canonical fields and adds first-paint row data such as `displayName`, `signedChangeRate`, `sparkline`, `trend`, and `marketStatus`.
- Snapshot items also include `kimchiComparable` and `kimchiComparisonReason`.

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "scope": "symbols",
    "requestedSymbols": ["BTC", "ETH", "OG"],
    "items": [
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "symbol": "BTC",
        "displaySymbol": "BTC/KRW",
        "displayName": "비트코인",
        "exchangeSymbol": "KRW-BTC",
        "market": "BTC/KRW",
        "baseCurrency": "BTC",
        "quoteCurrency": "KRW",
        "rawSymbol": "KRW-BTC",
        "price": 100000000,
        "change24h": 1.25,
        "signedChangeRate": 1.25,
        "volume24h": 1234,
        "sparkline": [98765432.1, 100000000],
        "sparklinePoints": [
          { "price": 98765432.1, "timestamp": 1712259278000 },
          { "price": 100000000, "timestamp": 1712345678000 }
        ],
        "sparklineSource": "derived_change24h",
        "trend": "up",
        "timestamp": 1712345678000,
        "asOf": 1712345678000,
        "source": "snapshot",
        "freshnessMs": 220,
        "stale": false,
        "status": "success",
        "marketStatus": "live",
        "errorCode": null,
        "errorMessage": null,
        "registryMapped": true,
        "tradable": true
      },
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "symbol": "ETH",
        "displaySymbol": "ETH/KRW",
        "displayName": "이더리움",
        "exchangeSymbol": "KRW-ETH",
        "market": "ETH/KRW",
        "baseCurrency": "ETH",
        "quoteCurrency": "KRW",
        "rawSymbol": "KRW-ETH",
        "price": null,
        "change24h": null,
        "signedChangeRate": null,
        "volume24h": null,
        "sparkline": [],
        "sparklinePoints": [],
        "sparklineSource": "unavailable",
        "trend": "unknown",
        "timestamp": null,
        "asOf": null,
        "source": "cache",
        "freshnessMs": null,
        "stale": false,
        "status": "partial",
        "marketStatus": "pending",
        "errorCode": "PARTIAL_DATA",
        "errorMessage": "missing_from_provider_snapshot",
        "registryMapped": true,
        "tradable": true
      }
    ],
    "partialFailures": [
      {
        "symbol": "ETH",
        "exchange": "upbit",
        "code": "PARTIAL_DATA",
        "message": "missing_from_provider_snapshot",
        "stage": "snapshot_cache",
        "source": "cache",
        "retryable": true
      },
      {
        "symbol": "OG",
        "exchange": "upbit",
        "code": "SYMBOL_MAPPING_NOT_FOUND",
        "message": "canonical mapping for OG could not be resolved on upbit",
        "stage": "symbol_mapping",
        "source": "cache",
        "retryable": false
      }
    ],
    "status": "partial_success",
    "source": "mixed",
    "freshnessMs": 220,
    "asOf": 1712345678000,
    "stale": false,
    "total": 2,
    "listedCount": 2,
    "staleItemCount": 0,
    "pendingItemCount": 1,
    "excludedUnlistedCount": 1
  }
}
```

### `GET /market/sparkline`

Query:

- `exchange`: required, `upbit | bithumb | coinone | korbit | binance`
- `symbols`: required, comma-separated symbols
- `batchIndex?`: optional non-negative client batch index for logs/debugging
- `allowStale?`: optional, defaults to allowing short stale sparkline cache reuse
- `debug?`: optional

Policy:

- Optimized for visible-first graph hydration. 5 to 20 symbols should be requested for the first viewport; larger lists should be split into 10 to 50 symbol batches.
- The server checks an `exchange + symbol + visible window` sparkline cache first, then hydrates only cache misses or pending rows.
- If a fresh row is unavailable but a renderable stale sparkline is still usable, the server returns the stale row instead of a blank graph. `symbolMeta`, `usableSymbols`, and `usableStaleSymbols` distinguish usable stale data from true no-data states, and `isRenderable` plus `renderPriority` let the client keep drawing without waiting for a retry.
- One bad symbol does not fail the route. `rejectedSymbols`, `unsupportedSymbols`, and `unavailableSymbols` let the client patch successful rows and retry only failures.

```json
{
  "success": true,
  "data": {
    "selectedExchange": "upbit",
    "partial": true,
    "requestedSymbols": ["BTC", "ETH", "BAD"],
    "acceptedSymbols": ["BTC", "ETH"],
    "rejectedSymbols": [],
    "unsupportedSymbols": [
      { "symbol": "BAD", "reason": "symbol_mapping_not_found", "retryable": false }
    ],
    "unavailableSymbols": [],
    "source": "mixed",
    "freshness": "slightly_delayed",
    "generatedAt": 1712345679000,
    "missingSymbols": ["BAD"],
    "usableSymbols": ["BTC", "ETH"],
    "usableStaleSymbols": ["ETH"],
    "symbolMeta": [
      {
        "symbol": "BTC",
        "source": "fresh_cache",
        "isRenderable": true,
        "usable": true,
        "renderPriority": "cached",
        "pointCount": 20,
        "lastSuccessfulGraphAt": "2024-04-05T19:34:38.000Z",
        "graphLatencyBucket": "fast",
        "freshnessBucket": "fresh",
        "generatedAt": 1712345678000
      },
      {
        "symbol": "ETH",
        "source": "stale_cache",
        "isRenderable": true,
        "usable": true,
        "renderPriority": "stale",
        "pointCount": 12,
        "lastSuccessfulGraphAt": "2024-04-05T19:34:30.000Z",
        "graphLatencyBucket": "delayed",
        "freshnessBucket": "slightly_delayed",
        "generatedAt": 1712345670000,
        "fallbackReason": "stale_cache"
      }
    ],
    "cache": { "hit": 1, "miss": 1, "stale": 1 },
    "batch": { "index": 0, "requestedCount": 3, "success": 2, "failed": 1 },
    "items": [
      {
        "symbol": "BTC",
        "displayName": "비트코인",
        "sparkline": [99000000, 100000000],
        "sparklinePointCount": 20,
        "displayStatus": "fresh",
        "partial": false
      }
    ]
  }
}
```

### `GET /market/symbols`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`

This endpoint returns the canonical symbol universe for one exchange so clients can expand `all` locally.
It follows the provider market universe, not the curated registry subset.

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "quoteCurrency": "KRW",
    "baseExchange": "binance",
    "total": 3,
    "items": [
      {
        "exchange": "upbit",
        "symbol": "BTC",
        "exchangeSymbol": "KRW-BTC",
        "market": "BTC/KRW",
        "baseCurrency": "BTC",
        "quoteCurrency": "KRW",
        "tradable": true,
        "kimchiComparable": true,
        "kimchiComparisonReason": "COMPARABLE"
      },
      {
        "exchange": "upbit",
        "symbol": "ETH",
        "exchangeSymbol": "KRW-ETH",
        "market": "ETH/KRW",
        "baseCurrency": "ETH",
        "quoteCurrency": "KRW",
        "tradable": true,
        "kimchiComparable": false,
        "kimchiComparisonReason": "BINANCE_REFERENCE_MISSING"
      }
    ]
  }
}
```

### `GET /market/orderbook`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`

```json
{
  "success": true,
  "data": {
    "exchange": "bithumb",
    "symbol": "BTC",
    "market": "BTC/KRW",
    "baseCurrency": "BTC",
    "quoteCurrency": "KRW",
    "rawSymbol": "BTC_KRW",
    "asks": [
      { "price": 100010000, "quantity": 0.2 }
    ],
    "bids": [
      { "price": 99990000, "quantity": 0.3 }
    ],
    "bestAsk": 100010000,
    "bestBid": 99990000,
    "spread": 20000,
    "timestamp": 1712345678000,
    "sourceTimestamp": 1712345678000,
    "stale": false,
    "staleAgeMs": 310
  }
}
```

### `GET /market/trades`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`
- `limit?: number`

Policy:

- `timestamp` is the normalized raw exchange execution timestamp in epoch milliseconds and may be `null` when the provider did not supply a valid executable time.
- `executedAt` is the ISO8601 form of the same normalized timestamp and may be `null`.
- The server does not synthesize fake display times. Invalid or date-only provider timestamps are preserved as `null` instead of being coerced to midnight or a local default.

```json
{
  "success": true,
  "data": [
    {
      "exchange": "coinone",
      "symbol": "BTC",
      "market": "BTC/KRW",
      "baseCurrency": "BTC",
      "quoteCurrency": "KRW",
      "rawSymbol": "BTC",
      "tradeId": "trade-1",
      "side": "buy",
      "price": 100000000,
      "quantity": 0.01,
      "notional": 1000000,
      "timestamp": 1712345678000,
      "executedAt": "2024-04-05T19:34:38.000Z",
      "sourceTimestamp": 1712345678000,
      "stale": false,
      "staleAgeMs": 210
    }
  ]
}
```

### `GET /market/candles`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`
- `interval?: 1m | 3m | 5m | 10m | 15m | 30m | 1h | 4h | 1d | 1w`
- `limit?: number`

If the requested interval is unsupported by the exchange, the server resolves to the next supported canonical interval before calling the provider.

The `data` array shape is unchanged. New clients should also read the additive top-level `meta` object to distinguish a renderable stale graph from true no-data. When last-known-good candles exist, upstream timeout/rate-limit/5xx failures return `200` with `meta.freshnessState: "stale"` instead of `503`. `503` is reserved for the cold case where no usable candle payload exists.

```json
{
  "success": true,
  "data": [
    {
      "exchange": "korbit",
      "symbol": "BTC",
      "market": "BTC/KRW",
      "baseCurrency": "BTC",
      "quoteCurrency": "KRW",
      "rawSymbol": "btc_krw",
      "interval": "15m",
      "openTime": 1712344800000,
      "closeTime": 1712345699999,
      "open": 99500000,
      "high": 100300000,
      "low": 99200000,
      "close": 100000000,
      "volume": 21.7,
      "sourceTimestamp": 1712345699999,
      "stale": false,
      "staleAgeMs": 2000
    }
  ],
  "meta": {
    "isRenderable": true,
    "freshnessState": "stale",
    "lastSuccessfulAt": 1712345699000,
    "source": "fallback",
    "fallbackReason": "timeout",
    "pointCount": 12,
    "retryAfterMs": 3000,
    "renderPriority": "stale",
    "refreshPriority": "visible"
  }
}
```

### `GET /charts/candles`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`
- `interval?: 1m | 3m | 5m | 10m | 15m | 30m | 1h | 4h | 1d | 1w`
- `limit?: number`

Policy:

- `items` contains settled historical candles only.
- `live` contains the current in-progress candle when the server has enough information to build it.
- `meta` mirrors `/market/candles` freshness fields so the client can keep a stale usable graph mounted while a background refresh runs.
- `liveStatus` is `live | stale | pending`.
- The live candle is server-normalized from provider candle history plus canonical public trade/ticker updates.

### `GET /kimchi-premium/comparable-symbols`

Query:

- `exchange: upbit | bithumb | coinone | korbit`
- `limit?: number`

Policy:

- Returns the domestic exchange's canonical symbols that are comparable with Binance.
- The response is ordered from the prepared market snapshot so the client can request a representative first-screen kimchi set first.

### `GET /kimchi-premium`

Query:

- `symbols`: required, comma-separated canonical symbols such as `BTC,ETH,XRP`
- `venue?`: `upbit | bithumb | coinone | korbit`
- `exchange?`: alias of `venue`
- `quoteCurrency?`: optional, currently only `KRW`

Policy:

- `symbols` is normalized by trim + uppercase + alias-to-canonical conversion + empty removal + de-duplication.
- Raw exchange symbols such as `KRW-BTC` and `BTCUSDT` are accepted as aliases and normalized to `BTC`.
- `all`, `*`, `null`, `undefined` and similar wildcard/null-like values are rejected only when no explicit canonical symbol remains. Mixed requests keep valid symbols and expose rejected values on batch-style endpoints.
- Every row is terminal with `status: loaded | stale | partial | unavailable | failed`.
- Rows also expose additive display stability fields: `displayMeta.status: ready | stale | partial | unavailable`, component booleans (`hasUsableDomesticPrice`, `hasUsableReferencePrice`, `hasUsableFxRate`), per-component last-success timestamps, `delayBucket`, and `displayHint`.
- Unsupported or unmapped symbols stay inside the payload with per-row `errorCode` instead of failing the whole request.
- This legacy endpoint keeps its array response shape. New clients that need patch-friendly metadata should use `/kimchi-premium/batch`.

Invalid request example:

```json
{
  "success": false,
  "error": "symbols query parameter is required",
  "details": {
    "code": "INVALID_REQUEST",
    "field": "symbols",
    "reason": "REQUIRED",
    "acceptedFormat": "comma-separated canonical symbols",
    "example": "BTC,ETH,XRP"
  }
}
```

### `GET /kimchi-premium/snapshot`

Query:

- `symbols`: required, comma-separated canonical symbols
- `domesticExchange?`: `upbit | bithumb | coinone | korbit`
- `venue?` / `exchange?`: legacy aliases of `domesticExchange`
- `quoteCurrency?`: optional, currently only `KRW`

Policy:

- The endpoint returns one canonical payload for first render, websocket fallback, and polling fallback.
- `status` is one of `success | partial_success | failure`.
- `partialFailures` surfaces pair-level issues without failing the route when at least one pair is usable.
- `supportedPairs` lists symbols that are supported by both the requested domestic exchange and Binance even if a live ticker or FX value is temporarily unavailable.
- FX fallback is explicit via `FX_RATE_UNAVAILABLE` and row-level `errorCode`.

```json
{
  "success": true,
  "data": {
    "domesticExchange": "upbit",
    "globalExchange": "binance",
    "items": [
      {
        "symbol": "BTC",
        "nameKo": "비트코인",
        "nameEn": "Bitcoin",
        "status": "partial",
        "displayMeta": {
          "status": "partial",
          "hasUsableDomesticPrice": true,
          "hasUsableReferencePrice": true,
          "hasUsableFxRate": false,
          "lastSuccessfulDomesticAt": 1712345679000,
          "lastSuccessfulReferenceAt": 1712345678000,
          "lastSuccessfulFxAt": null,
          "delayBucket": "none",
          "displayHint": "keep_last_good"
        },
        "errorCode": "FX_RATE_UNAVAILABLE",
        "errorMessage": "USD/KRW rate is unavailable",
        "source": "derived",
        "asOf": 1712345679000,
        "freshnessMs": 300,
        "binanceUsdtPrice": 70000,
        "domesticExchange": "upbit",
        "domesticPrice": 100000000,
        "usdKrwRate": null,
        "binanceKrwPrice": null,
        "premiumPercent": null,
        "premiumAmountKRW": null
      },
      {
        "symbol": "OG",
        "nameKo": "OG",
        "nameEn": "OG",
        "status": "unavailable",
        "errorCode": "SYMBOL_MAPPING_NOT_FOUND",
        "errorMessage": "canonical mapping for OG is missing",
        "source": "derived",
        "asOf": null,
        "freshnessMs": null,
        "binanceUsdtPrice": null,
        "domesticExchange": "upbit",
        "domesticPrice": null,
        "usdKrwRate": null,
        "binanceKrwPrice": null,
        "premiumPercent": null,
        "premiumAmountKRW": null
      }
    ],
    "partialFailures": [
      {
        "symbol": "BTC",
        "exchange": "fx",
        "code": "FX_RATE_UNAVAILABLE",
        "message": "USD/KRW rate is unavailable",
        "stage": "fx_rate",
        "source": "derived",
        "retryable": true
      },
      {
        "symbol": "OG",
        "exchange": "upbit",
        "code": "SYMBOL_MAPPING_NOT_FOUND",
        "message": "canonical mapping for OG is missing",
        "stage": "premium_compute",
        "source": "derived",
        "retryable": false
      }
    ],
    "supportedPairs": ["BTC"],
    "status": "partial_success",
    "source": "derived",
    "asOf": 1712345679000,
    "freshnessMs": 300,
    "stale": false,
    "total": 2
  }
}
```

### `GET /kimchi-premium/representatives`

Query:

- `exchange`: `upbit | bithumb | coinone | korbit`
- `limit?`: representative row count for first paint
- `debug?`: optional

Policy:

- This endpoint is optimized for first-click readiness. Representative rows use the representative cache and can be returned while full hydration remains pending.
- If at least one representative row has usable premium, domestic, or global data, `representativeReady` and `hasUsableRepresentativeData` stay true even when the full batch is still hydrating.
- `recommendedInitialBadge` is `ready` or `delayed` when representative data is usable; `sync` is reserved for no usable representative data.

```json
{
  "success": true,
  "data": {
    "selectedExchange": "coinone",
    "sourceExchange": "coinone",
    "displayStatus": "delayed",
    "partial": false,
    "items": [],
    "meta": {
      "representativeReady": true,
      "hasUsableRepresentativeData": true,
      "representativeSource": "stale_cache",
      "representativeFreshnessBucket": "delayed",
      "recommendedInitialBadge": "delayed",
      "fullHydrationPending": true,
      "representative": {
        "ready": true,
        "hasUsableData": true,
        "source": "stale_cache",
        "freshnessBucket": "delayed",
        "recommendedInitialBadge": "delayed"
      },
      "fullHydration": {
        "pending": true,
        "phase": "background_batch",
        "freshnessBucket": "delayed",
        "uiHint": "background_hydration_only"
      }
    }
  }
}
```

### `GET /kimchi-premium/batch`

Query:

- `symbols`: required, comma-separated symbols
- `domesticExchange?`: `upbit | bithumb | coinone | korbit`
- `venue?` / `exchange?`: legacy aliases of `domesticExchange`
- `quoteCurrency?`: optional, currently only `KRW`

Policy:

- Designed for representative-first and batch hydration. It preserves all snapshot fields and adds request classification metadata.
- Representative readiness is independent from full batch hydration. A stale but usable representative row can return `representativeReady: true` with `recommendedInitialBadge: "ready"` or `"delayed"` while `fullHydrationPending` remains true.
- Domestic price, Binance reference price, and FX rate are retained independently as last-known-good components. A component failure degrades the row to `stale` or `partial` with `displayHint: "keep_last_good"` when any usable value remains; cold-start no-data uses `displayHint: "unavailable_cold"`.
- `rejectedSymbols` are malformed or wildcard-like request tokens.
- `unsupportedSymbols` are canonical symbols that cannot be compared for the selected domestic exchange and Binance.
- `unavailableSymbols` are retryable data issues such as missing FX, missing provider snapshots, or stale/incomplete source data.

```json
{
  "success": true,
  "data": {
    "domesticExchange": "bithumb",
    "globalExchange": "binance",
    "requestedSymbols": ["BTC", "HOME", "FI"],
    "acceptedSymbols": ["BTC", "HOME", "FI"],
    "rejectedSymbols": [],
    "unsupportedSymbols": [
      { "symbol": "HOME", "reason": "symbol_mapping", "retryable": false }
    ],
    "unavailableSymbols": [
      { "symbol": "FI", "reason": "domestic_support", "retryable": true }
    ],
    "partial": true,
    "meta": {
      "requestedCount": 3,
      "normalizedCount": 3,
      "acceptedCount": 3,
      "rejectedCount": 0,
      "unsupportedCount": 1,
      "unavailableCount": 1,
      "representativeReady": true,
      "hasUsableRepresentativeData": true,
      "representativeSource": "stale_cache",
      "representativeFreshnessBucket": "slightly_delayed",
      "recommendedInitialBadge": "ready",
      "fullHydrationPending": true,
      "batchFreshnessBucket": "delayed",
      "uiHint": "background_hydration_only",
      "representative": {
        "ready": true,
        "hasUsableData": true,
        "source": "stale_cache",
        "freshnessBucket": "slightly_delayed",
        "recommendedInitialBadge": "ready"
      },
      "fullHydration": {
        "pending": true,
        "phase": "background_batch",
        "freshnessBucket": "delayed",
        "hydratedCount": 2,
        "unavailableCount": 1,
        "uiHint": "background_hydration_only"
      }
    },
    "items": []
  }
}
```

```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC",
      "nameKo": "비트코인",
      "nameEn": "Bitcoin",
      "quoteCurrency": "KRW",
      "status": "loaded",
      "statusReason": "READY",
      "missingFields": [],
      "failureStage": null,
      "referenceExchange": "binance",
      "referenceMarket": "BTC/USDT",
      "referenceTimestamp": 1712345678000,
      "referenceStale": false,
      "referenceStaleAgeMs": 500,
      "binancePrice": 70000,
      "binanceUsdtPrice": 70000,
      "usdKrwRate": 1350,
      "binanceKrwPrice": 94500000,
      "krwConvertedReference": 94500000,
      "domesticVenue": "upbit",
      "domesticExchange": "upbit",
      "domesticMarket": "BTC/KRW",
      "domesticPrice": 100000000,
      "premiumPercent": 5.82010582010582,
      "premiumAmountKRW": 5500000,
      "fxProvider": "exchangerate.host",
      "fxTimestamp": 1712345677000,
      "fxStale": false,
      "fxStaleAgeMs": 600,
      "sparkline": [100000000, 100000000],
      "sparklinePoints": [
        { "price": 100000000, "timestamp": 1712345619000 },
        { "price": 100000000, "timestamp": 1712345679000 }
      ],
      "sparklineSource": "flat_current",
      "domestic": [
        {
          "exchange": "upbit",
          "market": "BTC/KRW",
          "priceKrw": 100000000,
          "premiumPercent": 5.82010582010582,
          "timestamp": 1712345679000,
          "sourceExchange": "upbit",
          "sourceTimestamp": 1712345679000,
          "stale": false,
          "staleAgeMs": 300,
          "krwConvertedReference": 94500000,
          "reason": null
        }
      ],
      "updatedAt": 1712345679000,
      "stale": false,
      "timestampSkewMs": 2000
    }
  ]
}
```

## Trading Routes

All trading routes require `Authorization: Bearer <jwt>`.

### `GET /trading/chance`

Query:

- `exchange`
- `symbol`

Unsupported capability returns `501`.

### `POST /trading/orders`

Body:

```json
{
  "exchange": "upbit",
  "symbol": "BTC",
  "side": "buy",
  "type": "limit",
  "quantity": 0.01,
  "price": 100000000,
  "clientOrderId": "client-123"
}
```

`stop_limit` is explicitly unsupported by the current canonical create-order contract and returns `501`.

Example response:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "orderId": "b6d6f3e1-1f4b-4f57-a5ad-1d42c4bb3e98",
    "symbol": "BTC",
    "market": "BTC/KRW",
    "side": "buy",
    "type": "limit",
    "status": "open",
    "price": 100000000,
    "quantity": 0.01,
    "filledQuantity": 0,
    "remainingQuantity": 0.01,
    "averageFillPrice": 0,
    "createdAt": 1712345678000,
    "updatedAt": 1712345678000
  }
}
```

### `DELETE /trading/orders/:exchange/:orderId`

Query:

- `symbol?: BTC | ETH | ...`

`coinone` and `korbit` require `symbol` for cancel and detail lookup because the upstream private API is pair-scoped.

### `GET /trading/orders/:exchange/:orderId`

Query:

- `symbol?: BTC | ETH | ...`

### `GET /trading/open-orders`

Query:

- `exchange`
- `symbol?`

### `GET /trading/fills`

Query:

- `exchange`
- `symbol?`
- `limit?`

## Portfolio Routes

All portfolio routes require `Authorization: Bearer <jwt>`.

### `GET /portfolio/summary`

Query:

- `exchange?`

Behavior:

- `exchange`가 있으면 단일 거래소 canonical portfolio snapshot을 반환합니다.
- `exchange`가 없으면 검증 완료된 사용자 연결 전체를 집계한 `PortfolioSummary`를 반환합니다.

### `GET /portfolio/assets`

Query:

- `exchange?`

Behavior:

- 연결된 거래소 전체 자산을 `AssetPosition[]` + `exchangeGroups[]` + `failures[]` 구조로 반환합니다.
- 일부 거래소만 실패하면 `partialSuccess=true` 로 응답하고 성공 거래소 데이터는 유지합니다.

```json
{
  "success": true,
  "data": {
    "requestedExchanges": ["upbit", "bithumb"],
    "connectedExchanges": ["upbit"],
    "partialSuccess": true,
    "failures": [
      {
        "exchange": "bithumb",
        "code": "exchange_unavailable",
        "message": "거래소 응답이 일시적으로 불안정합니다.",
        "details": { "upstreamStatus": 503 }
      }
    ],
    "totals": {
      "estimatedTotalAssetValueKrw": 2000000,
      "estimatedTotalPnlValueKrw": 50000,
      "estimatedTotalPnlPercent": 2.56
    },
    "exchangeGroups": [
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "quoteCurrency": "KRW",
        "assetCount": 2,
        "totalAssetValue": 2000000,
        "totalAssetValueKrw": 2000000,
        "totalPnlValue": 50000,
        "totalPnlValueKrw": 50000,
        "fetchedAt": "2026-04-21T00:00:00.000Z",
        "assets": [
          {
            "exchange": "upbit",
            "exchangeName": "업비트",
            "quoteCurrency": "KRW",
            "asset": "BTC",
            "quantity": 0.01,
            "availableQuantity": 0.01,
            "lockedQuantity": 0,
            "averageBuyPrice": 95000000,
            "averageBuyPriceKrw": 95000000,
            "currentPrice": 100000000,
            "currentPriceKrw": 100000000,
            "marketValue": 1000000,
            "marketValueKrw": 1000000,
            "pnlValue": 50000,
            "pnlValueKrw": 50000,
            "pnlPercent": 5.26,
            "isCashAsset": false,
            "timestamp": 1712345678000
          }
        ]
      }
    ],
    "assets": [
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "quoteCurrency": "KRW",
        "asset": "BTC",
        "quantity": 0.01,
        "availableQuantity": 0.01,
        "lockedQuantity": 0,
        "averageBuyPrice": 95000000,
        "averageBuyPriceKrw": 95000000,
        "currentPrice": 100000000,
        "currentPriceKrw": 100000000,
        "marketValue": 1000000,
        "marketValueKrw": 1000000,
        "pnlValue": 50000,
        "pnlValueKrw": 50000,
        "pnlPercent": 5.26,
        "isCashAsset": false,
        "timestamp": 1712345678000
      }
    ],
    "generatedAt": "2026-04-21T00:00:00.000Z"
  }
}
```

### `GET /portfolio/history`

Query:

- `exchange`
- `symbol?`
- `limit?`

Current history is trade-driven canonical history produced from private fills/completed orders.

Policy:

- `data` only contains verified user events. Mock, seed, sample, synthetic snapshot, and snapshot-diff rows are filtered out.
- If the user has no verified event history, the server returns `[]`. It does not synthesize sample rows.
- Each item includes source metadata so clients can explicitly render only verified user activity.

```json
{
  "success": true,
  "data": [
    {
      "id": "fill-1",
      "exchange": "upbit",
      "assetSymbol": "BTC",
      "symbol": "BTC",
      "eventType": "trade",
      "type": "trade",
      "amount": 0.01,
      "price": 100000000,
      "occurredAt": "2024-04-05T19:34:38.000Z",
      "timestamp": 1712345678000,
      "source": "exchange_private_api",
      "sourceType": "fill",
      "isSynthetic": false,
      "isVerifiedUserEvent": true,
      "description": "BUY 0.01 @ 100000000"
    }
  ]
}
```

## Exchange Connection Routes

All routes require `Authorization: Bearer <jwt>`.

- `GET /exchange-connections`
- `GET /exchange-connections/:id`
- `GET /exchange-connections/:id/status`
- `POST /exchange-connections/test`
- `POST /exchange-connections`
- `POST /exchange-connections/:id/revalidate`
- `POST /exchange-connections/:id/validate`
- `PATCH /exchange-connections/:id`
- `DELETE /exchange-connections/:id`

Example `GET /exchange-connections` response:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "conn-1",
        "exchange": "upbit",
        "exchangeName": "업비트",
        "label": "Primary Upbit",
        "permission": "read_only",
        "connectionPurpose": "read_only",
        "permissionScope": ["read"],
        "credentialStatus": "active",
        "status": "connected",
        "maskedCredentialSummary": "abc*****xyz",
        "lastValidatedAt": "2026-04-17T06:00:00.000Z",
        "apiKeyMasked": "abc*****xyz",
        "hasSecretKey": true,
        "hasPassphrase": false,
        "credentialFields": [
          { "key": "apiKey", "label": "Access Key", "required": true, "masked": true },
          { "key": "secretKey", "label": "Secret Key", "required": true, "masked": true }
        ],
        "capabilities": {
          "canTestConnection": true,
          "canReadPortfolio": true,
          "canPlaceOrder": true,
          "canCancelOrder": true,
          "canReadOpenOrders": true,
          "canReadFills": true
        },
        "validation": {
          "status": "verified",
          "mode": "live_api",
          "canUsePrivateApi": true,
          "code": "verified",
          "appCode": "CONNECTION_VERIFIED",
          "message": "업비트 연결이 확인되었습니다.",
          "checkedAt": "2026-04-17T06:00:00.000Z"
        },
        "lastTestResult": {
          "exchange": "upbit",
          "success": true,
          "status": "verified",
          "mode": "live_api",
          "code": "verified",
          "appCode": "CONNECTION_VERIFIED",
          "permission": "read_only",
          "message": "업비트 연결이 확인되었습니다.",
          "checkedAt": "2026-04-17T06:00:00.000Z"
        },
        "operational": {
          "connectionStatus": "active",
          "lastSyncAt": "2026-04-17T06:05:00.000Z",
          "lastErrorCode": null,
          "lastErrorSummary": null,
          "failureReason": null,
          "isTestConnectionResult": true
        },
        "createdAt": "2026-04-17T05:59:00.000Z",
        "updatedAt": "2026-04-17T06:05:00.000Z"
      }
    ],
    "total": 1
  }
}
```

Credential status values:

- `pending_verification`
- `active`
- `verification_failed`
- `invalid_credentials`
- `insufficient_scope`
- `ip_not_allowed`
- `temporarily_unreachable`
- `revoked`
- `reauth_required`

Credential handling rules:

- `POST /exchange-connections/test` verifies a submitted key without storing it.
- `POST /exchange-connections` stores encrypted credentials and records a verified or failed status; it never marks a failed validation as active.
- `PATCH /exchange-connections/:id` never returns or exposes existing secrets. Secret changes require re-entry, while label-only changes do not decrypt credentials.
- `DELETE /exchange-connections/:id` hard-deletes the encrypted credential row. Dependent history rows keep nullable connection references.

Example `POST /exchange-connections/test` response:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "success": false,
    "status": "invalid",
    "mode": "live_api",
    "code": "insufficient_permissions",
    "appCode": "INSUFFICIENT_SCOPE",
    "permission": "trade_enabled",
    "message": "API 키 권한이 부족합니다.",
    "details": {
      "upstreamStatus": 403
    },
    "checkedAt": "2026-04-21T00:00:00.000Z"
  }
}
```

## Auth Routes

- `POST /auth/register`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/social/google`
- `POST /api/v1/auth/social/apple`
- `GET /api/v1/auth/me`

`/api/v1/auth/register` is the existing server path. `/auth/register` is a compatibility alias for the iOS client and uses the same handler and response contract.

Swagger/OpenAPI-compatible JSON is exposed at `GET /api/v1/openapi.json`.

### `POST /api/v1/auth/social/google`

Request:

```json
{
  "idToken": "GOOGLE_ID_TOKEN",
  "accessToken": "GOOGLE_ACCESS_TOKEN"
}
```

`idToken` is required. `accessToken` is accepted for client compatibility but identity verification uses the signed Google ID token. Expected audience: `142113558371-t5s22ri6gjl5aur76s81910gf2hb8p09.apps.googleusercontent.com`.

### `POST /api/v1/auth/social/apple`

Request:

```json
{
  "identityToken": "APPLE_IDENTITY_TOKEN",
  "authorizationCode": "APPLE_AUTHORIZATION_CODE",
  "fullName": "사용자 이름",
  "email": "user@example.com"
}
```

`identityToken` is required. Expected audience/client_id: `com.hwb.Cryptory`. The server verifies the token against Apple's JWKS and does not need `APPLE_TEAM_ID`, `APPLE_KEY_ID`, or `APPLE_PRIVATE_KEY` unless authorization-code exchange is added later.

### `POST /auth/register`

Request:

```json
{
  "nickname": "tester",
  "email": "user@example.com",
  "password": "password123"
}
```

Validation:

- `nickname`: required, 1-20 characters. Nicknames are not unique in the current DB schema.
- `email`: required, valid email format, normalized to lowercase before storage.
- `password`: required, 8-72 characters, stored only as a bcrypt hash.

Success response:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user-1",
      "email": "user@example.com",
      "nickname": "tester",
      "authProvider": "email",
      "createdAt": "2026-04-21T00:00:00.000Z",
      "updatedAt": "2026-04-21T00:00:00.000Z"
    },
    "token": "jwt"
  }
}
```

Error responses:

```json
{
  "success": false,
  "error": "이메일 형식이 올바르지 않습니다.",
  "code": "INVALID_EMAIL_FORMAT",
  "details": {
    "issues": [
      {
        "field": "email",
        "code": "INVALID_EMAIL_FORMAT",
        "message": "이메일 형식이 올바르지 않습니다."
      }
    ]
  }
}
```

```json
{
  "success": false,
  "error": "비밀번호는 8자 이상 72자 이하로 입력해야 합니다.",
  "code": "INVALID_PASSWORD_LENGTH",
  "details": {
    "issues": [
      {
        "field": "password",
        "code": "INVALID_PASSWORD_LENGTH",
        "message": "비밀번호는 8자 이상 72자 이하로 입력해야 합니다."
      }
    ]
  }
}
```

```json
{
  "success": false,
  "error": "요청 값을 확인해주세요.",
  "code": "INVALID_REQUEST",
  "details": {
    "issues": [
      {
        "field": "nickname",
        "code": "INVALID_REQUEST",
        "message": "요청 값을 확인해주세요."
      }
    ]
  }
}
```

```json
{
  "success": false,
  "error": "이미 가입된 이메일입니다",
  "code": "EMAIL_ALREADY_EXISTS",
  "details": {
    "field": "email",
    "resource": "user"
  }
}
```

Unexpected registration failures return HTTP 500 with `code: "AUTH_REGISTER_FAILED"` and do not expose passwords or secrets in logs.

## Exchange Metadata Routes

- `GET /exchange-metadata`
- `GET /exchange-metadata/:exchange`

## Unsupported Cases

- Binance private trading and private portfolio.
- Canonical `stop_limit` order creation.
- Provider-pair-scoped order lookup without `symbol` for Coinone and Korbit.
- Private websocket session fan-out to user-facing server routes. Current HTTP private APIs use live REST and update connection sync state; private WS orchestration is still pending.
