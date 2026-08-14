-- CAP — the second cap, in the unit damage is actually measured in.
--
-- Purely additive: one nullable column and one index. Nothing altered, nothing dropped, and every
-- existing row keeps today's behaviour because NULL means "no write cap".
--
-- `maxExecutionsPerDay` counts EXECUTION ROWS, and a row is one (rule x context) match. One
-- evaluator tick emits one context per active marketplace -- 9 on this account -- so a SCHEDULE
-- rule doing one logical run per tick writes 9 rows and 864 in a day. Measured 2026-08-14:
-- "Trim budget on weak ACOS" walked a campaign from EUR 100.00 to EUR 1.00 in 39 Amazon writes in
-- a single day while carrying a row cap of 10, because its trigger matched about once per tick and
-- its row count and write count were never the same quantity.
ALTER TABLE "AutomationRule" ADD COLUMN "maxWritesPerDay" INTEGER;

-- The write cap counts AdvertisingActionLog by ACTOR ('automation:<ruleId>'), once per rule
-- evaluation. It cannot use "executionId": automation-action-handlers.ts passes NULL on every rule
-- write (97 rows in 60 days carry one, against 36,219 by actor), so an executionId-keyed cap would
-- read zero for every rule and never bind.
CREATE INDEX "AdvertisingActionLog_userId_createdAt_idx"
  ON "AdvertisingActionLog"("userId", "createdAt" DESC);
