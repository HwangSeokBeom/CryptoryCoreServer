-- AlterTable
ALTER TABLE "ExchangeConnection"
ADD COLUMN "connectionStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "failureReason" TEXT,
ADD COLUMN "isTestConnectionResult" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastSyncAt" TIMESTAMP(3);
