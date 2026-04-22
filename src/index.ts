import 'dotenv/config';

import { execFileSync } from 'child_process';
import { buildApp } from './app';
import { getServerExchangeCredentialAvailability } from './config/exchange.credentials';
import { env } from './config/env';
import { logger } from './utils/logger';
import { prisma } from './config/database';
import { redis } from './config/redis';
import { closeWebSocketServer, setupWebSocket } from './websocket/wsServer';
import { startTickerCollector, stopTickerCollector } from './jobs/tickerCollector';

function lookupPortOccupant(port: number) {
  if (env.NODE_ENV !== 'development') {
    return null;
  }

  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpct'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = output
      .split('\n')
      .find((line) => line.startsWith('p'))
      ?.slice(1)
      .trim();
    const command = output
      .split('\n')
      .find((line) => line.startsWith('c'))
      ?.slice(1)
      .trim();
    return pid ? { pid, command: command || null } : null;
  } catch {
    return null;
  }
}

async function main() {
  const app = await buildApp();
  let shuttingDown = false;

  logger.info(
    {
      domain: 'process',
      event: 'process_start',
      pid: process.pid,
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
    },
    'Process starting',
  );

  logger.info(
    {
      domain: 'config',
      privateCredentialResolutionOrder: ['user_connection', 'server_env'],
      exchangeCredentialEnv: getServerExchangeCredentialAvailability(),
    },
    'Loaded exchange credential availability',
  );

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ domain: 'process', event: 'process_start_complete', port: env.PORT }, 'Server listening');

  const httpServer = app.server;
  setupWebSocket(httpServer, {
    privateStreamingEnabled: env.ENABLE_PRIVATE_WS,
    verifyJwt: async (token) => app.jwt.verify(token),
  });

  startTickerCollector();

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) {
      logger.warn({ domain: 'process', reason, exitCode }, 'Shutdown already in progress');
      return;
    }

    shuttingDown = true;
    logger.info({ domain: 'process', reason, exitCode }, 'Shutting down...');

    const forceExitTimer = setTimeout(() => {
      logger.error({ domain: 'process', reason, exitCode }, 'Shutdown timeout exceeded, forcing process exit');
      process.exit(exitCode);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await stopTickerCollector();
      await closeWebSocketServer('server_shutdown');

      const closeAppPromise = app.close();
      app.server.closeIdleConnections?.();
      app.server.closeAllConnections?.();
      await closeAppPromise;

      await prisma.$disconnect();
      redis.disconnect();
      logger.info({ domain: 'process', reason, exitCode }, 'Process shutdown completed');
    } catch (error) {
      logger.error({ domain: 'process', reason, exitCode, err: error }, 'Process shutdown failed');
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    }
  };

  process.once('SIGINT', () => {
    logger.warn({ domain: 'process', signal: 'SIGINT' }, 'Process signal received');
    void shutdown('signal:SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.warn({ domain: 'process', signal: 'SIGTERM' }, 'Process signal received');
    void shutdown('signal:SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ domain: 'process', reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.error({ domain: 'process', err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('beforeExit', (code) => {
    logger.info({ domain: 'process', exitCode: code }, 'Process beforeExit hook fired');
  });
  process.on('exit', (code) => {
    logger.info({ domain: 'process', exitCode: code }, 'Process exit hook fired');
  });
}

main().catch((err) => {
  if (err instanceof Error && /EADDRINUSE/.test(err.message)) {
    const occupant = lookupPortOccupant(env.PORT);
    logger.error(
      {
        domain: 'process',
        event: 'port_bind_failure',
        port: env.PORT,
        occupant,
        hint: `lsof -nP -iTCP:${env.PORT} -sTCP:LISTEN`,
        err,
      },
      'Failed to bind server port',
    );
    process.exit(1);
  }
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
