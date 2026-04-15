# API Contracts

All REST responses use the same envelope:

```json
{
  "success": true,
  "data": {}
}
```

Error responses use:

```json
{
  "success": false,
  "error": "message"
}
```

## Public REST

Base path: `/api/v1/public`

### `GET /tickers`

Query:

- `exchange?: upbit | bithumb | coinone | korbit | binance`
- `symbol?: BTC | ETH | ...`

Response `data`:

```json
{
  "items": [
    {
      "exchange": "upbit",
      "exchangeName": "업비트",
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
      "timestamp": 1712345678000
    }
  ],
  "total": 1,
  "snapshotAt": 1712345678000
}
```

### `GET /orderbook`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`

Response `data`:

```json
{
  "exchange": "upbit",
  "exchangeName": "업비트",
  "symbol": "BTC",
  "market": "BTC/KRW",
  "baseCurrency": "BTC",
  "quoteCurrency": "KRW",
  "rawSymbol": "KRW-BTC",
  "bestAsk": 100010000,
  "bestBid": 99990000,
  "spread": 20000,
  "asks": [
    { "price": 100010000, "quantity": 0.2 }
  ],
  "bids": [
    { "price": 99990000, "quantity": 0.3 }
  ],
  "timestamp": 1712345678000
}
```

### `GET /trades`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`
- `limit?: number` default `50`

Response `data`:

```json
{
  "exchange": "upbit",
  "exchangeName": "업비트",
  "symbol": "BTC",
  "market": "BTC/KRW",
  "items": [
    {
      "exchange": "upbit",
      "exchangeName": "업비트",
      "symbol": "BTC",
      "market": "BTC/KRW",
      "baseCurrency": "BTC",
      "quoteCurrency": "KRW",
      "rawSymbol": "KRW-BTC",
      "tradeId": "trade-1",
      "side": "buy",
      "price": 100000000,
      "quantity": 0.01,
      "notional": 1000000,
      "timestamp": 1712345678000
    }
  ],
  "total": 1,
  "snapshotAt": 1712345678000
}
```

### `GET /candles`

Query:

- `exchange: upbit | bithumb | coinone | korbit | binance`
- `symbol: BTC | ETH | ...`
- `period?: 1m | 3m | 5m | 15m | 30m | 1h | 4h | 1d | 1w`
- `limit?: number`

Response `data`:

```json
{
  "exchange": "upbit",
  "exchangeName": "업비트",
  "symbol": "BTC",
  "market": "BTC/KRW",
  "interval": "1h",
  "items": [
    {
      "timestamp": 1712345320000,
      "open": 99000000,
      "high": 101000000,
      "low": 98500000,
      "close": 100000000,
      "volume": 321
    }
  ],
  "total": 1
}
```

### `GET /kimchi-premium`

Query:

- `symbols: BTC,ETH,...`

Response `data`:

```json
{
  "baseExchange": "binance",
  "items": [
    {
      "symbol": "BTC",
      "nameKo": "비트코인",
      "nameEn": "Bitcoin",
      "binanceKrwPrice": 99500000,
      "domestic": [
        {
          "exchange": "upbit",
          "exchangeName": "업비트",
          "market": "BTC/KRW",
          "priceKrw": 100000000,
          "premiumPercent": 0.5
        }
      ]
    }
  ],
  "snapshotAt": 1712345678000
}
```

## Unified Market WebSocket

Path: `/ws/market`

Server welcome:

```json
{
  "type": "welcome",
  "protocolVersion": "2026-04-15",
  "path": "/ws/market",
  "authRequired": false,
  "channels": ["tickers", "orderbook", "trades"],
  "timestamp": 1712345678000
}
```

### Client request payloads

Ping:

```json
{
  "requestId": "req-1",
  "action": "ping"
}
```

Ticker subscribe or unsubscribe:

```json
{
  "requestId": "req-2",
  "action": "subscribe",
  "channel": "tickers",
  "exchanges": ["upbit", "binance"],
  "symbols": ["BTC", "ETH"]
}
```

