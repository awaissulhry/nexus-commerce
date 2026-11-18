-- Written by hand (B-PR-40, EXTRA 1; no schema folder of its own), after 202611180001_production_wave5_guards and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Putting a customer's sample decision back (production plan, schema wave 5/5, B-PR-40 EXTRA 1 for B-PR-30b; lead decision
-- from build/notes pr3h "BLOCKED, schema"; plan §3 "decide for a brand or undo, always with a reason it reads"; 08-backend §4.6):
-- the office puts back the customer's answer to a SAMPLE, COLOUR, LEATHER, FABRIC or TRIM approval request (platform/approvals-out
-- reverse: the request's reversal written first, then the record's own effect, in ONE command); the record follows. For every
-- login, the owner included. The refusals are check_violation (SQLSTATE 23514); their words name no other customer.
--
--   SampleRound   a DECIDED round goes back to UNDER_REVIEW, its decision cleared (decision, comments, when, how, by whom) and
--                 nothing else, only when the approval request it names is about it, was answered at the very time the round
--                 was decided (the decision being put back is that answer: a portal, link or decided-for answer) and is reversed;
--                 any other change of a DECIDED or CANCELLED round stays refused as before.
--   SampleSwatch  a decided swatch is undecided again, its decision cleared and nothing else, by the same rule (its approval
--                 request about it, answered when it was decided, reversed); otherwise only its note changes, as before.
--   OrderGate     a gate passed by its sample round waits again (passedAt and passedById cleared, nothing else) only when that
--                 round is back without a decision and the approval request it names (about it) is reversed — the reversal of
--                 the round's approval — and no work started on the gate's order: no cut of leather logged (a cut log piece
--                 that was not reversed) and no bundle made (not VOID) for a cell of its lines (a work order that is not a
--                 REPAIR and not CANCELLED: change-requests readCuts' rule). Passed and started before stay written once otherwise.
--
-- Earlier functions REDEFINED here, each from its current body, word for word but for the lines marked B-PR-40:
--   factory_sample_round_guard   (…_changes_samples_w2b_guards, W2b-4 wave 29/33; not redefined since)
--   factory_sample_swatch_guard  (…_brand_asks_guards, B-PR-23)
--   factory_order_gate_guard     (…_brand_asks_guards, B-PR-23)
-- Their triggers stay as they are. New helpers: "factory_sample_decision_reversed" and "factory_order_gate_waits_again" (with
-- "factory_sales_order_work_started"). USED FROM EARLIER WAVES, as they are: "factory_changes_words_ok",
-- "factory_sample_cells_problem" and "factory_sample_decision_problem" (…_changes_samples_w2b_guards).

-- =====================================================================================================================
-- B-PR-40 helpers. Each reads rows as the session sees them (the office's command): a row it cannot see reads as none, so the
-- move back is refused.

-- The decision being put back is the answer of this approval request, and that answer was reversed: the request is about this
-- record, it was answered at the time the record was decided, and it names its reversal.
CREATE FUNCTION "factory_sample_decision_reversed"(p_tenant uuid, p_record_type text, p_record uuid, p_approval uuid, p_decided_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_approval IS NOT NULL AND p_decided_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM "ApprovalRequest" a
     WHERE a."tenantId" = p_tenant AND a."id" = p_approval AND a."recordType" = p_record_type AND a."recordId" = p_record
       AND a."answeredAt" = p_decided_at AND a."reversedAt" IS NOT NULL)
$$;

-- Work started on a sales order: a cut of leather logged (a cut log piece of 1 or more that was not reversed, nor is a reversal)
-- or a bundle made (not VOID) for a cell of one of its lines, of a work order that is not a REPAIR and not CANCELLED.
CREATE FUNCTION "factory_sales_order_work_started"(p_tenant uuid, p_order uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "WorkOrderSize" c
      JOIN "WorkOrder" w ON w."tenantId" = c."tenantId" AND w."id" = c."workOrderId"
      JOIN "SalesOrderLine" l ON l."tenantId" = c."tenantId" AND l."id" = c."salesOrderLineId"
     WHERE c."tenantId" = p_tenant AND l."orderId" = p_order AND w."kind" <> 'REPAIR' AND w."status" <> 'CANCELLED'
       AND (EXISTS (SELECT 1 FROM "Bundle" b WHERE b."tenantId" = c."tenantId" AND b."workOrderSizeId" = c."id" AND b."status" <> 'VOID')
            OR EXISTS (SELECT 1 FROM "CutLogPiece" p JOIN "CutLog" g ON g."tenantId" = p."tenantId" AND g."id" = p."cutLogId"
                        WHERE p."tenantId" = c."tenantId" AND p."workOrderSizeId" = c."id" AND p."pieces" > 0 AND g."reversalOfId" IS NULL
                          AND NOT EXISTS (SELECT 1 FROM "CutLog" x WHERE x."tenantId" = g."tenantId" AND x."reversalOfId" = g."id"))))
$$;

-- A gate passed by its sample round may wait again: the round is back without a decision, the approval request it names (about
-- it) is reversed, and no work started on the gate's order.
CREATE FUNCTION "factory_order_gate_waits_again"(p_tenant uuid, p_round uuid, p_order uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_round IS NOT NULL
     AND EXISTS (SELECT 1 FROM "SampleRound" r
                   JOIN "ApprovalRequest" a ON a."tenantId" = r."tenantId" AND a."id" = r."approvalRequestId"
                  WHERE r."tenantId" = p_tenant AND r."id" = p_round AND r."decision" IS NULL
                    AND a."recordType" = 'SampleRound' AND a."recordId" = r."id" AND a."reversedAt" IS NOT NULL)
     AND NOT "factory_sales_order_work_started"(p_tenant, p_order)
$$;

-- =====================================================================================================================
-- SampleRound (SAL-311, SAL-312, PRD-158): REDEFINED from …_changes_samples_w2b_guards (its header there says the rest).
CREATE OR REPLACE FUNCTION "factory_sample_round_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a DECIDED or CANCELLED round may still be given: a certification sample's result and certificate (each once).
  after_end CONSTANT text[] := ARRAY['tenantId', 'testResult', 'certificateId', 'version', 'updatedAt'];
  -- B-PR-40: what putting back the answer that decided a round changes: back UNDER_REVIEW, its decision cleared.
  reopened CONSTANT text[] := ARRAY['tenantId', 'stage', 'decision', 'decisionComments', 'decidedAt', 'decidedVia', 'decidedById', 'version', 'updatedAt'];
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
    IF OLD."stage" IN ('DECIDED', 'CANCELLED') AND (to_jsonb(NEW) - after_end) IS DISTINCT FROM (to_jsonb(OLD) - after_end)
       -- B-PR-40: but a DECIDED round goes back UNDER_REVIEW, its decision cleared and nothing else, by the reversal of the
       -- approval request whose answer decided it (B-PR-30b; the API puts the gate it passed back to waiting after it).
       AND NOT (OLD."stage" = 'DECIDED' AND NEW."stage" = 'UNDER_REVIEW'
                AND (to_jsonb(NEW) - reopened) IS NOT DISTINCT FROM (to_jsonb(OLD) - reopened)
                AND "factory_sample_decision_reversed"(OLD."tenantId", 'SampleRound', OLD."id", OLD."approvalRequestId", OLD."decidedAt")) THEN
      RAISE EXCEPTION 'samples: sample round % is %; only a certification result and certificate may still come (a decided round goes back under review only by the reversal of the approval request that decided it)', OLD."id", OLD."stage"
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

-- =====================================================================================================================
-- SampleSwatch (SAL-314): REDEFINED from …_brand_asks_guards (B-PR-23; …_changes_samples_w2b_guards' header says the rest).
CREATE OR REPLACE FUNCTION "factory_sample_swatch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  after_decision CONSTANT text[] := ARRAY['tenantId', 'note', 'version', 'updatedAt'];
  -- B-PR-40: what putting back the answer that decided a swatch changes: its decision cleared.
  undecided CONSTANT text[] := ARRAY['tenantId', 'decision', 'decisionComments', 'decidedAt', 'decidedVia', 'decidedById', 'version', 'updatedAt'];
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
    IF OLD."decision" IS NOT NULL AND (to_jsonb(NEW) - after_decision) IS DISTINCT FROM (to_jsonb(OLD) - after_decision)
       -- B-PR-40: but a decided swatch is undecided again, its decision cleared and nothing else, by the reversal of the approval
       -- request whose answer decided it (B-PR-30b).
       AND NOT (NEW."decision" IS NULL
                AND (to_jsonb(NEW) - undecided) IS NOT DISTINCT FROM (to_jsonb(OLD) - undecided)
                AND "factory_sample_decision_reversed"(OLD."tenantId", 'SampleSwatch', OLD."id", OLD."approvalRequestId", OLD."decidedAt")) THEN
      RAISE EXCEPTION 'samples: swatch % is decided; only its note changes (it is undecided again only by the reversal of the approval request that decided it)', OLD."id"
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
  -- B-PR-23: FABRIC and TRIM read their material's kind too.
  IF TG_OP = 'INSERT' AND NEW."kind" IN ('LEATHER', 'FABRIC', 'TRIM') THEN
    SELECT i."kind"::text INTO material_kind FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND NEW."kind" = 'LEATHER' AND material_kind <> 'LEATHER' THEN
      RAISE EXCEPTION 'samples: a LEATHER swatch (%) is of a leather material, not of a %', NEW."id", material_kind
        USING ERRCODE = 'check_violation';
    END IF;
    -- B-PR-23: a FABRIC swatch of a textile, lining, membrane or padding; a TRIM swatch of a trim, hardware, thread or label.
    IF FOUND AND NEW."kind" = 'FABRIC' AND material_kind NOT IN ('TEXTILE', 'LINING', 'MEMBRANE', 'PADDING') THEN
      RAISE EXCEPTION 'samples: a FABRIC swatch (%) is of a textile, lining, membrane or padding, not of a %', NEW."id", material_kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF FOUND AND NEW."kind" = 'TRIM' AND material_kind NOT IN ('TRIM', 'HARDWARE', 'THREAD', 'LABEL') THEN
      RAISE EXCEPTION 'samples: a TRIM swatch (%) is of a trim, hardware, thread or label, not of a %', NEW."id", material_kind
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

-- =====================================================================================================================
-- OrderGate (PLN-186): REDEFINED from …_brand_asks_guards (B-PR-23; …_changes_samples_w2b_guards' header says the rest).
CREATE OR REPLACE FUNCTION "factory_order_gate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  round record;
  -- B-PR-40: what a passed gate's return to waiting changes: its pass cleared.
  rewaited CONSTANT text[] := ARRAY['tenantId', 'passedAt', 'passedById', 'version', 'updatedAt'];
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
    IF (OLD."passedAt" IS NOT NULL AND (NEW."passedAt", NEW."passedById") IS DISTINCT FROM (OLD."passedAt", OLD."passedById")
        -- B-PR-40: but a gate passed by its sample round waits again (its pass cleared, nothing else) by the reversal of the
        -- round's approval, the round back under review, while no work started on its order (B-PR-30b).
        AND NOT (NEW."passedAt" IS NULL AND NEW."passedById" IS NULL
                 AND (to_jsonb(NEW) - rewaited) IS NOT DISTINCT FROM (to_jsonb(OLD) - rewaited)
                 AND "factory_order_gate_waits_again"(OLD."tenantId", OLD."sampleRoundId", OLD."salesOrderId")))
       OR (OLD."overriddenAt" IS NOT NULL AND (NEW."overriddenAt", NEW."overriddenById", NEW."overrideReason") IS DISTINCT FROM (OLD."overriddenAt", OLD."overriddenById", OLD."overrideReason")) THEN
      RAISE EXCEPTION 'planning: gate % is passed, and started before, each once (a gate passed by its sample round waits again only by the reversal of the round''s approval, before work starts on its order)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."kind" = 'OTHER' AND NEW."label" IS NULL) OR NOT "factory_changes_words_ok"(NEW."label", 200, false) THEN
    RAISE EXCEPTION 'planning: gate % says what it is (up to 200 characters; required for OTHER)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- B-PR-23: a SIZE_SET gate names its size set round too.
  IF NEW."sampleRoundId" IS NOT NULL AND NEW."kind" NOT IN ('SAMPLE_APPROVED', 'PP_SAMPLE', 'SIZE_SET') THEN
    RAISE EXCEPTION 'planning: only a sample gate (SAMPLE_APPROVED, PP_SAMPLE, SIZE_SET) names a sample round (gate %)', NEW."id"
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
    -- B-PR-23: a SIZE_SET gate waits for a SIZE_SET round.
    IF FOUND AND NEW."kind" = 'SIZE_SET' AND round.kind <> 'SIZE_SET' THEN
      RAISE EXCEPTION 'planning: gate % waits for a SIZE_SET round, not a % one', NEW."id", round.kind
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
