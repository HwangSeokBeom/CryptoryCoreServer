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
  "message": "message",
  "error": "message",
  "code": "MACHINE_READABLE_CODE",
  "details": {}
}
```

`message` is the canonical user-displayable error text. `error` remains as a compatibility alias.
`code` is always present; routes that do not provide a more specific code use `REQUEST_FAILED`.
`details` is optional and must not contain credentials, tokens, API keys, signatures, or raw
authorization headers.

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

These public endpoints expose `appName`, legal/support URLs, account route contracts, social login client ids, and app-review readiness. Production startup requires all public legal/support URL env vars to be set to valid URLs: `APP_HOMEPAGE_URL`, `TERMS_URL`, `PRIVACY_POLICY_URL`, `SUPPORT_URL`, `ACCOUNT_DELETION_URL`, `INVESTMENT_DISCLAIMER_URL`, and `COMMUNITY_POLICY_URL`.

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

### `GET /market/candles`

Auth: not required. Compatibility alias: `GET /api/v1/market/candles`.

Query:

- `exchange`: `upbit | bithumb`
- `symbol`: base symbol or provider market id, for example `BTC`, `ETH`, `KRW-BTC`, `BTC-ETH`, `BTC/KRW`
- `quoteCurrency`: `KRW | BTC`
- `timeframe`: `1M | 5M | 15M | 1H | 4H | 1D | 1W`
- `limit`: default `200`, max `500`

Compatibility: `interval=1m|5m|15m|1h|4h|1d|1w` is accepted and normalized to `timeframe`, but the response shape remains the canonical iOS shape below. `/market/candles` does not return both `data[]` and `data.candles[]` unless the deprecated legacy mode below is used without `quoteCurrency`/`timeframe`.

Response:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "symbol": "BTC",
    "quoteCurrency": "KRW",
    "market": "KRW-BTC",
    "timeframe": "1H",
    "source": "upbit",
    "candles": [
      {
        "timestamp": "2026-05-04T12:00:00.000Z",
        "open": 95000000,
        "high": 96000000,
        "low": 94000000,
        "close": 95500000,
        "volume": 12.345,
        "quoteVolume": 1170000000
      }
    ],
    "summary": {
      "currentPrice": 95500000,
      "high24h": 97000000,
      "low24h": 93000000,
      "changeRate24h": 1.52,
      "volume24h": 201575000000
    }
  }
}
```

Candles are sorted ascending by `timestamp`. `4H` is aggregated from `1H`; `1W` is aggregated from `1D`.
The server applies a short TTL cache controlled by `CANDLE_CACHE_TTL_SECONDS`.

### `GET /market/exchanges`

Auth: not required. Compatibility alias: `GET /api/v1/market/exchanges`.

Returns the market quote capability contract clients should use before showing quote tabs.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "exchange": "upbit",
        "displayName": "업비트",
        "supportedQuotes": ["KRW", "BTC"],
        "defaultQuoteCurrency": "KRW",
        "enabled": true,
        "status": "active",
        "reason": null
      },
      {
        "exchange": "binance",
        "displayName": "바이낸스",
        "supportedQuotes": ["USDT", "BTC", "ETH"],
        "defaultQuoteCurrency": "USDT",
        "enabled": true,
        "status": "active",
        "reason": null
      }
    ]
  }
}
```

### `GET /market/tickers`

Auth: not required. Compatibility alias: `GET /api/v1/market/tickers`.

Query:

- `exchange`: `upbit | bithumb | coinone | korbit | binance`
- `quoteCurrency`: optional. Supported values depend on `exchange`.
- `sort`: optional `volume | changeRate | price | name | volume_desc | change_desc | price_desc`
- `order`: optional `asc | desc`
- `sortKey`: optional alias for `sort`. Accepted row keys include `volume24h`, `changeRate24h`, `currentPrice`, and `assetName`.
- `sortDirection`: optional alias for `order`.
- `limit`: optional, max `500`
- `cursor`: optional opaque cursor from `data.meta.nextCursor`

Exchange quote contract:

| exchange | displayName | supportedQuotes | defaultQuoteCurrency | note |
| --- | --- | --- | --- | --- |
| `upbit` | 업비트 | `KRW`, `BTC` | `KRW` | `KRW-BTC` is `BTC/KRW`, not a BTC quote market. BTC quote markets are `BTC-*`. |
| `bithumb` | 빗썸 | `KRW`, `BTC` | `KRW` | External rows are normalized to `marketId` and `displayPair` that match the requested quote. |
| `coinone` | 코인원 | `KRW` | `KRW` | BTC requests return unsupported diagnostics. |
| `korbit` | 코빗 | `KRW` | `KRW` | BTC requests return unsupported diagnostics. |
| `binance` | 바이낸스 | `USDT`, `BTC`, `ETH` | `USDT` | Binance is not KRW-centered. `exchange=binance` without `quoteCurrency` defaults to `USDT`; `KRW` is unsupported unless a separate conversion contract is introduced. |

Clients should call `GET /market/exchanges` or read `supportedQuotes` from `/market/tickers` before rendering quote segmented controls. Unsupported quote requests return `success=true` with `items=[]` and diagnostics instead of an ambiguous empty list.
Upbit currently advertises only `KRW` and `BTC`. Clients must not render an Upbit `USDT` quote tab unless the server contract starts including `USDT` in `supportedQuotes`.

Response:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "quoteCurrency": "BTC",
    "supportedQuotes": ["KRW", "BTC"],
    "defaultQuoteCurrency": "KRW",
    "items": [
      {
        "exchange": "upbit",
        "exchangeName": "업비트",
        "market": "BTC-ETH",
        "exchangeSymbol": "BTC-ETH",
        "marketId": "BTC-ETH",
        "rawSymbol": "BTC-ETH",
        "symbol": "ETH",
        "baseCurrency": "ETH",
        "quoteCurrency": "BTC",
        "displayPair": "ETH/BTC",
        "koreanName": "이더리움",
        "englishName": "Ethereum",
        "displayName": "이더리움",
        "currentPrice": 0.03,
        "price": 0.03,
        "current": 0.03,
        "changeRate24h": 1.52,
        "change24h": 1.52,
        "percent": 1.52,
        "signedChangePrice24h": 0.0004,
        "accTradePrice24h": 120.5,
        "accTradeVolume24h": 4012.1,
        "volume24h": 4012.1,
        "high24h": 0.031,
        "low24h": 0.029,
        "timestamp": 1777809600000,
        "sourceTimestamp": 1777809600000,
        "stale": false,
        "sparkline": [],
        "sparklinePoints": [],
        "sparklineSource": "unavailable",
        "sparklineQuality": "insufficient_points",
        "sparklinePointCount": 0,
        "sparklineIsDerived": false,
        "sparklineUpdatedAt": "2026-05-04T12:00:00.000Z",
        "sparklineUnavailableReason": "insufficient_sparkline_points",
        "sparklineLowInformationReason": null,
        "graphDisplayAllowed": false,
        "lowConfidence": false,
        "previewSparkline": [],
        "previewGraphQuality": "unavailable",
        "previewGraphIsDerived": false,
        "previewGraphPointCount": 0,
        "previewGraphRealSeries": false,
        "previewGraphDisplayAllowed": false
      }
    ],
    "meta": {
      "exchange": "upbit",
      "quoteCurrency": "BTC",
      "requestedLimit": 10,
      "returnedCount": 10,
      "nextCursor": "eyJzb3J0S2V5Ijoidm9sdW1lIiw...",
      "hasNext": true,
      "sparklineTargetPointCount": 24,
      "sparklineAttachedCount": 9,
      "sparklineMissingCount": 0,
      "sparklineUnavailableCount": 1,
      "sparklineLowInformationCount": 2,
      "supportedQuotes": ["KRW", "BTC"],
      "defaultQuoteCurrency": "KRW",
      "timing": {
        "totalMs": 120,
        "tickerFetchMs": 95,
        "sparklineAttachMs": 3
      }
    },
    "diagnostics": {
      "requestedExchange": "upbit",
      "requestedQuoteCurrency": "BTC",
      "supported": true,
      "unsupported": false,
      "providerStatus": "active",
      "providerLatencyMs": 123,
      "rawCount": 10,
      "mappedCount": 10,
      "returnedCount": 10,
      "omittedCount": 0,
      "zeroPriceCount": 0,
      "zeroVolumeCount": 0,
      "staleCount": 0,
      "reason": null,
      "previewGraphIsDerived": true,
      "previewGraphDerivedCount": 10,
      "previewGraphRealSeries": false,
      "previewGraphDisplayAllowed": false
    }
  }
}
```

