BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- AlterTable
ALTER TABLE "EbayNoticeQuarantine" ADD COLUMN     "reviewAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewNextAt" TIMESTAMP(3),
ADD COLUMN     "reviewOutcome" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ErasureRequest" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "quarantineId" TEXT,
    "evidenceOrderId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EBAY',
    "environment" TEXT NOT NULL,
    "matchBasis" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErasureRequest_workspaceId_status_createdAt_idx" ON "ErasureRequest"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ErasureRequest_evidenceOrderId_idx" ON "ErasureRequest"("evidenceOrderId");

-- CreateIndex
CREATE INDEX "ErasureRequest_quarantineId_status_idx" ON "ErasureRequest"("quarantineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ErasureRequest_workspace_quarantine_key" ON "ErasureRequest"("workspaceId", "quarantineId");

-- CreateIndex
CREATE INDEX "EbayNoticeQuarantine_topic_reviewedAt_reviewNextAt_idx" ON "EbayNoticeQuarantine"("topic", "reviewedAt", "reviewNextAt");

-- AddForeignKey
ALTER TABLE "ErasureRequest" ADD CONSTRAINT "ErasureRequest_quarantineId_fkey" FOREIGN KEY ("quarantineId") REFERENCES "EbayNoticeQuarantine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErasureRequest" ADD CONSTRAINT "ErasureRequest_evidenceOrderId_fkey" FOREIGN KEY ("evidenceOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;


GRANT SELECT, INSERT ON TABLE "ErasureRequest" TO nexus_workspace_runtime;
ALTER TABLE "ErasureRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ErasureRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ErasureRequest";
CREATE POLICY nexus_workspace_isolation ON "ErasureRequest" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ErasureRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ErasureRequest"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ErasureRequest";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ErasureRequest" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Order","from":"evidenceOrderId","to":"id"}]');
-- One business's record of one eBay deletion notice that matched its data. It holds no personal
-- data and is never deleted. Lifecycle (who may move it):
--   REVIEW_REQUIRED -> HELD       an active OWNER confirms the buyer; erasure waits for the fiscal-retention decision
--   REVIEW_REQUIRED -> DISMISSED  an active OWNER decides it is not this buyer (done)
--   HELD            -> COMPLETED  the system erasure executor only, once one is approved (done)
-- A done record releases its notice and order: deleting either then clears the pointer. An open
-- record keeps both, so its evidence cannot disappear while a business still has to decide.
CREATE OR REPLACE FUNCTION public.nexus_erasure_review_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog, pg_temp AS $$
DECLARE actor text := NULLIF(current_setting('nexus.actor_id',true),'');
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Erasure requests are the retained record of each deletion notice' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF actor IS NOT NULL THEN
      RAISE EXCEPTION 'Only verified ingress may record erasure review candidates' USING ERRCODE='42501';
    END IF;
    IF NEW.channel IS DISTINCT FROM 'EBAY' OR NEW."matchBasis" NOT IN ('user_id','username')
      OR NEW.status IS DISTINCT FROM 'REVIEW_REQUIRED' OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A new erasure request starts as an undecided candidate' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."EbayNoticeQuarantine" q WHERE q.id=NEW."quarantineId"
      AND q."signatureOk"=true AND q.topic='MARKETPLACE_ACCOUNT_DELETION' AND q.environment=NEW.environment
      AND q."resolvedReceiptId" IS NULL) THEN
      RAISE EXCEPTION 'A review candidate requires retained verified deletion evidence' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."Order" o JOIN public."ChannelConnection" c ON c.id=o."channelConnectionId"
      WHERE o.id=NEW."evidenceOrderId" AND o."workspaceId"=NEW."workspaceId" AND o.channel='EBAY'
        AND c."workspaceId"=o."workspaceId" AND c."channelType"='EBAY' AND c."managedBy"='oauth'
        AND c."externalAccountId" IS NOT NULL AND length(c."externalAccountId") BETWEEN 1 AND 1024
        AND c."connectionMetadata"->>'environment'=NEW.environment
        AND jsonb_typeof(o."ebayMetadata"->'buyer'->'username')='string') THEN
      RAISE EXCEPTION 'A review candidate requires its business existing eBay order evidence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['quarantineId','evidenceOrderId','status','decidedAt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['quarantineId','evidenceOrderId','status','decidedAt']) THEN
    RAISE EXCEPTION 'Only the review status of an erasure request may change' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW."quarantineId",NEW."evidenceOrderId") IS DISTINCT FROM ROW(OLD."quarantineId",OLD."evidenceOrderId") THEN
    -- Only a deleted notice/order clears a pointer (ON DELETE SET NULL), and only on a done record.
    IF OLD.status NOT IN ('DISMISSED','COMPLETED')
      OR ROW(NEW.status,NEW."decidedAt") IS DISTINCT FROM ROW(OLD.status,OLD."decidedAt")
      OR (NEW."quarantineId" IS NOT NULL AND NEW."quarantineId" IS DISTINCT FROM OLD."quarantineId")
      OR (NEW."evidenceOrderId" IS NOT NULL AND NEW."evidenceOrderId" IS DISTINCT FROM OLD."evidenceOrderId") THEN
      RAISE EXCEPTION 'An open erasure request keeps its notice and order evidence' USING ERRCODE='23503';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='REVIEW_REQUIRED' AND NEW.status IN ('HELD','DISMISSED') THEN
    -- A NULL actor (system work) matches no membership, so it can never decide for an owner.
    IF NOT EXISTS (SELECT 1 FROM public."WorkspaceMembership" m
      JOIN public."UserProfile" u ON u.id=m."userId"
      JOIN public."WorkspaceMemberRole" mr ON mr."membershipId"=m.id JOIN public."Role" r ON r.id=mr."roleId"
      WHERE m."workspaceId"=NEW."workspaceId" AND m."userId"=actor AND m.status='active' AND u.status='active' AND r.key='OWNER') THEN
      RAISE EXCEPTION 'Only an active owner of this business may decide an erasure review' USING ERRCODE='42501';
    END IF;
  ELSIF OLD.status='HELD' AND NEW.status='COMPLETED' THEN
    IF actor IS NOT NULL THEN
      RAISE EXCEPTION 'Only the approved erasure executor may complete a held request' USING ERRCODE='42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported erasure request transition' USING ERRCODE='23514';
  END IF;
  NEW."decidedAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nexus_erasure_review ON public."ErasureRequest";
