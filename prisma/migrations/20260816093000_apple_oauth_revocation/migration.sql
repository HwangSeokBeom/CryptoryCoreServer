ALTER TABLE "AuthIdentity"
ADD COLUMN IF NOT EXISTS "providerRefreshTokenEncrypted" TEXT,
ADD COLUMN IF NOT EXISTS "providerTokenUpdatedAt" TIMESTAMP(3);
