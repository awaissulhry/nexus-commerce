BEGIN;
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

-- Dedicated operator authority; never granted to the tenant runtime or a login here.
-- Apply transactionally. Migration administrators retain ADMIN, but not SET/INHERIT.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['nexus_ebay_quarantine_writer','nexus_ebay_quarantine_maintenance'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', name);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=name AND
      (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=name))
      OR pg_has_role('nexus_workspace_runtime',name,'MEMBER') THEN
      RAISE EXCEPTION 'Unsafe quarantine maintenance role configuration' USING ERRCODE='42501';
    END IF;
  END LOOP;
END $$;
GRANT nexus_ebay_quarantine_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
GRANT nexus_ebay_quarantine_maintenance TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
GRANT USAGE, CREATE ON SCHEMA public TO nexus_ebay_quarantine_writer;
GRANT USAGE ON SCHEMA public TO nexus_ebay_quarantine_maintenance;

REVOKE ALL ON public."EbayNoticeQuarantine" FROM PUBLIC, nexus_ebay_quarantine_maintenance, nexus_ebay_quarantine_writer;
GRANT SELECT ON public."EbayNoticeQuarantine" TO nexus_ebay_quarantine_writer;
GRANT UPDATE ("payloadEnc", "payloadKeyId") ON public."EbayNoticeQuarantine" TO nexus_ebay_quarantine_writer;
DROP POLICY IF EXISTS nexus_ebay_quarantine_rewrap ON public."EbayNoticeQuarantine";
CREATE POLICY nexus_ebay_quarantine_rewrap ON public."EbayNoticeQuarantine" FOR ALL TO nexus_ebay_quarantine_writer
  USING (true) WITH CHECK (true);

REVOKE ALL ON public."EbayQuarantineMaintenanceAudit" FROM PUBLIC, nexus_workspace_runtime, nexus_ebay_quarantine_maintenance, nexus_ebay_quarantine_writer;
GRANT INSERT ON public."EbayQuarantineMaintenanceAudit" TO nexus_ebay_quarantine_writer;
ALTER TABLE public."EbayQuarantineMaintenanceAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."EbayQuarantineMaintenanceAudit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_ebay_quarantine_audit ON public."EbayQuarantineMaintenanceAudit";
CREATE POLICY nexus_ebay_quarantine_audit ON public."EbayQuarantineMaintenanceAudit" FOR INSERT TO nexus_ebay_quarantine_writer WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.nexus_retain_quarantine_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'Quarantine maintenance audit is append-only' USING ERRCODE='42501';
END $$;
DROP TRIGGER IF EXISTS nexus_retain_quarantine_audit ON public."EbayQuarantineMaintenanceAudit";
CREATE TRIGGER nexus_retain_quarantine_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON public."EbayQuarantineMaintenanceAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION public.nexus_retain_quarantine_audit();

