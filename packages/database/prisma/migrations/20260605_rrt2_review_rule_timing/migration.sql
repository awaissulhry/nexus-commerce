-- RRT.2 — ReviewRule send-timing columns + zero-drift backfill. Fully additive.

ALTER TABLE "ReviewRule" ADD COLUMN "productTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ReviewRule" ADD COLUMN "sendDelayDays" INTEGER;
ALTER TABLE "ReviewRule" ADD COLUMN "anchor" TEXT NOT NULL DEFAULT 'DELIVERY';
ALTER TABLE "ReviewRule" ADD COLUMN "sendHourLocal" INTEGER;
ALTER TABLE "ReviewRule" ADD COLUMN "skipWeekends" BOOLEAN NOT NULL DEFAULT false;

-- Zero-drift: reproduce today's `deliveredAt + max(4, minDaysSinceDelivery)` send
-- delay exactly for every pre-existing rule. minDaysSinceDelivery is already
-- write-clamped to >= 4, so sendDelayDays = minDaysSinceDelivery == max(4, min).
-- The new ReviewTimingDefault table governs only no-rule orders and rules the
-- operator later switches to "use baseline" (clears the override).
UPDATE "ReviewRule" SET "sendDelayDays" = "minDaysSinceDelivery" WHERE "sendDelayDays" IS NULL;
