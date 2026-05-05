import WebSocket from 'ws';
import { logger } from '../../utils/logger';

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const PAYLOAD_LOG_PREVIEW_LIMIT = 1_200;

let websocketClientInstanceSequence = 0;

function formatPayloadPreview(payload: unknown) {
  try {
    const text =
      typeof payload === 'string' || Buffer.isBuffer(payload)
        ? payload.toString()
        : JSON.stringify(payload);
    return text.length > PAYLOAD_LOG_PREVIEW_LIMIT
      ? `${text.slice(0, PAYLOAD_LOG_PREVIEW_LIMIT)}...`
      : text;
  } catch {
    return String(payload);
  }
}

function resolveCloseFlags(socket: WebSocket) {
  const internalSocket = socket as WebSocket & {
    _closeFrameReceived?: boolean;
    _closeFrameSent?: boolean;
    closeFrameReceived?: boolean;
    closeFrameSent?: boolean;
  };
  const closeFrameReceived = Boolean(internalSocket.closeFrameReceived ?? internalSocket._closeFrameReceived);
  const closeFrameSent = Boolean(internalSocket.closeFrameSent ?? internalSocket._closeFrameSent);
  return {
    closeFrameReceived,
    closeFrameSent,
    closeWasClean: closeFrameReceived && closeFrameSent,
  };
}

function resolveReconnectDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}) {
  const exponentialDelayMs = Math.min(
    params.baseDelayMs * 2 ** Math.max(params.attempt - 1, 0),
    params.maxDelayMs,
  );
  if (params.jitterRatio <= 0) {
    return exponentialDelayMs;
  }

  const jitterWindowMs = Math.round(exponentialDelayMs * params.jitterRatio);
  const jitterMs = Math.round((Math.random() * 2 - 1) * jitterWindowMs);
  return Math.max(params.baseDelayMs, exponentialDelayMs + jitterMs);
}

export interface WebSocketClientDefinition {
  name: string;
  url: string;
  headers?: Record<string, string>;
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  buildConnectionRequest?:
    | (() => Promise<{ url?: string; headers?: Record<string, string> } | void>)
    | (() => { url?: string; headers?: Record<string, string> } | void);
  onUnexpectedResponse?: (
    response: { statusCode?: number; statusMessage?: string; headers: Record<string, string | string[] | undefined> },
    ctx: WebSocketClientManager,
  ) => Promise<{ handled?: boolean } | void> | { handled?: boolean } | void;
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

export interface WebSocketClientStateSnapshot {
  instanceId: string;
  url: string;
  stopped: boolean;
  stopping: boolean;
  connecting: boolean;
  hasOpened: boolean;
  connectAttempts: number;
  reconnectAttempts: number;
  socketReadyState: number | null;
  reconnectScheduled: boolean;
  reconnectScheduledFor: number | null;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  lastPingAt: number | null;
  lastPongAt: number | null;
  lastReconnectMetadata: WebSocketReconnectMetadata | null;
}

export class WebSocketClientManager {
  private readonly instanceId = `ws-client-${++websocketClientInstanceSequence}`;
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private connectAttempts = 0;
  private stopped = true;
  private stopping = false;
  private connecting = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectScheduledFor: number | null = null;
  private hasOpened = false;
  private activeUrl: string;
  private lastReconnectMetadata: WebSocketReconnectMetadata | null = null;
  private lastConnectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastPingAt: number | null = null;
  private lastPongAt: number | null = null;
  private stopReason: string | null = null;

  constructor(private readonly definition: WebSocketClientDefinition) {
    this.activeUrl = definition.url;
  }

  async start(createReason = 'start') {
    if (!this.stopped) {
      logger.info(
        {
          domain: 'exchange-ws',
          client: this.definition.name,
          clientInstanceId: this.instanceId,
          state: this.getDiagnostics(),
        },
        'Websocket client start skipped because client is already active',
      );
      return;
    }

    this.stopped = false;
    this.stopping = false;
    this.stopReason = null;
    await this.connect(createReason);
  }

