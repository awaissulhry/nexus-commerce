-- P2.1 — the inbound ledger learns to retry.
--
-- CX.4a gave `WebhookEvent` the columns a ledger needs and left the behaviour for
-- later: `nextAttemptAt` was never written, `status = 'dlq'` never set, and nothing
-- re-ran a failed event. This migration adds the one column that behaviour needs.
--
-- `attempts` already existed but carried two meanings at once: the ledger writer
-- incremented it when the CHANNEL delivered the same event again, and P2.1 needs it
-- to count how many times WE tried to handle the event. Those are different numbers
-- and a replay must reset one without erasing the other. So deliveries move to their
-- own column and `attempts` keeps only the handling count.
--
-- Safe to run against existing data: every one of the 5,256 rows present when this
-- was written has attempts = 0, so the split starts from a clean state either way.
ALTER TABLE "WebhookEvent"
  ADD COLUMN IF NOT EXISTS "deliveries" INTEGER NOT NULL DEFAULT 0;

-- Whatever `attempts` held before this, it was a delivery count. Move it, then let
-- `attempts` start again as a handling count.
UPDATE "WebhookEvent" SET "deliveries" = "attempts" WHERE "deliveries" = 0 AND "attempts" > 0;
UPDATE "WebhookEvent" SET "attempts" = 0 WHERE "attempts" > 0;
