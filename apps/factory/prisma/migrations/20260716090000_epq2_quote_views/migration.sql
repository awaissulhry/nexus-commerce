-- EPQ.2 — view tracking + follow-up engine columns. Additive only; authored
-- from `prisma migrate diff` output but hand-shaped to plain ADD COLUMNs (the
-- diff proposed a full Quote table rebuild, which takes a long write lock and
-- re-creates FK targets — needless risk while the Owner's server runs; the
-- end state is byte-identical, verified with `migrate diff --exit-code`).
-- NOT applied here — the merging session runs `prisma migrate dev` after the
-- Owner's dev server is restarted, per PLAYBOOK trap 6b.

-- AlterTable (EPQ.2 — public-page view counters)
ALTER TABLE "Quote" ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN "firstViewedAt" DATETIME;
ALTER TABLE "Quote" ADD COLUMN "lastViewedAt" DATETIME;

-- AlterTable (EPQ.2 — follow-up engine: nudge + due-rule flag/snooze clock)
ALTER TABLE "Quote" ADD COLUMN "lastNudgeAt" DATETIME;
ALTER TABLE "Quote" ADD COLUMN "followUpRule" TEXT;
ALTER TABLE "Quote" ADD COLUMN "followUpFlaggedAt" DATETIME;

-- CreateTable (EPQ.2 — one row per public-page open; ipHash = sha256(ip))
CREATE TABLE "QuoteViewEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "ua" TEXT,
    CONSTRAINT "QuoteViewEvent_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QuoteViewEvent_quoteId_at_idx" ON "QuoteViewEvent"("quoteId", "at");