`/market/tickers` returns one market list scoped by `exchange + quoteCurrency`. Every item must echo the same `exchange` and `quoteCurrency` as `data.exchange` and `data.quoteCurrency`; rows with mismatched `marketId`/`displayPair` are dropped before response and logged.
`quoteCurrency=BTC` returns only BTC quote markets. Upbit `KRW-BTC` is the Bitcoin/KRW market and must not appear in an Upbit BTC quote response. The server applies `TICKER_CACHE_TTL_SECONDS`.
`/market/tickers` is ticker-first: it never calls all-symbol trades/candles/history APIs to build first-paint rows.
Ticker rows include both canonical fields (`currentPrice`, `changeRate24h`, `accTradePrice24h`) and compatibility aliases (`exchangeSymbol`, `displayName`, `price`, `current`, `percent`, `volume24h`, `timestamp`, `sourceTimestamp`, `stale`) so old and new iOS mappers can render rows without dropping them.
Ticker list sparklines target 24 points and are attached before pagination responses are returned. Source priority is provider candle points embedded by the adapter, cached candle/sparkline rows, ticker ring buffer (`exchange|quoteCurrency|canonicalMarketId`, retained up to 240 observations), stale previous snapshot, then explicit `unavailable`. The list path does not fabricate linear 24-point trends from current price or 24h change. If a ticker ring buffer has fewer than 12 points, the response is normalized to `sparkline=[]`, `sparklinePoints=[]`, `sparklineSource=unavailable`, `sparklineQuality=insufficient_points`, and `sparklineUnavailableReason=insufficient_sparkline_points`. For real series, fewer than 12 points are not displayable, 12-23 points are allowed with `lowConfidence=true`, and 24 or more points are normal quality.

Unsupported quote example:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "quoteCurrency": "USDT",
    "supportedQuotes": ["KRW", "BTC"],
    "defaultQuoteCurrency": "KRW",
    "status": "unsupported",
    "items": [],
    "diagnostics": {
      "requestedExchange": "upbit",
      "requestedQuoteCurrency": "USDT",
      "supportedQuotes": ["KRW", "BTC"],
      "defaultQuoteCurrency": "KRW",
      "supported": false,
      "unsupported": true,
      "providerStatus": "unsupported",
      "reason": "quote_currency_not_supported",
      "returnedCount": 0
    }
  }
}
```

Empty, unsupported, and provider error are distinct:

- `unsupported`: requested quote is not in `supportedQuotes`; clients should hide/disable that tab.
- `empty`: quote is supported but provider returned no usable rows; clients can show an empty state and retry.
- `provider error`: response has `success=false`, `error.code=PROVIDER_UNAVAILABLE` or exchange error code, and `data.diagnostics.providerStatus="error"`.

### Public WebSocket `market.candle`

Path: `/ws/market`. Auth: not required. REST candle snapshots remain the initial chart source;
WebSocket candle events are incremental updates after the first REST paint.

Subscribe:

```json
{
  "type": "subscribe",
  "channel": "market.candle",
  "exchange": "upbit",
  "symbol": "BTC",
  "quoteCurrency": "KRW",
  "timeframe": "1H"
}
```

Event:

```json
{
  "type": "candle",
  "exchange": "upbit",
  "symbol": "BTC",
  "quoteCurrency": "KRW",
  "market": "KRW-BTC",
  "timeframe": "1H",
  "candle": {
    "timestamp": "2026-05-04T12:00:00.000Z",
    "open": 95000000,
    "high": 96000000,
    "low": 94000000,
    "close": 95500000,
    "volume": 0,
    "quoteVolume": 0
  },
  "isFinal": false
}
```

Unsubscribe uses the same payload with `"type": "unsubscribe"`.

### Price Alerts

All `/alerts/price` routes require an access token. Compatibility alias: `/api/v1/alerts/price`.

- `GET /alerts/price`: lists the current user's alerts. Optional query: `symbol`, `exchange`, `quoteCurrency`, `isActive`.
- `POST /alerts/price`: creates or reactivates a duplicate alert for the current user.
- `PATCH /alerts/price/{alertId}`: updates only the current user's alert.
- `DELETE /alerts/price/{alertId}`: deletes only the current user's alert.

Create body:

```json
{
  "exchange": "upbit",
  "symbol": "BTC",
  "quoteCurrency": "KRW",
  "condition": "ABOVE",
  "targetPrice": 100000000,
  "repeatMode": "ONCE",
  "isActive": true
}
```

`condition` is `ABOVE | BELOW`; `repeatMode` is `ONCE | REPEAT`. `targetPrice` must be greater than `0`.
`REPEAT` alerts use `PRICE_ALERT_REPEAT_COOLDOWN_SECONDS`; `ONCE` alerts are deactivated after a successful FCM send.

### FCM Tokens

All routes require an access token. Compatibility alias: `/api/v1/push/fcm-token`.

`POST /push/fcm-token` body:

```json
{
  "token": "fcm_registration_token",
  "platform": "IOS",
  "deviceId": "optional-device-id",
  "appVersion": "1.0.0",
  "environment": "dev"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "registered": true
  }
}
```

`DELETE /push/fcm-token` body:

```json
{
  "token": "fcm_registration_token"
}
```

The token is stored in the DB but never logged raw. Logs include only a SHA-256 prefix.
Invalid/unregistered FCM token failures deactivate the stored token.

### FCM Price Alert Payload

```json
{
  "notification": {
    "title": "BTC 가격 알림",
    "body": "BTC가 ₩100,000,000 이상에 도달했습니다."
  },
  "data": {
    "type": "PRICE_ALERT",
    "alertId": "alert-id",
    "exchange": "upbit",
    "symbol": "BTC",
    "quoteCurrency": "KRW",
    "condition": "ABOVE",
    "targetPrice": "100000000",
    "currentPrice": "100250000"
  }
}
```

Required env:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FCM_ENABLED`
- `FCM_DRY_RUN`
- `PRICE_ALERT_WORKER_ENABLED`
- `PRICE_ALERT_POLL_INTERVAL_MS`
- `PRICE_ALERT_REPEAT_COOLDOWN_SECONDS`
- `MARKET_DATA_PROVIDER`
- `CANDLE_CACHE_TTL_SECONDS`
- `TICKER_CACHE_TTL_SECONDS`
- `MARKET_COLLECTOR_ENABLED` defaults to `false`; public market streaming/background collection starts only when explicitly `true`.
- `MARKET_TRADE_COLLECTOR_ENABLED` defaults to `false`; exchange trades hydration starts only when explicitly `true`.
- `MARKET_TREND_SNAPSHOT_ENABLED` defaults to `false`; global market history snapshot persistence starts only when explicitly `true`.
- `MARKET_STARTUP_WARMUP_ENABLED` defaults to `false`; startup warmup remains disabled unless explicitly enabled.

Firebase Admin SDK service-account JSON files must not be committed or returned to clients.
`FIREBASE_PRIVATE_KEY` converts escaped `\n` sequences to real newlines at startup.

## Informational Public Routes

Canonical client paths are root-level routes. `/api/v1/news`, `/api/v1/coins`, and `/api/v1/market`
are compatibility aliases only; clients should document and prefer the root paths. If the alias is
enabled, it returns the same envelope and body shape.

Status policy:

- GET success: `200`.
- POST create success: `201`.
- POST vote/upsert success: `200`.
- Invalid request: `400`.
- Auth required or failed: `401`.
- Permission denied: `403`.
- Missing resource: `404`.
- Server error: `500`.

Informational routes:

