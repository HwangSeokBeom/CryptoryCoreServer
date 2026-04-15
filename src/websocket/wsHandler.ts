import WebSocket from 'ws';
import { logger } from '../utils/logger';

// Track subscriptions per client
const exchangeSubscriptions = new Map<WebSocket, Set<string>>();
const orderbookSubscriptions = new Map<WebSocket, { symbol: string; exchange: string } | null>();

export function handleMessage(ws: WebSocket, raw: WebSocket.RawData) {
  try {
    const msg = JSON.parse(raw.toString());

    switch (msg.action) {
      case 'subscribe': {
        if (!msg.exchange) return;
        let subs = exchangeSubscriptions.get(ws);
        if (!subs) {
          subs = new Set();
          exchangeSubscriptions.set(ws, subs);
        }
        subs.add(msg.exchange);
        logger.debug({ exchange: msg.exchange }, 'Client subscribed to exchange');
        break;
      }

      case 'unsubscribe': {
        const subs = exchangeSubscriptions.get(ws);
        if (subs && msg.exchange) {
          subs.delete(msg.exchange);
        }
        break;
      }

      case 'subscribe_orderbook': {
        if (!msg.symbol || !msg.exchange) return;
        orderbookSubscriptions.set(ws, { symbol: msg.symbol, exchange: msg.exchange });
        logger.debug({ symbol: msg.symbol, exchange: msg.exchange }, 'Client subscribed to orderbook');
        break;
      }

      case 'unsubscribe_orderbook': {
        orderbookSubscriptions.set(ws, null);
        break;
      }
    }
  } catch {
    logger.warn('Invalid WebSocket message');
  }
}

export function handleClose(ws: WebSocket) {
  exchangeSubscriptions.delete(ws);
  orderbookSubscriptions.delete(ws);
}

export function getExchangeSubscriptions(): Map<WebSocket, Set<string>> {
  return exchangeSubscriptions;
}

export function getOrderbookSubscriptions(): Map<WebSocket, { symbol: string; exchange: string } | null> {
  return orderbookSubscriptions;
}
