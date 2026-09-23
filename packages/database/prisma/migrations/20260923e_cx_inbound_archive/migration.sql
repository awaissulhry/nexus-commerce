-- D8: receipt identity and verification survive retention, duplicates and profile changes.
CREATE OR REPLACE FUNCTION nexus_retain_inbound_history() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Inbound delivery history must be archived, never deleted or truncated' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS nexus_retain_inbound_history ON "WebhookEvent";
CREATE TRIGGER nexus_retain_inbound_history BEFORE DELETE OR TRUNCATE ON "WebhookEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_retain_inbound_history();
REVOKE DELETE, TRUNCATE ON "WebhookEvent" FROM nexus_workspace_runtime;

DROP TRIGGER IF EXISTS nexus_retain_inbound_history ON "EbayNoticeQuarantine";
CREATE TRIGGER nexus_retain_inbound_history BEFORE DELETE OR TRUNCATE ON "EbayNoticeQuarantine"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_retain_inbound_history();
REVOKE DELETE, TRUNCATE ON "EbayNoticeQuarantine" FROM nexus_workspace_runtime;

CREATE INDEX IF NOT EXISTS "WebhookEvent_archive_candidates_idx"
  ON "WebhookEvent" ("workspaceId", "processedAt", id)
  WHERE status='done' AND "isProcessed"=true AND "processedAt" IS NOT NULL
    AND "archivedAt" IS NULL AND "nextAttemptAt" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL;
