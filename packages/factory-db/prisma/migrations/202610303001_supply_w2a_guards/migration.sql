-- Written by hand (Prisma does not model triggers), after the generated …_supply_w2a_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Product and supply, W2a schema wave 3/7 (plan W2A §5; features PRD-018, PRD-120, PRD-285, QHS-105, SCM-005, SCM-058,
-- SCM-059, SCM-060, SCM-087, SCM-115, SCM-118, SCM-123, SCM-134, SCM-138, SCM-140, SCM-141). apps/factory-api's modules
-- check all of this first; these rules hold for every login, the owner included. As in …_supply_guards: the tenant,
-- site and party of a row are held by the policies and the references, not here (the triggers leave "tenantId",
-- "siteId" and "partyId" to them); every refusal is a check_violation (SQLSTATE 23514); a rule that reads another row
-- skips a row this session cannot see (the policies refuse that write anyway); a trigger reads only tables and columns
-- the role that fires it may read. "Everything but these columns" is compared as jsonb, so a column added later is
-- frozen too unless a later migration names it.
--
-- This migration also REDEFINES the two purchase order guards of …_supply_po_proposals_guards (their rules and
-- messages kept, their triggers unchanged) for revisions with re-confirmation, the confirm-by deadline and a line's
-- cancel and close short.

-- ---------------------------------------------------------------------------------------------------------------------
-- History rows: PurchaseOrderRevision and PurchaseOrderReminder are append-only (scripts/factory/check-append-only.mjs).
-- No login may change or remove one, the owner included; the runtime roles have no UPDATE, DELETE or TRUNCATE grant.
CREATE FUNCTION "factory_supply_w2a_refuse_history_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % on "%" is refused; what was sent stays as it was sent', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "PurchaseOrderRevision_append_only" BEFORE UPDATE OR DELETE ON "PurchaseOrderRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_supply_w2a_refuse_history_change"();
CREATE TRIGGER "PurchaseOrderRevision_no_truncate" BEFORE TRUNCATE ON "PurchaseOrderRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_w2a_refuse_history_change"();
CREATE TRIGGER "PurchaseOrderReminder_append_only" BEFORE UPDATE OR DELETE ON "PurchaseOrderReminder"
  FOR EACH ROW EXECUTE FUNCTION "factory_supply_w2a_refuse_history_change"();
CREATE TRIGGER "PurchaseOrderReminder_no_truncate" BEFORE TRUNCATE ON "PurchaseOrderReminder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_w2a_refuse_history_change"();

-- PurchaseOrderRevision, INSERT (SCM-058)
--   order      written for an order that was sent (not DRAFT): the send's command writes it once the order is SENT.
--   snapshot   `after` and `afterPrices` are objects; `before` and `beforePrices` are objects too, or both null (revision 1).
--   document   the PDF is a file of this order (recordType PurchaseOrder).
CREATE FUNCTION "factory_purchase_order_revision_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  file_of text;
BEGIN
  SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId";
  IF state = 'DRAFT' THEN
    RAISE EXCEPTION 'supply: purchase order % is DRAFT; a revision is written when it is sent', NEW."purchaseOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revision" < 1
     OR jsonb_typeof(NEW."after") IS DISTINCT FROM 'object' OR jsonb_typeof(NEW."afterPrices") IS DISTINCT FROM 'object'
     OR (NEW."before" IS NULL) <> (NEW."beforePrices" IS NULL)
     OR (NEW."before" IS NOT NULL AND (jsonb_typeof(NEW."before") <> 'object' OR jsonb_typeof(NEW."beforePrices") <> 'object')) THEN
    RAISE EXCEPTION 'supply: revision % of purchase order % has a number from 1, the order as sent and its prices (objects), and the previous state with its prices or neither', NEW."revision", NEW."purchaseOrderId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."documentFileId" IS NOT NULL THEN
    SELECT f."recordType" || ':' || f."recordId"::text INTO file_of FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."documentFileId";
    IF FOUND AND file_of <> 'PurchaseOrder:' || NEW."purchaseOrderId"::text THEN
      RAISE EXCEPTION 'supply: the PDF of revision % of purchase order % is a file of that order', NEW."revision", NEW."purchaseOrderId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchaseOrderRevision_check" BEFORE INSERT ON "PurchaseOrderRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_order_revision_check"();

