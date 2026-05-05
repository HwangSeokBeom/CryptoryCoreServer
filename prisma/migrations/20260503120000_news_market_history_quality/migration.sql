CREATE TABLE IF NOT EXISTS "news_cache" (
  "id" TEXT NOT NULL,
  "cache_key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "symbol" TEXT,
  "published_at" TIMESTAMP(3),
  "payload" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "news_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "news_cache_cache_key_key" ON "news_cache"("cache_key");
CREATE INDEX IF NOT EXISTS "news_cache_symbol_published_at_idx" ON "news_cache"("symbol", "published_at");
CREATE INDEX IF NOT EXISTS "news_cache_expires_at_idx" ON "news_cache"("expires_at");
CREATE INDEX IF NOT EXISTS "news_cache_created_at_idx" ON "news_cache"("created_at");

ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "provider_news_id" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "summary" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "content" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "source_name" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "original_url" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "image_url" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "language" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "symbols" JSONB;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "tags" JSONB;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "relevance_score" DOUBLE PRECISION;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "scope" TEXT;
ALTER TABLE "news_cache" ADD COLUMN IF NOT EXISTS "raw_payload" JSONB;

CREATE INDEX IF NOT EXISTS "news_cache_published_at_idx" ON "news_cache"("published_at");
CREATE INDEX IF NOT EXISTS "news_cache_provider_idx" ON "news_cache"("provider");
CREATE INDEX IF NOT EXISTS "news_cache_relevance_score_idx" ON "news_cache"("relevance_score");

CREATE TABLE IF NOT EXISTS "global_market_history" (
  "id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "currency" TEXT NOT NULL,
  "market_cap" DOUBLE PRECISION,
  "volume_24h" DOUBLE PRECISION,
  "btc_dominance" DOUBLE PRECISION,
  "eth_dominance" DOUBLE PRECISION,
  "source" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "global_market_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "global_market_history_date_currency_source_key" ON "global_market_history"("date", "currency", "source");
CREATE INDEX IF NOT EXISTS "global_market_history_date_currency_idx" ON "global_market_history"("date", "currency");
CREATE INDEX IF NOT EXISTS "global_market_history_currency_date_idx" ON "global_market_history"("currency", "date");
