CREATE TABLE IF NOT EXISTS "price_alerts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "exchange" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "quote_currency" TEXT NOT NULL,
  "market" TEXT NOT NULL,
  "condition" TEXT NOT NULL,
  "target_price" DOUBLE PRECISION NOT NULL,
  "current_price_at_create" DOUBLE PRECISION,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "repeat_mode" TEXT NOT NULL DEFAULT 'ONCE',
  "last_triggered_at" TIMESTAMP(3),
  "trigger_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "price_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_alerts_condition_check" CHECK ("condition" IN ('ABOVE', 'BELOW')),
  CONSTRAINT "price_alerts_repeat_mode_check" CHECK ("repeat_mode" IN ('ONCE', 'REPEAT')),
  CONSTRAINT "price_alerts_quote_currency_check" CHECK ("quote_currency" IN ('KRW', 'BTC')),
  CONSTRAINT "price_alerts_target_price_check" CHECK ("target_price" > 0)
);

CREATE TABLE IF NOT EXISTS "fcm_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "device_id" TEXT,
  "app_version" TEXT,
  "environment" TEXT NOT NULL DEFAULT 'prod',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fcm_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fcm_tokens_platform_check" CHECK ("platform" IN ('IOS', 'ANDROID', 'WEB')),
  CONSTRAINT "fcm_tokens_environment_check" CHECK ("environment" IN ('dev', 'prod'))
);

CREATE TABLE IF NOT EXISTS "alert_delivery_logs" (
  "id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "fcm_token_id" TEXT,
  "status" TEXT NOT NULL,
  "provider_message_id" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_delivery_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alert_delivery_logs_status_check" CHECK ("status" IN ('SUCCESS', 'FAILED', 'SKIPPED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "price_alerts_user_id_exchange_symbol_quote_currency_condition_target_price_key"
  ON "price_alerts"("user_id", "exchange", "symbol", "quote_currency", "condition", "target_price");
CREATE INDEX IF NOT EXISTS "price_alerts_is_active_exchange_symbol_quote_currency_idx"
  ON "price_alerts"("is_active", "exchange", "symbol", "quote_currency");
CREATE INDEX IF NOT EXISTS "price_alerts_user_id_created_at_idx"
  ON "price_alerts"("user_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "fcm_tokens_user_id_token_key"
  ON "fcm_tokens"("user_id", "token");
CREATE INDEX IF NOT EXISTS "fcm_tokens_user_id_is_active_idx"
  ON "fcm_tokens"("user_id", "is_active");
CREATE INDEX IF NOT EXISTS "fcm_tokens_last_seen_at_idx"
  ON "fcm_tokens"("last_seen_at");

CREATE INDEX IF NOT EXISTS "alert_delivery_logs_alert_id_created_at_idx"
  ON "alert_delivery_logs"("alert_id", "created_at");
CREATE INDEX IF NOT EXISTS "alert_delivery_logs_user_id_created_at_idx"
  ON "alert_delivery_logs"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "alert_delivery_logs_status_created_at_idx"
  ON "alert_delivery_logs"("status", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_alerts_user_id_fkey'
  ) THEN
    ALTER TABLE "price_alerts"
      ADD CONSTRAINT "price_alerts_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fcm_tokens_user_id_fkey'
  ) THEN
    ALTER TABLE "fcm_tokens"
      ADD CONSTRAINT "fcm_tokens_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alert_delivery_logs_alert_id_fkey'
  ) THEN
    ALTER TABLE "alert_delivery_logs"
      ADD CONSTRAINT "alert_delivery_logs_alert_id_fkey"
      FOREIGN KEY ("alert_id") REFERENCES "price_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alert_delivery_logs_user_id_fkey'
  ) THEN
    ALTER TABLE "alert_delivery_logs"
      ADD CONSTRAINT "alert_delivery_logs_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alert_delivery_logs_fcm_token_id_fkey'
  ) THEN
    ALTER TABLE "alert_delivery_logs"
      ADD CONSTRAINT "alert_delivery_logs_fcm_token_id_fkey"
      FOREIGN KEY ("fcm_token_id") REFERENCES "fcm_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
