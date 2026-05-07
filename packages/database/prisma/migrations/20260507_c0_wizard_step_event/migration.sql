-- C.0 — WizardStepEvent telemetry table.
--
-- Append-only step-level events for the listing wizard. Distinct
-- from AuditLog (which records mutations on the wizard row); this
-- records UX events for drop-off analytics + per-step iteration.
--
-- Privacy is enforced at the writer (apps/api/src/services/
-- wizard-telemetry.ts) via a key allowlist + 80-char value cap +
-- PII regex guard. The schema itself is intentionally permissive
-- so future event types don't require migrations.

CREATE TABLE "WizardStepEvent" (
    "id" TEXT NOT NULL,
    "wizardId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorContext" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WizardStepEvent_pkey" PRIMARY KEY ("id")
);

-- Hot lookup paths.
CREATE INDEX "WizardStepEvent_wizardId_createdAt_idx"
    ON "WizardStepEvent"("wizardId", "createdAt");
CREATE INDEX "WizardStepEvent_productId_createdAt_idx"
    ON "WizardStepEvent"("productId", "createdAt");
CREATE INDEX "WizardStepEvent_type_step_createdAt_idx"
    ON "WizardStepEvent"("type", "step", "createdAt");
-- A12 — analytics path: "top errors over the last N days".
CREATE INDEX "WizardStepEvent_errorCode_createdAt_idx"
    ON "WizardStepEvent"("errorCode", "createdAt");
CREATE INDEX "WizardStepEvent_createdAt_idx"
    ON "WizardStepEvent"("createdAt");

-- A11 — defense-in-depth: schema-level allowlist on event type and
-- step range. Application writers (telemetry.service.ts) enforce
-- the same allowlist, but a direct INSERT from psql or a future
-- migration that bypasses the writer can't introduce off-vocabulary
-- rows. Prisma can't model CHECK constraints in schema.prisma so
-- they live as raw SQL and survive only if the migrations directory
-- isn't reset. New event types require a new migration that drops
-- and recreates this constraint.
ALTER TABLE "WizardStepEvent"
    ADD CONSTRAINT "WizardStepEvent_type_check"
    CHECK ("type" IN (
        'step_entered',
        'step_exited',
        'validation_failed',
        'validation_passed',
        'error_shown',
        'jumped_to_step',
        'submit_completed',
        'submit_failed',
        'wizard_started',
        'wizard_resumed',
        'wizard_discarded',
        'wizard_abandoned'
    ));

ALTER TABLE "WizardStepEvent"
    ADD CONSTRAINT "WizardStepEvent_step_check"
    CHECK ("step" >= 1 AND "step" <= 9);

-- Cascade delete: when a wizard or product disappears, its
-- step-event trail goes with it. ListingWizard.expiresAt cron
-- already cleans up DRAFT wizards >30d old; this keeps the
-- analytics table from accumulating orphans.
ALTER TABLE "WizardStepEvent"
    ADD CONSTRAINT "WizardStepEvent_wizardId_fkey"
    FOREIGN KEY ("wizardId") REFERENCES "ListingWizard"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WizardStepEvent"
    ADD CONSTRAINT "WizardStepEvent_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