- `GET /calculators/usdt-rate`
- `GET /news`
- `GET /news/overview`
- `GET /news/:newsId`
- `GET /coins/:symbol/news`
- `GET /coins/:symbol`
- `GET /coins/:symbol/info`
- `GET /coins/:symbol/analysis?timeframe=1m|5m|15m|30m|1h|2h`
- `GET /coins/:symbol/community`
- `POST /coins/:symbol/community` (requires access token, returns `201`)
- `POST /coins/:symbol/community/:itemId/like` (requires access token)
- `DELETE /coins/:symbol/community/:itemId/like` (requires access token)
- `GET /coins/:symbol/community/:itemId/comments`
- `POST /coins/:symbol/community/:itemId/comments` (requires access token)
- `POST /users/:userId/follow` (requires access token)
- `DELETE /users/:userId/follow` (requires access token)
- `GET /users/:userId/follow-state`
- `GET /coins/:symbol/sentiment`
- `POST /coins/:symbol/sentiment` (requires access token, upsert, returns `200`)
- `POST /translate` (legacy server-side fallback; current iOS news translation should prefer Apple Translation on-device)
- `GET /market/data` (legacy/deprecated for the news tab calculator flow)
- `GET /market/trends?range=7d|30d&currency=KRW` (legacy/deprecated for the news tab calculator flow)
- `GET /market/sentiment`
- `POST /market/sentiment` (requires access token, upsert, returns `200`)
- `GET /market/themes`

All successful responses use `{ "success": true, "data": ... }`. Provider failures should return a
200 response with null-safe fallback fields when a meaningful informational shell can still be built.
Missing provider data is represented with `available: false`, `reason`, `unavailableReasons`,
`dataState.emptyReason`, or an explicit empty-state object. Partial responses keep successful
subsections and mark missing provider sections with `available: false`, `reason`, `source`,
`provider`, `isStale`, or `emptyState`. The server must not return a bare empty array when the client
needs to distinguish "empty" from "not ready".

The informational APIs must not include buy/sell/recommendation/investment-advice wording in response
copy. Coin symbols are normalized before lookup, so `DRIFT/KRW`, `KRW-DRIFT`, and `drift` all resolve
to `DRIFT`; `ORCA/KRW`, `KRW-ORCA`, and `orca` all resolve to `ORCA`.

### `GET /calculators/usdt-rate`

USDT/KRW display rate for the News tab calculator segment. This is the only calculator API currently
needed by the client; profit/loss and averaging-down calculators must run locally on-device and must
not send user investment inputs to the server. The CoinMarketCap API key stays server-side and is
never returned to clients.

The server uses CoinMarketCap `GET /v2/cryptocurrency/quotes/latest` with `id=825` by default
(`USDT_COINMARKETCAP_ID` can override it), `convert=KRW`, and the `X-CMC_PRO_API_KEY` header. A
Redis-backed cache is used first, with in-memory fallback if Redis is unavailable. The host remains
`https://pro-api.coinmarketcap.com`; `pro-api` is the official API host name and does not imply a
Professional plan requirement.

Fresh response:

```json
{
  "success": true,
  "data": {
    "symbol": "USDT",
    "name": "Tether USDt",
    "convert": "KRW",
    "price": 1375.25,
    "source": "coinmarketcap",
    "cacheHit": false,
    "updatedAt": "2026-05-03T22:35:00.000Z",
    "expiresAt": "2026-05-03T22:40:00.000Z",
    "reason": null
  }
}
```

Stale cache fallback:

```json
{
  "success": true,
  "data": {
    "symbol": "USDT",
    "name": "Tether USDt",
    "convert": "KRW",
    "price": 1374.8,
    "source": "cache",
    "cacheHit": true,
    "updatedAt": "2026-05-03T22:30:00.000Z",
    "expiresAt": "2026-05-03T22:35:00.000Z",
    "reason": "using_stale_cache"
  }
}
```

Unavailable response:

```json
{
  "success": true,
  "data": {
    "symbol": "USDT",
    "name": "Tether USDt",
    "convert": "KRW",
    "price": null,
    "source": "none",
    "cacheHit": false,
    "updatedAt": null,
    "expiresAt": null,
    "reason": "coinmarketcap_api_key_missing"
  }
}
```

Failure reasons are `coinmarketcap_api_key_missing`, `coinmarketcap_rate_limited`,
`coinmarketcap_auth_failed`, `coinmarketcap_timeout`, `coinmarketcap_unavailable`,
`coinmarketcap_malformed_response`, `coinmarketcap_price_missing`, and `using_stale_cache`.
External provider failures return `200` with `price: null` when no stale cache exists;
validation/auth/internal server errors keep the normal error envelope.

### `GET /coins/:symbol/info`

```json
{
  "success": true,
  "data": {
    "symbol": "DRIFT",
    "scope": "coin",
    "marketId": "KRW-DRIFT",
    "displaySymbol": "DRIFT/KRW",
    "name": "Drift",
    "nameKo": "드리프트",
    "logoUrl": "https://...",
    "provider": "coingecko",
    "providerId": "drift-protocol",
    "description": {
      "available": true,
      "ko": null,
      "en": "English plain text",
      "plainTextKo": null,
      "plainTextEn": "English plain text",
      "rawHtml": "<p>English plain text</p>",
      "sourceLanguage": "en",
      "renderLanguage": "ko",
      "translated": false,
      "translationProvider": "unavailable",
      "reason": "TRANSLATION_PROVIDER_NOT_CONFIGURED",
      "updatedAt": "2026-05-02T13:22:00.000Z"
    },
    "links": {
      "homepage": "https://...",
      "whitepaper": null,
      "explorer": "https://..."
    },
    "homepageUrl": "https://...",
    "explorerUrl": "https://...",
    "market": {
      "price": 86.8,
      "priceCurrency": "KRW",
      "priceChangePercent24h": 2.97,
      "priceChangePercent7d": null,
      "priceChangePercent14d": null,
      "priceChangePercent30d": null,
      "priceChangePercent60d": null,
      "priceChangePercent200d": null,
      "priceChangePercent1y": null,
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
    "source": "coingecko",
    "updatedAt": "2026-05-02T13:22:00.000Z",
    "sourceDetail": {
      "metadata": "coingecko",
      "market": "market_snapshot",
      "fallbackUsed": false
    }
  }
}
```

Period price change fields are null-safe. The server maps provider values when available and returns
`null` when a provider does not publish that period; it does not synthesize historical period changes.
`GET /coins/:symbol` is the canonical coin info route and `GET /coins/:symbol/info` is kept as a
compatibility alias with the same body shape. Symbols are normalized before lookup:
`ORCA`, `orca`, `KRW-ORCA`, and `ORCA/KRW` all resolve to `ORCA`.

Description policy:

- CoinGecko `description.ko` is used first when present.
- If only English exists, the server attempts the configured translation provider. When translation
  is not configured, `plainTextEn`/`en` are populated and Korean fields are `null` with
  `translationProvider: "unavailable"` and `reason="TRANSLATION_PROVIDER_NOT_CONFIGURED"`.
