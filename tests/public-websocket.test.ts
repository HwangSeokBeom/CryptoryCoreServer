import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app';
import { publicMarketDataStore } from '../src/modules/public-market/market.data.store';
import { closeWebSocketServer, getWss, setupWebSocket } from '../src/websocket/wsServer';

function createJsonMessageReader(ws: WebSocket) {
  const queue: Array<Record<string, any>> = [];
  const waiters: Array<(message: Record<string, any>) => void> = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, any>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });

  return () => {
    const queued = queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise<Record<string, any>>((resolve) => waiters.push(resolve));
  };
}

describe('Public Market WebSocket', () => {
  it('registers the unified public websocket server on /ws/market', async () => {
    const app = await buildApp();
    const server = setupWebSocket(app.server);

    expect(server).toBeTruthy();
    expect(getWss()).toBe(server);

    await closeWebSocketServer();
    await app.close();
  });

  it('routes private trading websocket upgrades without the public ws server rejecting the path first', async () => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    setupWebSocket(app.server, {
      verifyJwt: async (token) => app.jwt.verify(token),
    });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP listener');
    }

    const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com' });
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/trading`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const firstMessage = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
      ws.once('error', reject);
    });

    expect(firstMessage).toMatchObject({
      type: 'subscribed',
      channel: 'private',
      path: '/ws/trading',
    });

    ws.close();
    await closeWebSocketServer();
    await app.close();
  });

  it('rejects private websocket tokens supplied in the URL query', async () => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    setupWebSocket(app.server, {
      verifyJwt: async (token) => app.jwt.verify(token),
    });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP listener');
    }

    const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com' });
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/trading?token=${encodeURIComponent(token)}`,
    );
    const statusCode = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      ws.once('open', () => reject(new Error('Query token unexpectedly authenticated')));
      ws.once('error', () => {});
    });

    expect(statusCode).toBe(401);
    ws.terminate();
    await closeWebSocketServer();
    await app.close();
  });

  it('accepts the iOS ticker subscription alias on /ws/market', async () => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    setupWebSocket(app.server);

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP listener');
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/market`);
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({
      action: 'subscribe',
      channel: 'ticker',
      exchange: 'upbit',
      quote: 'KRW',
      marketId: 'KRW-BTC',
    }));

    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
      ws.once('error', reject);
    });

    expect(ack).toMatchObject({
      type: 'ack',
      channel: 'tickers',
      action: 'subscribe',
      filters: {
        symbols: ['BTC'],
      },
    });

    ws.close();
    await closeWebSocketServer();
    await app.close();
  });

  it('replays only the newly requested ticker snapshot in the server event envelope', async () => {
    const now = Date.now();
    publicMarketDataStore.upsertTicker({
      channel: 'tickers',
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      price: 100_000_000,
      change24h: 1.25,
      volume24h: 12.5,
      high24h: 101_000_000,
      low24h: 99_000_000,
      timestamp: now,
    });
    publicMarketDataStore.upsertTicker({
      channel: 'tickers',
      exchange: 'upbit',
      symbol: 'ETH',
      market: 'ETH/KRW',
      baseCurrency: 'ETH',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-ETH',
      price: 4_000_000,
      change24h: -0.5,
      volume24h: 25,
      high24h: 4_100_000,
      low24h: 3_900_000,
      timestamp: now,
    });

    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    setupWebSocket(app.server);

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP listener');
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/market`);
    const nextMessage = createJsonMessageReader(ws);
    await nextMessage();

    ws.send(JSON.stringify({
      type: 'subscribe',
      action: 'subscribe',
      channel: 'ticker',
      exchange: 'upbit',
      symbol: 'BTC',
    }));
    expect(await nextMessage()).toMatchObject({ type: 'ack', channel: 'tickers' });
    expect(await nextMessage()).toMatchObject({
      type: 'event',
      channel: 'tickers',
      data: {
        exchange: 'upbit',
        symbol: 'BTC',
        price: 100_000_000,
      },
    });

    ws.send(JSON.stringify({
      type: 'subscribe',
      action: 'subscribe',
      channel: 'ticker',
      exchange: 'upbit',
      symbol: 'ETH',
    }));
    expect(await nextMessage()).toMatchObject({ type: 'ack', channel: 'tickers' });
    const secondSnapshot = await nextMessage();
    expect(secondSnapshot).toMatchObject({
      type: 'event',
      channel: 'tickers',
      data: {
        exchange: 'upbit',
        symbol: 'ETH',
        price: 4_000_000,
      },
    });
    expect(secondSnapshot.data.symbol).not.toBe('BTC');

    ws.close();
    await closeWebSocketServer();
    await app.close();
  });

  it('accepts selected-symbol market.candle subscriptions on /ws/market', async () => {
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    setupWebSocket(app.server);

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP listener');
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/market`);
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'market.candle',
      exchange: 'upbit',
      symbol: 'KRW-BTC',
      quoteCurrency: 'KRW',
      timeframe: '1H',
    }));

    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
      ws.once('error', reject);
    });

    expect(ack).toMatchObject({
      type: 'ack',
      channel: 'market.candle',
      action: 'subscribe',
      exchange: 'upbit',
      symbol: 'BTC',
      quoteCurrency: 'KRW',
      timeframe: '1H',
    });

    ws.close();
    await closeWebSocketServer();
    await app.close();
  });
});
