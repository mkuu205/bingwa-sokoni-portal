ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'REGISTRATION';
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'PHONE_CHANGE';

CREATE TABLE "WebSession" (
  "id" TEXT NOT NULL,
  "tokenType" TEXT NOT NULL,
  "userId" TEXT,
  "adminUsername" TEXT,
  "refreshTokenHash" TEXT NOT NULL,
  "legacyTokenHash" TEXT,
  "previousTokenHash" TEXT,
  "previousTokenAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "WebSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebSession_principal_check" CHECK (
    ("tokenType" = 'user' AND "userId" IS NOT NULL AND "adminUsername" IS NULL) OR
    ("tokenType" = 'admin' AND "userId" IS NULL AND "adminUsername" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "WebSession_refreshTokenHash_key" ON "WebSession"("refreshTokenHash");
CREATE UNIQUE INDEX "WebSession_legacyTokenHash_key" ON "WebSession"("legacyTokenHash");
CREATE INDEX "WebSession_userId_revokedAt_idx" ON "WebSession"("userId", "revokedAt");
CREATE INDEX "WebSession_expiresAt_idx" ON "WebSession"("expiresAt");
ALTER TABLE "WebSession" ADD CONSTRAINT "WebSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");
