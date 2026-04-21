-- AlterTable
ALTER TABLE "User"
ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'email',
ADD COLUMN "providerAccountId" TEXT;

-- AlterTable
ALTER TABLE "ExchangeConnection"
ADD COLUMN "validationCode" TEXT,
ADD COLUMN "validationDetails" JSONB,
ADD COLUMN "lastErrorCode" TEXT,
ADD COLUMN "lastErrorSummary" TEXT;

-- CreateTable
CREATE TABLE "ExchangeConnectionVerification" (
    "id" TEXT NOT NULL,
    "exchangeConnectionId" TEXT,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeConnectionVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchangeConnectionId" TEXT,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authProvider_providerAccountId_key" ON "User"("authProvider", "providerAccountId");

-- CreateIndex
CREATE INDEX "ExchangeConnectionVerification_userId_exchange_checkedAt_idx" ON "ExchangeConnectionVerification"("userId", "exchange", "checkedAt");

-- CreateIndex
CREATE INDEX "ExchangeConnectionVerification_exchangeConnectionId_checkedAt_idx" ON "ExchangeConnectionVerification"("exchangeConnectionId", "checkedAt");

-- CreateIndex
CREATE INDEX "OrderRequest_userId_exchange_createdAt_idx" ON "OrderRequest"("userId", "exchange", "createdAt");

-- CreateIndex
CREATE INDEX "OrderRequest_exchangeConnectionId_createdAt_idx" ON "OrderRequest"("exchangeConnectionId", "createdAt");

-- AddForeignKey
ALTER TABLE "ExchangeConnectionVerification" ADD CONSTRAINT "ExchangeConnectionVerification_exchangeConnectionId_fkey" FOREIGN KEY ("exchangeConnectionId") REFERENCES "ExchangeConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeConnectionVerification" ADD CONSTRAINT "ExchangeConnectionVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRequest" ADD CONSTRAINT "OrderRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRequest" ADD CONSTRAINT "OrderRequest_exchangeConnectionId_fkey" FOREIGN KEY ("exchangeConnectionId") REFERENCES "ExchangeConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
