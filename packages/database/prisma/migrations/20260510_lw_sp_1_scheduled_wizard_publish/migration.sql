-- SP.1 (list-wizard) — scheduled wizard publish.
--
-- Operator picks a future date/time on Step 9 Submit instead of
-- clicking Submit immediately. Cron picks PENDING rows where
-- scheduledFor <= now and fires the same orchestrator path /submit
-- hits.

CREATE TABLE "ScheduledWizardPublish" (
  "id"           TEXT PRIMARY KEY,
  "wizardId"     TEXT NOT NULL REFERENCES "ListingWizard"("id") ON DELETE CASCADE,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "firedAt"      TIMESTAMP(3),
  "cancelledAt"  TIMESTAMP(3),
  "fireResult"   JSONB,
  "fireError"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "createdBy"    TEXT
);

-- Cron picker — composite (status, scheduledFor) keeps the WHERE
-- clause covered by a single index lookup.
CREATE INDEX "ScheduledWizardPublish_status_scheduledFor_idx"
  ON "ScheduledWizardPublish"("status", "scheduledFor");

-- Per-wizard list — operators viewing a single wizard's history.
CREATE INDEX "ScheduledWizardPublish_wizardId_idx"
  ON "ScheduledWizardPublish"("wizardId");
