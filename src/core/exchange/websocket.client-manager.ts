import WebSocket from 'ws';
import { logger } from '../../utils/logger';
import { delay } from './retry-policy';

export interface WebSocketClientDefinition {
  name: string;
  url: string;
  headers?: Record<string, string>;
  heartbeatIntervalMs?: number;
  buildConnectionRequest?:
    | (() => Promise<{ url?: string; headers?: Record<string, string> } | void>)
    | (() => { url?: string; headers?: Record<string, string> } | void);
  onOpen: (ctx: WebSocketClientManager) => Promise<void> | void;
  onMessage: (raw: WebSocket.RawData, ctx: WebSocketClientManager) => Promise<void> | void;
  onReconnect?: (ctx: WebSocketClientManager) => Promise<void> | void;
}

export interface WebSocketReconnectMetadata {
  attempt: number;
  reasonType: 'close' | 'error' | 'connect_error' | 'unknown';
  code?: number;
  reason?: string;
  message?: string;
}

export class WebSocketClientManager {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private stopped = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hasOpened = false;
  private activeUrl: string;
  private lastReconnectMetadata: WebSocketReconnectMetadata | null = null;

  constructor(private readonly definition: WebSocketClientDefinition) {
    this.activeUrl = definition.url;
  }

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

  getReconnectMetadata(): WebSocketReconnectMetadata | null {
    return this.lastReconnectMetadata;
  }

  private async connect() {
    try {
      const request = await this.definition.buildConnectionRequest?.();
      const url = request?.url ?? this.definition.url;
      const headers = request?.headers ?? this.definition.headers;
      this.activeUrl = url;

      logger.info({ domain: 'exchange-ws', client: this.definition.name, url }, 'Connecting websocket client');
      this.socket = new WebSocket(url, { headers });
      const isReconnect = this.hasOpened;

      this.socket.on('open', () => {
        void this.handleOpen(isReconnect);
      });

      this.socket.on('message', (raw) => {
        void Promise.resolve(this.definition.onMessage(raw, this)).catch((error: unknown) => {
          logger.warn({ domain: 'exchange-ws', client: this.definition.name, err: error }, 'Websocket message handler failed');
        });
      });

      this.socket.on('close', (code, reason) => {
        const reasonText = reason?.toString('utf8').trim() || undefined;
        this.lastReconnectMetadata = {
          attempt: this.reconnectAttempts + 1,
          reasonType: 'close',
          code,
          reason: reasonText,
        };
        logger.warn(
          {
            domain: 'exchange-ws',
            client: this.definition.name,
            url: this.activeUrl,
            closeCode: code,
            closeReason: reasonText,
          },
          'Websocket client closed',
        );
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.socket = null;
        void this.scheduleReconnect();
      });

      this.socket.on('error', (err) => {
        this.lastReconnectMetadata = {
          attempt: this.reconnectAttempts + 1,
          reasonType: 'error',
          message: err.message,
        };
        logger.warn({ domain: 'exchange-ws', client: this.definition.name, err }, 'Websocket client error');
      });

      this.socket.on('ping', (data) => {
        this.socket?.pong(data);
      });
    } catch (error) {
      this.lastReconnectMetadata = {
        attempt: this.reconnectAttempts + 1,
        reasonType: 'connect_error',
        message: error instanceof Error ? error.message : String(error),
      };
      logger.warn({ domain: 'exchange-ws', client: this.definition.name, url: this.activeUrl, err: error }, 'Websocket connect failed');
      this.socket = null;
      await this.scheduleReconnect();
    }
  }

  private async handleOpen(isReconnect: boolean) {
    this.reconnectAttempts = 0;
    this.hasOpened = true;

    if (this.definition.heartbeatIntervalMs) {
      this.startHeartbeat(this.definition.heartbeatIntervalMs);
    }

    try {
      await this.definition.onOpen(this);
    } catch (error) {
      logger.warn({ domain: 'exchange-ws', client: this.definition.name, err: error }, 'Websocket open handler failed');
      this.socket?.terminate();
      return;
    }

    if (isReconnect && this.definition.onReconnect) {
      try {
        await this.definition.onReconnect(this);
      } catch (error) {
        logger.warn({ domain: 'exchange-ws', client: this.definition.name, err: error }, 'Websocket reconnect handler failed');
      }
    }
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

    logger.warn(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        reconnectAttempts: this.reconnectAttempts,
        reconnectDelayMs,
        url: this.activeUrl,
        reconnectReason: this.lastReconnectMetadata,
      },
      'Scheduling websocket reconnect',
    );

    await delay(Math.min(reconnectDelayMs, 25));
  }
}
