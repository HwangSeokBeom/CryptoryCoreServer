import WebSocket from 'ws';
import { getExchangeSubscriptions, getOrderbookSubscriptions } from './wsHandler';
import { getTickersByExchange } from '../modules/tickers/tickers.service';
import { getOrderbook } from '../modules/orderbook/orderbook.service';
import { logger } from '../utils/logger';

function sendJson(ws: WebSocket, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export async function broadcastTickers() {
  const exchangeSubs = getExchangeSubscriptions();
  const orderbookSubs = getOrderbookSubscriptions();

  // Collect unique exchanges to fetch
  const exchangesToFetch = new Set<string>();
  for (const subs of exchangeSubs.values()) {
    for (const ex of subs) {
      exchangesToFetch.add(ex);
    }
  }

  // Fetch ticker data once per exchange
  const tickerCache = new Map<string, Awaited<ReturnType<typeof getTickersByExchange>>>();
  await Promise.all(
    Array.from(exchangesToFetch).map(async (exchange) => {
      try {
        const tickers = await getTickersByExchange(exchange);
        tickerCache.set(exchange, tickers);
      } catch (err) {
        logger.warn({ exchange, err }, 'Failed to get tickers for broadcast');
      }
    }),
  );

  // Send tickers to each client based on their subscriptions
  for (const [ws, subs] of exchangeSubs.entries()) {
    for (const exchange of subs) {
      const tickers = tickerCache.get(exchange);
      if (tickers && tickers.length > 0) {
        sendJson(ws, { type: 'tickers', data: tickers });
      }
    }
  }

  // Send orderbook to subscribed clients
  for (const [ws, sub] of orderbookSubs.entries()) {
    if (!sub) continue;
    try {
      const orderbook = await getOrderbook(sub.symbol, sub.exchange, 10);
      if (orderbook) {
        sendJson(ws, {
          type: 'orderbook',
          data: {
            symbol: sub.symbol,
            exchange: sub.exchange,
            asks: orderbook.asks,
            bids: orderbook.bids,
            currentPrice: orderbook.currentPrice,
          },
        });
      }
    } catch (err) {
      logger.warn({ sub, err }, 'Failed to get orderbook for broadcast');
    }
  }
}
