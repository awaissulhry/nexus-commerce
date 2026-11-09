-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202611010302_changes_samples_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- Change control, release and samples, W2b-4 schema wave 29/33 (B-W2b-212; PRD-070, PRD-152, PRD-158, PRD-169, PRD-170,
-- PRD-191, PRD-232, PRD-259, MES-006, MES-018, SAL-311, SAL-312, SAL-314, SAL-316, PLN-186). apps/factory-api checks all of
-- this first and answers in words (B-W2b-226, -231, -246, -252, -263); these rules are the last word, for every login, the
-- owner included.
--
--   ChangeRequest      inserted OPEN, undecided, in no change order; numbered (CHANGE_REQUEST) at once, but an OPEN FLOOR
--                      request may wait for its number (a floor device cannot number it): given once, never changed, and
--                      set before it leaves OPEN; OPEN → IN_REVIEW | ACCEPTED | REJECTED, IN_REVIEW → ACCEPTED | REJECTED,
--                      ACCEPTED → DONE (its change order RELEASED); REJECTED and DONE never change; the decision (when, who,
--                      why for a rejection) written once; what, why and the revision fixed once decided; its company, site,
--                      source, party, sample round, style, work order and creation never change; a FLOOR request and one
--                      about a work order name the site; CUSTOMER and SUPPLIER exactly with a party, SAMPLE exactly with a
--                      round; the style of its company or tenant-wide, the work order of its style; a change order (of the
--                      same style: the reference) only while IN_REVIEW, ACCEPTED or DONE, never a REJECTED or CANCELLED
--                      one. Never deleted.
--   ChangeOrder        inserted DRAFT from a RELEASED revision of a style of its company (or tenant-wide), its number by
--                      `factory_document_number_guard` (…_numbering_floor_documents_guards, as it is); DRAFT → SUBMITTED |
--                      CANCELLED, SUBMITTED → APPROVED | REJECTED | CANCELLED, APPROVED → RELEASED | CANCELLED; out of
--                      DRAFT only the status, the times of the moves and the priority change, and nothing once REJECTED,
--                      RELEASED or CANCELLED; the times written once; the proposed revision a DRAFT one of the style after
--                      the one changed; submitted with it (still DRAFT); APPROVED only with at least one required approval
--                      APPROVED and none required undecided or any REJECTED; REJECTED only with a rejection; RELEASED only
--                      with its new revision RELEASED; a DATE effect exactly with its day. One live change order per
--                      proposed revision (a partial unique). Never deleted.
--   ChangeOrderItem    written, changed and removed only while its change order is DRAFT (its row FOR SHARE): a CHANGE line
--                      names a record (type and id) with what it is before and/or after; a WORK_IN_PROGRESS line an open
--                      work order of the change order's style and its disposition (one per work order: a partial unique).
--   ChangeApproval     named (undecided) and removed (undecided) while the change order is DRAFT or SUBMITTED; decided once,
--                      while it is SUBMITTED (a rejection says why); the approver is never the change order's author.
--   StyleRevision      REDEFINED `factory_style_revision_guard` (…_routings_instructions_w2b_guards, B-W2b-205's body as it
--                      is): a released or obsolete revision may also move its release scope and completeness score, and
--                      nothing else. Its own trigger: the colourways and sizes released are the style's, each once; on a
--                      RELEASED revision they only widen (empty = all never narrows again), on an OBSOLETE one they never
--                      change; the completeness score 0 to 100, none while DRAFT, given once.
--   WorkOrder          its own trigger: a SAMPLE work order names its sample round and only it does; the round never
--                      changes, is open when the work order is made, and its pinned revision is the work order's.
--   WorkOrderSize      REDEFINED `factory_work_order_size_guard` (…_production_w2a_guards, whole): a SAMPLE work order's cell
--                      is a size grid's (no measurement profile) and names a SIZE_GRID sales order line.
--   StoredFile         REDEFINED `factory_stored_file_floor_guard` (…_plant_care_w2b_guards, whole): a floor session may also
--                      add (and confirm the upload of) a PHOTO of a change request, of its site's company.
--   SampleRound        inserted neither DECIDED nor CANCELLED; its number by `factory_document_number_guard`; its company,
--                      style, kind, party and creation never change, its revision only while REQUESTED; the four manual
--                      stages move freely, DECIDED exactly with its decision, CANCELLED with when and why; once DECIDED or
--                      CANCELLED only the certification result and certificate may come, each once; the cells a list of
--                      the style's colourways and sizes with quantities; the charge with its currency; the decision whole
--                      (an OFFICE one by an office user; a PORTAL or LINK one the answer of its approval request: the same
--                      decision at the same time, by its portal user or its link); the approval request of kind SAMPLE
--                      about this round; certification columns only on a CERTIFICATION round. Never deleted.
--   SampleMeasurement  written and removed only while its round is open (its row FOR SHARE); the point, size and the spec
--                      frozen from it never change; measured, measured at and pass together, pass within the tolerance.
--   SampleComment      written and removed only while its round is open; resolved (with when and by whom) at any time.
--   SampleSwatch       of a colour and/or a lot of its material (a LEATHER swatch of a leather); what was sent and when fixed
--                      once sent; asked and decided only once sent; the decision as a round's (approval request kind COLOUR
--                      or LEATHER, about this swatch); once decided only its note changes; removed only before it is sent.
--   SampleShipment     added to a round not cancelled; its round, party, direction and creation never change; sent and
--                      received each set once, received after sent; a RETURN names no address; removed only before it is
--                      sent.
--   OrderGate          its order, kind and creation never change; OTHER says what it is; a round only for a sample gate (a
--                      PRE_PRODUCTION one for PP_SAMPLE), and passing with a round needs it approved; passed and overridden
--                      each written once; an override by someone who is neither the gate's owner nor its maker, with a
--                      reason; one per order and kind but OTHER (a partial unique); removed only while untouched.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the new checks are AFTER triggers (the
-- policies speak first), but the number guards (BEFORE, as everywhere). The tenant (and site) of a row are left to the
-- policies and the references, never compared here: a rule that reads another row skips a row this session cannot see. An
-- UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so a size or point code is checked for spaces only (a copy's carries a suffix), the
-- first rows the seeds give are the plain ones (an OPEN request, a DRAFT change order with a CHANGE line and an undecided
-- approval, a REQUESTED round, an unsent swatch and shipment, an OTHER gate), and the one-per rules are partial unique
-- indexes those rows stay outside of.
--
-- USED FROM EARLIER WAVES, as they are: "factory_document_number_guard" (…_numbering_floor_documents_guards),
-- "factory_styles_distinct" (…_styles_libraries_w2b_guards), "factory_quality_plant_in_scope" (…_quality_plant_w2a_guards).

CREATE FUNCTION "factory_changes_samples_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'changes and samples: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['ChangeRequest', 'ChangeOrder', 'ChangeOrderItem', 'ChangeApproval', 'SampleRound', 'SampleMeasurement',
                              'SampleComment', 'SampleSwatch', 'SampleShipment', 'OrderGate'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_changes_samples_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Words of at most `longest` characters, not blank, without control characters; `lines`: line breaks and tabs allowed (NULL:
-- not given, which the caller allows or not).
CREATE FUNCTION "factory_changes_words_ok"(words text, longest integer, lines boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT words IS NULL
      OR (btrim(words) <> '' AND char_length(words) <= longest
          AND CASE WHEN lines THEN words !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' ELSE words !~ '[[:cntrl:]]' END)
$$;

-- =====================================================================================================================
-- ChangeRequest (PRD-169, PRD-259, MES-006)
CREATE FUNCTION "factory_change_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'version', 'updatedAt'];
  style_company uuid;
  order_style uuid;
  order_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'changes: change request % is rejected, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."source", NEW."partyId", NEW."sampleRoundId", NEW."styleId", NEW."workOrderId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."siteId", OLD."source", OLD."partyId", OLD."sampleRoundId", OLD."styleId", OLD."workOrderId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'changes: the company, site, source, party, sample round, style, work order and creation of change request % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number" THEN
      RAISE EXCEPTION 'changes: the number % of change request % never changes', OLD."number", OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('IN_REVIEW', 'ACCEPTED', 'REJECTED'))
                OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('ACCEPTED', 'REJECTED'))
                OR (OLD."status" = 'ACCEPTED' AND NEW."status" = 'DONE')) THEN
      RAISE EXCEPTION 'changes: change request % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('REJECTED', 'DONE') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'changes: change request % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decidedAt" IS NOT NULL AND (NEW."decidedAt", NEW."decidedById", NEW."decisionNote") IS DISTINCT FROM (OLD."decidedAt", OLD."decidedById", OLD."decisionNote") THEN
      RAISE EXCEPTION 'changes: the decision on change request % is written once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('ACCEPTED', 'REJECTED', 'DONE') AND (NEW."title", NEW."reason", NEW."revisionId") IS DISTINCT FROM (OLD."title", OLD."reason", OLD."revisionId") THEN
      RAISE EXCEPTION 'changes: change request % is decided; what, why and the revision it is about stay as they were decided', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" <> 'OPEN' OR NEW."decidedAt" IS NOT NULL OR NEW."changeOrderId" IS NOT NULL THEN
    RAISE EXCEPTION 'changes: a new change request is OPEN, undecided and in no change order (request %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT "factory_changes_words_ok"(NEW."title", 200, false) OR NOT "factory_changes_words_ok"(NEW."reason", 4000, true)
     OR NOT "factory_changes_words_ok"(NEW."decisionNote", 2000, true) THEN
    RAISE EXCEPTION 'changes: change request % says what should change (up to 200 characters) and why (up to 4000), and a decision note up to 2000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."number" IS NOT NULL AND btrim(NEW."number") = '') OR (NEW."number" IS NULL AND (NEW."source" <> 'FLOOR' OR NEW."status" <> 'OPEN')) THEN
    RAISE EXCEPTION 'changes: change request % has its number from its company''s CHANGE_REQUEST series; only an OPEN request from the floor waits for it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" = 'FLOOR' OR NEW."workOrderId" IS NOT NULL) AND NEW."siteId" IS NULL THEN
    RAISE EXCEPTION 'changes: change request % names its site: a floor request comes from one, a work order is at one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."source" IN ('CUSTOMER', 'SUPPLIER')) <> (NEW."partyId" IS NOT NULL) OR (NEW."source" = 'SAMPLE') <> (NEW."sampleRoundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'changes: change request % from % names the customer or supplier who asked (exactly for those) and the sample round that raised it (exactly for SAMPLE)', NEW."id", NEW."source"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('ACCEPTED', 'REJECTED', 'DONE')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL)
     OR (NEW."decidedAt" IS NULL AND NEW."decisionNote" IS NOT NULL)
     OR (NEW."status" = 'REJECTED' AND NEW."decisionNote" IS NULL) THEN
    RAISE EXCEPTION 'changes: change request % is % with the wrong decision: when and by whom exactly once decided, why for a rejection', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."changeOrderId" IS NOT NULL AND NEW."status" NOT IN ('IN_REVIEW', 'ACCEPTED', 'DONE')) OR (NEW."status" = 'DONE' AND NEW."changeOrderId" IS NULL) THEN
    RAISE EXCEPTION 'changes: change request % is carried by a change order only while IN_REVIEW, ACCEPTED or DONE, and DONE by one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'changes: change request % is about a style of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."workOrderId" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId" AND w."styleId" <> NEW."styleId") THEN
      RAISE EXCEPTION 'changes: change request % names a work order of its style', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."changeOrderId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."changeOrderId" IS DISTINCT FROM OLD."changeOrderId" OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    SELECT o."styleId", o."status"::text INTO order_style, order_state
      FROM "ChangeOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."changeOrderId" FOR SHARE;
    IF FOUND AND ((NEW."status" = 'DONE' AND order_state <> 'RELEASED')
                  OR (NEW."changeOrderId" IS DISTINCT FROM OLD."changeOrderId" AND order_state IN ('REJECTED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'changes: change request % is carried by a change order that is not rejected or cancelled, and is DONE once that one is RELEASED (it is %)', NEW."id", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ChangeRequest_guard" AFTER INSERT OR UPDATE OR DELETE ON "ChangeRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_change_request_guard"();

-- =====================================================================================================================
-- ChangeOrder (PRD-170)
CREATE FUNCTION "factory_change_order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'version', 'updatedAt'];
  moves CONSTANT text[] := ARRAY['tenantId', 'status', 'priority', 'submittedAt', 'decidedAt', 'releasedAt', 'releasedById', 'cancelledAt',
    'cancelReason', 'version', 'updatedAt'];
  style_company uuid;
  from_state text;
  from_number integer;
  to_state text;
  to_number integer;
  named integer;
  approved integer;
  waiting integer;
  rejected integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'changes: change order % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."styleId", NEW."authorId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."styleId", OLD."authorId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'changes: the company, style, author and creation of change order % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('SUBMITTED', 'CANCELLED'))
                OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED'))
                OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('RELEASED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'changes: change order % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('REJECTED', 'RELEASED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'changes: change order % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - moves) IS DISTINCT FROM (to_jsonb(OLD) - moves) THEN
      RAISE EXCEPTION 'changes: change order % is %; only its status, the times of its moves and its priority change (what it changes was fixed when it was submitted)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt")
       OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
       OR (OLD."releasedAt" IS NOT NULL AND (NEW."releasedAt", NEW."releasedById") IS DISTINCT FROM (OLD."releasedAt", OLD."releasedById")) THEN
      RAISE EXCEPTION 'changes: the times of change order % are written once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'changes: a new change order is DRAFT, not % (order %)', NEW."status", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT "factory_changes_words_ok"(NEW."title", 200, false) OR NOT "factory_changes_words_ok"(NEW."reason", 4000, true)
     OR NOT "factory_changes_words_ok"(NEW."description", 10000, true) OR NOT "factory_changes_words_ok"(NEW."cancelReason", 1000, true) THEN
    RAISE EXCEPTION 'changes: change order % says what changes (up to 200 characters) and why (up to 4000), a description up to 10 000 and a cancel reason up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."effect" = 'DATE') <> (NEW."effectiveDate" IS NOT NULL) THEN
    RAISE EXCEPTION 'changes: change order % takes effect on a day exactly when its effect is DATE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DRAFT' AND NEW."submittedAt" IS NOT NULL)
     OR (NEW."status" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'RELEASED') AND NEW."submittedAt" IS NULL)
     OR (NEW."status" IN ('DRAFT', 'SUBMITTED') AND NEW."decidedAt" IS NOT NULL)
     OR (NEW."status" IN ('APPROVED', 'REJECTED', 'RELEASED') AND NEW."decidedAt" IS NULL)
     OR (NEW."status" = 'RELEASED') <> (NEW."releasedAt" IS NOT NULL)
     OR (NEW."releasedAt" IS NULL) <> (NEW."releasedById" IS NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL)
     OR NEW."decidedAt" < NEW."submittedAt" OR NEW."releasedAt" < NEW."decidedAt" THEN
    RAISE EXCEPTION 'changes: change order % is % with the wrong times: submitted from SUBMITTED on, decided when APPROVED or REJECTED (kept when RELEASED), released with who released it exactly when RELEASED, cancelled with why exactly when CANCELLED, in that order', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'changes: change order % changes a style of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."fromRevisionId" IS DISTINCT FROM OLD."fromRevisionId" OR NEW."toRevisionId" IS DISTINCT FROM OLD."toRevisionId" THEN
    SELECT r."status"::text, r."revision" INTO from_state, from_number
      FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."fromRevisionId";
    IF FOUND AND from_state <> 'RELEASED' THEN
      RAISE EXCEPTION 'changes: change order % changes the style''s RELEASED revision (revision % is %)', NEW."id", from_number, from_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."toRevisionId" IS NOT NULL THEN
      SELECT r."status"::text, r."revision" INTO to_state, to_number
        FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."toRevisionId";
      IF FOUND AND (to_state <> 'DRAFT' OR to_number <= from_number) THEN
        RAISE EXCEPTION 'changes: change order % proposes a DRAFT revision of the style after the one it changes (revision % is %)', NEW."id", to_number, to_state
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" <> OLD."status" THEN
    IF NEW."status" IN ('SUBMITTED', 'RELEASED') THEN
      IF NEW."toRevisionId" IS NULL THEN
        RAISE EXCEPTION 'changes: change order % is submitted with the DRAFT revision that holds the change', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."status"::text INTO to_state FROM "StyleRevision" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."toRevisionId" FOR SHARE;
      IF FOUND AND to_state <> (CASE NEW."status" WHEN 'SUBMITTED' THEN 'DRAFT' ELSE 'RELEASED' END) THEN
        RAISE EXCEPTION 'changes: change order % is % with its new revision %, not %', NEW."id", NEW."status",
          (CASE NEW."status" WHEN 'SUBMITTED' THEN 'still DRAFT' ELSE 'RELEASED' END), to_state
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" IN ('APPROVED', 'REJECTED') THEN
      SELECT count(*),
             count(*) FILTER (WHERE a."required" AND a."decision" = 'APPROVED'),
             count(*) FILTER (WHERE a."required" AND a."decision" IS NULL),
             count(*) FILTER (WHERE a."decision" = 'REJECTED')
        INTO named, approved, waiting, rejected
        FROM "ChangeApproval" a WHERE a."tenantId" = NEW."tenantId" AND a."changeOrderId" = NEW."id";
      IF NEW."status" = 'APPROVED' AND (approved = 0 OR waiting > 0 OR rejected > 0) THEN
        RAISE EXCEPTION 'changes: change order % is approved once a required approval is APPROVED, none required waits and none is REJECTED (% named, % approved, % waiting, % rejected)', NEW."id", named, approved, waiting, rejected
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."status" = 'REJECTED' AND rejected = 0 THEN
        RAISE EXCEPTION 'changes: change order % is rejected only by an approver''s rejection', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ChangeOrder_number" BEFORE INSERT OR UPDATE ON "ChangeOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('change order', 'CHANGE_ORDER');
CREATE TRIGGER "ChangeOrder_guard" AFTER INSERT OR UPDATE OR DELETE ON "ChangeOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_change_order_guard"();

-- One live change order per proposed revision: a DRAFT revision holds one change.
CREATE UNIQUE INDEX "ChangeOrder_one_live_per_to_revision" ON "ChangeOrder" ("tenantId", "toRevisionId")
  WHERE "toRevisionId" IS NOT NULL AND "status" NOT IN ('REJECTED', 'CANCELLED');

-- =====================================================================================================================
-- ChangeOrderItem (PRD-170, PRD-171, MES-006)
CREATE FUNCTION "factory_change_order_item_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_state text;
  order_style uuid;
  order_style_of_work uuid;
  work_state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  SELECT o."status"::text, o."styleId" INTO order_state, order_style
    FROM "ChangeOrder" o
   WHERE o."tenantId" = coalesce(NEW."tenantId", OLD."tenantId") AND o."id" = coalesce(NEW."changeOrderId", OLD."changeOrderId") FOR SHARE;
  IF FOUND AND order_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'changes: the lines of change order % change only while it is DRAFT (it is %)', coalesce(NEW."changeOrderId", OLD."changeOrderId"), order_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."changeOrderId", NEW."kind", NEW."createdAt", NEW."createdById")
                          IS DISTINCT FROM (OLD."id", OLD."changeOrderId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'changes: the change order, kind and creation of line % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR NOT "factory_changes_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'changes: line % of a change order has its place from 1 and a note up to 1000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'CHANGE'
     AND (NEW."recordType" IS NULL OR NEW."recordType" !~ '^[A-Z][A-Za-z0-9]{0,59}$' OR NEW."recordId" IS NULL
          OR (NEW."field" IS NOT NULL AND NEW."field" !~ '^[A-Za-z][A-Za-z0-9_.]{0,99}$')
          OR (NEW."before" IS NULL AND NEW."after" IS NULL)
          OR NEW."siteId" IS NOT NULL OR NEW."workOrderId" IS NOT NULL OR NEW."disposition" IS NOT NULL) THEN
    RAISE EXCEPTION 'changes: change line % names the record it touches (a model name and id, a field name or none) and what it is before and/or after, and no work order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'WORK_IN_PROGRESS'
     AND (NEW."workOrderId" IS NULL OR NEW."siteId" IS NULL OR NEW."disposition" IS NULL
          OR NEW."recordType" IS NOT NULL OR NEW."recordId" IS NOT NULL OR NEW."field" IS NOT NULL OR NEW."before" IS NOT NULL OR NEW."after" IS NOT NULL) THEN
    RAISE EXCEPTION 'changes: work in progress line % names an open work order and what happens to it, and no record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workOrderId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."workOrderId" IS DISTINCT FROM OLD."workOrderId") THEN
    SELECT w."styleId", w."status"::text INTO order_style_of_work, work_state
      FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND AND (order_style_of_work IS DISTINCT FROM order_style OR work_state IN ('CLOSED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'changes: line % names an open work order of the change order''s style (work order % is %)', NEW."id", NEW."workOrderId", work_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ChangeOrderItem_guard" AFTER INSERT OR UPDATE OR DELETE ON "ChangeOrderItem"
  FOR EACH ROW EXECUTE FUNCTION "factory_change_order_item_guard"();

-- One work in progress line per work order of a change order.
CREATE UNIQUE INDEX "ChangeOrderItem_one_per_work_order" ON "ChangeOrderItem" ("tenantId", "changeOrderId", "workOrderId")
  WHERE "workOrderId" IS NOT NULL;

-- =====================================================================================================================
-- ChangeApproval (PRD-170; the four eyes)
CREATE FUNCTION "factory_change_approval_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'version', 'updatedAt'];
  change_order record;
  seen boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  SELECT o."status"::text AS status, o."authorId" INTO change_order
    FROM "ChangeOrder" o
   WHERE o."tenantId" = coalesce(NEW."tenantId", OLD."tenantId") AND o."id" = coalesce(NEW."changeOrderId", OLD."changeOrderId") FOR SHARE;
  seen := FOUND;
  IF TG_OP = 'DELETE' THEN
    IF OLD."decision" IS NOT NULL OR (seen AND change_order.status NOT IN ('DRAFT', 'SUBMITTED')) THEN
      RAISE EXCEPTION 'changes: approval % is removed only undecided, while its change order is DRAFT or SUBMITTED', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."decision" IS NOT NULL OR (seen AND change_order.status NOT IN ('DRAFT', 'SUBMITTED')) THEN
      RAISE EXCEPTION 'changes: an approver is named undecided, while the change order is DRAFT or SUBMITTED (approval %)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW."id", NEW."changeOrderId", NEW."stage", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."changeOrderId", OLD."stage", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'changes: the change order, stage and creation of approval % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decision" IS NOT NULL AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'changes: approval % is decided; the decision is written once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF seen AND OLD."decision" IS NULL AND NEW."decision" IS NOT NULL AND change_order.status <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'changes: approval % is decided while its change order is SUBMITTED (it is %)', OLD."id", change_order.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF seen AND NEW."decision" IS NULL AND change_order.status NOT IN ('DRAFT', 'SUBMITTED') THEN
      RAISE EXCEPTION 'changes: approval % changes only while its change order is DRAFT or SUBMITTED (it is %)', OLD."id", change_order.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."stage" < 1 THEN
    RAISE EXCEPTION 'changes: approval % is of stage 1 or later', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."decision" IS NULL) <> (NEW."decidedAt" IS NULL)
     OR (NEW."decision" IS NULL AND NEW."reason" IS NOT NULL)
     OR (NEW."decision" = 'REJECTED' AND NEW."reason" IS NULL)
     OR NOT "factory_changes_words_ok"(NEW."reason", 2000, true) THEN
    RAISE EXCEPTION 'changes: approval % is decided with its time, and a rejection says why (up to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF seen AND NEW."approverId" = change_order."authorId" THEN
    RAISE EXCEPTION 'changes: the approver of change order % is never its author (approval %)', NEW."changeOrderId", NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ChangeApproval_guard" AFTER INSERT OR UPDATE OR DELETE ON "ChangeApproval"
  FOR EACH ROW EXECUTE FUNCTION "factory_change_approval_guard"();

-- =====================================================================================================================
-- StyleRevision (…_routings_instructions_w2b_guards), REDEFINED whole: B-W2b-205's body as it is, with the release scope
-- and the completeness score among what a released or obsolete revision may still change (their rules: the trigger below).
-- Every other column of a released revision stays frozen. The triggers stay.
CREATE OR REPLACE FUNCTION "factory_style_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a released or obsolete revision may still change: its status (RELEASED → OBSOLETE), its effectiveTo (by
  -- "StyleRevision_w2b4_effectivity"), the row's version and time; the tenant is the policies'.
  -- W2b-4 wave 29/33 (B-W2b-212): and its release scope and completeness score (by "StyleRevision_w2b4_release_scope").
  moves CONSTANT text[] := ARRAY['tenantId', 'status', 'effectiveTo', 'releasedColourwayIds', 'releasedSizes', 'completenessPct', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'product: revision % is %; it is kept, never deleted', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."styleId", NEW."revision", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."styleId", OLD."revision", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the style, number and creation of revision % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('RELEASED', 'OBSOLETE'))
                OR (OLD."status" = 'RELEASED' AND NEW."status" = 'OBSOLETE')) THEN
      RAISE EXCEPTION 'product: revision % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'DRAFT' AND (to_jsonb(NEW) - moves) IS DISTINCT FROM (to_jsonb(OLD) - moves) THEN
      RAISE EXCEPTION 'product: revision % is %; it never changes, a change is a new revision', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF (NEW."status" = 'RELEASED' AND NEW."releasedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND (NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL)) THEN
    RAISE EXCEPTION 'product: revision % is % with the wrong release time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- StyleRevision's release scope (PRD-191) and completeness score (PRD-232): its own trigger.
CREATE FUNCTION "factory_style_revision_release_scope"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_colourways uuid[] := coalesce(NEW."releasedColourwayIds", ARRAY[]::uuid[]);
  new_sizes text[] := coalesce(NEW."releasedSizes", ARRAY[]::text[]);
  old_colourways uuid[];
  old_sizes text[];
  range text[];
  scope_changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_colourways := coalesce(OLD."releasedColourwayIds", ARRAY[]::uuid[]);
    old_sizes := coalesce(OLD."releasedSizes", ARRAY[]::text[]);
    scope_changed := new_colourways IS DISTINCT FROM old_colourways OR new_sizes IS DISTINCT FROM old_sizes;
    IF NOT scope_changed AND NEW."completenessPct" IS NOT DISTINCT FROM OLD."completenessPct" AND NEW."status" = OLD."status" THEN
      RETURN NULL;
    END IF;
  ELSE
    scope_changed := cardinality(new_colourways) > 0 OR cardinality(new_sizes) > 0;
  END IF;

  IF scope_changed THEN
    IF NOT "factory_styles_distinct"(new_colourways) OR NOT "factory_styles_distinct"(new_sizes) THEN
      RAISE EXCEPTION 'product: revision % is released for each colourway and size once', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(new_colourways) AS c(id)
                WHERE NOT EXISTS (SELECT 1 FROM "Colourway" w WHERE w."tenantId" = NEW."tenantId" AND w."styleId" = NEW."styleId" AND w."id" = c.id)) THEN
      RAISE EXCEPTION 'product: revision % is released for colourways of its style', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."sizes" INTO range FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND NOT (new_sizes <@ coalesce(range, ARRAY[]::text[])) THEN
      RAISE EXCEPTION 'product: revision % is released for sizes of its style''s range', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."status" = 'OBSOLETE' THEN
      RAISE EXCEPTION 'product: revision % is OBSOLETE; what it was released for never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."status" = 'RELEASED'
       AND ((cardinality(old_colourways) = 0 AND cardinality(new_colourways) > 0)
            OR (cardinality(new_colourways) > 0 AND NOT (new_colourways @> old_colourways))
            OR (cardinality(old_sizes) = 0 AND cardinality(new_sizes) > 0)
            OR (cardinality(new_sizes) > 0 AND NOT (new_sizes @> old_sizes))) THEN
      RAISE EXCEPTION 'product: revision % is RELEASED; what it is released for only widens (more colourways or sizes, or all of them), never narrows', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."completenessPct" IS NOT NULL AND (NEW."completenessPct" < 0 OR NEW."completenessPct" > 100 OR NEW."status" = 'DRAFT') THEN
    RAISE EXCEPTION 'product: revision % has its completeness score (0 to 100) from its release on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."completenessPct" IS NOT NULL AND NEW."completenessPct" IS DISTINCT FROM OLD."completenessPct" THEN
    RAISE EXCEPTION 'product: the completeness score of revision % at its release is given once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleRevision_w2b4_release_scope" AFTER INSERT OR UPDATE OF "releasedColourwayIds", "releasedSizes", "completenessPct", "status" ON "StyleRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_release_scope"();

