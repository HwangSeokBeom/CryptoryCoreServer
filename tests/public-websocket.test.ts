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
});
