import { prisma } from '../config/database';
import { redis } from '../config/redis';

export type ReadinessCheckStatus = 'ok' | 'failed';

export type ReadinessSnapshot = {
  status: 'ready' | 'not_ready';
  timestamp: number;
  checks: {
    database: ReadinessCheckStatus;
    redis: ReadinessCheckStatus;
  };
};

type Probe = () => Promise<void>;

type ReadinessOptions = {
  databaseProbe?: Probe;
  redisProbe?: Probe;
  timeoutMs?: number;
};

async function defaultDatabaseProbe() {
  await prisma.$queryRaw`SELECT 1`;
}

async function defaultRedisProbe() {
  const response = await redis.ping();
  if (response !== 'PONG') {
    throw new Error('Unexpected Redis readiness response');
  }
}

async function runProbe(probe: Probe, timeoutMs: number): Promise<ReadinessCheckStatus> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Readiness probe timed out')), timeoutMs);
        timeout.unref();
      }),
    ]);
    return 'ok';
  } catch {
    return 'failed';
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function getReadinessSnapshot(options: ReadinessOptions = {}): Promise<ReadinessSnapshot> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const [database, redisStatus] = await Promise.all([
    runProbe(options.databaseProbe ?? defaultDatabaseProbe, timeoutMs),
    runProbe(options.redisProbe ?? defaultRedisProbe, timeoutMs),
  ]);

  return {
    status: database === 'ok' && redisStatus === 'ok' ? 'ready' : 'not_ready',
    timestamp: Date.now(),
    checks: {
      database,
      redis: redisStatus,
    },
  };
}
