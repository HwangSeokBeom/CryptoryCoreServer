# Market API Contract

## News tab calculator migration

The News tab no longer depends on market cap, volume, dominance history, or dashboard endpoints for
its calculator segment. Do not extend unstable global market history/dashboard providers for that
screen. Use `GET /calculators/usdt-rate` for the USDT/KRW calculator rate; profit/loss and
averaging-down calculator math stays local on the client.

The existing `/market/data`, `/market/trends`, and `/market-data/global/history` endpoints remain for
legacy clients, but they are not required for the new calculator flow and should be treated as
deprecated for the News tab.

## Symbol identity

- `unique identity`: `exchange + marketId`
- `symbol` is never a unique key. It is a display/helper asset code and short symbols such as `T`, `G`, `A`, `W` remain valid payload values.
- `marketId`: exchange-native market identifier used for provider calls. Examples: `KRW-BTC`, `BTC_KRW`, `BTC`, `btc_krw`.
- `rawSymbol`: raw exchange symbol as received from the exchange. Usually the same as `marketId`.
- `canonicalSymbol`: common asset symbol used for icon and cross-exchange identity. Example: `BTC`.
- `baseAsset`: traded asset. Example: `BTC`.
- `quoteAsset`: quote currency. Example: `KRW`.
- `displaySymbol`: user-facing pair label. Example: `BTC/KRW`.

Client rules:

- Use `exchange + marketId` for React row keys, cache keys, websocket subscription identity, and any dedupe logic.
- Use `canonicalSymbol` only for asset icon and metadata mapping.
- Use `symbol` only as a helper display/code field. Do not key lists or caches by `symbol` alone.

Prefer `marketId + exchange` for detail requests:

```http
GET /market/summary?exchange=korbit&marketId=btc_krw
GET /market/candles?exchange=korbit&marketId=btc_krw&interval=1h
GET /market/orderbook?exchange=korbit&marketId=btc_krw
GET /market/trades?exchange=korbit&marketId=btc_krw
```

`symbol + exchange` remains supported when the symbol resolves to a listed exchange market. Ambiguous values such as `symbol=C` are rejected before an upstream exchange call when no listed market can be resolved.

## Metadata fields

All active market, ticker, and candle APIs expose these fields in either each row item or the top-level market section metadata:

- `/market/markets`
- `/market/tickers`
- `/market/base-snapshot`
- `/market/snapshot`
- `/market/symbols`
- `/market/orderbook`
- `/market/trades`
- `/market/candles`
- `/market/summary`
- `/charts/candles`
- `/api/v1/public/markets`
- `/api/v1/public/tickers`
- `/api/v1/public/orderbook`
- `/api/v1/public/trades`
- `/api/v1/public/candles`

```json
{
  "exchange": "korbit",
  "marketId": "btc_krw",
  "rawSymbol": "btc_krw",
  "canonicalSymbol": "BTC",
  "baseAsset": "BTC",
  "quoteAsset": "KRW",
  "displaySymbol": "BTC/KRW",
  "koreanName": "비트코인",
  "englishName": "Bitcoin",
  "iconUrl": "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/btc.png",
  "isActive": true,
  "capabilities": {
    "supportsCandles": true,
    "supportsOrderBook": true,
    "supportsTrades": true
  }
}
```

Detail section responses also include:

```json
{
  "availability": {
    "candles": "available",
    "orderbook": "available",
    "trades": "available"
  },
  "isChartAvailable": true,
  "isOrderBookAvailable": true,
  "isTradesAvailable": true,
  "unavailableReason": null
}
```