-- =====================================================================================================================
-- WorkOrder (MES-018): a SAMPLE work order and its round. Its own trigger; production's factory_work_order_guard untouched
-- (it keeps the kind and the style, and releases a work order only with a RELEASED revision, so a sample work order is
-- released once the round's pinned revision is).
CREATE FUNCTION "factory_work_order_sample_round"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  round record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."kind", NEW."sampleRoundId", NEW."styleRevisionId") IS NOT DISTINCT FROM (OLD."kind", OLD."sampleRoundId", OLD."styleRevisionId") THEN
    RETURN NULL;
  END IF;
  IF (NEW."kind" = 'SAMPLE') <> (NEW."sampleRoundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'production: a SAMPLE work order names the sample round it makes, and only a SAMPLE one does (work order %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."sampleRoundId" IS DISTINCT FROM OLD."sampleRoundId" THEN
    RAISE EXCEPTION 'production: the sample round of work order % never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sampleRoundId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r."revisionId", r."stage"::text AS stage INTO round FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND round.stage IN ('DECIDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'production: sample round % is %; no work order is made for it', NEW."sampleRoundId", round.stage
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleRevisionId" IS NOT NULL AND NEW."styleRevisionId" <> round."revisionId" THEN
    RAISE EXCEPTION 'production: sample work order % is made from its round''s pinned revision', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "WorkOrder_w2b4_sample_round" AFTER INSERT OR UPDATE OF "kind", "sampleRoundId", "styleRevisionId" ON "WorkOrder"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_order_sample_round"();

-- WorkOrderSize (…_production_w2a_guards), REDEFINED whole: as there, but a SAMPLE work order's cell is a size grid's (no
-- measurement profile) and names a SIZE_GRID sales order line (the order that charges the samples: a cell needs one). The
-- triggers stay.
CREATE OR REPLACE FUNCTION "factory_work_order_size_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  order_kind text;
  part_of uuid;
  line record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."workOrderId" <> OLD."workOrderId" THEN
      RAISE EXCEPTION 'production: work order cell % never moves to another work order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    part_of := NEW."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."workOrderId" FOR SHARE;
  ELSE
    part_of := OLD."workOrderId";
    SELECT w."status"::text, w."kind"::text INTO state, order_kind FROM "WorkOrder" w WHERE w."tenantId" = OLD."tenantId" AND w."id" = OLD."workOrderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'production: work order % is %; its size quantities are frozen (MES-005), they change only while it is DRAFT', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1 OR btrim(NEW."size") = '' THEN
    RAISE EXCEPTION 'production: work order cell % has a size and at least one piece', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind IS NOT NULL AND order_kind <> 'REPAIR'
     AND ((order_kind = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
          OR (order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1)) THEN
    RAISE EXCEPTION 'production: work order cell % is one made-to-measure unit with its measurement profile, or a size-grid cell without one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF order_kind = 'REPAIR' AND NEW."measurementProfileId" IS NOT NULL AND NEW."quantity" <> 1 THEN
    RAISE EXCEPTION 'production: repair cell % repairs one made-to-measure garment (one unit with its profile)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."styleId", l."colourwayId", l."kind"::text AS kind, l."measurementProfileId" INTO line
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND
     AND ((line."styleId", line."colourwayId", line."measurementProfileId") IS DISTINCT FROM (NEW."styleId", NEW."colourwayId", NEW."measurementProfileId")
          OR (order_kind IS NOT NULL AND order_kind <> 'REPAIR'
              AND line.kind <> CASE WHEN order_kind = 'SAMPLE' THEN 'SIZE_GRID' ELSE order_kind END)) THEN
    RAISE EXCEPTION 'production: work order cell % makes its sales order line %: the same style, colourway, kind and measurement profile (a repair: any kind; a sample: a size grid''s)', NEW."id", NEW."salesOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- StoredFile, for a floor session only (…_plant_care_w2b_guards), REDEFINED whole: as there, and a floor session may also
-- add a PHOTO of a change request (PRD-259: report a spec problem with a photo), shared with the office and that floor only,
-- announced (PENDING_UPLOAD), with no office user, retention date or category, of its site's company, and confirm its
-- upload. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_stored_file_floor_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'floorSiteId', 'status', 'availableAt', 'quarantineReason', 'scanStatus', 'version', 'updatedAt'];
  record_company uuid;
  record_site uuid;
  record_status text;
  -- W2b-4 wave 29/33 (B-W2b-212; PRD-259): a photo of a change request the floor sends.
  change_photo boolean;
BEGIN
  IF current_user <> 'factory_floor_runtime' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."floorSiteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT ((OLD."kind" IN ('PHOTO', 'AUDIO') AND OLD."recordType" IN ('MaintenanceRequest', 'MaintenanceJob'))
            OR (OLD."kind" = 'PHOTO' AND OLD."recordType" = 'ChangeRequest'))
       OR (to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed)
       OR (NEW."status" <> OLD."status" AND NOT (OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED')))
       OR (NEW."scanStatus" <> OLD."scanStatus" AND NOT (OLD."scanStatus" = 'NOT_SCANNED' AND NEW."scanStatus" = 'PENDING')) THEN
      RAISE EXCEPTION 'files: the floor confirms the upload of its own photos and voice notes of a maintenance request or job, or photos of a change request, nothing else (file %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  change_photo := NEW."kind" = 'PHOTO' AND NEW."recordType" = 'ChangeRequest';
  IF NOT (change_photo OR (NEW."kind" IN ('PHOTO', 'AUDIO') AND NEW."recordType" IN ('MaintenanceRequest', 'MaintenanceJob')))
     OR NOT (NEW."visibility" @> ARRAY['OFFICE', 'FLOOR']::"FileAudience"[] AND NEW."visibility" <@ ARRAY['OFFICE', 'FLOOR']::"FileAudience"[])
     OR NEW."status" <> 'PENDING_UPLOAD' OR NEW."createdById" IS NOT NULL OR NEW."retainUntil" IS NOT NULL
     OR (NEW."category" IS NOT NULL AND (change_photo OR NEW."category" NOT IN ('BEFORE_WORK', 'AFTER_WORK'))) THEN
    RAISE EXCEPTION 'files: the floor adds only the photos and voice notes of a maintenance request or job and the photos of a change request, shared with the office and its floor, announced first (file %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A change request's photo (W2b-4): the floor inserts the request and cannot read it, so the photo is checked against the
  -- session's site only (its company); the office reads a request's photos by record type and id.
  IF change_photo THEN
    SELECT s."companyId" INTO record_company FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."floorSiteId";
    IF FOUND AND record_company IS DISTINCT FROM NEW."companyId" THEN
      RAISE EXCEPTION 'files: file % is a photo of a change request of this site''s company', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."recordType" = 'MaintenanceJob' THEN
    SELECT j."companyId", j."siteId", j."status"::text INTO record_company, record_site, record_status FROM "MaintenanceJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."recordId";
  ELSE
    SELECT r."companyId", r."siteId", r."status"::text INTO record_company, record_site, record_status FROM "MaintenanceRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END IF;
  IF NOT FOUND OR (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."floorSiteId") OR record_status IN ('CLOSED', 'CANCELLED', 'MERGED') THEN
    RAISE EXCEPTION 'files: file % is a photo or voice note of an open maintenance request or job of this site and its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- SampleRound (SAL-311, SAL-312, PRD-158)

-- What is wrong with a round's cells (null: nothing): a list of 1 to 200 objects {"colourwayId"?: a colourway of the style,
-- "size": a size of the style's range, "quantity": an integer from 1 to 1000}, each colourway and size once.
CREATE FUNCTION "factory_sample_cells_problem"(p_tenant uuid, p_style uuid, cells jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  cell jsonb;
  range text[];
  seen text[] := ARRAY[]::text[];
  colourway uuid;
  cell_key text;
BEGIN
  IF jsonb_typeof(cells) IS DISTINCT FROM 'array' OR jsonb_array_length(cells) NOT BETWEEN 1 AND 200 THEN
    RETURN 'a list of 1 to 200 cells';
  END IF;
  SELECT s."sizes" INTO range FROM "Style" s WHERE s."tenantId" = p_tenant AND s."id" = p_style;
  FOR cell IN SELECT value FROM jsonb_array_elements(cells) LOOP
    IF jsonb_typeof(cell) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(cell) AS k(name) WHERE k.name NOT IN ('colourwayId', 'size', 'quantity')) THEN
      RETURN 'cells of a colourway, a size and a quantity only';
    END IF;
    IF jsonb_typeof(cell -> 'size') IS DISTINCT FROM 'string' OR (range IS NOT NULL AND NOT ((cell ->> 'size') = ANY (range))) THEN
      RETURN format('a size of the style''s range in every cell (not %s)', coalesce(cell ->> 'size', 'none'));
    END IF;
    IF jsonb_typeof(cell -> 'quantity') IS DISTINCT FROM 'number' OR (cell ->> 'quantity') !~ '^[0-9]{1,4}$' OR (cell ->> 'quantity')::integer NOT BETWEEN 1 AND 1000 THEN
      RETURN 'a whole quantity from 1 to 1000 in every cell';
    END IF;
    colourway := NULL;
    IF jsonb_typeof(cell -> 'colourwayId') IS NOT NULL AND jsonb_typeof(cell -> 'colourwayId') <> 'null' THEN
      IF jsonb_typeof(cell -> 'colourwayId') <> 'string' OR (cell ->> 'colourwayId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN 'a colourway as its id';
      END IF;
      colourway := (cell ->> 'colourwayId')::uuid;
      IF NOT EXISTS (SELECT 1 FROM "Colourway" w WHERE w."tenantId" = p_tenant AND w."styleId" = p_style AND w."id" = colourway) THEN
        RETURN format('a colourway of the style (not %s)', colourway);
      END IF;
    END IF;
    cell_key := coalesce(colourway::text, '-') || '/' || (cell ->> 'size');
    IF cell_key = ANY (seen) THEN
      RETURN 'each colourway and size once';
    END IF;
    seen := seen || cell_key;
  END LOOP;
  RETURN NULL;
END
$$;

-- What is wrong with a sample decision (null: nothing), of a round or a swatch: its approval request (when named) asks this
-- kind of decision about this record; no decision, no words, time, way or decider; a decision has its time and way, words
-- for APPROVED_WITH_COMMENTS and REJECTED; an OFFICE one names its office user; a PORTAL or LINK one is the answer of its
-- approval request (the same decision at the same time, by its portal user, or by its link with no user).
CREATE FUNCTION "factory_sample_decision_problem"(p_tenant uuid, p_record_type text, p_record uuid, p_kind text, p_approval uuid,
  p_decision text, p_comments text, p_at timestamptz, p_via text, p_by uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  request record;
  seen boolean := false;
BEGIN
  IF p_approval IS NOT NULL THEN
    SELECT a."kind"::text AS kind, a."recordType", a."recordId", a."status"::text AS status, a."answeredAt", a."answeredByUserId", a."answeredViaLinkId"
      INTO request FROM "ApprovalRequest" a WHERE a."tenantId" = p_tenant AND a."id" = p_approval;
    seen := FOUND;
    IF seen AND (request.kind <> p_kind OR request."recordType" <> p_record_type OR request."recordId" <> p_record) THEN
      RETURN format('its approval request asks a %s decision about this %s (it asks %s about %s %s)', p_kind, p_record_type, request.kind, request."recordType", request."recordId");
    END IF;
  END IF;
  IF p_decision IS NULL THEN
    IF p_comments IS NOT NULL OR p_at IS NOT NULL OR p_via IS NOT NULL OR p_by IS NOT NULL THEN
      RETURN 'no decision yet: no words, time, way or decider';
    END IF;
    RETURN NULL;
  END IF;
  IF p_at IS NULL OR p_via IS NULL THEN
    RETURN 'a decision has its time and the way it was made';
  END IF;
  IF p_decision IN ('APPROVED_WITH_COMMENTS', 'REJECTED') AND p_comments IS NULL THEN
    RETURN 'approved with comments or rejected: the comments say why';
  END IF;
  IF p_via = 'OFFICE' THEN
    IF p_by IS NULL THEN
      RETURN 'an office decision names the office user who recorded it';
    END IF;
    RETURN NULL;
  END IF;
  IF p_approval IS NULL THEN
    RETURN 'a decision in the portal or by link is the answer of its approval request';
  END IF;
  IF seen AND (request.status IS DISTINCT FROM CASE p_decision WHEN 'APPROVED' THEN 'APPROVED' WHEN 'APPROVED_WITH_COMMENTS' THEN 'APPROVED_WITH_CHANGES' ELSE 'REFUSED' END
               OR request."answeredAt" IS DISTINCT FROM p_at
               OR (p_via = 'PORTAL' AND (request."answeredByUserId" IS NULL OR p_by IS DISTINCT FROM request."answeredByUserId"))
               OR (p_via = 'LINK' AND (request."answeredViaLinkId" IS NULL OR p_by IS NOT NULL))) THEN
    RETURN 'a decision in the portal or by link is its approval request''s answer: the same decision, at its time, by its portal user or through its link';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "factory_sample_round_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a DECIDED or CANCELLED round may still be given: a certification sample's result and certificate (each once).
  after_end CONSTANT text[] := ARRAY['tenantId', 'testResult', 'certificateId', 'version', 'updatedAt'];
  problem text;
  style_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'samples: sample round % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."styleId", NEW."kind", NEW."partyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."styleId", OLD."kind", OLD."partyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'samples: the company, style, kind, party and creation of sample round % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."revisionId" <> OLD."revisionId" AND OLD."stage" <> 'REQUESTED' THEN
      RAISE EXCEPTION 'samples: sample round % is made from its pinned revision; it changes only while REQUESTED (it is %)', OLD."id", OLD."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."stage" IN ('DECIDED', 'CANCELLED') AND (to_jsonb(NEW) - after_end) IS DISTINCT FROM (to_jsonb(OLD) - after_end) THEN
      RAISE EXCEPTION 'samples: sample round % is %; only a certification result and certificate may still come', OLD."id", OLD."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."testResult" IS NOT NULL AND NEW."testResult" IS DISTINCT FROM OLD."testResult")
       OR (OLD."certificateId" IS NOT NULL AND NEW."certificateId" IS DISTINCT FROM OLD."certificateId") THEN
      RAISE EXCEPTION 'samples: the certification result and certificate of sample round % are written once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."stage" IN ('DECIDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'samples: a new sample round is neither decided nor cancelled (round %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."roundNo" < 1
     OR NOT "factory_changes_words_ok"(NEW."instructions", 4000, true) OR NOT "factory_changes_words_ok"(NEW."decisionComments", 4000, true)
     OR NOT "factory_changes_words_ok"(NEW."testZones", 1000, true) OR NOT "factory_changes_words_ok"(NEW."cancelReason", 1000, true) THEN
    RAISE EXCEPTION 'samples: sample round % has a round number from 1, instructions and decision comments up to 4000 characters, test zones and a cancel reason up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."chargeAmountMinor" IS NULL) <> (NEW."chargeCurrency" IS NULL) OR NEW."chargeAmountMinor" < 0 OR NEW."chargeCurrency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'samples: the charge of sample round % is 0 or more in a currency (ISO 4217), both or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stage" = 'DECIDED') <> (NEW."decision" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: sample round % is DECIDED exactly with its decision (it is %)', NEW."id", NEW."stage"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stage" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL) OR (NEW."stage" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: sample round % is cancelled with when and why, exactly when CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" <> 'CERTIFICATION' AND (NEW."testZones" IS NOT NULL OR NEW."testResult" IS NOT NULL OR NEW."certificateId" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: only a CERTIFICATION round has test zones, a result and a certificate (round %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvalRequestId" IS NOT NULL AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'samples: sample round % asks its brand: an internal round has no approval request', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."cells" IS DISTINCT FROM OLD."cells" THEN
    problem := "factory_sample_cells_problem"(NEW."tenantId", NEW."styleId", NEW."cells");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'samples: the cells of sample round % are %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT'
     OR (NEW."approvalRequestId", NEW."decision", NEW."decisionComments", NEW."decidedAt", NEW."decidedVia", NEW."decidedById")
        IS DISTINCT FROM (OLD."approvalRequestId", OLD."decision", OLD."decisionComments", OLD."decidedAt", OLD."decidedVia", OLD."decidedById") THEN
    problem := "factory_sample_decision_problem"(NEW."tenantId", 'SampleRound', NEW."id", 'SAMPLE', NEW."approvalRequestId", NEW."decision"::text,
      NEW."decisionComments", NEW."decidedAt", NEW."decidedVia"::text, NEW."decidedById");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'samples: sample round % is wrong in its decision: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT s."companyId" INTO style_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'samples: sample round % is of a style of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SampleRound_number" BEFORE INSERT OR UPDATE ON "SampleRound"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('sample round', 'SAMPLE_ROUND');
CREATE TRIGGER "SampleRound_guard" AFTER INSERT OR UPDATE OR DELETE ON "SampleRound"
  FOR EACH ROW EXECUTE FUNCTION "factory_sample_round_guard"();

-- The stage of a round, its row locked FOR SHARE (a decision waits for the transaction that writes its fit, and a write
-- after the decision sees it decided); null when the session cannot see it.
CREATE FUNCTION "factory_sample_round_stage"(p_tenant uuid, p_round uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  SELECT r."stage"::text INTO state FROM "SampleRound" r WHERE r."tenantId" = p_tenant AND r."id" = p_round FOR SHARE;
  RETURN state;
END
$$;

-- =====================================================================================================================
-- SampleMeasurement (PRD-070)
CREATE FUNCTION "factory_sample_measurement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  state := "factory_sample_round_stage"(coalesce(NEW."tenantId", OLD."tenantId"), coalesce(NEW."roundId", OLD."roundId"));
  IF state IN ('DECIDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'samples: the fit of sample round % is written only while it is open (it is %)', coalesce(NEW."roundId", OLD."roundId"), state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW."id", NEW."roundId", NEW."pointOfMeasureId", NEW."pomCode", NEW."pomName", NEW."size", NEW."nominal", NEW."toleranceMinus", NEW."tolerancePlus", NEW."uom", NEW."createdAt", NEW."createdById")
         IS DISTINCT FROM
         (OLD."id", OLD."roundId", OLD."pointOfMeasureId", OLD."pomCode", OLD."pomName", OLD."size", OLD."nominal", OLD."toleranceMinus", OLD."tolerancePlus", OLD."uom", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'samples: measurement % keeps its round, point, size and the spec frozen from it', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR NEW."pomCode" !~ '^\S{1,60}$' OR NOT "factory_changes_words_ok"(NEW."pomName", 200, false) OR NEW."size" !~ '^\S{1,40}$'
     OR NOT "factory_changes_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'samples: measurement % has its row from 1, a point code (up to 60, no spaces), a name up to 200, a size (up to 40, no spaces), a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."nominal" <= 0 OR NEW."toleranceMinus" < 0 OR NEW."tolerancePlus" < 0 OR NEW."uom" NOT IN ('CM', 'MM') OR NEW."measured" <= 0 THEN
    RAISE EXCEPTION 'samples: measurement % has a nominal value above 0, tolerances of 0 or more, a measured value above 0, in CM or MM', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."measured" IS NULL) <> (NEW."measuredAt" IS NULL) OR (NEW."measured" IS NULL) <> (NEW."pass" IS NULL)
     OR NEW."pass" IS DISTINCT FROM (NEW."measured" BETWEEN NEW."nominal" - NEW."toleranceMinus" AND NEW."nominal" + NEW."tolerancePlus") THEN
    RAISE EXCEPTION 'samples: measurement % has its measured value, when and whether it is within the tolerance (% - % … + %) together', NEW."id", NEW."nominal", NEW."toleranceMinus", NEW."tolerancePlus"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SampleMeasurement_guard" AFTER INSERT OR UPDATE OR DELETE ON "SampleMeasurement"
  FOR EACH ROW EXECUTE FUNCTION "factory_sample_measurement_guard"();

-- =====================================================================================================================
-- SampleComment (PRD-152)
CREATE FUNCTION "factory_sample_comment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  resolution CONSTANT text[] := ARRAY['tenantId', 'resolved', 'resolvedAt', 'resolvedById', 'version', 'updatedAt'];
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  -- Resolving moves at any time; anything else only while the round is open.
  IF TG_OP <> 'UPDATE' OR (to_jsonb(NEW) - resolution) IS DISTINCT FROM (to_jsonb(OLD) - resolution) THEN
    state := "factory_sample_round_stage"(coalesce(NEW."tenantId", OLD."tenantId"), coalesce(NEW."roundId", OLD."roundId"));
    IF state IN ('DECIDED', 'CANCELLED') THEN
      RAISE EXCEPTION 'samples: the comments of sample round % are written only while it is open (it is %)', coalesce(NEW."roundId", OLD."roundId"), state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."roundId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."roundId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'samples: the round and creation of comment % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."pomCode" IS NOT NULL AND NEW."pomCode" !~ '^\S{1,60}$') OR (NEW."pointOfMeasureId" IS NOT NULL AND NEW."pomCode" IS NULL)
     OR NOT "factory_changes_words_ok"(NEW."bodyArea", 100, false) OR NEW."text" IS NULL OR NOT "factory_changes_words_ok"(NEW."text", 2000, true) THEN
    RAISE EXCEPTION 'samples: comment % says it in words (up to 2000 characters), about a point (its code: up to 60, no spaces) and/or a body area (up to 100)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resolved" <> (NEW."resolvedAt" IS NOT NULL) OR NEW."resolved" <> (NEW."resolvedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: comment % is resolved exactly with when and by whom', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SampleComment_guard" AFTER INSERT OR UPDATE OR DELETE ON "SampleComment"
  FOR EACH ROW EXECUTE FUNCTION "factory_sample_comment_guard"();

-- =====================================================================================================================
-- SampleSwatch (SAL-314)
CREATE FUNCTION "factory_sample_swatch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  after_decision CONSTANT text[] := ARRAY['tenantId', 'note', 'version', 'updatedAt'];
  problem text;
  material_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'samples: swatch % was sent; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."styleId", NEW."roundId", NEW."partyId", NEW."kind", NEW."itemId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."styleId", OLD."roundId", OLD."partyId", OLD."kind", OLD."itemId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'samples: the style, round, brand, kind, material and creation of swatch % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."sentAt" IS NOT NULL AND (NEW."sentAt", NEW."itemColourId", NEW."lotSiteId", NEW."lotId") IS DISTINCT FROM (OLD."sentAt", OLD."itemColourId", OLD."lotSiteId", OLD."lotId") THEN
      RAISE EXCEPTION 'samples: swatch % was sent; what was sent and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."decision" IS NOT NULL AND (to_jsonb(NEW) - after_decision) IS DISTINCT FROM (to_jsonb(OLD) - after_decision) THEN
      RAISE EXCEPTION 'samples: swatch % is decided; only its note changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."itemColourId" IS NULL AND NEW."lotId" IS NULL) OR (NEW."lotSiteId" IS NULL) <> (NEW."lotId" IS NULL)
     OR NOT "factory_changes_words_ok"(NEW."note", 500, true) THEN
    RAISE EXCEPTION 'samples: swatch % is of a colour and/or a lot (with its site) of its material, with a note up to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sentAt" IS NULL AND (NEW."approvalRequestId" IS NOT NULL OR NEW."decision" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: swatch % is asked and decided once it is sent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."kind" = 'LEATHER' THEN
    SELECT i."kind"::text INTO material_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND material_kind <> 'LEATHER' THEN
      RAISE EXCEPTION 'samples: a LEATHER swatch (%) is of a leather material, not of a %', NEW."id", material_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT'
     OR (NEW."approvalRequestId", NEW."decision", NEW."decisionComments", NEW."decidedAt", NEW."decidedVia", NEW."decidedById")
        IS DISTINCT FROM (OLD."approvalRequestId", OLD."decision", OLD."decisionComments", OLD."decidedAt", OLD."decidedVia", OLD."decidedById") THEN
    problem := "factory_sample_decision_problem"(NEW."tenantId", 'SampleSwatch', NEW."id", NEW."kind"::text, NEW."approvalRequestId", NEW."decision"::text,
      NEW."decisionComments", NEW."decidedAt", NEW."decidedVia"::text, NEW."decidedById");
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'samples: swatch % is wrong in its decision: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SampleSwatch_guard" AFTER INSERT OR UPDATE OR DELETE ON "SampleSwatch"
  FOR EACH ROW EXECUTE FUNCTION "factory_sample_swatch_guard"();

-- =====================================================================================================================
-- SampleShipment (SAL-316)
CREATE FUNCTION "factory_sample_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'samples: sample shipment % was sent; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."roundId", NEW."partyId", NEW."direction", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."roundId", OLD."partyId", OLD."direction", OLD."createdAt", OLD."createdById")
       OR (OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt")
       OR (OLD."receivedAt" IS NOT NULL AND NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt") THEN
      RAISE EXCEPTION 'samples: the round, party, direction and creation of sample shipment % never change, and its sent and received times are set once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    state := "factory_sample_round_stage"(NEW."tenantId", NEW."roundId");
    IF state = 'CANCELLED' THEN
      RAISE EXCEPTION 'samples: sample round % is cancelled; nothing is shipped for it', NEW."roundId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."receivedAt" IS NOT NULL AND (NEW."sentAt" IS NULL OR NEW."receivedAt" < NEW."sentAt"))
     OR (NEW."direction" = 'RETURN' AND NEW."shipToAddressId" IS NOT NULL) THEN
    RAISE EXCEPTION 'samples: sample shipment % is received after it was sent, and a RETURN names no address of the party', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_changes_words_ok"(NEW."carrierName", 100, false) OR NOT "factory_changes_words_ok"(NEW."trackingNumber", 100, false)
     OR (NEW."trackingUrl" IS NOT NULL AND (NEW."trackingUrl" !~ '^https://[^[:space:][:cntrl:]]+$' OR char_length(NEW."trackingUrl") > 2000))
     OR NOT "factory_changes_words_ok"(NEW."note", 1000, true) THEN
    RAISE EXCEPTION 'samples: sample shipment % names its courier and tracking number (up to 100 characters each), the tracking page as an https address (up to 2000), a note up to 1000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SampleShipment_guard" AFTER INSERT OR UPDATE OR DELETE ON "SampleShipment"
  FOR EACH ROW EXECUTE FUNCTION "factory_sample_shipment_guard"();

-- =====================================================================================================================
-- OrderGate (PLN-186)
CREATE FUNCTION "factory_order_gate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  round record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."passedAt" IS NOT NULL OR OLD."overriddenAt" IS NOT NULL THEN
      RAISE EXCEPTION 'planning: gate % was passed or started before; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'planning: the order, kind and creation of gate % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."passedAt" IS NOT NULL AND (NEW."passedAt", NEW."passedById") IS DISTINCT FROM (OLD."passedAt", OLD."passedById"))
       OR (OLD."overriddenAt" IS NOT NULL AND (NEW."overriddenAt", NEW."overriddenById", NEW."overrideReason") IS DISTINCT FROM (OLD."overriddenAt", OLD."overriddenById", OLD."overrideReason")) THEN
      RAISE EXCEPTION 'planning: gate % is passed, and started before, each once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."kind" = 'OTHER' AND NEW."label" IS NULL) OR NOT "factory_changes_words_ok"(NEW."label", 200, false) THEN
    RAISE EXCEPTION 'planning: gate % says what it is (up to 200 characters; required for OTHER)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sampleRoundId" IS NOT NULL AND NEW."kind" NOT IN ('SAMPLE_APPROVED', 'PP_SAMPLE') THEN
    RAISE EXCEPTION 'planning: only a sample gate (SAMPLE_APPROVED, PP_SAMPLE) names a sample round (gate %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."passedAt" IS NULL) <> (NEW."passedById" IS NULL)
     OR (NEW."overriddenAt" IS NULL) <> (NEW."overriddenById" IS NULL) OR (NEW."overriddenAt" IS NULL) <> (NEW."overrideReason" IS NULL)
     OR NOT "factory_changes_words_ok"(NEW."overrideReason", 1000, true) THEN
    RAISE EXCEPTION 'planning: gate % is passed with when and by whom, and started before with when, by whom and why (up to 1000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."overriddenById" = NEW."ownerId" OR NEW."overriddenById" = NEW."createdById" THEN
    RAISE EXCEPTION 'planning: the order of gate % starts before it only by the word of someone who is neither its owner nor its maker', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sampleRoundId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."sampleRoundId" IS DISTINCT FROM OLD."sampleRoundId" OR NEW."passedAt" IS DISTINCT FROM OLD."passedAt") THEN
    SELECT r."kind"::text AS kind, r."decision"::text AS decision INTO round
      FROM "SampleRound" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sampleRoundId";
    IF FOUND AND NEW."kind" = 'PP_SAMPLE' AND round.kind <> 'PRE_PRODUCTION' THEN
      RAISE EXCEPTION 'planning: gate % waits for a PRE_PRODUCTION round, not a % one', NEW."id", round.kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."passedAt" IS NOT NULL AND round.decision IS DISTINCT FROM 'APPROVED' AND round.decision IS DISTINCT FROM 'APPROVED_WITH_COMMENTS' THEN
      RAISE EXCEPTION 'planning: gate % passes once its sample round is approved (it is %)', NEW."id", coalesce(round.decision, 'not decided')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderGate_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderGate"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_gate_guard"();

-- One gate per kind and order; OTHER as many as needed.
CREATE UNIQUE INDEX "OrderGate_one_per_kind" ON "OrderGate" ("tenantId", "salesOrderId", "kind") WHERE "kind" <> 'OTHER';
