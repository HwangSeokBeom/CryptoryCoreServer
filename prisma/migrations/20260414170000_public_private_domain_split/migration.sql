-- CreateTable
CREATE TABLE "ExchangeConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "label" TEXT,
    "apiKeyEncrypted" TEXT NOT NULL,
    "secretKeyEncrypted" TEXT NOT NULL,
    "passphraseEncrypted" TEXT,
    "validationStatus" TEXT NOT NULL DEFAULT 'placeholder',
    "validationMode" TEXT NOT NULL DEFAULT 'placeholder',
    "validationMessage" TEXT,
    "canUsePrivateApi" BOOLEAN NOT NULL DEFAULT false,
    "lastValidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeConnection_userId_exchange_idx" ON "ExchangeConnection"("userId", "exchange");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeConnection_userId_exchange_key" ON "ExchangeConnection"("userId", "exchange");

-- AddForeignKey
ALTER TABLE "ExchangeConnection" ADD CONSTRAINT "ExchangeConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