Orderbook subscribe or unsubscribe:

```json
{
  "requestId": "req-3",
  "action": "subscribe",
  "channel": "orderbook",
  "exchange": "upbit",
  "symbols": ["BTC", "ETH"]
}
```

Trades subscribe or unsubscribe:

```json
{
  "requestId": "req-4",
  "action": "subscribe",
  "channel": "trades",
  "exchange": "binance",
  "symbols": ["BTC"]
}
```

### Server response payloads

Ack:

```json
{
  "type": "ack",
  "requestId": "req-3",
  "action": "subscribe",
  "channel": "orderbook",
  "filters": {
    "exchange": "upbit",
    "symbols": ["BTC", "ETH"]
  },
  "snapshotSent": true,
  "timestamp": 1712345678000
}
```

For `tickers`, the `filters` object contains `active`, `exchanges`, and `symbols`.

Pong:

```json
{
  "type": "pong",
  "requestId": "req-1",
  "timestamp": 1712345678000
}
```

Error:

```json
{
  "type": "error",
  "requestId": "req-5",
  "code": "invalid_request",
  "message": "Invalid websocket request.",
  "timestamp": 1712345678000
}
```

Event:

```json
{
  "type": "event",
  "channel": "tickers",
  "data": {
    "exchange": "upbit",
    "exchangeName": "업비트",
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
    "timestamp": 1712345678000
  },
  "timestamp": 1712345678000
}
```

`orderbook` and `trades` event payloads reuse the same DTOs as the REST response bodies.

## Private Exchange Connection CRUD

Base path: `/api/v1/private/exchange-connections`

All endpoints require `Authorization: Bearer <jwt>`.

### `GET /`

Response `data`:

```json
{
  "items": [
    {
      "id": "conn-1",
      "exchange": "upbit",
      "exchangeName": "업비트",
      "label": "Primary Upbit",
      "apiKeyMasked": "abc***xyz",
      "hasSecretKey": true,
      "hasPassphrase": false,
      "validation": {
        "status": "placeholder",
        "mode": "placeholder",
        "canUsePrivateApi": false,
        "message": "Credentials stored for upbit, but a live private adapter is not implemented yet.",
        "checkedAt": "2026-04-15T00:00:00.000Z"
      },
      "createdAt": "2026-04-15T00:00:00.000Z",
      "updatedAt": "2026-04-15T00:00:00.000Z"
    }
  ],
  "total": 1
}
```

### `POST /`

Request:

```json
{
  "exchange": "upbit",
  "label": "Primary Upbit",
  "apiKey": "live-api-key",
  "secretKey": "live-secret-key",
  "passphrase": "optional"
}
```

Response `data`: same DTO as list item. Returns `201`.

### `PATCH /:exchange`

Request:

```json
{
  "label": "Updated Upbit",
  "apiKey": "rotated-api-key",
  "secretKey": "rotated-secret-key",
  "passphrase": null
}
```

Notes:

- `label: null` clears the label
- `passphrase: null` clears the passphrase
- omitted fields keep the previous value

Response `data`: same DTO as list item.

### `DELETE /:exchange`

Response `data`:

```json
{
  "exchange": "upbit",
  "exchangeName": "업비트",
  "removedAt": "2026-04-15T00:10:00.000Z"
}
```

## Placeholder Private Domains

The following private endpoints are still backed by the internal database placeholder provider, not by live exchange private adapters:

- `/api/v1/private/balances`
- `/api/v1/private/holdings`
- `/api/v1/private/portfolio`
- `/api/v1/private/portfolio/summary`
- `/api/v1/private/orders` (read)
- `/api/v1/private/open-orders`
- `/api/v1/private/fills`

Current provider boundary:

- Public market data: live exchange public WebSocket and REST collectors
- Exchange connection CRUD: encrypted credential storage plus validation metadata
- Private account reads: database placeholder provider
- Live private exchange adapter: not implemented yet
