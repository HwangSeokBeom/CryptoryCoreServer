import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;

  readyState = 0;
  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  readonly send = vi.fn();
  readonly terminate = vi.fn();
  readonly ping = vi.fn();
  readonly pong = vi.fn();

  constructor(
    public readonly url: string,
    public readonly options?: { headers?: Record<string, string> },
  ) {
    sockets.push(this);
  }

  on(event: string, handler: (...args: any[]) => void) {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
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
    vi.clearAllMocks();
  });

  it('resyncs only after a successful reconnect open event', async () => {
    const { WebSocketClientManager } = await import('../src/core/exchange/websocket.client-manager');
    const onOpen = vi.fn();
    const onReconnect = vi.fn();

    const manager = new WebSocketClientManager({
      name: 'test-ws',
      url: 'wss://example.test/ws',
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

    sockets[0].emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);

    sockets[1].readyState = MockWebSocket.OPEN;
    sockets[1].emit('open');
    await Promise.resolve();

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
