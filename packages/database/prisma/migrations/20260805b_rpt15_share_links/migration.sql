-- RPT.15 — read-only, expiring share links for a single report result.
--
-- Only the SHA-256 hash of the token is stored, never the token itself: a
-- database disclosure must not hand out working links. The raw token is
-- returned once, at creation, and is unrecoverable afterwards.
--
-- `query` is frozen at creation and is the only query the public endpoint will
-- run. The endpoint takes no filter/grouping/column input from the caller —
-- otherwise one leaked link becomes an unauthenticated query interface over the
-- whole reporting engine.
--
-- Additive: one new table, no change to any existing one.

CREATE TABLE IF NOT EXISTS "ReportShareLink" (
    "id"           TEXT         NOT NULL,
    "tokenHash"    TEXT         NOT NULL,
    "reportId"     TEXT         NOT NULL,
    "query"        JSONB        NOT NULL,
    "label"        TEXT,
    "createdBy"    TEXT         NOT NULL DEFAULT 'default-user',
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "revokedAt"    TIMESTAMP(3),
    "viewCount"    INTEGER      NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportShareLink_pkey" PRIMARY KEY ("id")
);

-- Unique because the hash is the lookup key for every public read.
CREATE UNIQUE INDEX IF NOT EXISTS "ReportShareLink_tokenHash_key"
    ON "ReportShareLink" ("tokenHash");

CREATE INDEX IF NOT EXISTS "ReportShareLink_createdBy_createdAt_idx"
    ON "ReportShareLink" ("createdBy", "createdAt");

-- Supports sweeping expired links without scanning the table.
CREATE INDEX IF NOT EXISTS "ReportShareLink_expiresAt_idx"
    ON "ReportShareLink" ("expiresAt");
