-- Phase H — Privacy, consent, retention, exports.
--
-- Three new tables, no existing-column changes. All FKs to
-- UserProfile use ON DELETE SET NULL so deleting a user (when
-- Phase I lands a real delete flow) keeps the audit trail intact.

-- ── ConsentRecord ──────────────────────────────────────────────
CREATE TABLE "ConsentRecord" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT,
  "kind"      TEXT NOT NULL,
  "version"   TEXT NOT NULL,
  "accepted"  BOOLEAN NOT NULL,
  "ip"        TEXT,
  "userAgent" TEXT,
  "metadata"  JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConsentRecord_userId_idx" ON "ConsentRecord"("userId");
CREATE INDEX "ConsentRecord_userId_kind_idx"
  ON "ConsentRecord"("userId", "kind");
CREATE INDEX "ConsentRecord_createdAt_idx" ON "ConsentRecord"("createdAt");
ALTER TABLE "ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── DataRetentionPolicy (single row) ─────────────────────────
CREATE TABLE "DataRetentionPolicy" (
  "id"        TEXT NOT NULL,
  "policies"  JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataRetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- ── DataExportRequest ────────────────────────────────────────
CREATE TABLE "DataExportRequest" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT,
  "status"      TEXT NOT NULL DEFAULT 'QUEUED',
  "format"      TEXT NOT NULL DEFAULT 'json',
  "scope"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "downloadUrl" TEXT,
  "expiresAt"   TIMESTAMP(3),
  "bytes"       INTEGER,
  "error"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "DataExportRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DataExportRequest_userId_idx" ON "DataExportRequest"("userId");
CREATE INDEX "DataExportRequest_userId_status_idx"
  ON "DataExportRequest"("userId", "status");
CREATE INDEX "DataExportRequest_createdAt_idx"
  ON "DataExportRequest"("createdAt");
ALTER TABLE "DataExportRequest"
  ADD CONSTRAINT "DataExportRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
