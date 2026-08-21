-- SG.5 — account default ACoS target for bid_apply's targetAcos ops (INTEGER percent).
-- Additive; old code ignores the column.
ALTER TABLE "AdsAutomationState" ADD COLUMN "defaultTargetAcosPct" INTEGER;
