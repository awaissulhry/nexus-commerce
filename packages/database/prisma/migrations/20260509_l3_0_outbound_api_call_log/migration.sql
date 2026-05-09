-- L.3.0 — Outbound API call observability.
--
-- Captures one row per outbound HTTP call to a channel API
-- (Amazon SP-API, eBay REST, Shopify Admin, etc.) so operators
-- can diagnose:
--   - Did the call happen?
--   - How long did it take? (p50/p95/p99 by operation × channel)
--   - What status code came back?
--   - If failed, what was the error code + message?
--   - Are we hitting throttle limits?
--
-- Pre-this table, Amazon + eBay had no per-call observability —
-- diagnosing an outage meant SSH-ing into Railway and tailing
-- logger output. This unblocks the /sync-logs hub's API-call view.
--
-- Volume: 2 channels × ~10 distinct operations × 15-min cadence
-- ≈ 200 calls/hr ≈ 1.7M/yr. Indexes cover the hot query paths;
-- retention cron (planned L.x) will trim to a 30-day rolling
-- window before storage becomes a concern.

CREATE TABLE IF NOT EXISTS "OutboundApiCallLog" (
  "id"              TEXT NOT NULL,

  -- What channel + which marketplace.
  "channel"         TEXT NOT NULL,
  "marketplace"     TEXT,
  "connectionId"    TEXT,

  -- What was called.
  "operation"       TEXT NOT NULL,
  "endpoint"        TEXT,
  "method"          TEXT,

  -- What happened.
  "statusCode"      INTEGER,
  "success"         BOOLEAN NOT NULL,
  "latencyMs"       INTEGER NOT NULL,

  -- Error detail when success=false.
  "errorMessage"    TEXT,
  "errorCode"       TEXT,
  "errorType"       TEXT,

  -- Correlation.
  "requestId"       TEXT,
  "triggeredBy"     TEXT NOT NULL DEFAULT 'api',

  -- Optional payloads (writers should slim or skip on success).
  "requestPayload"  JSONB,
  "responsePayload" JSONB,

  -- Optional entity correlation.
  "productId"       TEXT,
  "listingId"       TEXT,
  "orderId"         TEXT,

  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutboundApiCallLog_pkey" PRIMARY KEY ("id")
);

-- Hot query paths.
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_channel_createdAt_idx"
  ON "OutboundApiCallLog"("channel", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_createdAt_idx"
  ON "OutboundApiCallLog"("createdAt");
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_success_createdAt_idx"
  ON "OutboundApiCallLog"("success", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_operation_createdAt_idx"
  ON "OutboundApiCallLog"("operation", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_statusCode_createdAt_idx"
  ON "OutboundApiCallLog"("statusCode", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_requestId_idx"
  ON "OutboundApiCallLog"("requestId");
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_productId_idx"
  ON "OutboundApiCallLog"("productId");
