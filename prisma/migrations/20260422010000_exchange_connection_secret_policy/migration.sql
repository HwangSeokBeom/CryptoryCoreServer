-- Exchange credential storage policy hardening.
-- Existing encrypted credentials remain encrypted. Legacy rows receive a masked
-- placeholder until the user revalidates or reconnects, because the database
-- migration must not decrypt secrets.

ALTER TABLE "ExchangeConnection"
ADD COLUMN IF NOT EXISTS "apiKeyMasked" TEXT NOT NULL DEFAULT '********',
ADD COLUMN IF NOT EXISTS "apiKeyFingerprint" TEXT,
ADD COLUMN IF NOT EXISTS "connectionPurpose" TEXT NOT NULL DEFAULT 'read_only',
ADD COLUMN IF NOT EXISTS "permissionScope" JSONB;

UPDATE "ExchangeConnection"
SET "connectionStatus" = CASE
  WHEN "connectionStatus" = 'pending' THEN 'pending_verification'
  WHEN "connectionStatus" = 'invalid' THEN 'verification_failed'
  ELSE "connectionStatus"
END;

CREATE INDEX IF NOT EXISTS "ExchangeConnection_userId_apiKeyFingerprint_idx"
ON "ExchangeConnection"("userId", "apiKeyFingerprint");