- HTML is preserved only in `rawHtml`; display fields are stripped and entity-decoded plain text.
- If no description exists, `description.available=false` and `reason="DESCRIPTION_NOT_AVAILABLE"`.

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
    "symbol": "ORCA",
    "items": [
      {
        "id": "community_item_id",
        "symbol": "ORCA",
        "content": "12313",
        "author": {
          "id": "user_id",
          "nickname": null,
          "displayName": "us***@example.com",
          "emailMasked": "us***@example.com",
          "isPrivateRelay": false,
          "avatarUrl": null,
          "isFollowing": false,
          "followable": true,
          "isMe": false
        },
        "createdAt": "2026-05-02T02:24:27.420Z",
        "updatedAt": "2026-05-02T02:24:27.420Z",
        "likeCount": 0,
        "replyCount": 0,
        "commentCount": 0,
        "isLiked": false,
        "myReaction": null
      }
    ],
    "pagination": {
      "nextCursor": null,
      "hasMore": false
    },
    "summary": {
      "itemCount": 1,
      "participantCount": 1
    }
  }
}
```

Compatibility fields `vote` and `nextCursor` can be present for older clients. New clients should use
`pagination` and `summary`.

### `POST /coins/:symbol/community`

Requires a valid access token. Missing, invalid, and expired access tokens return stable 401 codes:
`ACCESS_TOKEN_REQUIRED`, `ACCESS_TOKEN_INVALID`, or `ACCESS_TOKEN_EXPIRED`.

```json
{
  "success": true,
  "data": {
    "item": {
      "id": "community-item-id",
      "symbol": "ORCA",
      "content": "12313",
      "author": {
        "id": "user-id",
        "nickname": null,
        "displayName": "us***@example.com",
        "emailMasked": "us***@example.com",
        "isPrivateRelay": false,
        "avatarUrl": null,
        "isFollowing": false,
        "followable": true,
        "isMe": true
      },
      "createdAt": "2026-05-02T00:00:00.000Z",
      "updatedAt": "2026-05-02T00:00:00.000Z",
      "likeCount": 0,
      "replyCount": 0,
      "commentCount": 0,
      "isLiked": false,
      "myReaction": null
    },
    "summary": {
      "itemCount": 1,
      "participantCount": 1
    }
  }
}
```

POST trims `content`, rejects empty content with `400 INVALID_COMMUNITY_CONTENT`, and returns an
`item` with the same canonical shape used by GET `items[]`. `id` is always a string, timestamps are ISO
strings, and `author` is never null. `participantCount` is the unique author count for the symbol and
includes the newly created post author.

### Community Likes

`POST /coins/:symbol/community/:itemId/like` creates a like for the authenticated user. Repeated
POST calls are idempotent and do not increase `likeCount` more than once. `DELETE` removes the like;
deleting a missing like is also idempotent.

```json
{
  "success": true,
  "data": {
    "itemId": "community_item_id",
    "symbol": "ORCA",
    "isLiked": true,
    "likeCount": 12,
    "updatedAt": "2026-05-02T14:00:00.000Z"
  }
}
```

Missing items return `404 COMMUNITY_ITEM_NOT_FOUND`. Community item list and create DTOs include
`likeCount`, `isLiked`, and `myReaction`.

### Community Comments

`GET /coins/:symbol/community/:itemId/comments` returns a cursor page and comment summary.
`POST /coins/:symbol/community/:itemId/comments` requires auth and body `{ "content": "댓글 내용" }`.
Content is trimmed; empty content returns `400 INVALID_COMMENT_CONTENT`.

```json
{
  "success": true,
  "data": {
    "symbol": "ORCA",
    "itemId": "community_item_id",
    "items": [
      {
        "id": "comment_id",
        "itemId": "community_item_id",
        "content": "댓글 내용",
          "author": {
            "id": "user_id",
            "nickname": null,
            "displayName": "Apple 사용자",
            "emailMasked": "w9***@privaterelay.appleid.com",
            "isPrivateRelay": true,
            "avatarUrl": null,
            "isFollowing": false,
            "followable": true,
            "isMe": false
          },
        "createdAt": "2026-05-02T14:00:00.000Z",
        "updatedAt": "2026-05-02T14:00:00.000Z"
      }
    ],
    "pagination": { "nextCursor": null, "hasMore": false },
    "summary": { "commentCount": 1 }
  }
}
```

### Author Follow

Discussion-card follow state is author follow, not coin watch/star state. `POST /users/:userId/follow`
and `DELETE /users/:userId/follow` are idempotent. Self-follow returns `400 CANNOT_FOLLOW_SELF`.

```json
{
  "success": true,
  "data": {
    "targetUserId": "user_id",
    "isFollowing": true,
    "followerCount": 10,
    "updatedAt": "2026-05-02T14:00:00.000Z"
  }
}
```

Community item and comment `author` is never `null` and includes `displayName`, `nickname`,
`emailMasked`, `isPrivateRelay`, `isFollowing`, `followable`, and `isMe`. Display-name priority is:
profile display name, nickname, name, Apple private relay fallback `"Apple 사용자"`, masked normal
email local part, then `"사용자"`. The raw email address is never returned as `displayName`; email
exposure is limited to `emailMasked`. When `author.id` is missing, `followable=false` so the client can
disable follow actions.

Auth error example:

```json
{
  "success": false,
  "message": "인증이 필요합니다",
  "error": "인증이 필요합니다",
  "code": "ACCESS_TOKEN_REQUIRED",
  "details": {
    "hasAuthorization": false,
    "tokenLength": 0
  }
}
```

### Coin Sentiment

`GET /coins/:symbol/sentiment` and `POST /coins/:symbol/sentiment` are scoped to one normalized coin
symbol. POST accepts `{ "vote": "bullish" }` or `{ "vote": "bearish" }`, requires auth, and upserts
one vote per `user + symbol + UTC date`.

```json
{
  "success": true,
  "data": {
    "scope": "coin",
    "symbol": "ORCA",
    "date": "2026-05-02",
    "totalParticipants": 12,
    "bullishCount": 7,
    "bearishCount": 5,
    "bullishRatio": 58.33,
    "bearishRatio": 41.67,
    "ratioScale": "percent",
    "myVote": "bullish",
    "updatedAt": "2026-05-02T02:24:27.420Z"
  }
}
```

`POST /coins/:symbol/votes` remains a compatibility alias for the older community poll shape and
should not be used for new client work.
Invalid sentiment votes return `400 INVALID_SENTIMENT_VOTE`.

### Market Sentiment

`GET /market/sentiment` and `POST /market/sentiment` are scoped to the whole market, not a coin. POST
accepts `{ "vote": "bullish" }` or `{ "vote": "bearish" }`, requires auth, and upserts one vote per
`user + UTC date`.

```json
{
  "success": true,
  "data": {
    "scope": "market",
    "date": "2026-05-02",
    "totalParticipants": 120,
    "bullishCount": 70,
    "bearishCount": 50,
    "bullishRatio": 58.33,
    "bearishRatio": 41.67,
    "ratioScale": "percent",
    "myVote": "bearish",
    "updatedAt": "2026-05-02T02:24:27.420Z"
  }
}
```

GET is public and returns `myVote: null` when no authenticated user is available. Invalid POST votes
return `400 INVALID_SENTIMENT_VOTE`; missing/invalid auth returns `401` with the auth error code.

### `POST /translate`

Server-side translation endpoint for coin descriptions and news fallback translation. External
provider credentials stay in server environment only.

```json
{
  "success": true,
  "data": {
    "sourceLanguage": "en",
    "targetLanguage": "ko",
    "translatedText": "한국어 번역문",
    "provider": "openai",
    "cached": false,
    "updatedAt": "2026-05-02T14:00:00.000Z"
  }
}
```

Supported providers are `TRANSLATION_PROVIDER=openai|papago|google`. Cache key is normalized plain
text hash + source language + target language. HTML input is converted to plain text before
translation. Text longer than `TRANSLATION_MAX_TEXT_LENGTH` returns `400 TRANSLATION_TEXT_TOO_LONG`
with chunking guidance. Missing provider credentials return `503 TRANSLATION_PROVIDER_NOT_CONFIGURED`.
Successful translation results are cached by text hash + target language. Provider failures are not
cached as long-lived successes; coin description responses keep English text and set
`description.reason` instead.

Coin info description contract:

- `description.ko/plainTextKo` use CoinGecko `description.ko` first.
- If Korean text is missing and English text exists, the server calls the configured translation
  provider and sets `translationProvider` to the concrete provider name such as `openai`.
- If translation cannot run, `ko/plainTextKo=null`, `en/plainTextEn` remain populated, and `reason`
  is `TRANSLATION_PROVIDER_NOT_CONFIGURED` or `TRANSLATION_FAILED`.
- `rawHtml` is the provider HTML, while `plainTextKo/plainTextEn` are safe display text.

### `GET /news`

```json
{
  "success": true,
  "data": {
    "scope": "market",
    "sourceStatus": {
      "externalConfigured": true,
      "externalAvailable": true,
      "providers": ["cryptopanic", "coindesk_rss"],
      "fallbackUsed": false,
      "reason": null,
      "externalCount": 20,
      "fallbackCount": 0
    },
    "items": [
      {
        "id": "btc-market-overview-2026-04-30",
        "scope": "market",
        "symbols": ["BTC"],
        "title": "Bitcoin market data shows steady liquidity across major venues",
        "titleKo": "비트코인 시장 데이터, 주요 거래소에서 안정적인 유동성 보여",
        "summary": "English summary",
        "summaryKo": "한국어 요약",
        "source": "Cryptory Research",
        "provider": "cryptory_research",
        "publishedAt": "2026-04-30T00:00:00.000Z",
        "url": "https://cryptory.example/news/btc-market-overview-2026-04-30",
        "imageUrl": null,
        "tags": ["market", "bitcoin", "BTC"],
        "language": "en",
        "translated": true,
        "translationProvider": "server",
        "tone": "neutral"
      }
    ],
    "pagination": {
      "nextCursor": null,
      "hasMore": false
    },
    "emptyState": {
      "isEmpty": false,
      "reason": null
    },
    "updatedAt": "2026-05-02T13:22:00.000Z",
    "nextCursor": null
  }
}
```

Market news uses `scope: "market"`. `source` is always a non-empty string on items. List responses
also include `source`, `cacheHit`, `providerStatus`, `reason`, `date`, and the applied
`sort: { orderBy, direction }` so clients can distinguish provider outages from valid empty results.
External fetch
uses `NEWS_PROVIDER=cryptopanic|cryptocurrency_cv|newsapi`. CryptoPanic uses only
`CRYPTOPANIC_API_BASE_URL` and is skipped when `CRYPTOPANIC_API_KEY` is empty.
`cryptocurrency_cv` uses `CRYPTOCURRENCY_CV_API_BASE_URL` with no auth header and no API key query:
`/news` for market news, `/search?q={symbol}` for coin news, and `/digest` for the news overview.
`newsapi` uses `NEWSAPI_API_BASE_URL` and sends the key server-side through `X-Api-Key`. When
`NEWS_PROVIDER=newsapi`, NewsAPI is the primary provider for market and coin news. When another
selected provider is unavailable, NewsAPI is used as fallback if `NEWSAPI_API_KEY` is configured;
otherwise the server falls back to public RSS feeds
(`NEWS_RSS_FEEDS` or defaults: CoinDesk, Cointelegraph, Decrypt). `cryptory_research` items are the
last fallback only and are marked through `sourceStatus.fallbackUsed=true`; they are not presented as
external provider data. `sourceStatus.providers` includes `cryptocurrency_cv` when that provider is
selected. Successful provider results are cached for `NEWS_CACHE_TTL_SECONDS`; provider failure or
rate limit falls back to the cached payload before returning an empty response. Items are deduped by
URL hash and normalized title, then sorted by the requested `sort/orderBy/direction` with
`publishedAt desc` as the default.

### `GET /coins/:symbol/news`

```json
{
  "success": true,
  "data": {
    "scope": "coin",
    "symbol": "ORCA",
    "coinName": "Orca",
    "provider": "cryptopanic",
    "sourceStatus": {
      "externalConfigured": true,
      "externalAvailable": true,
      "providers": ["cryptopanic", "coindesk_rss"],
      "fallbackUsed": false,
      "reason": null,
      "externalCount": 20,
      "fallbackCount": 0
    },
    "items": [],
    "relatedItems": [],
    "pagination": {
      "nextCursor": null,
      "hasMore": false
    },
    "emptyState": {
      "isEmpty": true,
      "reason": "NO_DIRECT_COIN_NEWS"
    },
    "updatedAt": "2026-05-02T13:22:00.000Z",
    "nextCursor": null
  }
}
```

Coin news uses `scope: "coin"` and keeps direct and ecosystem-related items separate. Direct matching
order is provider `currencies/symbols`, exact tags, title/summary keyword, then coin-name keyword.
`relatedItems` may contain ecosystem context such as Solana/DEX/DeFi for ORCA, and clients should
label it as related fallback rather than direct token news. A coin with no direct news returns `200`
with `emptyState.reason="NO_DIRECT_COIN_NEWS"` when `relatedItems` exists, or
`NO_RELATED_COIN_NEWS` when neither direct nor related items are available. The top-level `reason`
uses client-facing lower-case values such as `no_related_news`,
`provider_limit_or_error_and_cache_empty`, or `providers_disabled_and_cache_empty`. Ambiguous symbols
such as `BIO` use metadata keywords such as `BIO Protocol`, `BIO token`, `BIO crypto`, `DeSci`, and
`bio.xyz` rather than bare word matching.

### `GET /market/data`

Canonical market dashboard endpoint. Existing exchange list endpoint `GET /market/overview?exchange=...`
is a separate market-list route and is not the dashboard contract.

```json
{
  "success": true,
  "data": {
    "scope": "market",
    "currency": "KRW",
    "source": "coingecko",
    "updatedAt": "2026-05-02T02:24:00.000Z",
    "isStale": false,
    "sourceStatus": {
      "marketDataAvailable": true,
      "fearGreedAvailable": true,
      "fallbackUsed": false,
      "staleCacheUsed": false,
      "reasons": []
    },
    "metrics": {
      "totalMarketCap": {
        "value": 2680000000000,
        "formatted": "KRW 2.68조",
        "currency": "KRW",
        "source": "coingecko",
        "updatedAt": "2026-05-02T02:24:00.000Z",
        "available": true,
        "reason": null
      },
      "totalVolume24h": {
        "value": 83225000000,
        "formatted": "KRW 832.25억",
        "currency": "KRW",
        "source": "coingecko",
        "updatedAt": "2026-05-02T02:24:00.000Z",
        "available": true,
        "reason": null
      },
      "btcDominance": { "value": 58.47, "unit": "percent", "source": "coingecko", "available": true, "reason": null },
      "ethDominance": { "value": 10.37, "unit": "percent", "source": "coingecko", "available": true, "reason": null },
      "fearGreedIndex": {
        "value": 26,
        "unit": "index",
        "label": "fear",
        "labelKo": "공포",
        "scale": { "min": 0, "max": 100 },
        "available": true,
        "source": "alternative.me",
        "reason": null
      },
      "altcoinIndex": {
        "value": null,
        "unit": "index",
        "label": null,
        "labelKo": null,
        "available": false,
        "source": null,
        "reason": "ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED"
      }
    },
    "availability": {
      "totalMarketCap": true,
      "totalVolume24h": true,
      "btcDominance": true,
      "ethDominance": true,
      "fearGreedIndex": true,
      "altcoinIndex": false
    },
    "unavailableReasons": {
      "altcoinIndex": "ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED"
    }
  }
}
```

Fear & Greed thresholds:

- `0..24`: `extreme_fear` / `극단적 공포`
- `25..44`: `fear` / `공포`
- `45..55`: `neutral` / `중립`
- `56..75`: `greed` / `탐욕`
- `76..100`: `extreme_greed` / `극단적 탐욕`

Therefore score `26` must be `fear` / `공포`, not neutral.

### `GET /market/trends?range=7d|30d&currency=KRW`

Market trend series uses provider snapshots accumulated by the server. CoinGecko global data provides
current values only, so the server records current snapshots and returns explicit partial state until
there are enough points for a chart.

```json
{
  "success": true,
  "data": {
    "scope": "market",
    "range": "7d",
    "currency": "KRW",
    "source": "coingecko+news_provider",
    "updatedAt": "2026-05-02T02:24:00.000Z",
    "pointCount": 2,
    "chartReady": false,
    "renderHint": "limited_points",
    "dataQuality": {
      "level": "low",
      "messageKo": "추이 차트를 표시하기에는 데이터가 아직 적습니다.",
      "reason": "INSUFFICIENT_POINTS"
    },
    "availability": {
      "totalMarketCap": true,
      "totalVolume": true,
      "btcDominance": true,
      "ethDominance": true,
      "fearGreedIndex": false
    },
    "unavailableReasons": {
      "fearGreedIndex": "HISTORICAL_FEAR_GREED_NOT_AVAILABLE"
    },
    "points": [
      {
        "timestamp": "2026-04-26T00:00:00.000Z",
        "totalMarketCap": 2600000000000,
        "totalVolume": 79000000000,
        "btcDominance": 57.9,
        "ethDominance": 10.1,
        "fearGreedIndex": null
      }
    ],
    "emptyState": {
      "isEmpty": false,
      "reason": null
    }
  }
}
```

`pointCount` is the number of returned points. `chartReady=false` when fewer than 7 points exist.
`renderHint` values are `limited_points` for 0-2 points, `limited` for 3-6 points, and `chart` for
7 or more points. The iOS client must not render the large trend chart when `chartReady=false`; it may
show a compact/empty state using `dataQuality.messageKo`. `points[]` shape is fixed, timestamps are
ISO strings, and numeric fields are numbers or `null`.

### `GET /news/overview`

Latest-trends/news overview endpoint for the segmented news screen.

```json
{
  "success": true,
  "data": {
    "scope": "market",
    "updatedAt": "2026-05-02T02:24:00.000Z",
    "source": "coingecko+news_provider",
    "sourceStatus": {
      "marketDataAvailable": true,
      "fearGreedAvailable": true,
      "newsAvailable": true,
      "fallbackUsed": false,
      "reasons": [],
      "news": {
        "externalConfigured": true,
        "externalAvailable": true,
        "providers": ["cryptopanic", "coindesk_rss"],
        "fallbackUsed": false,
        "reason": null
      }
    },
    "summary": {
      "title": "오늘 시장 요약",
      "headline": "현재 시장 심리는 공포 구간입니다.",
      "headlineKo": "현재 시장 심리는 공포 구간입니다.",
      "description": "BTC dominance is 58.47% and 24h volume is KRW 832.25억.",
      "descriptionKo": "BTC 도미넌스는 58.47%, 24시간 거래량은 KRW 832.25억입니다.",
      "tone": "fear",
      "available": true,
      "reason": null
    },
    "mood": {
      "score": 26,
      "label": "fear",
      "labelKo": "공포",
      "scale": { "min": 0, "max": 100 },
      "thresholds": [
        { "min": 0, "max": 24, "label": "extreme_fear", "labelKo": "극단적 공포" },
        { "min": 25, "max": 44, "label": "fear", "labelKo": "공포" },
        { "min": 45, "max": 55, "label": "neutral", "labelKo": "중립" },
        { "min": 56, "max": 75, "label": "greed", "labelKo": "탐욕" },
        { "min": 76, "max": 100, "label": "extreme_greed", "labelKo": "극단적 탐욕" }
      ],
      "source": "alternative.me",
      "available": true,
      "reason": null,
      "updatedAt": "2026-05-02T02:24:00.000Z"
    },
    "marketSentiment": {
      "scope": "market",
      "date": "2026-05-02",
      "totalParticipants": 0,
      "bullishCount": 0,
      "bearishCount": 0,
      "bullishRatio": 0,
      "bearishRatio": 0,
      "ratioScale": "percent",
      "myVote": null,
      "updatedAt": "2026-05-02T02:24:00.000Z"
    },
    "topNews": [
      {
        "id": "news_id",
        "title": "뉴스 제목",
        "titleKo": "뉴스 제목",
        "summary": "summary",
        "summaryKo": "요약",
        "source": "source name",
        "provider": "cryptopanic",
        "publishedAt": "2026-05-02T01:00:00.000Z",
        "url": "https://example.com/news",
        "imageUrl": null,
        "tags": ["BTC"],
        "symbols": ["BTC"]
      }
    ]
  }
}
```

`events` and `eventsState` are removed from the canonical overview contract. Older clients should
hide the major-events card when those optional deprecated fields are absent.

### External Provider Environment

- Coin info and market dashboard: `COINGECKO_API_BASE_URL`, optional `COINGECKO_API_KEY`.
- Calculator USDT/KRW rate: `COINMARKETCAP_API_BASE_URL`, `COINMARKETCAP_API_KEY`,
  `COINMARKETCAP_TIMEOUT_MS`, `USDT_RATE_CACHE_TTL_SECONDS`, `USDT_COINMARKETCAP_ID`.
- Market history cache: `MARKET_DATA_CACHE_TTL_SECONDS`; optional `COINMARKETCAP_API_KEY` and
  `CRYPTOCOMPARE_API_KEY` are accepted without making startup depend on them.
- Fear & Greed: Alternative.me public endpoint.
- News: `NEWS_PROVIDER=cryptopanic|cryptocurrency_cv|newsapi`; optional `CRYPTOPANIC_API_KEY`,
  `CRYPTOPANIC_API_BASE_URL`; `CRYPTOCURRENCY_CV_API_BASE_URL` for the no-auth cryptocurrency.cv
  provider; `NEWSAPI_API_KEY`/`NEWSAPI_API_BASE_URL` for NewsAPI primary or fallback;
  `NEWS_CACHE_TTL_SECONDS`.
- News RSS fallback: optional `NEWS_RSS_FEEDS` comma-separated URLs. If omitted, the server uses
  public CoinDesk, Cointelegraph, and Decrypt RSS feeds before falling back to `cryptory_research`.
- Translation: `TRANSLATION_PROVIDER`, `TRANSLATION_API_BASE_URL`, `TRANSLATION_MODEL`,
  `TRANSLATION_MAX_TEXT_LENGTH`, plus provider credentials `OPENAI_API_KEY`,
  `PAPAGO_CLIENT_ID/PAPAGO_CLIENT_SECRET`, or `GOOGLE_TRANSLATE_API_KEY`.
- External API keys are never returned to clients and are redacted from logs.

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

### Deprecated Legacy `GET /market/tickers`

The canonical active client contract is the iOS first-paint contract documented near the top of this file: `GET /market/tickers?exchange=upbit&quoteCurrency=KRW|BTC&sort=&order=&limit=` returning `data.items[]`.

This legacy shape is retained only for older clients that omit `quoteCurrency`.

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

- `exchange`: required. Supports `upbit | bithumb | coinone | korbit | binance`.
- `quoteCurrency`: optional per exchange. Defaults to the exchange default (`binance` defaults to `USDT`).
- `symbols`: comma-separated base symbols.
- `marketIds`: comma-separated market ids. Use this when available to avoid ambiguity.
- `interval`: optional, defaults to `1H`
- `limit`: optional, defaults to `24`, max `60`
- `priority`: optional. `priority=top`, or `marketIds` count `1..4` with `limit=60`, uses the fast interactive sparkline path.
- `batchIndex?`: optional non-negative client batch index for logs/debugging
- `allowStale?`: optional, defaults to allowing short stale sparkline cache reuse
- `debug?`: optional

Either `symbols` or `marketIds` is required. Wildcards such as `all`, `*`, `null`, and `undefined` are rejected.

Policy:

- `/market/tickers` is for fast first paint rows plus a derived preview.
- `/market/sparkline?quoteCurrency=...` is for visible row mini graphs keyed by `exchange + quoteCurrency + marketId`.
- The prepared ring buffer key is `exchange:quoteCurrency:marketId`, for example `upbit:KRW:KRW-BIO` or `binance:USDT:BTCUSDT`; Upbit `KRW-BIO` and Bithumb `KRW-BIO` never share points.
- `priority=top` targets an overall response within `1200ms`; each item independently settles as cache, stale cache, ring partial, provider full/partial, timeout with partial, timeout unavailable, provider unavailable, resolve failed, or quote mismatch. One slow provider must not hold the whole batch open.
- It resolves `marketIds` first, then checks the in-memory sparkline cache, ticker snapshot ring buffer, provider candle/minute data, partial real fallback, and finally explicit `unavailable`. It does not promote derived/linear previews to displayable graph quality.
- The canonical sparkline route does not call trades or orderbook providers. For `limit=60&interval=1m`, provider minute candles may be used as `provider_candle_1m`; `/market/candles` remains the selected detail chart endpoint.
- Symbol cap is 50. Cap violations return `400 SYMBOLS_LIMIT_EXCEEDED`; partial success is allowed for unsupported or unavailable symbols.
- Quality enum includes `provider_candle_1m`, `provider_partial_real`, `provider_mini`, `provider_mini_real`, `prepared_cache`, `prepared_cache_real`, `cache_partial_real`, `cache_stale_real`, `live_buffer_partial`, `refined_mini`, `refined_mini_real`, `derived_preview`, `derived_interpolated`, `insufficient_variation`, `flat_current`, `placeholder`, and `unavailable`.
- `pointCount = points.length`.
- `pointCount <= 6` must be `derived_preview`, `flat_current`, `placeholder`, or unavailable; it must not be reported as prepared/provider quality.
- `prepared_cache`, `prepared_cache_real`, `cache_partial_real`, `cache_stale_real`, `live_buffer_partial`, `provider_partial_real`, `refined_mini`, `refined_mini_real`, `provider_mini`, `provider_mini_real`, and `provider_candle_1m` mean `isDerived=false`, but clients should still require `realSeries=true`. `pointCount >= 8`, `uniqueValueCount >= 3`, `valueRange > 0`, and `isLinearDerived=false` are sufficient for displayable partial real rows.
- Server start or cold buffer returns provider candle data, displayable partial real data, or `unavailable`; it must not fabricate a fake prepared cache.
- `pointCount=60` alone is not enough. If values are flat, have too few unique values, or look like first/last interpolation, the server sets `realSeries=false` and downgrades `quality` to `insufficient_variation`, `derived_preview`, or `derived_interpolated`.
- `marketIds` take precedence over `symbols` when both are present. `symbols` are resolved with `exchange + quoteCurrency`, so `KRW-BTC` resolves only as `BTC/KRW` when `quoteCurrency=KRW`; it is never treated as a BTC quote market.
- Clients should replace a preview row graph only when `graphDisplayAllowed=true`, `isDerived=false`, `realSeries=true`, quality is `provider_candle_1m`, `provider_partial_real`, `prepared_cache`, `prepared_cache_real`, `cache_partial_real`, `cache_stale_real`, `live_buffer_partial`, `refined_mini`, `refined_mini_real`, `provider_mini`, or `provider_mini_real`, and `exchange`, `quoteCurrency`, `marketId`, and generation context match the row being replaced. Partial rows may be displayed only when the server has already set `graphDisplayAllowed=true`.
- Partial real rows set `partial=true`, `diagnostics.partial=true`, `diagnostics.partialReason` (`buffer_warming`, `provider_partial`, or `timeout_with_partial`), `diagnostics.coverageRatio=pointCount/requestedLimit`, and `recommendedDisplayScale`.
- High-quality real cache writes are quality ranked. `unavailable`, provider timeout, resolve failure, empty provider responses, derived previews, and linear/fake graphs do not delete or overwrite an existing displayable real cache entry. Item diagnostics include `cacheKey`, `cacheWriteDecision`, `previousQuality`, and `newQuality`.
- Coinone and Korbit keep app canonical `marketId` separate from provider format. Cache keys always include `KRW`, for example `coinone:KRW:KRW-BTC` and `korbit:KRW:KRW-BTC`; Coinone provider market is the base symbol such as `BTC`, while Korbit provider market is lower snake case such as `btc_krw`.
- Response diagnostics include `priority`, `elapsedMs`, `timeoutMs`, `providerTimeoutCount`, `providerFailedCount`, `resolveFailedCount`, `quoteMismatchCount`, `displayAllowedCount`, `partialCount`, `fullCount`, `staleCount`, `cacheHitCount`, `staleCacheHitCount`, `ringBufferHitCount`, `providerFetchCount`, `minPointCount`, `maxPointCount`, `qualities`, and `heavyPathUsed`.
- Item diagnostics include `decision`, `resolvedBy`, `provider`, `providerMarket`, `cacheKey`, `cacheHit`, `stale`, `cacheAgeMs`, `cacheWriteDecision`, `previousQuality`, `newQuality`, `ringBufferHit`, `providerFetched`, `providerLatencyMs`, `providerTimeout`, `providerError`, `fallbackReason`, `partial`, `partialReason`, `coverageRatio`, value statistics, `isFlat`, `isLinearDerived`, `graphDisplayAllowedReason`, and `recommendedDisplayScale`.
- The server computes `rangeRatio=valueRange/abs(meanValue)`, `firstLastChangeRatio`, `uniqueValueCount`, `directionChanges`, `zeroDeltaCount`, `duplicateTimestampCount`, `linearityScore`, `isFlat`, and `isLinearDerived` for every item. `recommendedDisplayScale` is `0.25` for `rangeRatio < 0.002`, `0.40` for `< 0.005`, `0.60` for `< 0.015`, and `0.80` otherwise.

The example below abbreviates `points`, `sparkline`, and `sparklinePoints`; real responses always have `pointCount === points.length === sparklinePointCount`. Each point includes both `price` for backward compatibility and `value` for the detailed graph contract.

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "quoteCurrency": "KRW",
    "supportedQuotes": ["KRW", "BTC"],
    "defaultQuoteCurrency": "KRW",
    "interval": "1H",
    "limit": 60,
    "items": [
      {
        "exchange": "upbit",
        "symbol": "BIO",
        "marketId": "KRW-BIO",
        "baseCurrency": "BIO",
        "quoteCurrency": "KRW",
        "displayPair": "BIO/KRW",
        "points": [
          { "price": 86.1, "value": 86.1, "timestamp": 1777875600000 },
          { "price": 86.7, "value": 86.7, "timestamp": 1777875660000 }
        ],
        "sparkline": [86.1, 86.7],
        "sparklinePoints": [
          { "price": 86.1, "value": 86.1, "timestamp": 1777875600000 },
          { "price": 86.7, "value": 86.7, "timestamp": 1777875660000 }
        ],
        "source": "prepared_cache",
        "sparklineSource": "prepared_cache",
        "quality": "prepared_cache",
        "sparklineQuality": "prepared_cache",
        "sparklinePointCount": 60,
        "pointCount": 60,
        "isRenderable": true,
        "isDerived": false,
        "realSeries": true,
        "graphDisplayAllowed": true,
        "recommendedDisplayScale": 0.8,
        "volatilityHint": "high",
        "stale": false,
        "updatedAt": 1777875660000,
        "interval": "1H",
        "requestedLimit": 60,
        "from": 1777875600000,
        "to": 1777875660000,
        "generatedAt": "2026-05-04T10:00:00.000Z",
        "sourceReason": "ticker_snapshot_ring_buffer",
        "diagnostics": {
          "requestedLimit": 60,
          "pointCount": 60,
          "provider": null,
          "cacheHit": false,
          "cacheAgeMs": null,
          "stale": false,
          "ringBufferHit": true,
          "providerFetched": false,
          "providerLatencyMs": null,
          "providerTimeout": false,
          "partial": false,
          "partialReason": null,
          "coverageRatio": 1,
          "uniqueValueCount": 24,
          "minValue": 84.9,
          "maxValue": 88.2,
          "meanValue": 86.7,
          "firstValue": 86.1,
          "lastValue": 86.7,
          "valueRange": 3.3,
          "rangeRatio": 0.0380622837,
          "firstLastChangeRatio": 0.0069686411,
          "directionChanges": 18,
          "zeroDeltaCount": 0,
          "duplicateTimestampCount": 0,
          "linearityScore": 0.41,
          "straightnessScore": 0.41,
          "isFlat": false,
          "isLinearDerived": false,
          "realSeries": true,
          "graphDisplayAllowed": true,
          "graphDisplayAllowedReason": "real_series_ready",
          "recommendedDisplayScale": 0.8,
          "volatilityHint": "high",
          "fallbackReason": "ticker_snapshot_ring_buffer",
          "resolvedBy": "ring_buffer"
        }
      }
    ],
    "unsupportedSymbols": [],
    "unavailableSymbols": [],
    "diagnostics": {
      "requestedExchange": "upbit",
      "requestedQuoteCurrency": "KRW",
      "exchange": "upbit",
      "quoteCurrency": "KRW",
      "requestedCount": 1,
      "returnedCount": 1,
      "fullCount": 1,
      "partialCount": 0,
      "fallbackCount": 0,
      "derivedCount": 0,
      "realSeriesCount": 1,
      "displayAllowedCount": 1,
      "unavailableCount": 0,
      "qualities": { "prepared_cache": 1 },
      "cacheHitCount": 0,
      "ringBufferHitCount": 1,
      "providerFetchCount": 0,
      "providerTimeoutCount": 0,
      "avgLatencyMs": 1,
      "maxLatencyMs": 1,
      "unsupported": false,
      "unsupportedDetails": [],
      "reason": null,
      "supportedQuotes": ["KRW", "BTC"],
      "defaultQuoteCurrency": "KRW",
      "minPointCount": 60,
      "maxPointCount": 60,
      "pointCountMin": 60,
      "pointCountMax": 60,
      "invalidPointCount": 0,
      "heavyPathUsed": false
    }
  }
}
```

