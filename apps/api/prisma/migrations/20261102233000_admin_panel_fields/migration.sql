ALTER TABLE "User"
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspensionReason" TEXT;

ALTER TABLE "AuditEvent"
  ADD COLUMN "actorLabel" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "idempotencyKey" TEXT;

CREATE INDEX "AuditEvent_idempotencyKey_idx" ON "AuditEvent"("idempotencyKey");
