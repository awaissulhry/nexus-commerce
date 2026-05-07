-- C.0 rollback. Forward-only by default; apply manually only if
-- the WizardStepEvent table needs to be removed (writes are
-- fire-and-forget, so dropping is safe — readers tolerate the
-- absence).

DROP TABLE IF EXISTS "WizardStepEvent" CASCADE;
