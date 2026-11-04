ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'REGISTRATION';
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'PHONE_CHANGE';

ALTER TABLE "Payment"
  ADD COLUMN "requestIdempotencyKey" TEXT;

CREATE UNIQUE INDEX "Payment_requestIdempotencyKey_key"
  ON "Payment"("requestIdempotencyKey");
