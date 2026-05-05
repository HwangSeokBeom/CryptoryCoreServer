import 'dotenv/config';

import { buildApp } from '../src/app';

async function injectJson(app: Awaited<ReturnType<typeof buildApp>>, url: string) {
  const response = await app.inject({ method: 'GET', url });
  const body = JSON.parse(response.body);
  return { statusCode: response.statusCode, body };
}

async function main() {
  const app = await buildApp();
  try {
    const ticker = await injectJson(app, '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=5');
    const candles = await injectJson(app, '/market/candles?exchange=upbit&symbol=BTC&quoteCurrency=KRW&timeframe=1H&limit=2');

    const tickerCount = Array.isArray(ticker.body?.data?.items) ? ticker.body.data.items.length : 0;
    const candleCount = Array.isArray(candles.body?.data?.candles) ? candles.body.data.candles.length : 0;

    console.log(JSON.stringify({
      ticker: {
        statusCode: ticker.statusCode,
        success: ticker.body?.success === true,
        count: tickerCount,
      },
      candles: {
        statusCode: candles.statusCode,
        success: candles.body?.success === true,
        count: candleCount,
        status: candles.body?.data?.status ?? null,
      },
    }, null, 2));

    if (ticker.statusCode !== 200 || ticker.body?.success !== true || tickerCount < 1) {
      process.exitCode = 1;
    }
    if (candles.statusCode !== 200 || candles.body?.success !== true || !Array.isArray(candles.body?.data?.candles)) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
