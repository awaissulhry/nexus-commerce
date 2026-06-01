-- AU.3 — hourly bid dayparting: bid multiplier per window + original bid snapshot.
-- Additive nullable columns; existing schedules keep working unchanged.
ALTER TABLE "AdSchedule"
  ADD COLUMN IF NOT EXISTS "originalBids" JSONB;
