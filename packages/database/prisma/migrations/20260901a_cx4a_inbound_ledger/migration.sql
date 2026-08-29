-- CX.4a — the inbound ledger.
--
-- `WebhookEvent` becomes the InboundEvent table the CX programme's §3.4.3 calls for,
-- by extension rather than replacement: 5,158 live rows already carry the payloads and
-- the provider timestamps, and a parallel table would have split the history in two.
--
-- Additive and idempotent throughout. Nothing existing changes meaning: `isProcessed`
-- keeps its exact role and `status` is derived from it, so the two cannot disagree on
-- the day this ships.
ALTER TABLE "WebhookEvent"
  ADD COLUMN IF NOT EXISTS "connectionId"  TEXT,
  ADD COLUMN IF NOT EXISTS "status"        TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "attempts"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3),
  -- Tri-state ON PURPOSE. true = a signature was checked and passed; false = checked
  -- and failed; NULL = this transport carries no signature to check. Amazon's SQS
  -- notifications are plain JSON authenticated by the queue's IAM policy, not signed
  -- (research R1), so `false` would be a lie about them and `true` a bigger one.
  ADD COLUMN IF NOT EXISTS "signatureOk"   BOOLEAN,
  -- What actually established trust: 'ebay_ecdsa' | 'sqs_iam' | 'shopify_hmac' | 'none'.
  ADD COLUMN IF NOT EXISTS "verifiedBy"    TEXT,
  ADD COLUMN IF NOT EXISTS "payloadDigest" TEXT,
  ADD COLUMN IF NOT EXISTS "lastError"     TEXT,
  -- Decision 9 — archive, never delete. The row stays; the payload moves and leaves
  -- a pointer. Unused until the archiver ships; declared here so the ledger's shape
  -- is settled in one migration rather than three.
  ADD COLUMN IF NOT EXISTS "archivedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archiveUri"    TEXT;

-- Backfill. Every existing row is Amazon-via-SQS and already processed; deriving
-- `status` from `isProcessed` keeps the two columns consistent from the first second.
UPDATE "WebhookEvent"
   SET "status" = CASE WHEN "isProcessed" THEN 'done' ELSE 'pending' END
 WHERE "status" = 'pending';

-- Name the trust boundary for the rows that already exist rather than leaving it blank
-- and letting a reader assume a signature was checked.
UPDATE "WebhookEvent"
   SET "verifiedBy" = 'sqs_iam'
 WHERE "verifiedBy" IS NULL AND "channel" = 'AMAZON';

CREATE INDEX IF NOT EXISTS "WebhookEvent_status_nextAttemptAt_idx" ON "WebhookEvent" ("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "WebhookEvent_connectionId_idx"        ON "WebhookEvent" ("connectionId");
CREATE INDEX IF NOT EXISTS "WebhookEvent_signatureOk_idx"         ON "WebhookEvent" ("signatureOk") WHERE "signatureOk" = false;
