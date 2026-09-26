CREATE TABLE "EbayNoticeQuarantine" (
  "id" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "signatureOk" BOOLEAN NOT NULL DEFAULT false,
  "externalId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "subjectHash" TEXT,
  "firstOwnerWorkspaceId" TEXT,
  "payloadEnc" TEXT,
  "payloadKeyId" TEXT,
  "payloadDigest" TEXT NOT NULL,
  "verificationKeyId" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveries" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT NOT NULL,
  "resolvedWorkspaceId" TEXT,
  "resolvedReceiptId" TEXT,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "EbayNoticeQuarantine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EbayNoticeQuarantine_environment_check" CHECK ("environment" IN ('production','sandbox')),
  CONSTRAINT "EbayNoticeQuarantine_digest_check" CHECK ("payloadDigest" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "EbayNoticeQuarantine_environment_signatureOk_externalId_key" ON "EbayNoticeQuarantine"("environment","signatureOk","externalId");
CREATE UNIQUE INDEX "EbayNoticeQuarantine_resolvedReceiptId_key" ON "EbayNoticeQuarantine"("resolvedReceiptId");
CREATE INDEX "EbayNoticeQuarantine_subjectHash_receivedAt_idx" ON "EbayNoticeQuarantine"("subjectHash","receivedAt");
CREATE INDEX "EbayNoticeQuarantine_firstOwnerWorkspaceId_resolvedAt_idx" ON "EbayNoticeQuarantine"("firstOwnerWorkspaceId","resolvedAt");
GRANT SELECT, INSERT ON "EbayNoticeQuarantine" TO nexus_workspace_runtime;

ALTER TABLE "EbayNoticeQuarantine" ADD CONSTRAINT "EbayNoticeQuarantine_resolvedReceiptId_fkey" FOREIGN KEY ("resolvedReceiptId") REFERENCES "WebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "WebhookEvent_channel_externalId_idx" ON "WebhookEvent"("channel","externalId");

-- Unassigned provider data is application-scoped, never a default business's payload.
ALTER TABLE "EbayNoticeQuarantine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EbayNoticeQuarantine" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_ebay_quarantine_system ON "EbayNoticeQuarantine";
CREATE POLICY nexus_ebay_quarantine_system ON "EbayNoticeQuarantine" FOR ALL TO nexus_workspace_runtime
  USING (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL);
REVOKE DELETE, UPDATE ON "EbayNoticeQuarantine" FROM nexus_workspace_runtime;
GRANT UPDATE ("deliveries", "lastReceivedAt", "resolvedWorkspaceId", "resolvedReceiptId", "resolvedAt")
  ON "EbayNoticeQuarantine" TO nexus_workspace_runtime;

-- FOR SHARE requires UPDATE privilege. Keep the ownership index read-only to the
-- runtime role; this narrow system-only function supplies the lock, never a write.
CREATE OR REPLACE FUNCTION nexus_lock_ebay_notice_owner(notice_environment text, subject_id text)
RETURNS TABLE ("workspaceId" text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NULLIF(current_setting('nexus.actor_id', true), '') IS NOT NULL
    OR notice_environment NOT IN ('production', 'sandbox') THEN
    RAISE EXCEPTION 'This ownership lock is only available to verified ingress' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT o."workspaceId", w.status FROM "ChannelAccountOwnership" o JOIN "Workspace" w ON w.id=o."workspaceId"
    WHERE o."channelType"='EBAY' AND o.environment=notice_environment AND o."externalAccountId"=subject_id FOR SHARE OF o;
END $$;
REVOKE ALL ON FUNCTION nexus_lock_ebay_notice_owner(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_lock_ebay_notice_owner(text, text) TO nexus_workspace_runtime;

-- Remember known-first delivery ownership even when a retry changes/omits its
-- subject. Return metadata only; tenant callers cannot enumerate other profiles.
CREATE OR REPLACE FUNCTION nexus_ebay_notice_workspace(notice_environment text, notice_id text)
RETURNS TABLE ("workspaceId" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NULLIF(current_setting('nexus.actor_id', true), '') IS NOT NULL
    OR notice_environment NOT IN ('production', 'sandbox') THEN
    RAISE EXCEPTION 'Delivery lookup is only available to verified ingress' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT e."workspaceId" FROM "WebhookEvent" e
    WHERE e.channel='EBAY' AND e."externalId"='ebay:' || notice_environment || ':' || notice_id
      AND e."signatureOk"=true AND e."verifiedBy"='ebay_ecdsa' LIMIT 2;
END $$;
REVOKE ALL ON FUNCTION nexus_ebay_notice_workspace(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_ebay_notice_workspace(text, text) TO nexus_workspace_runtime;

CREATE OR REPLACE FUNCTION nexus_ebay_quarantine_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.environment NOT IN ('production', 'sandbox') OR NEW."payloadDigest" !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid eBay quarantine environment or digest' USING ERRCODE = '23514';
  END IF;
  IF (NEW."signatureOk" AND (NEW."payloadEnc" IS NULL OR NEW."payloadKeyId" IS NULL))
    OR (NOT NEW."signatureOk" AND (NEW."payloadEnc" IS NOT NULL OR NEW."payloadKeyId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Only verified quarantine may retain an encrypted body' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.environment, NEW."signatureOk", NEW."externalId", NEW.topic, NEW."subjectHash",
      NEW."firstOwnerWorkspaceId", NEW."payloadEnc", NEW."payloadKeyId", NEW."payloadDigest", NEW."verificationKeyId", NEW."receivedAt", NEW.reason)
    IS DISTINCT FROM ROW(OLD.id, OLD.environment, OLD."signatureOk", OLD."externalId", OLD.topic, OLD."subjectHash",
      OLD."firstOwnerWorkspaceId", OLD."payloadEnc", OLD."payloadKeyId", OLD."payloadDigest", OLD."verificationKeyId", OLD."receivedAt", OLD.reason) THEN
    RAISE EXCEPTION 'The original eBay quarantine receipt and proof are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."resolvedReceiptId" IS NOT NULL AND
    ROW(NEW."resolvedWorkspaceId", NEW."resolvedReceiptId", NEW."resolvedAt") IS DISTINCT FROM
    ROW(OLD."resolvedWorkspaceId", OLD."resolvedReceiptId", OLD."resolvedAt") THEN
    RAISE EXCEPTION 'A quarantined eBay notice cannot be routed again' USING ERRCODE = '23514';
  END IF;
  IF NEW."deliveries" < 1 OR (TG_OP = 'UPDATE' AND NEW."deliveries" < OLD."deliveries") THEN
    RAISE EXCEPTION 'Delivery history cannot be reduced' USING ERRCODE = '23514';
  END IF;
  IF (NEW."resolvedReceiptId" IS NULL) <> (NEW."resolvedWorkspaceId" IS NULL)
      OR (NEW."resolvedReceiptId" IS NULL) <> (NEW."resolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'A quarantine handoff requires the complete destination pointer' USING ERRCODE = '23514';
  END IF;
  IF NEW."resolvedReceiptId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."resolvedReceiptId" IS NULL) AND NOT EXISTS (
    SELECT 1 FROM "WebhookEvent" e WHERE NEW."signatureOk" = true AND e.id = NEW."resolvedReceiptId" AND e."workspaceId" = NEW."resolvedWorkspaceId"
      AND e.channel = 'EBAY' AND e."eventType" = NEW.topic AND e."signatureOk" = true AND e."verifiedBy" = 'ebay_ecdsa'
      AND e."externalId" = 'ebay:' || NEW.environment || ':' || NEW."externalId"
  ) THEN
    RAISE EXCEPTION 'The quarantine destination must preserve its verified receipt identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nexus_ebay_quarantine ON "EbayNoticeQuarantine";
CREATE TRIGGER nexus_ebay_quarantine BEFORE INSERT OR UPDATE ON "EbayNoticeQuarantine"
  FOR EACH ROW EXECUTE FUNCTION nexus_ebay_quarantine_guard();
