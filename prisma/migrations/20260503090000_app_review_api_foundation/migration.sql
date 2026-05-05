CREATE TABLE IF NOT EXISTS "translation_cache" (
  "id" TEXT NOT NULL,
  "source_language" TEXT NOT NULL,
  "target_language" TEXT NOT NULL,
  "original_hash" TEXT NOT NULL,
  "original_text" TEXT NOT NULL,
  "translated_text" TEXT,
  "provider" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "translation_cache_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "community_reports" (
  "id" TEXT NOT NULL,
  "reporter_user_id" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'received',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "community_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "user_blocks" (
  "id" TEXT NOT NULL,
  "blocker_user_id" TEXT NOT NULL,
  "blocked_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "user_follows" (
  "id" TEXT NOT NULL,
  "follower_user_id" TEXT NOT NULL,
  "following_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_follows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "market_data_cache" (
  "id" TEXT NOT NULL,
  "cache_key" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "market_data_cache_pkey" PRIMARY KEY ("id")
);

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

CREATE UNIQUE INDEX IF NOT EXISTS "translation_cache_source_language_target_language_original_hash_key"
  ON "translation_cache"("source_language", "target_language", "original_hash");
CREATE INDEX IF NOT EXISTS "translation_cache_created_at_idx" ON "translation_cache"("created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "community_reports_reporter_user_id_target_type_target_id_key"
  ON "community_reports"("reporter_user_id", "target_type", "target_id");
CREATE INDEX IF NOT EXISTS "community_reports_created_at_idx" ON "community_reports"("created_at");
CREATE INDEX IF NOT EXISTS "community_reports_target_type_target_id_idx" ON "community_reports"("target_type", "target_id");
CREATE INDEX IF NOT EXISTS "community_reports_reporter_user_id_idx" ON "community_reports"("reporter_user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "user_blocks_blocker_user_id_blocked_user_id_key"
  ON "user_blocks"("blocker_user_id", "blocked_user_id");
CREATE INDEX IF NOT EXISTS "user_blocks_blocker_user_id_idx" ON "user_blocks"("blocker_user_id");
CREATE INDEX IF NOT EXISTS "user_blocks_blocked_user_id_idx" ON "user_blocks"("blocked_user_id");
CREATE INDEX IF NOT EXISTS "user_blocks_created_at_idx" ON "user_blocks"("created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "user_follows_follower_user_id_following_user_id_key"
  ON "user_follows"("follower_user_id", "following_user_id");
CREATE INDEX IF NOT EXISTS "user_follows_follower_user_id_idx" ON "user_follows"("follower_user_id");
CREATE INDEX IF NOT EXISTS "user_follows_following_user_id_idx" ON "user_follows"("following_user_id");
CREATE INDEX IF NOT EXISTS "user_follows_created_at_idx" ON "user_follows"("created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "market_data_cache_cache_key_key" ON "market_data_cache"("cache_key");
CREATE INDEX IF NOT EXISTS "market_data_cache_expires_at_idx" ON "market_data_cache"("expires_at");
CREATE INDEX IF NOT EXISTS "market_data_cache_created_at_idx" ON "market_data_cache"("created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "news_cache_cache_key_key" ON "news_cache"("cache_key");
CREATE INDEX IF NOT EXISTS "news_cache_symbol_published_at_idx" ON "news_cache"("symbol", "published_at");
CREATE INDEX IF NOT EXISTS "news_cache_expires_at_idx" ON "news_cache"("expires_at");
CREATE INDEX IF NOT EXISTS "news_cache_created_at_idx" ON "news_cache"("created_at");
