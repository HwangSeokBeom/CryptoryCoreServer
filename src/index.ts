import 'dotenv/config';

import { execFileSync } from 'child_process';
import { buildApp } from './app';
import { getExchangeConfig } from './config/exchange.config';
import { getServerExchangeCredentialAvailability } from './config/exchange.credentials';
import { env } from './config/env';
import { logger } from './utils/logger';
import { prisma } from './config/database';
import { redis } from './config/redis';
import { closeWebSocketServer, setupWebSocket } from './websocket/wsServer';
import { startTickerCollector, stopTickerCollector } from './jobs/tickerCollector';
import { initializeFcm } from './domains/push/fcm.service';
import { startPriceAlertWorker, stopPriceAlertWorker } from './domains/alerts/price-alert.worker';

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

function getEnabledStartupJobs() {
  return [
    env.MARKET_COLLECTOR_ENABLED ? 'marketCollector' : null,
    env.MARKET_COLLECTOR_ENABLED && env.MARKET_TRADE_COLLECTOR_ENABLED ? 'marketTradeCollector' : null,
    env.MARKET_TREND_SNAPSHOT_ENABLED ? 'marketTrendSnapshot' : null,
    env.MARKET_STARTUP_WARMUP_ENABLED ? 'marketStartupWarmup' : null,
    env.PRICE_ALERT_WORKER_ENABLED ? 'priceAlertWorker' : null,
  ].filter((job): job is string => Boolean(job));
}

async function main() {
  logger.info(
    { domain: 'startup-jobs', enabledJobs: getEnabledStartupJobs() },
    `[StartupJobs] enabled jobs=${JSON.stringify(getEnabledStartupJobs())}`,
  );
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

  initializeFcm();

  logger.info(
    {
      domain: 'config',
      privateCredentialResolutionOrder: ['user_connection', 'server_env'],
      exchangeCredentialEnv: getServerExchangeCredentialAvailability(),
    },
    'Loaded exchange credential availability',
  );

  logger.info(
    {
      domain: 'config',
      newsProvider: env.NEWS_PROVIDER,
      hasNewsApiKey: Boolean(env.NEWSAPI_API_KEY?.trim()),
    },
    `[Config] NEWS_PROVIDER=${env.NEWS_PROVIDER} hasNewsApiKey=${Boolean(env.NEWSAPI_API_KEY?.trim())}`,
  );

  const binanceConfig = getExchangeConfig('binance');
  logger.info(
    {
      domain: 'config',
      exchange: 'binance',
      publicRestBaseUrl: binanceConfig.publicRestBaseUrl,
      privateRestBaseUrl: binanceConfig.privateRestBaseUrl,
      webSocketBaseUrl: binanceConfig.publicWebSocketUrl,
    },
    'Loaded Binance endpoint configuration',
  );

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(
    {
      domain: 'process',
      event: 'process_start_complete',
      port: env.PORT,
      restBaseURL: `http://127.0.0.1:${env.PORT}`,
      marketBaseURL: `http://127.0.0.1:${env.PORT}/market`,
      marketWebSocketURL: `ws://127.0.0.1:${env.PORT}/ws/market`,
    },
    `Server listening on http://127.0.0.1:${env.PORT} (market REST http://127.0.0.1:${env.PORT}/market, WS ws://127.0.0.1:${env.PORT}/ws/market)`,
  );

  const httpServer = app.server;
  setupWebSocket(httpServer, {
    privateStreamingEnabled: env.ENABLE_PRIVATE_WS,
    verifyJwt: async (token) => app.jwt.verify(token),
  });
  logger.info(
    {
      domain: 'process',
      event: 'public_market_api_ready',
      port: env.PORT,
      healthURL: `http://127.0.0.1:${env.PORT}/health`,
      marketHealthURL: `http://127.0.0.1:${env.PORT}/market/health`,
      tickerURL: `http://127.0.0.1:${env.PORT}/market/tickers?exchange=upbit&quoteCurrency=KRW`,
      candleURL: `http://127.0.0.1:${env.PORT}/market/candles?exchange=upbit&symbol=KRW-BTC&quote=KRW&timeframe=1H&limit=200`,
      webSocketURL: `ws://127.0.0.1:${env.PORT}/ws/market`,
    },
    'Public market REST and websocket endpoints ready',
  );

  startTickerCollector();
  startPriceAlertWorker();

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
      stopPriceAlertWorker();
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
