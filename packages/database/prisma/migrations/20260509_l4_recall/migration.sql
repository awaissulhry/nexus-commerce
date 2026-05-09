-- L.4 — Lot recall workflow.
--
-- Per EU GPSR, when a supplier issues a recall, Xavia needs to:
--   1. Mark the affected lot as recalled so remaining sellable units
--      stop being allocated by FEFO consume.
--   2. Enumerate which orders shipped affected units (forward trace).
--   3. Track the recall lifecycle (open → closed) for audit.
--
-- One row per (lot × recall instance). A lot can have multiple
-- historical recalls (rare but possible — e.g., same batch flagged
-- for two separate defects). At most one recall is OPEN per lot at
-- any time, enforced via partial unique index.

CREATE TABLE "LotRecall" (
  "id"        TEXT PRIMARY KEY,
  "lotId"     TEXT NOT NULL,
  "reason"    TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'OPEN',
  "openedAt"  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedBy"  TEXT,
  "closedAt"  TIMESTAMP,
  "closedBy"  TEXT,
  "notes"     TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LotRecall_status_valid" CHECK ("status" IN ('OPEN', 'CLOSED'))
);

ALTER TABLE "LotRecall"
  ADD CONSTRAINT "LotRecall_lotId_fkey"
  FOREIGN KEY ("lotId") REFERENCES "Lot"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LotRecall_lotId_idx" ON "LotRecall"("lotId");
CREATE INDEX "LotRecall_status_idx" ON "LotRecall"("status");

-- At most one OPEN recall per lot at any time. Closed recalls don't
-- count, so a lot can have an unlimited audit history but only one
-- active issue.
CREATE UNIQUE INDEX "LotRecall_one_open_per_lot"
  ON "LotRecall"("lotId")
  WHERE "status" = 'OPEN';