-- No GUC bypass: only the restricted definer identity may replace the two cipher
-- fields, and even it may not change any other original, delivery or routing field.
CREATE OR REPLACE FUNCTION public.nexus_ebay_quarantine_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.environment NOT IN ('production', 'sandbox') OR NEW."payloadDigest" !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid eBay quarantine environment or digest' USING ERRCODE='23514';
  END IF;
  IF (NEW."signatureOk" AND (NEW."payloadEnc" IS NULL OR NEW."payloadKeyId" IS NULL))
    OR (NOT NEW."signatureOk" AND (NEW."payloadEnc" IS NOT NULL OR NEW."payloadKeyId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Only verified quarantine may retain an encrypted body' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND current_user='nexus_ebay_quarantine_writer' THEN
    IF (to_jsonb(NEW) - ARRAY['payloadEnc','payloadKeyId']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['payloadEnc','payloadKeyId']) THEN
      RAISE EXCEPTION 'Maintenance may change only ciphertext and key metadata' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.environment,NEW."signatureOk",NEW."externalId",NEW.topic,NEW."subjectHash",
      NEW."firstOwnerWorkspaceId",NEW."payloadEnc",NEW."payloadKeyId",NEW."payloadDigest",NEW."verificationKeyId",NEW."receivedAt",NEW.reason)
    IS DISTINCT FROM ROW(OLD.id,OLD.environment,OLD."signatureOk",OLD."externalId",OLD.topic,OLD."subjectHash",
      OLD."firstOwnerWorkspaceId",OLD."payloadEnc",OLD."payloadKeyId",OLD."payloadDigest",OLD."verificationKeyId",OLD."receivedAt",OLD.reason) THEN
    RAISE EXCEPTION 'The original eBay quarantine receipt and proof are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD."resolvedReceiptId" IS NOT NULL AND
    ROW(NEW."resolvedWorkspaceId",NEW."resolvedReceiptId",NEW."resolvedAt") IS DISTINCT FROM
    ROW(OLD."resolvedWorkspaceId",OLD."resolvedReceiptId",OLD."resolvedAt") THEN
    RAISE EXCEPTION 'A quarantined eBay notice cannot be routed again' USING ERRCODE='23514';
  END IF;
  IF NEW.deliveries < 1 OR (TG_OP='UPDATE' AND NEW.deliveries < OLD.deliveries) THEN
    RAISE EXCEPTION 'Delivery history cannot be reduced' USING ERRCODE='23514';
  END IF;
  IF (NEW."resolvedReceiptId" IS NULL) <> (NEW."resolvedWorkspaceId" IS NULL)
    OR (NEW."resolvedReceiptId" IS NULL) <> (NEW."resolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'A quarantine handoff requires the complete destination pointer' USING ERRCODE='23514';
  END IF;
  IF NEW."resolvedReceiptId" IS NOT NULL AND (TG_OP='INSERT' OR OLD."resolvedReceiptId" IS NULL) AND NOT EXISTS (
    SELECT 1 FROM public."WebhookEvent" e WHERE NEW."signatureOk"=true AND e.id=NEW."resolvedReceiptId" AND e."workspaceId"=NEW."resolvedWorkspaceId"
      AND e.channel='EBAY' AND e."eventType"=NEW.topic AND e."signatureOk"=true AND e."verifiedBy"='ebay_ecdsa'
      AND e."externalId"='ebay:' || NEW.environment || ':' || NEW."externalId"
  ) THEN
    RAISE EXCEPTION 'The quarantine destination must preserve its verified receipt identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.nexus_rewrap_ebay_quarantine(
  notice_id text, expected_cipher text, expected_key text, expected_digest text,
  replacement_cipher text, target_key text, operation_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed integer;
BEGIN
  IF notice_id IS NULL OR notice_id='' OR expected_cipher IS NULL OR expected_key IS NULL
    OR expected_digest IS NULL OR expected_digest !~ '^[a-f0-9]{64}$' OR operation_id IS NULL
    OR replacement_cipher IS NULL OR octet_length(replacement_cipher)>3145728
    OR replacement_cipher NOT LIKE 'v2:%' OR target_key IS NULL
    OR target_key !~ '^arn:[a-z0-9-]+:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$' THEN
    RAISE EXCEPTION 'Invalid quarantine maintenance request' USING ERRCODE='22023';
  END IF;
  IF replacement_cipher=expected_cipher THEN RETURN false; END IF;
  UPDATE public."EbayNoticeQuarantine" SET "payloadEnc"=replacement_cipher,"payloadKeyId"=target_key
    WHERE id=notice_id AND "signatureOk"=true AND "payloadEnc"=expected_cipher AND "payloadKeyId"=expected_key AND "payloadDigest"=expected_digest;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN RETURN false; END IF;
  INSERT INTO public."EbayQuarantineMaintenanceAudit"
    ("operationId","quarantineId","recordedAt","sessionUser","oldKeyId","newKeyId","oldCipherDigest","newCipherDigest")
    VALUES (operation_id,notice_id,clock_timestamp(),session_user,expected_key,target_key,
      encode(sha256(convert_to(expected_cipher,'UTF8')),'hex'),encode(sha256(convert_to(replacement_cipher,'UTF8')),'hex'));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.nexus_rewrap_ebay_quarantine(text,text,text,text,text,text,uuid) FROM PUBLIC, nexus_workspace_runtime;
GRANT EXECUTE ON FUNCTION public.nexus_rewrap_ebay_quarantine(text,text,text,text,text,text,uuid) TO nexus_ebay_quarantine_maintenance;
ALTER FUNCTION public.nexus_rewrap_ebay_quarantine(text,text,text,text,text,text,uuid) OWNER TO nexus_ebay_quarantine_writer;
-- Global operator inventory returns metadata only, never body, subject or provider ID.
-- Separate initial/range queries keep subsequent pages on the primary-key range.
CREATE OR REPLACE FUNCTION public.nexus_ebay_quarantine_inventory(after_id text, page_limit integer)
RETURNS TABLE (id text,"signatureOk" boolean,"payloadPresent" boolean,"payloadKeyId" text,
  "apparentVersion" text,resolved boolean,"ownerKnown" boolean,"receivedAt" timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF page_limit IS NULL OR page_limit<1 OR page_limit>100 OR length(after_id)>256 THEN
    RAISE EXCEPTION 'Invalid quarantine inventory bounds' USING ERRCODE='22023';
  END IF;
  IF after_id IS NULL THEN
    RETURN QUERY
    SELECT q.id,q."signatureOk",q."payloadEnc" IS NOT NULL,q."payloadKeyId",
      CASE WHEN q."payloadEnc" IS NULL THEN 'none' ELSE CASE substring(q."payloadEnc" from 1 for 3)
        WHEN 'v1:' THEN 'v1' WHEN 'v2:' THEN 'v2' ELSE 'malformed' END END,
      q."resolvedReceiptId" IS NOT NULL,q."firstOwnerWorkspaceId" IS NOT NULL,q."receivedAt" AT TIME ZONE 'UTC'
      FROM public."EbayNoticeQuarantine" q ORDER BY q.id LIMIT page_limit;
  ELSE
    RETURN QUERY
    SELECT q.id,q."signatureOk",q."payloadEnc" IS NOT NULL,q."payloadKeyId",
      CASE WHEN q."payloadEnc" IS NULL THEN 'none' ELSE CASE substring(q."payloadEnc" from 1 for 3)
        WHEN 'v1:' THEN 'v1' WHEN 'v2:' THEN 'v2' ELSE 'malformed' END END,
      q."resolvedReceiptId" IS NOT NULL,q."firstOwnerWorkspaceId" IS NOT NULL,q."receivedAt" AT TIME ZONE 'UTC'
      FROM public."EbayNoticeQuarantine" q WHERE q.id>after_id ORDER BY q.id LIMIT page_limit;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.nexus_ebay_quarantine_inventory(text,integer) FROM PUBLIC,nexus_workspace_runtime;
GRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_inventory(text,integer) TO nexus_ebay_quarantine_maintenance;
ALTER FUNCTION public.nexus_ebay_quarantine_inventory(text,integer) OWNER TO nexus_ebay_quarantine_writer;

REVOKE CREATE ON SCHEMA public FROM nexus_ebay_quarantine_writer;
GRANT nexus_ebay_quarantine_writer TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
DO $$ BEGIN
  IF has_schema_privilege('nexus_ebay_quarantine_writer','public','CREATE') THEN
    RAISE EXCEPTION 'Quarantine writer must not retain effective schema CREATE permission' USING ERRCODE='42501';
  END IF;
END $$;

DROP TRIGGER IF EXISTS nexus_ebay_quarantine ON public."EbayNoticeQuarantine";
CREATE TRIGGER nexus_ebay_quarantine BEFORE INSERT OR UPDATE ON public."EbayNoticeQuarantine"
  FOR EACH ROW EXECUTE FUNCTION public.nexus_ebay_quarantine_guard();
COMMIT;
