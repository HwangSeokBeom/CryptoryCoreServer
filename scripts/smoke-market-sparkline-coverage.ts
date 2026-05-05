import 'dotenv/config';

process.env.SPARKLINE_WARMUP_ENABLED ??= 'false';

type App = Awaited<ReturnType<typeof import('../src/app').buildApp>>;

type Target = {
  exchange: string;
  quoteCurrency: string;
};

const TARGETS: Target[] = [
  { exchange: 'upbit', quoteCurrency: 'KRW' },
  { exchange: 'upbit', quoteCurrency: 'BTC' },
  { exchange: 'bithumb', quoteCurrency: 'KRW' },
  { exchange: 'coinone', quoteCurrency: 'KRW' },
  { exchange: 'korbit', quoteCurrency: 'KRW' },
  { exchange: 'binance', quoteCurrency: 'USDT' },
];

function bucketPointCount(pointCount: number) {
  if (pointCount === 0) return 'count0';
  if (pointCount === 1) return 'count1';
  if (pointCount <= 11) return 'count2to11';
  if (pointCount <= 23) return 'count12to23';
  if (pointCount === 24) return 'count24';
  return 'countOver24';
}

async function injectJson(app: App, url: string) {
  const response = await app.inject({ method: 'GET', url });
  const body = JSON.parse(response.body);
  return { statusCode: response.statusCode, body };
}

async function main() {
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const rows: Array<Record<string, unknown>> = [];
  let failed = false;
  try {
    for (const target of TARGETS) {
      const url = `/market/tickers?exchange=${target.exchange}&quoteCurrency=${target.quoteCurrency}&limit=80`;
      const startedAt = Date.now();
      const response = await injectJson(app, url);
      const totalMs = Date.now() - startedAt;
      const items = Array.isArray(response.body?.data?.items) ? response.body.data.items : [];
      const meta = response.body?.data?.meta ?? {};
      const summary = meta.sparklineSummary ?? {};
      const pointCountDistribution = {
        count0: 0,
        count1: 0,
        count2to11: 0,
        count12to23: 0,
        count24: 0,
        countOver24: 0,
      };
      let invalidShortDisplayCount = 0;
      for (const item of items) {
        const pointCount = Number(item.sparklinePointCount ?? 0);
        pointCountDistribution[bucketPointCount(pointCount) as keyof typeof pointCountDistribution] += 1;
        if (pointCount >= 2 && pointCount <= 11 && item.graphDisplayAllowed === true) {
          invalidShortDisplayCount += 1;
        }
      }
      const row = {
        exchange: target.exchange,
        quoteCurrency: target.quoteCurrency,
        statusCode: response.statusCode,
        returnedCount: items.length,
        graphDisplayAllowedCount: items.filter((item: any) => item.graphDisplayAllowed === true).length,
        displayable24Count: items.filter((item: any) => item.graphDisplayAllowed === true && Number(item.sparklinePointCount ?? 0) >= 24).length,
        provider24Count: summary.providerCandle24 ?? 0,
        listSparkline24Count: summary.listSparkline24 ?? 0,
        stale24Count: summary.staleListSparkline24 ?? 0,
        tickerRingBufferCount: summary.tickerRingBuffer ?? items.filter((item: any) => item.sparklineSource === 'ticker_ring_buffer').length,
        lowInformationCount: summary.lowInformation ?? 0,
        unavailableCount: summary.unavailable ?? 0,
        pointCountDistribution,
        attachMs: summary.attachMs ?? meta.timing?.sparklineAttachMs ?? null,
        totalMs: meta.timing?.totalMs ?? totalMs,
        providerFetchFailed: summary.providerFetchFailed ?? 0,
        rateLimitCount: summary.providerFetchHttp429 ?? 0,
        providerFetch4xx: summary.providerFetch4xx ?? 0,
        providerFetch5xx: summary.providerFetch5xx ?? 0,
        providerLatencyP50Ms: summary.providerLatencyP50Ms ?? 0,
        providerLatencyP95Ms: summary.providerLatencyP95Ms ?? 0,
        invalidShortDisplayCount,
      };
      rows.push(row);
      if (response.statusCode !== 200 || response.body?.success !== true || items.length <= 0 || invalidShortDisplayCount > 0) {
        failed = true;
      }
    }
    console.table(rows.map((row) => ({
      exchange: row.exchange,
      quoteCurrency: row.quoteCurrency,
      returnedCount: row.returnedCount,
      displayable24Count: row.displayable24Count,
      stale24Count: row.stale24Count,
      provider24Count: row.provider24Count,
      listSparkline24Count: row.listSparkline24Count,
      lowInformationCount: row.lowInformationCount,
      unavailableCount: row.unavailableCount,
      attachMs: row.attachMs,
      totalMs: row.totalMs,
      rateLimitCount: row.rateLimitCount,
    })));
    console.log(JSON.stringify({ rows }, null, 2));
    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