Curl verification examples:

```bash
curl 'http://127.0.0.1:3000/market/sparkline?exchange=binance&quoteCurrency=USDT&marketIds=USDCUSDT,BTCUSDT,ETHUSDT,SOLUSDT&limit=60&interval=1m&priority=top'
curl 'http://127.0.0.1:3000/market/tickers?exchange=bithumb&quoteCurrency=KRW&limit=4'
curl 'http://127.0.0.1:3000/market/sparkline?exchange=bithumb&quoteCurrency=KRW&marketIds={top4-marketIds-from-tickers}&limit=60&interval=1m&priority=top'
curl 'http://127.0.0.1:3000/market/tickers?exchange=coinone&quoteCurrency=KRW&limit=4'
curl 'http://127.0.0.1:3000/market/sparkline?exchange=coinone&quoteCurrency=KRW&marketIds={top4-marketIds-from-tickers}&limit=60&interval=1m&priority=top'
curl 'http://127.0.0.1:3000/market/tickers?exchange=korbit&quoteCurrency=KRW&limit=4'
curl 'http://127.0.0.1:3000/market/sparkline?exchange=korbit&quoteCurrency=KRW&marketIds={top4-marketIds-from-tickers}&limit=60&interval=1m&priority=top'
```

Check response diagnostics for `priority`, `elapsedMs`, `displayAllowedCount`, `partialCount`, `fullCount`, `staleCount`, `unavailableCount`, and `quoteMismatchCount`. Check each item for `marketId`, `pointCount`, `quality`, `realSeries`, `graphDisplayAllowed`, `diagnostics.decision`, `diagnostics.cacheKey`, `diagnostics.providerMarket`, `diagnostics.cacheWriteDecision`, and `diagnostics.fallbackReason`. Full real rows should usually have quality `provider_candle_1m` or `prepared_cache_real` with decision `provider_full`, `cache_full`, or `cache_stale_full`; partial displayable rows should be `provider_partial_real`, `live_buffer_partial`, `cache_partial_real`, or `cache_stale_real`; provider misses should be explicit `unavailable` or stale real cache, not a derived preview.

