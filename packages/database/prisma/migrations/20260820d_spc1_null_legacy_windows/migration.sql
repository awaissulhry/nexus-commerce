-- SPC.1 — retire the three fabricated zeros. The one non-additive step in the
-- whole SPC programme, and the reason it is a migration of its own.
--
-- `sales1dCents`, `sales14dCents` and `sales30dCents` were declared `@default(0)`
-- and never written, so every row reads 0 — and 0 is ALSO the right answer for a
-- campaign-day that sold nothing in that window. Once SPC.1 starts requesting the
-- real figures, the two become indistinguishable on exactly the rows that can never
-- be filled: 1,092 campaign rows and 6,995 product-ad rows predate Amazon's 95-day
-- retention wall (2026-05-17) and are permanently unreachable.
--
-- Measured immediately before writing this, on 2026-08-20: each of the three
-- columns holds exactly ONE distinct value across all 50,141 rows — `0`. By
-- contrast `sales7dCents`, which IS requested, holds 59 distinct values up to
-- 35,296. So this destroys no information; it replaces a known-meaningless
-- constant with the absence it always was.
--
-- 🔴 ORDERING MATTERS. This must not run before the widened ingest is deployed.
-- The old `ingestCampaignRows` writes a hard `sales14dCents: 0` for every
-- Sponsored Products row, so running this against the old code would have tonight's
-- cron re-zero every row it touches — a half-nulled column, which is worse than
-- either state. Prisma applies migrations in name order and this sorts after
-- 20260820c, so a single deploy applies the columns and this together with the code
-- that maintains them.
--
-- Scoped to rows written before the widened ingest existed. Anything the new code
-- has already touched carries a real value or a real NULL and must be left alone.

UPDATE "AmazonAdsDailyPerformance"
   SET "sales1dCents"  = NULL,
       "sales14dCents" = NULL,
       "sales30dCents" = NULL
 WHERE ("sales1dCents" = 0 OR "sales14dCents" = 0 OR "sales30dCents" = 0)
   AND "reportedAt" < TIMESTAMP '2026-08-20 00:00:00';