CREATE TRIGGER nexus_erasure_review BEFORE INSERT OR UPDATE OR DELETE ON public."ErasureRequest"
  FOR EACH ROW EXECUTE FUNCTION public.nexus_erasure_review_guard();
DROP TRIGGER IF EXISTS nexus_erasure_review_truncate ON public."ErasureRequest";
CREATE TRIGGER nexus_erasure_review_truncate BEFORE TRUNCATE ON public."ErasureRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION public.nexus_erasure_review_guard();
-- Owners change the status only; the trigger stamps decidedAt. Nobody deletes a record.
REVOKE UPDATE, DELETE, TRUNCATE ON public."ErasureRequest" FROM nexus_workspace_runtime;
GRANT UPDATE ("status") ON public."ErasureRequest" TO nexus_workspace_runtime;
DROP POLICY IF EXISTS nexus_erasure_review_system_write ON public."ErasureRequest";
CREATE POLICY nexus_erasure_review_system_write ON public."ErasureRequest" AS RESTRICTIVE FOR INSERT TO nexus_workspace_runtime
  WITH CHECK (NULLIF(current_setting('nexus.actor_id',true),'') IS NULL);

-- Deletion review bookkeeping. eBay is answered once the notice is stored; the retry worker
-- reviews it later. Only verified deletion notices carry review state, and a finished review
-- names its outcome ('unsupported' stays unfinished so a later reader can still review it).
ALTER TABLE public."EbayNoticeQuarantine" DROP CONSTRAINT IF EXISTS "EbayNoticeQuarantine_review_state";
ALTER TABLE public."EbayNoticeQuarantine" ADD CONSTRAINT "EbayNoticeQuarantine_review_state" CHECK (
  ("reviewAttempts"=0 AND "reviewNextAt" IS NULL AND "reviewedAt" IS NULL AND "reviewOutcome" IS NULL)
  OR ("signatureOk" AND topic='MARKETPLACE_ACCOUNT_DELETION' AND "reviewAttempts">=0
    AND ("reviewOutcome" IS NULL OR "reviewOutcome" IN ('matched','unmatched','unsupported'))
    AND (("reviewedAt" IS NULL)=("reviewOutcome" IS NULL OR "reviewOutcome"='unsupported'))));
GRANT UPDATE ("reviewAttempts", "reviewNextAt", "reviewedAt", "reviewOutcome") ON public."EbayNoticeQuarantine" TO nexus_workspace_runtime;

