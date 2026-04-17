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
  "error": "message"
}
```

## Security

- User exchange credentials are stored only through DB encrypted fields backed by `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`.
- Provider auth/signing is handled only inside provider or validator code.
- Developer fallback keys in `.env` are manual smoke-test placeholders only and must never proxy user trading or portfolio requests.
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

Base paths:

- `GET /market/markets`
- `GET /market/tickers`
- `GET /market/orderbook`
- `GET /market/trades`
- `GET /market/candles`
- `GET /kimchi-premium`

### `GET /market/markets`

Query:

- `exchange?: upbit | bithumb | coinone | korbit | binance`

Example response:

```json
{
  "success": true,
  "data": [
    {
      "exchange": "upbit",
      "exchangeName": "업비트",
      "symbol": "BTC",
      "market": "BTC/KRW",
      "rawSymbol": "KRW-BTC",
      "quoteCurrency": "KRW",
      "nameKo": "비트코인",
      "nameEn": "Bitcoin"
    }
  ]
}
```

### `GET /market/tickers`

Query:

- `exchange?: upbit | bithumb | coinone | korbit | binance`
- `symbol?: BTC | ETH | ...`

Freshness fields are attached to every item.

```json
{
  "success": true,
  "data": [
    {
      "exchange": "upbit",
      "symbol": "BTC",
      "market": "BTC/KRW",
      "baseCurrency": "BTC",
      "quoteCurrency": "KRW",
      "rawSymbol": "KRW-BTC",
      "price": 100000000,
      "change24h": 1.25,
      "volume24h": 1234,
      "high24h": 101000000,
      "low24h": 98000000,
      "timestamp": 1712345678000,
      "sourceTimestamp": 1712345678000,
      "stale": false,
      "staleAgeMs": 420
    }
  ]
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
  ]
}
```

### `GET /kimchi-premium`

Query:

- `symbols=BTC,ETH,...`

Unknown symbols return `400 unsupported symbol: <SYMBOL>`.

```json
{
  "success": true,
  "data": [
    {
      "symbol": "BTC",
      "nameKo": "비트코인",
      "nameEn": "Bitcoin",
      "referenceExchange": "binance",
      "referenceMarket": "BTC/USDT",
      "referenceTimestamp": 1712345678000,
      "referenceStale": false,
      "referenceStaleAgeMs": 500,
      "binanceUsdtPrice": 70000,
      "usdKrwRate": 1350,
      "binanceKrwPrice": 94500000,
      "krwConvertedReference": 94500000,
      "fxProvider": "exchangerate.host",
      "fxTimestamp": 1712345677000,
      "fxStale": false,
      "fxStaleAgeMs": 600,
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
          "krwConvertedReference": 94500000
        }
      ],
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

- `exchange`

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "balances": [
      { "asset": "KRW", "free": 1000000, "locked": 0, "averageBuyPrice": 0 },
      { "asset": "BTC", "free": 0.01, "locked": 0, "averageBuyPrice": 95000000 }
    ],
    "positions": [
      {
        "exchange": "upbit",
        "symbol": "BTC",
        "quantity": 0.01,
        "free": 0.01,
        "locked": 0,
        "averageBuyPrice": 95000000,
        "currentPrice": 100000000,
        "marketValue": 1000000,
        "pnlValue": 50000,
        "pnlPercent": 5.26,
        "timestamp": 1712345678000
      }
    ],
    "totalAssetValue": 2000000,
    "totalPnlValue": 50000,
    "totalPnlPercent": 2.56,
    "timestamp": 1712345678000
  }
}
```

### `GET /portfolio/history`

Query:

- `exchange`
- `symbol?`
- `limit?`

Current history is trade-driven canonical history produced from private fills/completed orders.

## Exchange Connection Routes

All routes require `Authorization: Bearer <jwt>`.

- `GET /exchange-connections`
- `POST /exchange-connections`
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
        "apiKeyMasked": "abc*****xyz",
        "hasSecretKey": true,
        "hasPassphrase": false,
        "validation": {
          "status": "verified",
          "mode": "live_api",
          "canUsePrivateApi": true,
          "message": "upbit private API credentials verified successfully.",
          "checkedAt": "2026-04-17T06:00:00.000Z"
        },
        "operational": {
          "connectionStatus": "active",
          "lastSyncAt": "2026-04-17T06:05:00.000Z",
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

## Unsupported Cases

- Binance private trading and private portfolio.
- Canonical `stop_limit` order creation.
- Provider-pair-scoped order lookup without `symbol` for Coinone and Korbit.
- Private websocket session fan-out to user-facing server routes. Current HTTP private APIs use live REST and update connection sync state; private WS orchestration is still pending.