## List and ticker shape

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "exchange": "korbit",
        "exchangeName": "코빗",
        "marketId": "btc_krw",
        "canonicalSymbol": "BTC",
        "baseAsset": "BTC",
        "quoteAsset": "KRW",
        "displaySymbol": "BTC/KRW",
        "koreanName": "비트코인",
        "englishName": "Bitcoin",
        "iconUrl": "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/btc.png",
        "price": 100000000,
        "change24h": 1.2,
        "volume24h": 12345
      }
    ],
    "meta": {
      "sourceOfTruth": "provider_market_universe",
      "returnedCount": 1
    }
  }
}
```

## Summary shape

```json
{
  "success": true,
  "data": {
    "metadata": {
      "exchange": "korbit",
      "marketId": "btc_krw",
      "canonicalSymbol": "BTC",
      "displaySymbol": "BTC/KRW",
      "iconUrl": "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/btc.png",
      "availability": {
        "candles": "available",
        "orderbook": "available",
        "trades": "available"
      }
    },
    "latestTicker": {
      "price": 100000000,
      "change24h": 1.2,
      "timestamp": 1712345678000
    },
    "updatedAt": 1712345678000
  }
}
```

## Candles shape

Existing `/market/candles` keeps `data` as an array and adds section metadata:

```json
{
  "success": true,
  "data": [
    {
      "openTime": 1712340000000,
      "closeTime": 1712343600000,
      "open": 99000000,
      "high": 101000000,
      "low": 98500000,
      "close": 100000000,
      "volume": 321
    }
  ],
  "total": 1,
  "meta": {
    "isRenderable": true,
    "freshnessState": "live",
    "source": "memory",
    "pointCount": 1
  },
  "metadata": {
    "exchange": "korbit",
    "marketId": "btc_krw",
    "canonicalSymbol": "BTC",
    "availability": {
      "candles": "available",
      "orderbook": "available",
      "trades": "available"
    }
  }
}
```

## Orderbook shape

```json
{
  "success": true,
  "data": {
    "exchange": "korbit",
    "marketId": "btc_krw",
    "canonicalSymbol": "BTC",
    "bestAsk": 100010000,
    "bestBid": 99990000,
    "asks": [{ "price": 100010000, "quantity": 0.2 }],
    "bids": [{ "price": 99990000, "quantity": 0.3 }],
    "metadata": {
      "marketId": "btc_krw",
      "canonicalSymbol": "BTC",
      "availability": {
        "candles": "available",
        "orderbook": "available",
        "trades": "available"
      }
    }
  }
}
```

## Trades shape

Empty trades are a successful empty section:

```json
{
  "success": true,
  "data": [],
  "total": 0,
  "metadata": {
    "marketId": "btc_krw",
    "canonicalSymbol": "BTC",
    "availability": {
      "trades": "available"
    }
  }
}
```

## Unavailable error shape

Temporary upstream failures use structured errors:

```json
{
  "success": false,
  "code": "MARKET_DATA_UNAVAILABLE",
  "target": "candles",
  "exchange": "korbit",
  "marketId": "btc_krw",
  "canonicalSymbol": "BTC",
  "message": "korbit candles are temporarily unavailable",
  "userMessage": "코빗 차트 데이터가 일시적으로 제공되지 않고 있어요.",
  "retryable": true,
  "reason": "upstream_503",
  "metadata": {
    "marketId": "btc_krw",
    "canonicalSymbol": "BTC"
  }
}
```

Unsupported or unresolved requests use `MARKET_DATA_UNSUPPORTED` with `retryable: false`.

## Client integration examples

Ticker row identity:

```json
{
  "exchange": "bithumb",
  "marketId": "T_KRW",
  "symbol": "T",
  "canonicalSymbol": "T",
  "baseAsset": "T",
  "quoteAsset": "KRW",
  "displaySymbol": "T/KRW",
  "price": 1234
}
```

Client usage:

```json
{
  "rowKey": "bithumb:T_KRW",
  "cacheKey": "ticker:bithumb:T_KRW",
  "iconLookupKey": "T"
}
```

Chart identity:

```json
{
  "success": true,
  "data": {
    "exchange": "upbit",
    "marketId": "KRW-T",
    "symbol": "T",
    "canonicalSymbol": "T",
    "baseAsset": "T",
    "quoteAsset": "KRW",
    "displaySymbol": "T/KRW",
    "interval": "1m",
    "items": [
      {
        "exchange": "upbit",
        "marketId": "KRW-T",
        "symbol": "T",
        "canonicalSymbol": "T",
        "openTime": 1712345640000,
        "closeTime": 1712345700000,
        "close": 1234
      }
    ]
  }
}
```
