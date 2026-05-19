-- CreateTable: FlatFilePullJob
-- Phase 5 of the in-editor Pull from Amazon / eBay feature. Persists
-- each job so a browser refresh or server restart doesn't lose an
-- in-flight pull. Dual-written alongside the existing in-memory queue
-- — DB acts as the recovery surface, in-memory is the fast path.

CREATE TABLE "FlatFilePullJob" (
    "id"            TEXT NOT NULL,
    "channel"       TEXT NOT NULL,
    "marketplace"   TEXT NOT NULL,
    "productType"   TEXT,
    "skus"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status"        TEXT NOT NULL DEFAULT 'running',
    "progress"      INTEGER NOT NULL DEFAULT 0,
    "total"         INTEGER NOT NULL DEFAULT 0,
    "pulled"        INTEGER NOT NULL DEFAULT 0,
    "skipped"       INTEGER NOT NULL DEFAULT 0,
    "failed"        INTEGER NOT NULL DEFAULT 0,
    "errors"        JSONB NOT NULL DEFAULT '[]'::JSONB,
    "rows"          JSONB NOT NULL DEFAULT '[]'::JSONB,
    "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt"        TIMESTAMP(3),
    "fatalError"    TEXT,

    CONSTRAINT "FlatFilePullJob_pkey" PRIMARY KEY ("id")
);

-- Composite index: drives "is there an in-flight job for this editor?"
-- lookups on mount, plus admin filtering by status.
CREATE INDEX "FlatFilePullJob_channel_marketplace_status_idx"
    ON "FlatFilePullJob"("channel", "marketplace", "status");

-- Secondary index for ordered scans (admin views, retention cleanup).
CREATE INDEX "FlatFilePullJob_startedAt_idx"
    ON "FlatFilePullJob"("startedAt");
