-- STO.2 — per-weekday send-time optimization windows
CREATE TABLE IF NOT EXISTS "ReviewSendWindow" (
  "id"          TEXT NOT NULL,
  "marketplace" TEXT NOT NULL DEFAULT '*',
  "dayOfWeek"   INTEGER NOT NULL,
  "hourLocal"   INTEGER NOT NULL,
  "dayRank"     INTEGER NOT NULL DEFAULT 0,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewSendWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReviewSendWindow_marketplace_dayOfWeek_key"
  ON "ReviewSendWindow"("marketplace", "dayOfWeek");
CREATE INDEX IF NOT EXISTS "ReviewSendWindow_marketplace_isActive_idx"
  ON "ReviewSendWindow"("marketplace", "isActive");

-- Seed the global default pattern (research-based starting points; fully editable
-- in the UI). Evenings on weekdays (people check their personal phone/email after
-- work), late mornings on weekends (leisure browsing). Hours are in the buyer's
-- local timezone. dayRank (lower = better) ranks the weekday for STO.6
-- shift-to-best-day: Tue/Wed best, weekends next, Mon/Fri worst.
INSERT INTO "ReviewSendWindow"
  ("id","marketplace","dayOfWeek","hourLocal","dayRank","isActive","updatedAt") VALUES
  ('rsw_glob_0','*',0,11,2,true,CURRENT_TIMESTAMP),
  ('rsw_glob_1','*',1,19,6,true,CURRENT_TIMESTAMP),
  ('rsw_glob_2','*',2,19,1,true,CURRENT_TIMESTAMP),
  ('rsw_glob_3','*',3,19,1,true,CURRENT_TIMESTAMP),
  ('rsw_glob_4','*',4,19,3,true,CURRENT_TIMESTAMP),
  ('rsw_glob_5','*',5,18,7,true,CURRENT_TIMESTAMP),
  ('rsw_glob_6','*',6,11,2,true,CURRENT_TIMESTAMP)
ON CONFLICT ("marketplace","dayOfWeek") DO NOTHING;
