-- O.2 — Outbound rebuild: TrackingEvent + TrackingMessageLog tables.
--
-- TrackingEvent is the carrier scan log per shipment (append-only).
-- Written by the Sendcloud webhook (O.7) and Amazon shipping-event
-- handlers (future); read by the timeline drawer (O.20), the branded
-- tracking page (O.21), and the late-shipment outbound risk job (O.19).
--
-- TrackingMessageLog is the channel-pushback retry queue (us → channel).
-- Written by the mark-shipped path + the retry job (O.12); read by the
-- retry job itself + the drawer's "tracking push status" pill.
--
-- Both tables are empty on creation — no backfill source. Consumers
-- land in O.7 (Sendcloud webhook), O.9-O.11 (channel pushback), O.12
-- (retry job), O.20 (timeline UI), O.21 (branded tracking page).

DO $$ BEGIN
  CREATE TYPE "TrackingMessageStatus" AS ENUM (
    'PENDING','IN_FLIGHT','SUCCESS','FAILED','DEAD_LETTER'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── TrackingEvent ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TrackingEvent" (
  "id"                TEXT PRIMARY KEY,
  "shipmentId"        TEXT NOT NULL,
  -- Distinct from createdAt (= ingestion). Carrier scans can arrive
  -- minutes-to-hours after the physical event; the timeline sorts by
  -- this column.
  "occurredAt"        TIMESTAMP(3) NOT NULL,
  -- Normalized event code (carriers each have their own taxonomy; the
  -- webhook handler maps down to ours so the UI doesn't care which
  -- carrier the scan came from). Documented values:
  --   ANNOUNCED | PICKED_UP | IN_TRANSIT | OUT_FOR_DELIVERY |
  --   DELIVERED | DELIVERY_ATTEMPTED | EXCEPTION |
  --   RETURNED_TO_SENDER | CANCELLED | INFO
  "code"              TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "location"          TEXT,
  -- Provenance — SENDCLOUD | AMAZON | EBAY_MFP | MANUAL.
  "source"            TEXT NOT NULL,
  -- Original carrier code/payload kept for audit + future taxonomy
  -- refinements. Read-only after insert.
  "carrierRawCode"    TEXT,
  "carrierRawPayload" JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrackingEvent_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "TrackingEvent_shipmentId_occurredAt_idx"
  ON "TrackingEvent"("shipmentId", "occurredAt");
CREATE INDEX IF NOT EXISTS "TrackingEvent_code_occurredAt_idx"
  ON "TrackingEvent"("code", "occurredAt");
CREATE INDEX IF NOT EXISTS "TrackingEvent_occurredAt_idx"
  ON "TrackingEvent"("occurredAt");

-- ── TrackingMessageLog ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TrackingMessageLog" (
  "id"                TEXT PRIMARY KEY,
  "shipmentId"        TEXT NOT NULL,
  "channel"           "OrderChannel" NOT NULL,
  -- nullable for channels with no per-marketplace split (Shopify, Woo).
  "marketplace"       TEXT,
  "status"            "TrackingMessageStatus" NOT NULL DEFAULT 'PENDING',
  -- Retry state. Default maxAttempts = 8 → ≈26h of exponential backoff
  -- (5min × 2^n, capped at 12h per attempt) before DEAD_LETTER.
  "attemptCount"      INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"       INTEGER NOT NULL DEFAULT 8,
  "nextAttemptAt"     TIMESTAMP(3),
  "lastAttemptedAt"   TIMESTAMP(3),
  -- Most-recent failure only. Full per-attempt history would balloon
  -- this table; if richer audit is needed, add an Attempt sub-table
  -- later. lastErrorCode is the channel's response code (Amazon
  -- "InvalidParameterValue", HTTP 429, etc.).
  "lastError"         TEXT,
  "lastErrorCode"     TEXT,
  "requestPayload"    JSONB NOT NULL,
  "responsePayload"   JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrackingMessageLog_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE
);
-- Retry job's primary read:
--   WHERE status = 'PENDING' AND nextAttemptAt <= NOW()
--   ORDER BY nextAttemptAt ASC
CREATE INDEX IF NOT EXISTS "TrackingMessageLog_status_nextAttemptAt_idx"
  ON "TrackingMessageLog"("status", "nextAttemptAt");
-- Per-shipment lookup for the drawer pill + manual replay.
CREATE INDEX IF NOT EXISTS "TrackingMessageLog_shipmentId_channel_idx"
  ON "TrackingMessageLog"("shipmentId", "channel");
-- DLQ inspection.
CREATE INDEX IF NOT EXISTS "TrackingMessageLog_status_createdAt_idx"
  ON "TrackingMessageLog"("status", "createdAt");