Fallback example where a 60-point response is not a detailed graph:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "quoteCurrency": "KRW",
    "interval": "1M",
    "limit": 60,
    "items": [
      {
        "exchange": "upbit",
        "symbol": "BTC",
        "marketId": "KRW-BTC",
        "quoteCurrency": "KRW",
        "displayPair": "BTC/KRW",
        "pointCount": 60,
        "points": [
          { "price": 100000000, "value": 100000000, "timestamp": 1777875600000 }
        ],
        "quality": "insufficient_variation",
        "source": "provider_candle_1m",
        "isDerived": false,
        "realSeries": false,
        "graphDisplayAllowed": false,
        "recommendedDisplayScale": 0.25,
        "diagnostics": {
          "pointCount": 60,
          "uniqueValueCount": 1,
          "minValue": 100000000,
          "maxValue": 100000000,
          "meanValue": 100000000,
          "firstValue": 100000000,
          "lastValue": 100000000,
          "valueRange": 0,
          "rangeRatio": 0,
          "firstLastChangeRatio": 0,
          "directionChanges": 0,
          "zeroDeltaCount": 59,
          "duplicateTimestampCount": 0,
          "linearityScore": 1,
          "straightnessScore": 1,
          "isFlat": true,
          "isLinearDerived": true,
          "realSeries": false,
          "graphDisplayAllowed": false,
          "recommendedDisplayScale": 0.25,
          "volatilityHint": "flat",
          "fallbackReason": "insufficient_variation",
          "resolvedBy": "provider_candle"
        }
      }
    ],
    "diagnostics": {
      "requestedCount": 1,
      "returnedCount": 1,
      "fallbackCount": 1,
      "derivedCount": 0,
      "realSeriesCount": 0,
      "displayAllowedCount": 0,
      "unavailableCount": 0,
      "qualities": { "insufficient_variation": 1 },
      "heavyPathUsed": false
    }
  }
}
```

Derived fallback example:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "quoteCurrency": "KRW",
    "items": [
      {
        "exchange": "upbit",
        "symbol": "BTC",
        "marketId": "KRW-BTC",
        "displayPair": "BTC/KRW",
        "pointCount": 6,
        "points": [
          { "price": 99000000, "value": 99000000, "timestamp": 1777723200000 },
          { "price": 100000000, "value": 100000000, "timestamp": 1777809600000 }
        ],
        "quality": "derived_preview",
        "source": "derived_change24h",
        "isDerived": true,
        "realSeries": false,
        "graphDisplayAllowed": false,
        "recommendedDisplayScale": 0.6,
        "diagnostics": {
          "resolvedBy": "ticker_preview",
          "fallbackReason": "provider_unavailable",
          "pointCount": 6,
          "uniqueValueCount": 6,
          "rangeRatio": 0.01005,
          "isLinearDerived": false,
          "realSeries": false,
          "graphDisplayAllowed": false
        }
      }
    ],
    "diagnostics": {
      "requestedCount": 1,
      "returnedCount": 1,
      "fallbackCount": 1,
      "derivedCount": 1,
      "realSeriesCount": 0,
      "displayAllowedCount": 0,
      "qualities": { "derived_preview": 1 }
    }
  }
}
```

