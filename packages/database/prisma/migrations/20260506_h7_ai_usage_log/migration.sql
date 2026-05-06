-- =====================================================================
-- H.7: AI provider usage + cost ledger
--
-- Every server-side LLM call writes one AiUsageLog row so the
-- settings page can show 7-day token + spend totals per provider,
-- and so we have a correlation log when a user reports "my AI fill
-- returned garbage" — the row carries entityType/entityId of the
-- product the call was for.
--
-- Cost is committed at write time against the provider's RATE_CARD
-- (see apps/api/src/services/ai/providers/{gemini,anthropic}.provider.ts).
-- We do NOT recompute historical rows when vendors change pricing;
-- the value here is what was billable at the moment of the call.
--
-- Indexes:
--   - (provider, createdAt) — settings page 7-day-by-provider rollup
--   - (feature, createdAt)  — group spend by user-facing surface
--   - (entityType, entityId) — "show me every AI call against
--     product X" for the activity timeline
--   - (userId, createdAt) — per-user spend caps in a future commit
--   - (createdAt) — pruning old rows past retention
-- =====================================================================

CREATE TABLE "AiUsageLog" (
  "id"           TEXT PRIMARY KEY,
  "provider"     TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "feature"      TEXT,
  "entityType"   TEXT,
  "entityId"     TEXT,
  "inputTokens"  INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costUSD"      DECIMAL(12,6) NOT NULL DEFAULT 0,
  "metadata"     JSONB,
  "latencyMs"    INTEGER,
  "ok"           BOOLEAN NOT NULL DEFAULT TRUE,
  "errorCode"    TEXT,
  "errorMessage" TEXT,
  "userId"       TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AiUsageLog_provider_createdAt_idx"
  ON "AiUsageLog" ("provider", "createdAt");
CREATE INDEX "AiUsageLog_feature_createdAt_idx"
  ON "AiUsageLog" ("feature", "createdAt");
CREATE INDEX "AiUsageLog_entityType_entityId_idx"
  ON "AiUsageLog" ("entityType", "entityId");
CREATE INDEX "AiUsageLog_userId_createdAt_idx"
  ON "AiUsageLog" ("userId", "createdAt");
CREATE INDEX "AiUsageLog_createdAt_idx"
  ON "AiUsageLog" ("createdAt");
