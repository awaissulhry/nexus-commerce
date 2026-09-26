-- Additive: old receivers can coexist during the controlled worker cutover.
ALTER TABLE "WebhookEvent"
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "processingUntil" TIMESTAMP(3),
  ADD COLUMN "rawBody" BYTEA,
  ADD COLUMN "verificationHeaders" JSONB;
