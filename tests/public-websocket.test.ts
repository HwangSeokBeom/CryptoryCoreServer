import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closeWebSocketServer, getWss, setupWebSocket } from '../src/websocket/wsServer';

describe('Public Market WebSocket', () => {
  it('registers the unified public websocket server on /ws/market', async () => {
    const app = await buildApp();
    const server = setupWebSocket(app.server);

    expect(server).toBeTruthy();
    expect(getWss()).toBe(server);

    closeWebSocketServer();
    await app.close();
  });
});
