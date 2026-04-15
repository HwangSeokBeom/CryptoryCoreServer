import WebSocket from 'ws';
import { logger } from '../../utils/logger';
import { delay } from './retry-policy';

export interface WebSocketClientDefinition {
  name: string;
  url: string;
  heartbeatIntervalMs?: number;
  onOpen: (ctx: WebSocketClientManager) => Promise<void> | void;
  onMessage: (raw: WebSocket.RawData, ctx: WebSocketClientManager) => Promise<void> | void;
  onReconnect?: (ctx: WebSocketClientManager) => Promise<void> | void;
}

export class WebSocketClientManager {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private stopped = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly definition: WebSocketClientDefinition) {}

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.socket?.terminate();
    this.socket = null;
  }

  sendJson(payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  sendRaw(payload: string | Buffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(payload);
  }

  private async connect() {
    logger.info({ domain: 'exchange-ws', client: this.definition.name, url: this.definition.url }, 'Connecting websocket client');
    this.socket = new WebSocket(this.definition.url);

    this.socket.on('open', async () => {
      this.reconnectAttempts = 0;
      if (this.definition.heartbeatIntervalMs) {
        this.startHeartbeat(this.definition.heartbeatIntervalMs);
      }
      await this.definition.onOpen(this);
    });

    this.socket.on('message', (raw) => {
      void this.definition.onMessage(raw, this);
    });

    this.socket.on('close', () => {
      void this.scheduleReconnect();
    });

    this.socket.on('error', (err) => {
      logger.warn({ domain: 'exchange-ws', client: this.definition.name, err }, 'Websocket client error');
    });

    this.socket.on('ping', (data) => {
      this.socket?.pong(data);
    });
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.ping();
      }
    }, intervalMs);
  }

  private async scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const reconnectDelayMs = Math.min(1_000 * 2 ** (this.reconnectAttempts - 1), 30_000);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, reconnectDelayMs);

    if (this.definition.onReconnect) {
      await delay(Math.min(reconnectDelayMs, 1_000));
      await this.definition.onReconnect(this);
    }

    logger.warn(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        reconnectAttempts: this.reconnectAttempts,
        reconnectDelayMs,
      },
      'Scheduling websocket reconnect',
    );
  }
}
