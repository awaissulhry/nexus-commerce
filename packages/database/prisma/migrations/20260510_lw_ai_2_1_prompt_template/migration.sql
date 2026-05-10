-- AI-2.1 (list-wizard) — prompts as data.
--
-- Lifts the four hardcoded LLM prompts out of
-- apps/api/src/services/ai/listing-content.service.ts so they can be
-- A/B-tested + revised without redeploying the API. Subsequent
-- AI-2.x commits seed the four current prompts, wire the matcher
-- into ListingContentService, and surface admin UI on /settings/ai.
--
-- Lifecycle: DRAFT / ACTIVE / ARCHIVED. The matcher (lands in AI-2.2)
-- will prefer the most-specific scope (language && marketplace) → ...
-- → (null) so per-IT prompts override the global default.

CREATE TABLE "PromptTemplate" (
  "id"          TEXT PRIMARY KEY,
  "feature"     TEXT NOT NULL,
  "name"        TEXT NOT NULL DEFAULT 'default',
  "description" TEXT,
  "body"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'DRAFT',
  "version"     INTEGER NOT NULL DEFAULT 1,
  "language"    TEXT,
  "marketplace" TEXT,
  "callCount"   INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdBy"   TEXT
);

CREATE INDEX "PromptTemplate_feature_status_idx"
  ON "PromptTemplate"("feature", "status");
CREATE INDEX "PromptTemplate_status_idx" ON "PromptTemplate"("status");