-- PurchaseOrderReminder, INSERT (SCM-087)
--   CONFIRMATION  only while the order is SENT (waiting for the supplier's answer), naming its current revision.
CREATE FUNCTION "factory_purchase_order_reminder_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  current_revision integer;
BEGIN
  SELECT o."status"::text, o."revision" INTO state, current_revision
    FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId";
  IF FOUND AND NEW."kind" = 'CONFIRMATION' AND (state <> 'SENT' OR NEW."revision" <> current_revision) THEN
    RAISE EXCEPTION 'supply: purchase order % is % (revision %); a reminder to confirm goes only to a SENT order, for its current revision', NEW."purchaseOrderId", state, current_revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PurchaseOrderReminder_check" BEFORE INSERT ON "PurchaseOrderReminder"
  FOR EACH ROW EXECUTE FUNCTION "factory_purchase_order_reminder_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- PurchaseOrder, in addition to …_supply_po_proposals_guards (whose rules and messages this keeps):
--   revision   a CONFIRMED order goes back to DRAFT as its next revision too (B-W2a-52: the supplier confirms it
--              again), and so does an order with proposed changes the buyer refuses to counter-propose
--              (CHANGES_PROPOSED → DRAFT, decision REFUSED). A confirmed order loses its confirmation in that move
--              (sourcing.prisma PurchaseOrderRevision keeps it); its send time goes too, as from SENT.
--   confirmBy  the confirm-by deadline (SCM-087): set at the send, the office may move it later (a partner session
--              never); after the send time.
--   send       DRAFT → SENT counts only the lines not cancelled (their sum is the order's amount, at least one), and
--              refuses an order whose open lines still hold an earlier revision's confirmation.
CREATE OR REPLACE FUNCTION "factory_purchase_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  proposal_columns CONSTANT text[] := ARRAY['proposedAt', 'proposalLinkId', 'proposedByName', 'proposalSupplierRef', 'proposalNote',
    'proposalDecision', 'proposalDecidedAt', 'proposalDecidedById', 'proposalDecisionNote'];
  progress CONSTANT text[] := ARRAY['status', 'revision', 'sentAt', 'sentById', 'confirmBy', 'confirmedAt', 'confirmedVia', 'confirmLinkId',
    'confirmedByName', 'supplierRef', 'confirmNote', 'declinedAt', 'declineReason', 'closedAt', 'cancelledAt', 'cancelReason',
    'internalNote', 'version', 'updatedAt'] || proposal_columns;
  answer CONSTANT text[] := ARRAY['status', 'confirmedAt', 'confirmedVia', 'confirmLinkId', 'confirmedByName', 'supplierRef',
    'confirmNote', 'declinedAt', 'declineReason', 'version', 'updatedAt'] || proposal_columns;
  line_count integer;
  line_total bigint;
  still_confirmed integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: purchase order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    -- A new proposal replaces the last one: the buyer's last decision is cleared with it.
    IF OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED' THEN
      NEW."proposalDecision" := NULL;
      NEW."proposalDecidedAt" := NULL;
      NEW."proposalDecidedById" := NULL;
      NEW."proposalDecisionNote" := NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, number and creation of purchase order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" IN ('CONFIRMED', 'SENT', 'DRAFT'))
                OR (OLD."status" = 'DECLINED' AND NEW."status" IN ('DRAFT', 'CANCELLED'))
                OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'DRAFT'))
                OR (OLD."status" IN ('PARTLY_RECEIVED', 'RECEIVED') AND NEW."status" IN ('PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CONFIRMED', 'SENT'))) THEN
      RAISE EXCEPTION 'supply: purchase order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its terms change only while it is DRAFT (recall it to change it)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."confirmedAt", NEW."confirmedVia", NEW."confirmLinkId", NEW."confirmedByName", NEW."supplierRef", NEW."confirmNote")
       IS DISTINCT FROM
       (OLD."confirmedAt", OLD."confirmedVia", OLD."confirmLinkId", OLD."confirmedByName", OLD."supplierRef", OLD."confirmNote")
       AND NOT (OLD."status" IN ('SENT', 'CHANGES_PROPOSED') AND NEW."status" = 'CONFIRMED' AND OLD."confirmedAt" IS NULL)
       -- W2a: a confirmed order going back to DRAFT as its next revision loses its confirmation (all of it).
       AND NOT (OLD."status" = 'CONFIRMED' AND NEW."status" = 'DRAFT' AND NEW."confirmedAt" IS NULL AND NEW."confirmedVia" IS NULL
                AND NEW."confirmLinkId" IS NULL AND NEW."confirmedByName" IS NULL AND NEW."supplierRef" IS NULL AND NEW."confirmNote" IS NULL) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order % is set once, when it moves from SENT to CONFIRMED (or from CHANGES_PROPOSED, accepted), and cleared only when a confirmed order goes back to DRAFT for a new revision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposedAt", NEW."proposalLinkId", NEW."proposedByName", NEW."proposalSupplierRef", NEW."proposalNote")
       IS DISTINCT FROM
       (OLD."proposedAt", OLD."proposalLinkId", OLD."proposedByName", OLD."proposalSupplierRef", OLD."proposalNote")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED') THEN
      RAISE EXCEPTION 'supply: the supplier''s proposal for purchase order % is written only when it moves from SENT to CHANGES_PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposalDecision", NEW."proposalDecidedAt", NEW."proposalDecidedById", NEW."proposalDecisionNote")
       IS DISTINCT FROM
       (OLD."proposalDecision", OLD."proposalDecidedAt", OLD."proposalDecidedById", OLD."proposalDecisionNote")
       AND NOT ((OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" IN ('CONFIRMED', 'SENT', 'DRAFT')) OR (OLD."status" = 'SENT' AND NEW."status" = 'CHANGES_PROPOSED')) THEN
      RAISE EXCEPTION 'supply: the buyer''s decision on the proposal for purchase order % is written only when it leaves CHANGES_PROPOSED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CHANGES_PROPOSED' AND NEW."status" <> OLD."status"
       AND ((NEW."status" = 'CONFIRMED' AND (NEW."proposalDecision" IS DISTINCT FROM 'ACCEPTED' OR NEW."confirmedVia" IS DISTINCT FROM 'LINK' OR NEW."confirmLinkId" IS DISTINCT FROM NEW."proposalLinkId"))
            OR (NEW."status" IN ('SENT', 'DRAFT') AND NEW."proposalDecision" IS DISTINCT FROM 'REFUSED')) THEN
      RAISE EXCEPTION 'supply: purchase order % leaves CHANGES_PROPOSED only by the buyer''s decision: ACCEPTED to CONFIRMED (through the proposal''s link) or REFUSED back to SENT (or to DRAFT, to counter-propose a new revision)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."declinedAt", NEW."declineReason") IS DISTINCT FROM (OLD."declinedAt", OLD."declineReason")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" = 'DECLINED') THEN
      RAISE EXCEPTION 'supply: the supplier''s decline of purchase order % is written only when it moves from SENT to DECLINED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."sentAt", NEW."sentById") IS DISTINCT FROM (OLD."sentAt", OLD."sentById")
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR (OLD."status" IN ('SENT', 'DECLINED', 'CONFIRMED', 'CHANGES_PROPOSED') AND NEW."status" = 'DRAFT')) THEN
      RAISE EXCEPTION 'supply: purchase order % gets its send time when it is sent, and loses it when it goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revision" NOT IN (OLD."revision", OLD."revision" + 1)
       OR (NEW."status" = 'DRAFT' AND OLD."status" IN ('SENT', 'DECLINED', 'CONFIRMED', 'CHANGES_PROPOSED')) <> (NEW."revision" = OLD."revision" + 1) THEN
      RAISE EXCEPTION 'supply: the revision of purchase order % goes up by one exactly when a SENT, DECLINED, CONFIRMED or CHANGES_PROPOSED order goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'SENT' THEN
      SELECT count(*) FILTER (WHERE l."cancelledAt" IS NULL),
             coalesce(sum(l."netAmount") FILTER (WHERE l."cancelledAt" IS NULL), 0),
             count(*) FILTER (WHERE l."cancelledAt" IS NULL AND l."closedShortAt" IS NULL AND (l."confirmedQuantity" IS NOT NULL OR l."confirmedDate" IS NOT NULL))
        INTO line_count, line_total, still_confirmed
        FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."purchaseOrderId" = NEW."id";
      IF line_count = 0 THEN
        RAISE EXCEPTION 'supply: purchase order % has no line; it cannot be sent (a cancelled line does not count)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF line_total <> NEW."netAmount" THEN
        RAISE EXCEPTION 'supply: the amount of purchase order % (%) is not the sum of its lines (%)', NEW."id", NEW."netAmount", line_total
          USING ERRCODE = 'check_violation';
      END IF;
      IF still_confirmed > 0 THEN
        RAISE EXCEPTION 'supply: % line(s) of purchase order % still hold the confirmation of an earlier revision; clear it before sending revision %', still_confirmed, NEW."id", NEW."revision"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || answer)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer))
            OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED')))) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms or declines its SENT purchase order, or answers it with changes (order %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."revision" < 1 OR NEW."netAmount" < 0 THEN
    RAISE EXCEPTION 'supply: purchase order % has a revision from 1 and no negative amount', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT' AND NEW."sentAt" IS NOT NULL) OR (NEW."status" NOT IN ('DRAFT', 'CANCELLED') AND NEW."sentAt" IS NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with the wrong send time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."confirmBy" IS NOT NULL AND NEW."sentAt" IS NOT NULL AND NEW."confirmBy" <= NEW."sentAt" THEN
    RAISE EXCEPTION 'supply: purchase order % is to be confirmed by a time after it was sent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."confirmedAt" IS NULL) <> (NEW."confirmedVia" IS NULL)
     OR (NEW."confirmedAt" IS NULL AND (NEW."confirmLinkId" IS NOT NULL OR NEW."confirmedByName" IS NOT NULL OR NEW."supplierRef" IS NOT NULL OR NEW."confirmNote" IS NOT NULL))
     OR (NEW."confirmedVia" IS NOT DISTINCT FROM 'LINK') <> (NEW."confirmLinkId" IS NOT NULL)
     OR (NEW."status" = 'CONFIRMED' AND NEW."confirmedAt" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'SENT', 'DECLINED', 'CHANGES_PROPOSED') AND NEW."confirmedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent confirmation (its time, channel and link go together, from CONFIRMED on)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CHANGES_PROPOSED' AND (NEW."proposedAt" IS NULL OR NEW."proposalLinkId" IS NULL OR NEW."proposalDecision" IS NOT NULL))
     OR (NEW."proposedAt" IS NULL AND (NEW."proposalLinkId" IS NOT NULL OR NEW."proposedByName" IS NOT NULL OR NEW."proposalSupplierRef" IS NOT NULL OR NEW."proposalNote" IS NOT NULL OR NEW."proposalDecision" IS NOT NULL))
     OR (NEW."proposalDecision" IS NULL) <> (NEW."proposalDecidedAt" IS NULL)
     OR (NEW."proposalDecision" IS NULL AND (NEW."proposalDecidedById" IS NOT NULL OR NEW."proposalDecisionNote" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with an inconsistent proposal (CHANGES_PROPOSED with its time and link and no decision yet; a decision with its time)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DECLINED' AND NEW."declinedAt" IS NULL) OR (NEW."declinedAt" IS NULL AND NEW."declineReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'supply: purchase order % is % with the wrong decline time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED' AND btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'supply: purchase order % is % with the wrong closing or cancellation (a cancellation has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- PurchaseOrderLine, in addition to …_supply_po_proposals_guards (whose rules and messages this keeps):
--   cancel       (SCM-059) cancelledAt with its reason (and who), set once, while its order is not RECEIVED, CLOSED or
--                CANCELLED; never on a new line.
--   close short  (SCM-060) closedShortAt with its reason (and who), set once, while its order is PARTLY_RECEIVED.
--   ended        a line cancelled or closed short (never both) changes no more; on a sent order these columns are the
--                only ones besides the supplier's answer that change; a partner session never writes them.
--   revision     while its order is DRAFT (a new revision), a line's earlier confirmation and proposal are cleared
--                (all to null), so the supplier confirms the new revision again.
CREATE OR REPLACE FUNCTION "factory_purchase_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  answer CONSTANT text[] := ARRAY['confirmedQuantity', 'confirmedDate', 'proposedQuantity', 'proposedDate', 'proposedSplitQuantity',
    'proposedSplitDate', 'proposalReason', 'version', 'updatedAt'];
  ending CONSTANT text[] := ARRAY['cancelledAt', 'cancelledById', 'cancelReason', 'closedShortAt', 'closedShortById', 'closeShortReason'];
  state text;
  part_of uuid;
  item_needs_test boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."purchaseOrderId" <> OLD."purchaseOrderId" THEN
      RAISE EXCEPTION 'supply: purchase order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."purchaseOrderId";
    SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId" FOR SHARE;
  ELSE
    part_of := OLD."purchaseOrderId";
    SELECT o."status"::text INTO state FROM "PurchaseOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."purchaseOrderId" FOR SHARE;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its lines are removed only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: purchase order % is %; lines are added only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."confirmedQuantity" IS NOT NULL OR NEW."confirmedDate" IS NOT NULL
       OR NEW."proposedQuantity" IS NOT NULL OR NEW."proposedDate" IS NOT NULL OR NEW."proposedSplitQuantity" IS NOT NULL
       OR NEW."proposedSplitDate" IS NOT NULL OR NEW."proposalReason" IS NOT NULL THEN
      RAISE EXCEPTION 'supply: purchase order line % is new; the supplier has not confirmed it yet (nor proposed a change)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."cancelledAt" IS NOT NULL OR NEW."closedShortAt" IS NOT NULL THEN
      RAISE EXCEPTION 'supply: purchase order line % is new; it is not cancelled or closed short yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (OLD."cancelledAt" IS NOT NULL OR OLD."closedShortAt" IS NOT NULL)
       AND (to_jsonb(NEW) - (kept || ARRAY['version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: purchase order line % is cancelled or closed short; it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (to_jsonb(NEW) - (kept || answer || ending)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer || ending)) THEN
      RAISE EXCEPTION 'supply: purchase order % is %; its lines change only while it is DRAFT (recall it to change them)', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate")
       AND NOT (state IS NOT DISTINCT FROM 'DRAFT' AND NEW."confirmedQuantity" IS NULL AND NEW."confirmedDate" IS NULL)
       AND ((OLD."confirmedQuantity" IS NOT NULL AND NEW."confirmedQuantity" IS DISTINCT FROM OLD."confirmedQuantity")
            OR (OLD."confirmedDate" IS NOT NULL AND NEW."confirmedDate" IS DISTINCT FROM OLD."confirmedDate")
            OR (state IS NOT NULL AND state NOT IN ('SENT', 'CHANGES_PROPOSED', 'CONFIRMED'))) THEN
      RAISE EXCEPTION 'supply: the supplier''s confirmation of purchase order line % is set once, while its order is SENT or CONFIRMED (or CHANGES_PROPOSED, when the buyer accepts the supplier''s changes), and cleared only while its order is DRAFT for a new revision', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."proposedQuantity", NEW."proposedDate", NEW."proposedSplitQuantity", NEW."proposedSplitDate", NEW."proposalReason")
       IS DISTINCT FROM
       (OLD."proposedQuantity", OLD."proposedDate", OLD."proposedSplitQuantity", OLD."proposedSplitDate", OLD."proposalReason")
       AND state IS NOT NULL AND state <> 'SENT'
       AND NOT (state = 'DRAFT' AND NEW."proposedQuantity" IS NULL AND NEW."proposedDate" IS NULL AND NEW."proposedSplitQuantity" IS NULL
                AND NEW."proposedSplitDate" IS NULL AND NEW."proposalReason" IS NULL) THEN
      RAISE EXCEPTION 'supply: the supplier''s proposal for purchase order line % is written only while its order is SENT (and cleared only while it is DRAFT)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."cancelledAt", NEW."cancelledById", NEW."cancelReason") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledById", OLD."cancelReason")
       AND NOT (OLD."cancelledAt" IS NULL AND NEW."cancelledAt" IS NOT NULL AND btrim(coalesce(NEW."cancelReason", '')) <> ''
                AND (state IS NULL OR state NOT IN ('RECEIVED', 'CLOSED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'supply: purchase order line % is cancelled once, with its time and reason, while its order is not received, closed or cancelled', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."closedShortAt", NEW."closedShortById", NEW."closeShortReason") IS DISTINCT FROM (OLD."closedShortAt", OLD."closedShortById", OLD."closeShortReason")
       AND NOT (OLD."closedShortAt" IS NULL AND NEW."closedShortAt" IS NOT NULL AND btrim(coalesce(NEW."closeShortReason", '')) <> ''
                AND (state IS NULL OR state = 'PARTLY_RECEIVED')) THEN
      RAISE EXCEPTION 'supply: purchase order line % is closed short once, with its time and reason, while its order is PARTLY_RECEIVED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND ((to_jsonb(NEW) - (kept || answer)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer))
            OR ((NEW."confirmedQuantity", NEW."confirmedDate") IS DISTINCT FROM (OLD."confirmedQuantity", OLD."confirmedDate") AND state IS DISTINCT FROM 'SENT')) THEN
      RAISE EXCEPTION 'supply: a partner session only confirms the lines of its SENT purchase order, or proposes changes to them (line %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."unitPrice" < 0 OR NEW."netAmount" < 0 OR NEW."confirmedQuantity" < 0
     OR NEW."estimatedHides" < 0 OR NEW."areaTolerancePct" < 0 OR NEW."thicknessMinMm" > NEW."thicknessMaxMm" THEN
    RAISE EXCEPTION 'supply: purchase order line % has a quantity above 0, no negative price, amount, confirmed quantity, hides or tolerance, and a thickness range from low to high', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."proposedQuantity" < 0
     OR (NEW."proposedSplitQuantity" IS NULL) <> (NEW."proposedSplitDate" IS NULL)
     OR NEW."proposedSplitQuantity" <= 0
     OR (NEW."proposedSplitQuantity" IS NOT NULL AND (NEW."proposedQuantity" IS NULL OR NEW."proposedQuantity" <= 0 OR NEW."proposedDate" IS NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order line % has no negative proposed quantity, and a second delivery with its quantity and date after a first one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."cancelledAt" IS NOT NULL AND NEW."closedShortAt" IS NOT NULL)
     OR (NEW."cancelledAt" IS NULL AND (NEW."cancelledById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL))
     OR (NEW."closedShortAt" IS NULL AND (NEW."closedShortById" IS NOT NULL OR NEW."closeShortReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: purchase order line % is cancelled or closed short (not both), each with its own time', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."itemId" <> OLD."itemId" OR NEW."requiresCrViTest" <> OLD."requiresCrViTest" THEN
    SELECT i."requiresCrViTest" INTO item_needs_test FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_needs_test AND NOT NEW."requiresCrViTest" THEN
      RAISE EXCEPTION 'supply: item % needs Cr VI evidence (REACH Annex XVII entry 47); purchase order line % must say so', NEW."itemId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- GoodsReceiptLine, in addition to …_supply_guards (SCM-123, SCM-059, SCM-060)
--   received unit  receivedQuantity, receivedUom and receivedFactor all three or none, both numbers above 0; then the
--                  line's base quantity is receivedQuantity × receivedFactor rounded to 4 decimals.
--   ended line     a receipt line never receives against a purchase order line that is cancelled or closed short.
CREATE FUNCTION "factory_goods_receipt_line_w2a_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ended boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."receivedQuantity" IS NULL) <> (NEW."receivedUom" IS NULL) OR (NEW."receivedQuantity" IS NULL) <> (NEW."receivedFactor" IS NULL) THEN
    RAISE EXCEPTION 'inventory: goods receipt line % names how it came (quantity, unit and factor) all together or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."receivedQuantity" IS NOT NULL
     AND (NEW."receivedQuantity" <= 0 OR NEW."receivedFactor" <= 0 OR NEW."baseQuantity" <> round(NEW."receivedQuantity" * NEW."receivedFactor", 4)) THEN
    RAISE EXCEPTION 'inventory: goods receipt line % came as % % of % base units each: its base quantity is % (not %)', NEW."id", NEW."receivedQuantity", NEW."receivedUom", NEW."receivedFactor", round(NEW."receivedQuantity" * NEW."receivedFactor", 4), NEW."baseQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."purchaseOrderLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."purchaseOrderLineId" IS DISTINCT FROM OLD."purchaseOrderLineId") THEN
    SELECT (l."cancelledAt" IS NOT NULL OR l."closedShortAt" IS NOT NULL) INTO ended
      FROM "PurchaseOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."purchaseOrderLineId";
    IF ended THEN
      RAISE EXCEPTION 'inventory: purchase order line % is cancelled or closed short; it takes no more goods (goods receipt line %)', NEW."purchaseOrderLineId", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GoodsReceiptLine_w2a_guard" BEFORE INSERT OR UPDATE ON "GoodsReceiptLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_goods_receipt_line_w2a_guard"();

-- Location (SCM-141): a SUBCONTRACTOR location names its workshop (partyId), and only it does; the workshop never
-- changes (so a location never becomes or stops being a workshop's).
CREATE FUNCTION "factory_location_party_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    RAISE EXCEPTION 'inventory: the workshop of location % never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'SUBCONTRACTOR') <> (NEW."partyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: location % is a SUBCONTRACTOR location exactly when it names the workshop that holds it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Location_party_guard" BEFORE INSERT OR UPDATE OF "kind", "partyId" ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "factory_location_party_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Style (PRD-018): the commodity code is 6, 8 or 10 digits (HS, CN, TARIC), the origin a two-letter country code, the
-- net mass above 0.
CREATE FUNCTION "factory_style_customs_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."hsCode" !~ '^[0-9]{6}([0-9]{2}([0-9]{2})?)?$' OR NEW."originCountry" !~ '^[A-Z]{2}$' OR NEW."netMassKg" <= 0 THEN
    RAISE EXCEPTION 'product: style % has a commodity code of 6, 8 or 10 digits, an origin of two capital letters (ISO 3166-1) and a net mass above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Style_customs_guard" BEFORE INSERT OR UPDATE OF "hsCode", "originCountry", "netMassKg" ON "Style"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_customs_guard"();

-- RoutingOperation (PRD-120): a fee per piece or transit days only with the workshop; neither negative, at most a year
-- in transit. (A released revision's steps change not at all: …_product_guards.)
CREATE FUNCTION "factory_routing_subcontract_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."supplierId" IS NULL AND (NEW."pricePerPiece" IS NOT NULL OR NEW."transitDays" IS NOT NULL))
     OR NEW."pricePerPiece" < 0 OR NEW."transitDays" < 0 OR NEW."transitDays" > 365 THEN
    RAISE EXCEPTION 'product: routing step % names its workshop before a fee or transit days, neither negative, at most 365 days', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoutingOperation_subcontract_guard" BEFORE INSERT OR UPDATE OF "supplierId", "pricePerPiece", "transitDays" ON "RoutingOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_routing_subcontract_guard"();

-- Certificate (QHS-105): its renewal is set once and never changed or cleared; it is another certificate of the same
-- holder (company or brand), valid from a later day. (A certificate renews at most one: the unique key.)
CREATE FUNCTION "factory_certificate_successor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  renewal record;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."successorId" IS NOT NULL AND NEW."successorId" IS DISTINCT FROM OLD."successorId" THEN
    RAISE EXCEPTION 'compliance: the renewal of certificate % is set once, never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."successorId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."successorId" IS NULL) THEN
    IF NEW."successorId" = NEW."id" THEN
      RAISE EXCEPTION 'compliance: certificate % does not renew itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c."companyId", c."holderPartyId", c."validFrom" INTO renewal FROM "Certificate" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."successorId";
    IF FOUND AND ((renewal."companyId", renewal."holderPartyId") IS DISTINCT FROM (NEW."companyId", NEW."holderPartyId") OR renewal."validFrom" <= NEW."validFrom") THEN
      RAISE EXCEPTION 'compliance: certificate % is renewed by a certificate of the same holder, valid from a later day', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Certificate_successor_guard" BEFORE INSERT OR UPDATE OF "successorId" ON "Certificate"
  FOR EACH ROW EXECUTE FUNCTION "factory_certificate_successor_guard"();

-- TypeChangeReview (PRD-285; Reg. 2016/425 Annex V 7.2)
--   INSERT   a review starts OPEN.
--   UPDATE   its subject (style, revisions, certificate) and creation never change; OPEN → NOTIFIED | NOT_NEEDED,
--            NOTIFIED → APPROVED | REFUSED; what changed is fixed once it leaves OPEN; a final review changes no more.
--   DELETE   never (kept with the technical documentation, art. 8(3)).
--   every row  `changes` is a list; the compared revision is another one; notifiedAt exactly from NOTIFIED on (not for
--            NOT_NEEDED); the answer (time, reference) exactly in APPROVED and REFUSED; the decision (time, who, note)
--            exactly in the final states, with its reason for NOT_NEEDED.
CREATE FUNCTION "factory_type_change_review_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compliance: type-change review % is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'compliance: type-change review % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."styleId", NEW."revisionId", NEW."certificateId", NEW."comparedRevisionId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."styleId", OLD."revisionId", OLD."certificateId", OLD."comparedRevisionId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'compliance: the style, revisions, certificate and creation of type-change review % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('NOTIFIED', 'NOT_NEEDED'))
                OR (OLD."status" = 'NOTIFIED' AND NEW."status" IN ('APPROVED', 'REFUSED'))) THEN
      RAISE EXCEPTION 'compliance: type-change review % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('APPROVED', 'REFUSED', 'NOT_NEEDED')
       AND (to_jsonb(NEW) - ARRAY['tenantId', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'compliance: type-change review % is %; it changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND NEW."changes" IS DISTINCT FROM OLD."changes" THEN
      RAISE EXCEPTION 'compliance: what changed in type-change review % is fixed once it left OPEN', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."notifiedAt" IS DISTINCT FROM OLD."notifiedAt" AND NOT (OLD."status" = 'OPEN' AND NEW."status" = 'NOTIFIED') THEN
      RAISE EXCEPTION 'compliance: type-change review % records when the notified body was told in the move to NOTIFIED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF jsonb_typeof(NEW."changes") IS DISTINCT FROM 'array' OR NEW."comparedRevisionId" = NEW."revisionId" THEN
    RAISE EXCEPTION 'compliance: type-change review % lists what changed, against another revision than the one that changes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."notifiedAt" IS NOT NULL) <> (NEW."status" IN ('NOTIFIED', 'APPROVED', 'REFUSED'))
     OR (NEW."answeredAt" IS NOT NULL) <> (NEW."status" IN ('APPROVED', 'REFUSED'))
     OR (NEW."answeredAt" IS NULL AND NEW."answerReference" IS NOT NULL)
     OR (NEW."decidedAt" IS NOT NULL) <> (NEW."status" IN ('APPROVED', 'REFUSED', 'NOT_NEEDED'))
     OR (NEW."decidedAt" IS NULL AND (NEW."decidedById" IS NOT NULL OR NEW."decisionNote" IS NOT NULL))
     OR (NEW."status" = 'NOT_NEEDED' AND btrim(coalesce(NEW."decisionNote", '')) = '') THEN
    RAISE EXCEPTION 'compliance: type-change review % is % with the wrong times (told from NOTIFIED on, answered in APPROVED or REFUSED, decided in a final state, with the reason when not needed)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "TypeChangeReview_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TypeChangeReview"
  FOR EACH ROW EXECUTE FUNCTION "factory_type_change_review_guard"();
CREATE TRIGGER "TypeChangeReview_no_truncate" BEFORE TRUNCATE ON "TypeChangeReview"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- SupplierItem (SCM-005): archived, never deleted; its supplier, company, material and colour never change (another
-- source is a new row); a factor above 0, no negative price, a minimum and multiple above 0, no negative lead time, a
-- currency of three capital letters.
CREATE FUNCTION "factory_supplier_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: approved source % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."itemId", NEW."itemColourId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."itemId", OLD."itemColourId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, material, colour and creation of approved source % never change (another source is a new row)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."purchaseFactor" <= 0 OR NEW."unitPrice" < 0 OR NEW."minOrderQty" <= 0 OR NEW."orderMultiple" <= 0 OR NEW."leadTimeDays" < 0
     OR NEW."currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'supply: approved source % has a factor above 0, no negative price, a minimum and multiple above 0, no negative lead time and an ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_item_guard"();
CREATE TRIGGER "SupplierItem_no_truncate" BEFORE TRUNCATE ON "SupplierItem"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- ReceiptDiscrepancy (SCM-118)
--   INSERT   it starts OPEN, on an OPEN or POSTED receipt, naming the receipt's supplier.
--   UPDATE   its receipt, supplier and creation never change; what is wrong (line, kind, quantity, note) changes only
--            while OPEN; OPEN → SENT | CLOSED, SENT → AGREED | CLOSED, AGREED → CREDITED | CLOSED, CREDITED → CLOSED;
--            a CLOSED one changes no more; sentAt and sentById are written in the move to SENT.
--   DELETE   only while OPEN (recorded by mistake, never sent).
--   every row  its line is a line of its receipt; a quantity above 0 with its unit, or neither; sent exactly from SENT on
--            (a discrepancy closed before it was sent never was); closedAt exactly while CLOSED.
CREATE FUNCTION "factory_receipt_discrepancy_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_state text;
  receipt_supplier uuid;
  line_receipt uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'inventory: discrepancy % is %; only an OPEN one (never sent) is removed', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'inventory: discrepancy % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."status"::text, r."supplierId" INTO receipt_state, receipt_supplier
      FROM "GoodsReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."receiptId";
    IF FOUND AND (receipt_state NOT IN ('OPEN', 'POSTED') OR receipt_supplier <> NEW."supplierId") THEN
      RAISE EXCEPTION 'inventory: discrepancy % is recorded on an OPEN or POSTED goods receipt (this one is %), naming its supplier', NEW."id", receipt_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."receiptId", NEW."supplierId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."receiptId", OLD."supplierId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'inventory: the receipt, supplier and creation of discrepancy % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('SENT', 'CLOSED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('AGREED', 'CLOSED'))
                OR (OLD."status" = 'AGREED' AND NEW."status" IN ('CREDITED', 'CLOSED'))
                OR (OLD."status" = 'CREDITED' AND NEW."status" = 'CLOSED')) THEN
      RAISE EXCEPTION 'inventory: discrepancy % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED'
       AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'siteId', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'inventory: discrepancy % is CLOSED; it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN'
       AND (NEW."seq", NEW."receiptLineId", NEW."kind", NEW."quantity", NEW."uom", NEW."note")
           IS DISTINCT FROM (OLD."seq", OLD."receiptLineId", OLD."kind", OLD."quantity", OLD."uom", OLD."note") THEN
      RAISE EXCEPTION 'inventory: discrepancy % is %; what was found changes only while it is OPEN', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."sentAt", NEW."sentById") IS DISTINCT FROM (OLD."sentAt", OLD."sentById") AND NOT (OLD."status" = 'OPEN' AND NEW."status" = 'SENT') THEN
      RAISE EXCEPTION 'inventory: discrepancy % records its report to the supplier in the move to SENT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."receiptLineId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."receiptLineId" IS DISTINCT FROM OLD."receiptLineId") THEN
    SELECT l."receiptId" INTO line_receipt FROM "GoodsReceiptLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."receiptLineId";
    IF FOUND AND line_receipt <> NEW."receiptId" THEN
      RAISE EXCEPTION 'inventory: discrepancy % names a line of its own goods receipt', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."quantity" IS NULL) <> (NEW."uom" IS NULL) OR NEW."quantity" <= 0
     OR (NEW."status" IN ('SENT', 'AGREED', 'CREDITED') AND NEW."sentAt" IS NULL) OR (NEW."status" = 'OPEN' AND NEW."sentAt" IS NOT NULL)
     OR (NEW."sentAt" IS NULL AND NEW."sentById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory: discrepancy % is % with a quantity above 0 and its unit (or neither), sent from SENT on and closed exactly when CLOSED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ReceiptDiscrepancy_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ReceiptDiscrepancy"
  FOR EACH ROW EXECUTE FUNCTION "factory_receipt_discrepancy_guard"();
CREATE TRIGGER "ReceiptDiscrepancy_no_truncate" BEFORE TRUNCATE ON "ReceiptDiscrepancy"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- SupplierClaim (SCM-134, SCM-135)
--   INSERT   a claim starts as DRAFT.
--   UPDATE   its company, number and creation never change; DRAFT → SENT | CANCELLED, SENT → ACCEPTED | REJECTED |
--            CLOSED, ACCEPTED → CLOSED, REJECTED → SENT | CLOSED; after DRAFT its kind, receipt, order, where it was
--            found, reason and currency are fixed; CLOSED and CANCELLED change no more but the internal note; sentAt and
--            sentById are written in a move to SENT, the supplier's answer in a move to ACCEPTED or REJECTED.
--   DELETE   never (cancelled or closed).
--   every row  a reason; a remedy from SENT on; sent from SENT on (never while DRAFT); answered while ACCEPTED or
--            REJECTED; closedAt exactly while CLOSED; cancelledAt with its reason exactly while CANCELLED; no negative
--            credit, an ISO 4217 currency; its receipt is of its supplier (and of its order, when both), its order too.
CREATE FUNCTION "factory_supplier_claim_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_supplier uuid;
  receipt_order uuid;
  order_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: claim % is cancelled or closed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: claim % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, number and creation of claim % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SENT', 'CANCELLED'))
                OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'REJECTED', 'CLOSED'))
                OR (OLD."status" = 'ACCEPTED' AND NEW."status" = 'CLOSED')
                OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('SENT', 'CLOSED'))) THEN
      RAISE EXCEPTION 'supply: claim % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT'
       AND (NEW."kind", NEW."goodsReceiptId", NEW."purchaseOrderId", NEW."foundAt", NEW."reason", NEW."currency")
           IS DISTINCT FROM (OLD."kind", OLD."goodsReceiptId", OLD."purchaseOrderId", OLD."foundAt", OLD."reason", OLD."currency") THEN
      RAISE EXCEPTION 'supply: claim % is %; what it is about is fixed once it is sent', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId', 'partyId', 'internalNote', 'version', 'updatedAt'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'siteId', 'partyId', 'internalNote', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'supply: claim % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."sentAt", NEW."sentById") IS DISTINCT FROM (OLD."sentAt", OLD."sentById") AND NOT (NEW."status" = 'SENT' AND OLD."status" <> 'SENT') THEN
      RAISE EXCEPTION 'supply: claim % records its send in a move to SENT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."supplierAnswer", NEW."answeredAt") IS DISTINCT FROM (OLD."supplierAnswer", OLD."answeredAt")
       AND NOT (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'REJECTED')) THEN
      RAISE EXCEPTION 'supply: claim % records the supplier''s answer in the move to ACCEPTED or REJECTED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR (NEW."goodsReceiptId", NEW."purchaseOrderId", NEW."partyId") IS DISTINCT FROM (OLD."goodsReceiptId", OLD."purchaseOrderId", OLD."partyId") THEN
    IF NEW."goodsReceiptId" IS NOT NULL THEN
      SELECT r."supplierId", r."purchaseOrderId" INTO receipt_supplier, receipt_order
        FROM "GoodsReceipt" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."goodsReceiptId";
      IF FOUND AND (receipt_supplier <> NEW."partyId" OR (NEW."purchaseOrderId" IS NOT NULL AND receipt_order IS DISTINCT FROM NEW."purchaseOrderId")) THEN
        RAISE EXCEPTION 'supply: claim % names a goods receipt of its supplier (and of its purchase order)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."purchaseOrderId" IS NOT NULL THEN
      SELECT o."partyId" INTO order_party FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId";
      IF FOUND AND order_party <> NEW."partyId" THEN
        RAISE EXCEPTION 'supply: claim % names a purchase order of its supplier', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF btrim(NEW."reason") = '' OR NEW."expectedCreditAmount" < 0 OR NEW."currency" !~ '^[A-Z]{3}$'
     OR (NEW."status" NOT IN ('DRAFT', 'CANCELLED') AND NEW."remedy" IS NULL)
     OR (NEW."status" IN ('SENT', 'ACCEPTED', 'REJECTED', 'CLOSED')) <> (NEW."sentAt" IS NOT NULL)
     OR (NEW."sentAt" IS NULL AND NEW."sentById" IS NOT NULL)
     OR (NEW."status" IN ('ACCEPTED', 'REJECTED') AND NEW."answeredAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND (NEW."answeredAt" IS NOT NULL OR NEW."supplierAnswer" IS NOT NULL))
     OR (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED' AND btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'supply: claim % is % with the wrong fields (a reason; a remedy from SENT on; sent from SENT on; answered when ACCEPTED or REJECTED; closed or cancelled with its time and reason; no negative credit)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierClaim_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierClaim"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_claim_guard"();
CREATE TRIGGER "SupplierClaim_no_truncate" BEFORE TRUNCATE ON "SupplierClaim"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- SupplierClaimLine
--   INSERT, DELETE  only while its claim is DRAFT.
--   UPDATE  it never moves to another claim; what it is about (discrepancy, receipt line, item, colour, lot, hide,
--           quantities, reason, place) changes only while the claim is DRAFT; its move and return DDT are set once, and
--           nothing changes once the claim is CLOSED or CANCELLED.
--   every row  quantities above 0, no negative cost or credit; a hide with its lot; its discrepancy is of the claim's
--           supplier; its move is of the line's item, lot and hide.
CREATE FUNCTION "factory_supplier_claim_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
  discrepancy_supplier uuid;
  moved record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."claimId" <> OLD."claimId" THEN
      RAISE EXCEPTION 'supply: claim line % never moves to another claim', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."claimId";
    SELECT c."status"::text INTO state FROM "SupplierClaim" c WHERE c."tenantId" = OLD."tenantId" AND c."id" = OLD."claimId" FOR SHARE;
  ELSE
    part_of := NEW."claimId";
    SELECT c."status"::text INTO state FROM "SupplierClaim" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."claimId" FOR SHARE;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: claim % is %; its lines are added and removed only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  ELSE
    IF state IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'supply: claim % is %; its lines change no more', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (NEW."seq", NEW."discrepancyId", NEW."receiptLineId", NEW."itemId", NEW."itemColourId", NEW."lotId", NEW."hideId", NEW."quantity", NEW."uom", NEW."baseQuantity", NEW."reason")
           IS DISTINCT FROM
           (OLD."seq", OLD."discrepancyId", OLD."receiptLineId", OLD."itemId", OLD."itemColourId", OLD."lotId", OLD."hideId", OLD."quantity", OLD."uom", OLD."baseQuantity", OLD."reason") THEN
      RAISE EXCEPTION 'supply: claim % is %; what its lines are about changes only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."moveId" IS NOT NULL AND NEW."moveId" IS DISTINCT FROM OLD."moveId") OR (OLD."ddtId" IS NOT NULL AND NEW."ddtId" IS DISTINCT FROM OLD."ddtId") THEN
      RAISE EXCEPTION 'supply: the stock move and return DDT of claim line % are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR NEW."unitCost" < 0 OR NEW."creditAmount" < 0 OR (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL) THEN
    RAISE EXCEPTION 'supply: claim line % has its quantities above 0, no negative cost or credit, and a hide only with its lot', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."discrepancyId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."discrepancyId" IS DISTINCT FROM OLD."discrepancyId") THEN
    SELECT d."supplierId" INTO discrepancy_supplier FROM "ReceiptDiscrepancy" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."discrepancyId";
    IF FOUND AND discrepancy_supplier <> NEW."partyId" THEN
      RAISE EXCEPTION 'supply: claim line % pursues a discrepancy of its claim''s supplier', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."moveId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."moveId" IS DISTINCT FROM OLD."moveId") THEN
    SELECT m."itemId", m."lotId", m."hideId" INTO moved FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."moveId";
    IF FOUND AND (moved."itemId" <> NEW."itemId" OR (NEW."lotId" IS NOT NULL AND moved."lotId" IS DISTINCT FROM NEW."lotId")
                  OR (NEW."hideId" IS NOT NULL AND moved."hideId" IS DISTINCT FROM NEW."hideId")) THEN
      RAISE EXCEPTION 'supply: claim line % names a stock move of its own item, lot and hide', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SupplierClaimLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SupplierClaimLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_supplier_claim_line_guard"();
CREATE TRIGGER "SupplierClaimLine_no_truncate" BEFORE TRUNCATE ON "SupplierClaimLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- SubcontractOrder (SCM-138, SCM-141)
--   INSERT   an order starts as DRAFT.
--   UPDATE   its company, number and creation never change; the status moves as subcontract.prisma says; its terms
--            change only while DRAFT (afterwards only its status and times, the expected-back date, its note and
--            internal note); CLOSED and CANCELLED change no more but the internal note; issuedAt and issuedById are
--            written in DRAFT → ISSUED and cleared in ISSUED → DRAFT; DRAFT → ISSUED needs an operation, and its amount
--            is the sum of its operations'.
--   DELETE   never (cancelled).
--   every row  its location is a SUBCONTRACTOR location of its workshop; issued exactly from ISSUED to CLOSED (a
--            cancellation keeps it or not); closedAt exactly while CLOSED; cancelledAt with its reason exactly while
--            CANCELLED; no negative amount, an ISO 4217 currency, due back on or after its order date.
CREATE FUNCTION "factory_subcontract_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  progress CONSTANT text[] := ARRAY['status', 'issuedAt', 'issuedById', 'closedAt', 'cancelledAt', 'cancelReason', 'expectedBackDate',
    'note', 'internalNote', 'version', 'updatedAt'];
  place record;
  op_count integer;
  op_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supply: subcontract order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: subcontract order % starts as DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'supply: the company, number and creation of subcontract order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('ISSUED', 'CANCELLED'))
                OR (OLD."status" = 'ISSUED' AND NEW."status" IN ('DRAFT', 'AT_WORKSHOP', 'CANCELLED'))
                OR (OLD."status" = 'AT_WORKSHOP' AND NEW."status" IN ('ISSUED', 'PARTLY_RECEIVED', 'RECEIVED'))
                OR (OLD."status" = 'PARTLY_RECEIVED' AND NEW."status" IN ('AT_WORKSHOP', 'RECEIVED'))
                OR (OLD."status" = 'RECEIVED' AND NEW."status" IN ('PARTLY_RECEIVED', 'CLOSED'))) THEN
      RAISE EXCEPTION 'supply: subcontract order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - (kept || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || progress)) THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; its terms change only while it is DRAFT', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED')
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."issuedAt", NEW."issuedById") IS DISTINCT FROM (OLD."issuedAt", OLD."issuedById")
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED') OR (OLD."status" = 'ISSUED' AND NEW."status" = 'DRAFT')) THEN
      RAISE EXCEPTION 'supply: subcontract order % gets its issue time when it is issued, and loses it when it goes back to DRAFT', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'ISSUED' THEN
      SELECT count(*), coalesce(sum(o."netAmount"), 0) INTO op_count, op_total
        FROM "SubcontractOperation" o WHERE o."tenantId" = NEW."tenantId" AND o."subcontractOrderId" = NEW."id";
      IF op_count = 0 THEN
        RAISE EXCEPTION 'supply: subcontract order % has no operation; it cannot be issued', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF op_total <> NEW."netAmount" THEN
        RAISE EXCEPTION 'supply: the amount of subcontract order % (%) is not the sum of its operations (%)', NEW."id", NEW."netAmount", op_total
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR (NEW."locationId", NEW."partyId") IS DISTINCT FROM (OLD."locationId", OLD."partyId") THEN
    SELECT l."kind"::text AS kind, l."partyId" INTO place FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."locationId";
    IF FOUND AND (place.kind <> 'SUBCONTRACTOR' OR place."partyId" IS DISTINCT FROM NEW."partyId") THEN
      RAISE EXCEPTION 'supply: subcontract order % sends its work to a SUBCONTRACTOR location of its workshop', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."netAmount" < 0 OR NEW."currency" !~ '^[A-Z]{3}$' OR NEW."expectedBackDate" < NEW."orderDate"
     OR (NEW."status" IN ('ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED') AND NEW."issuedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."issuedAt" IS NOT NULL)
     OR (NEW."issuedAt" IS NULL AND NEW."issuedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED' AND btrim(coalesce(NEW."cancelReason", '')) = '') THEN
    RAISE EXCEPTION 'supply: subcontract order % is % with the wrong fields (no negative amount, an ISO 4217 currency, due back after its date, issued from ISSUED on, closed or cancelled with its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractOrder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SubcontractOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_order_guard"();
CREATE TRIGGER "SubcontractOrder_no_truncate" BEFORE TRUNCATE ON "SubcontractOrder"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- SubcontractOperation (PRD-120, SCM-138, SCM-142)
--   INSERT, DELETE  only while its order is DRAFT; a new operation has sent and back nothing yet.
--   UPDATE  it never moves to another order; while its order is not DRAFT only the counts, the expected-back date and
--           the note change, and nothing once the order is CLOSED or CANCELLED.
--   every row  pieces above 0 and, per size, adding up to them; no negative fee, amount or count; back (good,
--           defective, scrapped) at most what was sent, sent at most the pieces.
CREATE FUNCTION "factory_subcontract_operation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  progress CONSTANT text[] := ARRAY['piecesSent', 'piecesBackGood', 'piecesBackDefective', 'piecesScrapped', 'expectedBackDate', 'note', 'version', 'updatedAt'];
  state text;
  part_of uuid;
  size_pieces numeric;
  size_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."subcontractOrderId" <> OLD."subcontractOrderId" THEN
      RAISE EXCEPTION 'supply: subcontract operation % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    part_of := OLD."subcontractOrderId";
    SELECT s."status"::text INTO state FROM "SubcontractOrder" s WHERE s."tenantId" = OLD."tenantId" AND s."id" = OLD."subcontractOrderId" FOR SHARE;
  ELSE
    part_of := NEW."subcontractOrderId";
    SELECT s."status"::text INTO state FROM "SubcontractOrder" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."subcontractOrderId" FOR SHARE;
  END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    IF state IS NOT NULL AND state <> 'DRAFT' THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; its operations are added and removed only while it is DRAFT', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW."piecesSent" <> 0 OR NEW."piecesBackGood" <> 0 OR NEW."piecesBackDefective" <> 0 OR NEW."piecesScrapped" <> 0 THEN
      RAISE EXCEPTION 'supply: subcontract operation % is new; nothing was sent or came back yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF state IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; its operations change no more', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IS NOT NULL AND state <> 'DRAFT'
       AND (to_jsonb(NEW) - (ARRAY['tenantId', 'siteId', 'workOrderId'] || progress)) IS DISTINCT FROM (to_jsonb(OLD) - (ARRAY['tenantId', 'siteId', 'workOrderId'] || progress)) THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; its operations change only while it is DRAFT (but for the pieces sent and back)', part_of, state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF jsonb_typeof(NEW."sizes") IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'supply: subcontract operation % lists its pieces per size', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), sum(CASE WHEN jsonb_typeof(e -> 'pieces') = 'number' THEN (e ->> 'pieces')::numeric END)
    INTO size_count, size_pieces FROM jsonb_array_elements(NEW."sizes") e;
  IF NEW."pieces" <= 0 OR NEW."pricePerPiece" < 0 OR NEW."netAmount" < 0
     OR NEW."piecesSent" < 0 OR NEW."piecesBackGood" < 0 OR NEW."piecesBackDefective" < 0 OR NEW."piecesScrapped" < 0
     OR NEW."piecesBackGood" + NEW."piecesBackDefective" + NEW."piecesScrapped" > NEW."piecesSent" OR NEW."piecesSent" > NEW."pieces"
     OR (size_count > 0 AND size_pieces IS DISTINCT FROM NEW."pieces"::numeric) THEN
    RAISE EXCEPTION 'supply: subcontract operation % has pieces above 0 (its sizes adding up to them), no negative fee, amount or count, and no more back than sent nor sent than pieces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractOperation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SubcontractOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_operation_guard"();
CREATE TRIGGER "SubcontractOperation_no_truncate" BEFORE TRUNCATE ON "SubcontractOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();

-- SubcontractKitLine (SCM-140, SCM-141)
--   INSERT  a line starts PLANNED, on an order not yet received, closed or cancelled.
--   UPDATE  it never moves to another order; PLANNED → SENT | CANCELLED, SENT → PLANNED (its transfer reversed);
--           CANCELLED changes no more; a SENT line's goods (item, colour, lot, hide, quantities) are fixed.
--   DELETE  only while PLANNED.
--   every row  quantities above 0; a hide with its lot; SENT exactly with its time and move, and the time, move and
--           DDT only while SENT; its move is a TRANSFER into the order's workshop location of the line's item, colour,
--           lot, hide and base quantity.
CREATE FUNCTION "factory_subcontract_kit_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  order_location uuid;
  moved record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'PLANNED' THEN
      RAISE EXCEPTION 'supply: kit line % is %; only a PLANNED line is removed', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT s."status"::text, s."locationId" INTO state, order_location
    FROM "SubcontractOrder" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."subcontractOrderId" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PLANNED' THEN
      RAISE EXCEPTION 'supply: kit line % starts PLANNED, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF state IN ('RECEIVED', 'CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'supply: subcontract order % is %; no kit line is added to it', NEW."subcontractOrderId", state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."subcontractOrderId" <> OLD."subcontractOrderId" THEN
      RAISE EXCEPTION 'supply: kit line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'PLANNED' AND NEW."status" IN ('SENT', 'CANCELLED')) OR (OLD."status" = 'SENT' AND NEW."status" = 'PLANNED')) THEN
      RAISE EXCEPTION 'supply: kit line % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId', 'partyId', 'version', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'siteId', 'partyId', 'version', 'updatedAt']) THEN
      RAISE EXCEPTION 'supply: kit line % is CANCELLED; it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SENT' AND NEW."status" = 'SENT'
       AND (NEW."itemId", NEW."itemColourId", NEW."lotId", NEW."hideId", NEW."quantity", NEW."uom", NEW."baseQuantity")
           IS DISTINCT FROM (OLD."itemId", OLD."itemColourId", OLD."lotId", OLD."hideId", OLD."quantity", OLD."uom", OLD."baseQuantity") THEN
      RAISE EXCEPTION 'supply: kit line % is SENT; the goods it sent are fixed', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."quantity" <= 0 OR NEW."baseQuantity" <= 0 OR (NEW."hideId" IS NOT NULL AND NEW."lotId" IS NULL)
     OR (NEW."status" = 'SENT') <> (NEW."sentAt" IS NOT NULL AND NEW."moveId" IS NOT NULL)
     OR (NEW."status" <> 'SENT' AND (NEW."sentAt" IS NOT NULL OR NEW."moveId" IS NOT NULL OR NEW."ddtId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'supply: kit line % is % with its quantities above 0, a hide only with its lot, and its time, move and DDT exactly while SENT', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."moveId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."moveId" IS DISTINCT FROM OLD."moveId") THEN
    SELECT m."reason"::text AS reason, m."toLocationId", m."itemId", m."itemColourId", m."lotId", m."hideId", m."baseQuantity"
      INTO moved FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."moveId";
    IF FOUND AND (moved.reason <> 'TRANSFER' OR moved."toLocationId" IS DISTINCT FROM order_location
                  OR (moved."itemId", moved."itemColourId", moved."lotId", moved."hideId") IS DISTINCT FROM (NEW."itemId", NEW."itemColourId", NEW."lotId", NEW."hideId")
                  OR moved."baseQuantity" <> NEW."baseQuantity") THEN
      RAISE EXCEPTION 'supply: kit line % names the TRANSFER move that put its goods (same item, colour, lot, hide and base quantity) into its order''s workshop location', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "SubcontractKitLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SubcontractKitLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_subcontract_kit_line_guard"();
CREATE TRIGGER "SubcontractKitLine_no_truncate" BEFORE TRUNCATE ON "SubcontractKitLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_supply_refuse_truncate"();
