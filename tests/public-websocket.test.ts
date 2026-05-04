import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app';
import { closeWebSocketServer, getWss, setupWebSocket } from '../src/websocket/wsServer';

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
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/trading?token=${encodeURIComponent(token)}`);

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
