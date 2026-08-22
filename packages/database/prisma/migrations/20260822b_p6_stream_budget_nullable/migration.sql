-- ADM-P6/B2 — the AMS budget-usage stream becomes a second producer for this table, and its
-- record shape is unverified (no record has ever arrived). If it carries no budget amount, the
-- reading is still worth keeping: the PERCENTAGE is the measurement. A fabricated 0 denominator
-- would be a lie where a NULL is an absence.
-- Non-destructive: relaxing NOT NULL cannot fail on existing rows and drops no data.
ALTER TABLE "AdBudgetUsageSample" ALTER COLUMN "budgetCents" DROP NOT NULL;
