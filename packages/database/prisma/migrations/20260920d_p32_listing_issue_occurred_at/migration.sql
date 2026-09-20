-- P3.2 — the "as-of time" the plan row asks for.
--
-- lastSeenAt says when WE last saw the issue. occurredAt says when the CHANNEL says it
-- was true, where those differ: a JSON_LISTINGS_FEED that completed at 03:00 and was
-- reconciled by the poll cron at 04:00 is as of 03:00, and an operator judging whether
-- their fix landed needs the former.
--
-- Additive and nullable: every existing row keeps meaning exactly what it meant.
ALTER TABLE "ListingIssue" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);
