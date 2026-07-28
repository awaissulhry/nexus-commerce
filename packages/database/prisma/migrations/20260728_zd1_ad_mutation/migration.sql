-- AX-ZD.1 — a typed mutation record for ad writes.
--
-- Ad writes ride OutboundSyncQueue, a PRODUCT/LISTING model: productId,
-- channelListingId, externalListingId, and no campaign, ad-group or target
-- foreign key. The entity and the changed fields live inside a JSON payload.
--
-- Three consequences, all live:
--   1. The drift check's pending-write lookup is a CAMPAIGN-WIDE JSON-path scan,
--      so one queued mutation classifies EVERY drifting field on that campaign
--      as WRITE_PENDING — a queued budget change hides a name edit made in
--      Seller Central.
--   2. /campaigns/:id/pending-writes reconstructs state by scanning JSON.
--   3. Writes cannot be serialised per entity, which is exactly what Amazon's
--      HTTP 423 ConcurrentModificationException exists to punish.
--
-- This is ADDITIVE. OutboundSyncQueue remains the dispatch path and keeps its
-- grace-period, dead-lettering and write-gate behaviour unchanged; AdMutation
-- is written alongside it so the typed record exists to be read from. Moving
-- dispatch is a separate, verifiable step.

CREATE TABLE IF NOT EXISTS "AdMutation" (
  "id"               TEXT PRIMARY KEY,
  "entityType"       TEXT NOT NULL,
  "entityId"         TEXT NOT NULL,
  "externalEntityId" TEXT,
  "profileId"        TEXT,
  "marketplace"      TEXT,
  "field"            TEXT NOT NULL,
  "intendedValue"    TEXT,
  "previousValue"    TEXT,
  "state"            TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "lastError"        TEXT,
  "changeSetId"      TEXT,
  "importJobId"      TEXT,
  "ruleId"           TEXT,
  "actor"            TEXT NOT NULL,
  "idempotencyKey"   TEXT,
  "holdUntil"        TIMESTAMP(3),
  "outboundQueueId"  TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"        TIMESTAMP(3)
);

-- The lookup the drift check needs: is THIS field on THIS entity in flight?
CREATE INDEX IF NOT EXISTS "AdMutation_entity_field_state_idx"
  ON "AdMutation" ("entityType", "entityId", "field", "state");
-- Per-entity serialisation and the pending-writes panel.
CREATE INDEX IF NOT EXISTS "AdMutation_entity_state_idx" ON "AdMutation" ("entityType", "entityId", "state");
CREATE INDEX IF NOT EXISTS "AdMutation_changeSetId_idx"  ON "AdMutation" ("changeSetId");
CREATE INDEX IF NOT EXISTS "AdMutation_state_hold_idx"   ON "AdMutation" ("state", "holdUntil");
-- At-least-once delivery needs a dedupe primitive.
CREATE UNIQUE INDEX IF NOT EXISTS "AdMutation_idempotencyKey_key"
  ON "AdMutation" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
