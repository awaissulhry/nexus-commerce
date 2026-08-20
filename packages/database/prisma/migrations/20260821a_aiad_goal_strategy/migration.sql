-- AIAD.4 — per-goal strategy dials (additive): Target ACoS + bid band, read into the
-- AutopilotPlan guardrails at materialization. NULL = conductor defaults.
ALTER TABLE "AdProductGoal" ADD COLUMN "targetAcosPct" INTEGER;
ALTER TABLE "AdProductGoal" ADD COLUMN "bidMinCents" INTEGER;
ALTER TABLE "AdProductGoal" ADD COLUMN "bidMaxCents" INTEGER;
