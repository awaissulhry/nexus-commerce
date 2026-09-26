-- Additive: existing receipts keep their status, schedule and processing protocol.
ALTER TABLE "WebhookEvent"
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseUntil" TIMESTAMP(3);

ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_lease_pair_check"
  CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL));
