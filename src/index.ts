import 'dotenv/config';

import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { prisma } from './config/database';
import { redis } from './config/redis';
import { closeWebSocketServer, setupWebSocket } from './websocket/wsServer';
import { startTickerCollector, stopTickerCollector } from './jobs/tickerCollector';

async function main() {
  const app = await buildApp();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(`Server listening on port ${env.PORT}`);

  const httpServer = app.server;
  setupWebSocket(httpServer);

  startTickerCollector();

  const shutdown = async () => {
    logger.info('Shutting down...');
    stopTickerCollector();
    closeWebSocketServer();
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