-- D8 still holds: quarantine history is never deleted or truncated. The ONE exception is the
-- expiry below, running as the restricted writer, and only for a verified deletion notice that
-- was never handed off, whose review finished, and which is past the 30-day floor. An open
-- erasure request still stops it (its evidence guard refuses clearing the pointer).
CREATE OR REPLACE FUNCTION public.nexus_retain_ebay_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog, pg_temp AS $$
BEGIN
  -- reviewedAt is only ever set on a verified deletion notice whose review finished
  -- (CHECK "EbayNoticeQuarantine_review_state"), so it carries the topic and outcome too.
  IF TG_OP='DELETE' THEN
    IF current_user='nexus_ebay_quarantine_writer' AND OLD."resolvedReceiptId" IS NULL
      AND OLD."reviewedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 days' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Inbound delivery history must be archived, never deleted or truncated' USING ERRCODE='42501';
END $$;
DROP TRIGGER IF EXISTS nexus_retain_inbound_history ON public."EbayNoticeQuarantine";
CREATE TRIGGER nexus_retain_inbound_history BEFORE DELETE ON public."EbayNoticeQuarantine"
  FOR EACH ROW EXECUTE FUNCTION public.nexus_retain_ebay_notice();
DROP TRIGGER IF EXISTS nexus_retain_ebay_notice_truncate ON public."EbayNoticeQuarantine";
CREATE TRIGGER nexus_retain_ebay_notice_truncate BEFORE TRUNCATE ON public."EbayNoticeQuarantine"
  FOR EACH STATEMENT EXECUTE FUNCTION public.nexus_retain_ebay_notice();

-- Expiry of deletion notices no business still needs: reviewed (matched nothing, or every
-- business's request is done) and past the retention period. The period is the application's
-- EBAY_DELETION_NOTICE_RETENTION_DAYS; the database refuses anything shorter than 30 days.
-- Unreviewed and unreadable ('unsupported') notices are never expired here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexus_ebay_quarantine_writer' AND NOT rolcanlogin AND NOT rolbypassrls AND NOT rolsuper) THEN
    RAISE EXCEPTION 'The restricted quarantine writer role is required' USING ERRCODE='42501';
  END IF;
END $$;
GRANT nexus_ebay_quarantine_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
GRANT CREATE ON SCHEMA public TO nexus_ebay_quarantine_writer;
GRANT DELETE ON public."EbayNoticeQuarantine" TO nexus_ebay_quarantine_writer;
GRANT SELECT ("quarantineId", status) ON public."ErasureRequest" TO nexus_ebay_quarantine_writer;
DROP POLICY IF EXISTS nexus_erasure_request_expiry ON public."ErasureRequest";
CREATE POLICY nexus_erasure_request_expiry ON public."ErasureRequest" FOR SELECT TO nexus_ebay_quarantine_writer USING (true);
CREATE OR REPLACE FUNCTION public.nexus_expire_ebay_deletion_notices(retention_days integer, batch_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, pg_temp AS $$
DECLARE expired integer;
BEGIN
  IF NULLIF(current_setting('nexus.actor_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'Deletion notice expiry is system maintenance only' USING ERRCODE='42501';
  END IF;
  IF retention_days IS NULL OR retention_days < 30 OR retention_days > 3650 OR batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 500 THEN
    RAISE EXCEPTION 'Invalid deletion notice expiry bounds' USING ERRCODE='22023';
  END IF;
  WITH due AS (
    SELECT q.id FROM public."EbayNoticeQuarantine" q
    WHERE q.topic='MARKETPLACE_ACCOUNT_DELETION' AND q."resolvedReceiptId" IS NULL
      AND q."reviewedAt" < (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => retention_days)
      AND NOT EXISTS (SELECT 1 FROM public."ErasureRequest" r WHERE r."quarantineId"=q.id AND r.status IN ('REVIEW_REQUIRED','HELD'))
    ORDER BY q."reviewedAt", q.id LIMIT batch_limit FOR UPDATE OF q SKIP LOCKED)
  DELETE FROM public."EbayNoticeQuarantine" q USING due WHERE q.id=due.id;
  GET DIAGNOSTICS expired=ROW_COUNT;
  RETURN expired;
END $$;
REVOKE ALL ON FUNCTION public.nexus_expire_ebay_deletion_notices(integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nexus_expire_ebay_deletion_notices(integer,integer) TO nexus_workspace_runtime;
ALTER FUNCTION public.nexus_expire_ebay_deletion_notices(integer,integer) OWNER TO nexus_ebay_quarantine_writer;
REVOKE CREATE ON SCHEMA public FROM nexus_ebay_quarantine_writer;
GRANT nexus_ebay_quarantine_writer TO CURRENT_USER WITH INHERIT FALSE, SET FALSE;
DO $$ BEGIN
  IF has_schema_privilege('nexus_ebay_quarantine_writer','public','CREATE') THEN
    RAISE EXCEPTION 'Quarantine writer must not retain effective schema CREATE permission' USING ERRCODE='42501';
  END IF;
END $$;
COMMIT;
