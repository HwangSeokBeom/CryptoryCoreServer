import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly send = vi.fn();
  readonly terminate = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', 1006, Buffer.alloc(0));
  });
  readonly ping = vi.fn();
  readonly pong = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = MockWebSocket.CLOSING;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(
    public readonly url: string,
    public readonly options?: { headers?: Record<string, string> },
  ) {
    super();
    sockets.push(this);
  }
}

vi.mock('ws', () => ({
  default: MockWebSocket,
}));

describe('WebSocket Client Manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resyncs only after a successful reconnect open event', async () => {
    const { WebSocketClientManager } = await import('../src/core/exchange/websocket.client-manager');
    const onOpen = vi.fn();
    const onReconnect = vi.fn();

    const manager = new WebSocketClientManager({
      name: 'test-ws',
      url: 'wss://example.test/ws',
      reconnectJitterRatio: 0,
      onOpen,
      onMessage: vi.fn(),
      onReconnect,
    });

    await manager.start();
    expect(sockets).toHaveLength(1);

    sockets[0].readyState = MockWebSocket.OPEN;
    sockets[0].emit('open');
    await Promise.resolve();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(0);

    sockets[0].emit('close', 1005, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);

    sockets[1].readyState = MockWebSocket.OPEN;
    sockets[1].emit('open');
    await Promise.resolve();

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('does not schedule duplicate reconnect timers for the same close sequence', async () => {
    const { WebSocketClientManager } = await import('../src/core/exchange/websocket.client-manager');

    const manager = new WebSocketClientManager({
      name: 'test-ws',
      url: 'wss://example.test/ws',
      reconnectJitterRatio: 0,
      onOpen: vi.fn(),
      onMessage: vi.fn(),
    });

    await manager.start();
    sockets[0].readyState = MockWebSocket.OPEN;
    sockets[0].emit('open');
    await Promise.resolve();

    sockets[0].emit('close', 1005, Buffer.alloc(0));
    sockets[0].emit('close', 1005, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets).toHaveLength(2);
  });

  it('cancels a pending reconnect when the client stops', async () => {
    const { WebSocketClientManager } = await import('../src/core/exchange/websocket.client-manager');

    const manager = new WebSocketClientManager({
      name: 'test-ws',
      url: 'wss://example.test/ws',
      reconnectJitterRatio: 0,
      onOpen: vi.fn(),
      onMessage: vi.fn(),
    });

    await manager.start();
    sockets[0].readyState = MockWebSocket.OPEN;
    sockets[0].emit('open');
    await Promise.resolve();

    sockets[0].emit('close', 1005, Buffer.alloc(0));
    await manager.stop('test_stop');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(1);
  });
});