  async stop(reason = 'client_stop') {
    this.stopped = true;
    this.stopping = true;
    this.stopReason = reason;
    this.clearHeartbeatTimer();
    this.clearReconnectTimer();

    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      this.stopping = false;
      return;
    }

    logger.info(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        clientInstanceId: this.instanceId,
        url: this.activeUrl,
        stopReason: reason,
        socketReadyState: socket.readyState,
        lastMessageAt: this.lastMessageAt,
        lastPingAt: this.lastPingAt,
        lastPongAt: this.lastPongAt,
      },
      'Stopping websocket client',
    );

    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        try {
          socket.terminate();
        } finally {
          finalize();
        }
      }, DEFAULT_CLOSE_TIMEOUT_MS);
      timeout.unref?.();

      const finalize = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.stopping = false;
        resolve();
      };

      if (socket.readyState === WebSocket.CLOSED) {
        finalize();
        return;
      }

      socket.once('close', finalize);

      try {
        socket.close(1000, reason.slice(0, 120));
      } catch {
        socket.terminate();
      }
    });
  }

  sendJson(payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    logger.info(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        clientInstanceId: this.instanceId,
        url: this.activeUrl,
        payloadPreview: formatPayloadPreview(payload),
        payloadType: Array.isArray(payload) ? 'array' : typeof payload,
      },
      'Sending websocket JSON payload',
    );
    this.socket.send(JSON.stringify(payload));
  }

  sendRaw(payload: string | Buffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    logger.info(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        clientInstanceId: this.instanceId,
        url: this.activeUrl,
        payloadPreview: formatPayloadPreview(payload),
        payloadBytes: Buffer.byteLength(payload),
      },
      'Sending websocket raw payload',
    );
    this.socket.send(payload);
  }

  getReconnectMetadata(): WebSocketReconnectMetadata | null {
    return this.lastReconnectMetadata;
  }

  getDiagnostics(): WebSocketClientStateSnapshot {
    return {
      instanceId: this.instanceId,
      url: this.activeUrl,
      stopped: this.stopped,
      stopping: this.stopping,
      connecting: this.connecting,
      hasOpened: this.hasOpened,
      connectAttempts: this.connectAttempts,
      reconnectAttempts: this.reconnectAttempts,
      socketReadyState: this.socket?.readyState ?? null,
      reconnectScheduled: this.reconnectTimer !== null,
      reconnectScheduledFor: this.reconnectScheduledFor,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastPingAt: this.lastPingAt,
      lastPongAt: this.lastPongAt,
      lastReconnectMetadata: this.lastReconnectMetadata,
    };
  }

  private async connect(createReason: string) {
    if (this.stopped || this.connecting) {
      return;
    }

    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      logger.info(
        {
          domain: 'exchange-ws',
          client: this.definition.name,
          clientInstanceId: this.instanceId,
          url: this.activeUrl,
          createReason,
          socketReadyState: this.socket.readyState,
        },
        'Skipping websocket connect because an active socket already exists',
      );
      return;
    }

    this.connecting = true;
    this.clearReconnectTimer();

    try {
      const request = await this.definition.buildConnectionRequest?.();
      if (this.stopped) {
        return;
      }

      const url = request?.url ?? this.definition.url;
      const headers = request?.headers ?? this.definition.headers;
      const connectAttempt = ++this.connectAttempts;
      const reconnectAttempt = this.reconnectAttempts;
      this.activeUrl = url;

      logger.info(
        {
          domain: 'exchange-ws',
          client: this.definition.name,
          clientInstanceId: this.instanceId,
          url,
          createReason,
          connectAttempt,
          reconnectAttempt,
          reconnectScheduled: this.reconnectTimer !== null,
        },
        'Connecting websocket client',
      );

      const socket = new WebSocket(url, { headers });
      this.socket = socket;
      const isReconnect = this.hasOpened;

      socket.on('open', () => {
        if (socket !== this.socket) {
          return;
        }
        void this.handleOpen(isReconnect, connectAttempt);
      });

      socket.on('message', (raw) => {
        if (socket !== this.socket) {
          return;
        }

        this.lastMessageAt = Date.now();
        void Promise.resolve(this.definition.onMessage(raw, this)).catch((error: unknown) => {
          logger.warn(
            {
              domain: 'exchange-ws',
              client: this.definition.name,
              clientInstanceId: this.instanceId,
              err: error,
            },
            'Websocket message handler failed',
          );
        });
      });

      socket.on('close', (code, reason) => {
        if (socket !== this.socket && this.socket !== null) {
          return;
        }

        const reasonText = reason?.toString('utf8').trim() || undefined;
        const closeFlags = resolveCloseFlags(socket);
        const closeWasRequestedByClient = this.stopped || this.stopping;
        this.lastReconnectMetadata = {
          attempt: this.reconnectAttempts + 1,
          reasonType: 'close',
          code,
          reason: reasonText,
        };
        this.clearHeartbeatTimer();
        if (this.socket === socket) {
          this.socket = null;
        }

        logger[closeWasRequestedByClient ? 'info' : 'warn'](
          {
            domain: 'exchange-ws',
            client: this.definition.name,
            clientInstanceId: this.instanceId,
            url: this.activeUrl,
            connectAttempt,
            closeCode: code,
            closeReason: reasonText,
            closeWasClean: closeFlags.closeWasClean,
            closeFrameReceived: closeFlags.closeFrameReceived,
            closeFrameSent: closeFlags.closeFrameSent,
            lastMessageAt: this.lastMessageAt,
            lastPingAt: this.lastPingAt,
            lastPongAt: this.lastPongAt,
            reconnectScheduled: this.reconnectTimer !== null,
            stopReason: this.stopReason,
          },
          closeWasRequestedByClient
            ? 'Websocket client closed after stop request'
            : 'Websocket client closed',
        );

        if (!closeWasRequestedByClient) {
          void this.scheduleReconnect();
        }
      });

      socket.on('error', (err) => {
        if (socket !== this.socket && this.socket !== null) {
          return;
        }

        const reasonType = socket.readyState === WebSocket.CONNECTING ? 'connect_error' : 'error';
        this.lastReconnectMetadata = {
          attempt: this.reconnectAttempts + 1,
          reasonType,
          message: err.message,
        };
        logger.warn(
          {
            domain: 'exchange-ws',
            client: this.definition.name,
            clientInstanceId: this.instanceId,
            url: this.activeUrl,
            connectAttempt,
            lastMessageAt: this.lastMessageAt,
            lastPingAt: this.lastPingAt,
            lastPongAt: this.lastPongAt,
            err,
          },
          reasonType === 'connect_error' ? 'Websocket connect failed' : 'Websocket client error',
        );
      });

      socket.on('unexpected-response', (_request, response) => {
        if (socket !== this.socket && this.socket !== null) {
          return;
        }

        const statusCode = response.statusCode;
        const statusMessage = response.statusMessage;
        this.lastReconnectMetadata = {
          attempt: this.reconnectAttempts + 1,
          reasonType: 'connect_error',
          code: statusCode,
          message: statusMessage ? `HTTP ${statusCode} ${statusMessage}` : `HTTP ${statusCode}`,
        };
        this.clearHeartbeatTimer();
        if (this.socket === socket) {
          this.socket = null;
        }
        response.resume();

        void Promise.resolve(this.definition.onUnexpectedResponse?.({
          statusCode,
          statusMessage,
          headers: response.headers,
        }, this)).then((result) => {
          logger[result?.handled ? 'info' : 'warn'](
            {
              domain: 'exchange-ws',
              client: this.definition.name,
              clientInstanceId: this.instanceId,
              url: this.activeUrl,
              connectAttempt,
              statusCode,
              statusMessage,
              reconnectScheduled: this.reconnectTimer !== null,
            },
            result?.handled ? 'Websocket connect rejected and handled' : 'Websocket connect rejected',
          );

          if (!this.stopped && !this.stopping) {
            void this.scheduleReconnect();
          }
        }).catch((error: unknown) => {
          logger.warn(
            {
              domain: 'exchange-ws',
              client: this.definition.name,
              clientInstanceId: this.instanceId,
              url: this.activeUrl,
              connectAttempt,
              statusCode,
              err: error,
            },
            'Websocket unexpected-response handler failed',
          );
          if (!this.stopped && !this.stopping) {
            void this.scheduleReconnect();
          }
        });
      });

      socket.on('ping', (data) => {
        if (socket !== this.socket) {
          return;
        }

        this.lastPingAt = Date.now();
        socket.pong(data);
      });

      socket.on('pong', () => {
        if (socket !== this.socket) {
          return;
        }

        this.lastPongAt = Date.now();
      });
    } catch (error) {
      this.lastReconnectMetadata = {
        attempt: this.reconnectAttempts + 1,
        reasonType: 'connect_error',
        message: error instanceof Error ? error.message : String(error),
      };
      logger.warn(
        {
          domain: 'exchange-ws',
          client: this.definition.name,
          clientInstanceId: this.instanceId,
          url: this.activeUrl,
          lastMessageAt: this.lastMessageAt,
          lastPingAt: this.lastPingAt,
          lastPongAt: this.lastPongAt,
          err: error,
        },
        'Websocket connect failed',
      );
      this.socket = null;
      await this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async handleOpen(isReconnect: boolean, connectAttempt: number) {
    this.reconnectAttempts = 0;
    this.hasOpened = true;
    this.lastConnectedAt = Date.now();

    if (this.definition.heartbeatIntervalMs) {
      this.startHeartbeat(this.definition.heartbeatIntervalMs);
    }

    logger.info(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        clientInstanceId: this.instanceId,
        url: this.activeUrl,
        connectAttempt,
        isReconnect,
      },
      'Websocket client connected',
    );

    try {
      await this.definition.onOpen(this);
    } catch (error) {
      logger.warn(
        {
          domain: 'exchange-ws',
          client: this.definition.name,
          clientInstanceId: this.instanceId,
          err: error,
        },
        'Websocket open handler failed',
      );
      this.socket?.terminate();
      return;
    }

    if (isReconnect && this.definition.onReconnect) {
      try {
        await this.definition.onReconnect(this);
      } catch (error) {
        logger.warn(
          {
            domain: 'exchange-ws',
            client: this.definition.name,
            clientInstanceId: this.instanceId,
            err: error,
          },
          'Websocket reconnect handler failed',
        );
      }
    }
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        return;
      }

      this.lastPingAt = Date.now();
      this.socket.ping();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async scheduleReconnect() {
    if (this.stopped) {
      return;
    }

    if (this.reconnectTimer) {
      logger.info(
        {
          domain: 'exchange-ws',
          client: this.definition.name,
          clientInstanceId: this.instanceId,
          reconnectAttempts: this.reconnectAttempts,
          reconnectScheduledFor: this.reconnectScheduledFor,
          reconnectReason: this.lastReconnectMetadata,
        },
        'Skipping websocket reconnect scheduling because a reconnect is already pending',
      );
      return;
    }

    this.reconnectAttempts += 1;
    const reconnectDelayMs = resolveReconnectDelayMs({
      attempt: this.reconnectAttempts,
      baseDelayMs: this.definition.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
      maxDelayMs: this.definition.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      jitterRatio: this.definition.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO,
    });
    this.reconnectScheduledFor = Date.now() + reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectScheduledFor = null;
      void this.connect('reconnect');
    }, reconnectDelayMs);
    this.reconnectTimer.unref?.();

    logger.warn(
      {
        domain: 'exchange-ws',
        client: this.definition.name,
        clientInstanceId: this.instanceId,
        reconnectAttempts: this.reconnectAttempts,
        reconnectDelayMs,
        reconnectScheduledFor: this.reconnectScheduledFor,
        url: this.activeUrl,
        reconnectReason: this.lastReconnectMetadata,
        lastMessageAt: this.lastMessageAt,
        lastPingAt: this.lastPingAt,
        lastPongAt: this.lastPongAt,
      },
      'Scheduling websocket reconnect',
    );
  }

  private clearHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectScheduledFor = null;
  }
}
