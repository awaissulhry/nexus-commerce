-- R0.3 — Returns bug-fix foundation columns.
--
-- Two adds, both nullable, both indexed:
--
--   sendcloudParcelId — mirrors the parcel id the /generate-label
--                       route gets back from Sendcloud. The Sendcloud
--                       webhook (sendcloud-webhooks.routes.ts) already
--                       resolves Shipment via Shipment.sendcloudParcelId;
--                       this column extends the same lookup to Return,
--                       so return-leg tracking events update Return
--                       status (REQUESTED → IN_TRANSIT) instead of
--                       black-boxing.
--
--   idempotencyKey   — POST /fulfillment/returns honours an
--                       Idempotency-Key header. Same key + same body
--                       → same Return row, no double-create from
--                       network retries. Partial unique index
--                       (NULL ≠ NULL in Postgres UNIQUE handles this
--                       implicitly, but we keep the predicate explicit
--                       for index-pruning clarity).
--
-- Both adds are idempotent.

ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "sendcloudParcelId" TEXT;
ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "idempotencyKey"    TEXT;

CREATE INDEX IF NOT EXISTS "Return_sendcloudParcelId_idx"
  ON "Return" ("sendcloudParcelId");

CREATE UNIQUE INDEX IF NOT EXISTS "Return_idempotencyKey_uniq"
  ON "Return" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
