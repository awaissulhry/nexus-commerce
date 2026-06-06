-- STO.6 — per-rule "shift to best nearby day" toggle
ALTER TABLE "ReviewRule" ADD COLUMN IF NOT EXISTS "shiftToBestDay" BOOLEAN NOT NULL DEFAULT false;