Provider unavailable example:

```json
{
  "success": true,
  "data": {
    "exchange": "coinone",
    "quoteCurrency": "KRW",
    "items": [
      {
        "exchange": "coinone",
        "symbol": "BTC",
        "marketId": "KRW-BTC",
        "displayPair": "BTC/KRW",
        "pointCount": 0,
        "points": [],
        "quality": "unavailable",
        "source": "unavailable",
        "isDerived": false,
        "realSeries": false,
        "graphDisplayAllowed": false,
        "diagnostics": {
          "resolvedBy": "provider_candle",
          "fallbackReason": "provider_unavailable",
          "pointCount": 0,
          "uniqueValueCount": 0,
          "valueRange": 0,
          "rangeRatio": 0,
          "isFlat": false,
          "realSeries": false,
          "graphDisplayAllowed": false
        }
      }
    ],
    "diagnostics": {
      "requestedCount": 1,
      "returnedCount": 1,
      "fallbackCount": 1,
      "derivedCount": 0,
      "realSeriesCount": 0,
      "displayAllowedCount": 0,
      "unavailableCount": 1,
      "qualities": { "unavailable": 1 }
    }
  }
}
```

Unsupported quote requests, for example `/market/sparkline?exchange=upbit&quoteCurrency=USDT&symbols=BTC`, return `items: []`, `supportedQuotes: ["KRW", "BTC"]`, `defaultQuoteCurrency: "KRW"`, and `diagnostics.unsupported: true` with `reason: "quote_currency_not_supported"` and `heavyPathUsed: false`.

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

### Deprecated Legacy `GET /market/candles`

The canonical active client contract is the iOS chart contract documented near the top of this file: `GET /market/candles?exchange=upbit&symbol=BTC&quoteCurrency=KRW&timeframe=1H&limit=200` returning `data.candles[]`.

This legacy array shape is retained only for older clients that omit `quoteCurrency`, `quote`, and `timeframe`.

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
