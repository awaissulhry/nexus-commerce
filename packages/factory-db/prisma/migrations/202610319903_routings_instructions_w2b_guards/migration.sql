-- Written by hand (Prisma does not model triggers or partial indexes), after the generated
-- 202610319902_routings_instructions_w2b_schema and before the policy migration. When the migrations are renumbered, keep
-- this file as it is under its new timestamp.

-- Routings, standard minutes and work instructions, W2b-4 schema wave 25/33 (B-W2b-205; PRD-111, PRD-113, PRD-114,
-- PRD-117, PRD-118, PRD-119, PRD-124, PRD-126, PRD-128, MES-110, MES-119). apps/factory-api checks all of this first and
-- answers in words (B-W2b-214, -215, -225); these rules are the last word, for every login, the owner included.
--
--   minutes                    an operation's or a routing step's basic minutes and three allowances come together or not
--                              at all; basic above 0, each allowance from 0 to below 100 percent; the SMV is then
--                              round(basic × (1 + (personal + fatigue + delay) / 100), 3) (numeric, half away from 0).
--   Operation                  once it has an approved SMV version (APPROVED, or SUPERSEDED after an approval), its five
--                              numbers change only to those of an APPROVED version (PRD-113: an SMV change is a new
--                              version a second person approves). An operation never governed keeps W1's typed SMV.
--   OperationTimeVersion       inserted PROPOSED; PROPOSED → APPROVED | REJECTED (a decider who is not the proposer, with
--                              when; a rejection says why) | SUPERSEDED (replaced before any decision); APPROVED →
--                              SUPERSEDED; REJECTED and SUPERSEDED final; its numbers, source, day, reason and proposer
--                              never change; the decision is written once; never deleted.
--   RoutingOperation           (its own trigger, after the …_product_guards part rule) the minutes rule; set-up, wait and
--                              move minutes from 0; a named time version is APPROVED and its numbers are the step's (the
--                              reference keeps it of the step's operation); the cells it applies to: sizes of the style's
--                              range, colourways of the style, no blank or repeated value; a checkpoint plan is not an
--                              incoming or return plan, and of the style's company when the style has one.
--   RoutingOperationSizeTime,  parts of the step's revision: the …_product_guards part rule (factory_style_revision_part_guard,
--   OperationMachineSetting    as it is) refuses any write once the revision is released. A size code has no spaces and its
--                              extra minutes are not 0 and leave the step's minutes above 0. A setting belongs to a library
--                              operation or to one routing step (with its revision), never moves, and says something.
--   StyleRevision              REDEFINED `factory_style_revision_guard` (…_product_guards), whole: once out of DRAFT, every
--                              column but the status and effectiveTo is frozen, a column added later too (W1 listed its
--                              columns one by one). Its own trigger: effectiveTo after effectiveFrom, only on an OBSOLETE
--                              revision that was released, set once; a release that names no effectiveFrom takes the
--                              release's day (Europe/Rome).
--   WorkInstruction            its company, number, operation and revision never change (the number by
--                              `factory_document_number_guard`, …_numbering_floor_documents_guards, as it is); a revision
--                              with its style, or neither; the operation and the style are the company's or tenant-wide;
--                              one ACTIVE per company, operation and revision (or none): partial unique indexes; never
--                              deleted.
--   WorkInstructionVersion     inserted DRAFT; DRAFT → PUBLISHED (approved by someone who is not its author, with when;
--                              the instruction ACTIVE; at least one step; every medium's file AVAILABLE; what changed said
--                              from version 2) | DISCARDED; PUBLISHED → SUPERSEDED (with when); out of DRAFT nothing but the
--                              status and supersededAt changes; one PUBLISHED per instruction (partial unique); never
--                              deleted.
--   WorkInstructionStep,       written, changed and removed only while the version is DRAFT (its row FOR SHARE: a publish
--   WorkInstructionMedia       waits for an edit in flight); the version's status they carry moves only with the version's
--                              (the reference's ON UPDATE CASCADE, which this rule lets through); words per language as a
--                              JSON object of non-blank strings; a step's code and icon key without spaces; a PHOTO is an
--                              image, a VIDEO a video.
--   InstructionAcknowledgement inserted for a PUBLISHED or SUPERSEDED version (a floor session sees no other, and is refused
--                              one it cannot see on its own site); the worker's employee (factory_floor_work_employee_check,
--                              …_floor_work_w2b_guards, as it is); a language code; a floor session names its device; a
--                              client event id and the device's clock only with a device. Append-only for every login.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words. The tenant (and site) of a row are left
-- to the policies and the references, never compared here: a rule that reads another row skips a row this session cannot
-- see. An UPDATE that changes nothing passes. "Everything but these columns" is compared as jsonb, so a column added later
-- is frozen too unless a later migration names it.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so no rule here gives a unique key of ids alone ("once per worker and version" is the
-- API's), a size or step code is checked for spaces only, a version and a time version start DRAFT or PROPOSED, and the
-- one-ACTIVE and one-PUBLISHED rules are partial unique indexes the seeds' first rows stay outside of.

CREATE FUNCTION "factory_routings_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The minutes rule (PRD-111), shared by Operation, RoutingOperation and OperationTimeVersion.
CREATE FUNCTION "factory_minutes_from_allowances"(basic numeric, personal numeric, fatigue numeric, delay numeric) RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$
  SELECT round(basic * (1 + (personal + fatigue + delay) / 100), 3)
$$;

CREATE FUNCTION "factory_minutes_check"(what text, row_id uuid, smv numeric, basic numeric, personal numeric, fatigue numeric, delay numeric) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF basic IS NULL AND personal IS NULL AND fatigue IS NULL AND delay IS NULL THEN
    RETURN;
  END IF;
  IF basic IS NULL OR personal IS NULL OR fatigue IS NULL OR delay IS NULL THEN
    RAISE EXCEPTION 'product: % % gives its basic minutes and the personal, fatigue and delay allowances together, or none of them', what, row_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF basic <= 0 THEN
    RAISE EXCEPTION 'product: the basic minutes of % % are above 0', what, row_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF personal < 0 OR personal >= 100 OR fatigue < 0 OR fatigue >= 100 OR delay < 0 OR delay >= 100 THEN
    RAISE EXCEPTION 'product: each allowance of % % is from 0 to below 100 percent', what, row_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF smv IS DISTINCT FROM "factory_minutes_from_allowances"(basic, personal, fatigue, delay) THEN
    RAISE EXCEPTION 'product: the standard minutes of % % are % (basic % × (1 + (% + % + %) / 100)), not %', what, row_id,
      "factory_minutes_from_allowances"(basic, personal, fatigue, delay), basic, personal, fatigue, delay, smv
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Operation (PRD-111, PRD-113): the minutes rule; once governed, the SMV moves only to an approved version's numbers.
CREATE FUNCTION "factory_operation_minutes_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct")
         IS NOT DISTINCT FROM (OLD."standardMinutes", OLD."basicMinutes", OLD."personalPct", OLD."fatiguePct", OLD."delayPct") THEN
    RETURN NEW;
  END IF;
  PERFORM "factory_minutes_check"('operation', NEW."id", NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct");
  IF TG_OP = 'UPDATE'
     AND EXISTS (SELECT 1 FROM "OperationTimeVersion" v
                  WHERE v."tenantId" = NEW."tenantId" AND v."operationId" = NEW."id"
                    AND (v."status" = 'APPROVED' OR (v."status" = 'SUPERSEDED' AND v."decidedAt" IS NOT NULL)))
     AND NOT EXISTS (SELECT 1 FROM "OperationTimeVersion" v
                      WHERE v."tenantId" = NEW."tenantId" AND v."operationId" = NEW."id" AND v."status" = 'APPROVED'
                        AND (v."standardMinutes", v."basicMinutes", v."personalPct", v."fatiguePct", v."delayPct")
                            = (NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct")) THEN
    RAISE EXCEPTION 'product: operation % has an approved SMV; its minutes change only to those of an APPROVED version (an SMV change is a new version a second person approves)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Operation_minutes" BEFORE INSERT OR UPDATE ON "Operation"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_minutes_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- OperationTimeVersion (PRD-113): a proposal, decided once by a second person.
CREATE FUNCTION "factory_operation_time_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What may change: the decision (once) and the status; the tenant is the policies'.
  moves CONSTANT text[] := ARRAY['tenantId', 'status', 'decidedById', 'decidedAt', 'decisionNote', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product: SMV version % is kept, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PROPOSED' OR NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."decisionNote" IS NOT NULL THEN
      RAISE EXCEPTION 'product: SMV version % starts PROPOSED, with no decision', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."number" < 1 OR btrim(NEW."reason") = '' THEN
      RAISE EXCEPTION 'product: SMV version % has a number from 1 and says why it is proposed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM "factory_minutes_check"('SMV version', NEW."id", NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct");
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - moves) IS DISTINCT FROM (to_jsonb(OLD) - moves) THEN
    RAISE EXCEPTION 'product: SMV version % never changes its operation, number, minutes, source, day, reason or proposer; a change is a new version', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'PROPOSED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'SUPERSEDED'))
              OR (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'product: SMV version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."decidedAt" IS NOT NULL
     AND (NEW."decidedById", NEW."decidedAt", NEW."decisionNote") IS DISTINCT FROM (OLD."decidedById", OLD."decidedAt", OLD."decisionNote") THEN
    RAISE EXCEPTION 'product: the decision on SMV version % is written once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'PROPOSED' OR (OLD."status" = 'PROPOSED' AND NEW."status" = 'SUPERSEDED'))
     AND (NEW."decidedById", NEW."decidedAt", NEW."decisionNote") IS DISTINCT FROM (NULL::uuid, NULL::timestamptz, NULL::text) THEN
    RAISE EXCEPTION 'product: SMV version % carries a decision only when APPROVED or REJECTED (a proposal replaced before any decision has none)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('APPROVED', 'REJECTED') OR (NEW."status" = 'SUPERSEDED' AND (NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL)) THEN
    IF NEW."decidedById" IS NULL OR NEW."decidedAt" IS NULL THEN
      RAISE EXCEPTION 'product: SMV version % is % with who decided it and when', OLD."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."decidedById" = NEW."proposedById" THEN
      RAISE EXCEPTION 'product: SMV version % is decided by someone who did not propose it (four eyes)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."status" = 'REJECTED' AND (NEW."decisionNote" IS NULL OR btrim(NEW."decisionNote") = '') THEN
    RAISE EXCEPTION 'product: SMV version % is rejected with why', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationTimeVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OperationTimeVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_time_version_guard"();
CREATE TRIGGER "OperationTimeVersion_no_truncate" BEFORE TRUNCATE ON "OperationTimeVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_routings_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- RoutingOperation (PRD-111, PRD-113, PRD-119, PRD-126, PRD-128): its own trigger, named to fire after W1's
-- "RoutingOperation_revision_guard" (a released revision's step is refused by the part rule first).
CREATE FUNCTION "factory_routing_operation_depth_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  given record;
  style_sizes text[];
  style_company uuid;
  style_found boolean := false;
  plan record;
  colourways integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR (NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct", NEW."timeVersionId")
        IS DISTINCT FROM (OLD."standardMinutes", OLD."basicMinutes", OLD."personalPct", OLD."fatiguePct", OLD."delayPct", OLD."timeVersionId") THEN
    PERFORM "factory_minutes_check"('routing step', NEW."id", NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct");
    IF NEW."timeVersionId" IS NOT NULL THEN
      SELECT v."status"::text AS status, v."standardMinutes", v."basicMinutes", v."personalPct", v."fatiguePct", v."delayPct" INTO given
        FROM "OperationTimeVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."timeVersionId";
      IF FOUND THEN
        IF given.status <> 'APPROVED' THEN
          RAISE EXCEPTION 'product: routing step % copies an APPROVED SMV version of its operation, not a % one', NEW."id", given.status
            USING ERRCODE = 'check_violation';
        END IF;
        IF (given."standardMinutes", given."basicMinutes", given."personalPct", given."fatiguePct", given."delayPct")
           IS DISTINCT FROM (NEW."standardMinutes", NEW."basicMinutes", NEW."personalPct", NEW."fatiguePct", NEW."delayPct") THEN
          RAISE EXCEPTION 'product: routing step % names SMV version %, so its minutes and allowances are that version''s', NEW."id", NEW."timeVersionId"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW."setupMinutes" < 0 OR NEW."waitMinutes" < 0 OR NEW."moveMinutes" < 0 THEN
    RAISE EXCEPTION 'product: the set-up, wait and move minutes of routing step % are from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT'
     OR (NEW."appliesToSizes", NEW."appliesToColourwayIds", NEW."appliesToOptionValueIds", NEW."inspectionPlanId")
        IS DISTINCT FROM (OLD."appliesToSizes", OLD."appliesToColourwayIds", OLD."appliesToOptionValueIds", OLD."inspectionPlanId") THEN
    IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW."appliesToSizes", '{}'::text[])) AS s(code) WHERE s.code IS NULL OR s.code !~ '^\S+$')
       OR cardinality(coalesce(NEW."appliesToSizes", '{}'::text[])) <> (SELECT count(DISTINCT s.code) FROM unnest(coalesce(NEW."appliesToSizes", '{}'::text[])) AS s(code))
       OR cardinality(coalesce(NEW."appliesToColourwayIds", '{}'::uuid[])) <> (SELECT count(DISTINCT c.id) FROM unnest(coalesce(NEW."appliesToColourwayIds", '{}'::uuid[])) AS c(id))
       OR cardinality(coalesce(NEW."appliesToOptionValueIds", '{}'::uuid[])) <> (SELECT count(DISTINCT o.id) FROM unnest(coalesce(NEW."appliesToOptionValueIds", '{}'::uuid[])) AS o(id)) THEN
      RAISE EXCEPTION 'product: routing step % names each size, colourway and option value it is for once, a size by its code', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT s."sizes", s."companyId", true INTO style_sizes, style_company, style_found
      FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF style_found THEN
      IF NOT (coalesce(NEW."appliesToSizes", '{}'::text[]) <@ coalesce(style_sizes, '{}'::text[])) THEN
        RAISE EXCEPTION 'product: routing step % is only for sizes of its style''s range', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO colourways FROM "Colourway" c
        WHERE c."tenantId" = NEW."tenantId" AND c."styleId" = NEW."styleId" AND c."id" = ANY (coalesce(NEW."appliesToColourwayIds", '{}'::uuid[]));
      IF colourways <> cardinality(coalesce(NEW."appliesToColourwayIds", '{}'::uuid[])) THEN
        RAISE EXCEPTION 'product: routing step % is only for colourways of its own style', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."inspectionPlanId" IS NOT NULL THEN
      SELECT p."stage"::text AS stage, p."companyId" INTO plan FROM "InspectionPlan" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."inspectionPlanId";
      IF FOUND THEN
        IF plan.stage IN ('INCOMING', 'RETURN') THEN
          RAISE EXCEPTION 'product: the checkpoint of routing step % is an inspection of the work (cutting, in-line, end of line or final), not an % plan', NEW."id", plan.stage
            USING ERRCODE = 'check_violation';
        END IF;
        IF style_found AND style_company IS NOT NULL AND plan."companyId" <> style_company THEN
          RAISE EXCEPTION 'product: the checkpoint of routing step % is a plan of its style''s company', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoutingOperation_w2b4_depth" BEFORE INSERT OR UPDATE ON "RoutingOperation"
  FOR EACH ROW EXECUTE FUNCTION "factory_routing_operation_depth_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- RoutingOperationSizeTime (PRD-114): a part of the revision (the W1 part rule), a size code, extra minutes that are not 0
-- and leave the step's minutes above 0.
CREATE FUNCTION "factory_routing_size_time_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  step_minutes numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."size" !~ '^\S+$' OR NEW."extraMinutes" = 0 THEN
    RAISE EXCEPTION 'product: the extra minutes % of a routing step name a size by its code (no spaces) and are not 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."standardMinutes" INTO step_minutes FROM "RoutingOperation" r
    WHERE r."tenantId" = NEW."tenantId" AND r."revisionId" = NEW."revisionId" AND r."id" = NEW."routingOperationId";
  IF FOUND AND step_minutes + NEW."extraMinutes" <= 0 THEN
    RAISE EXCEPTION 'product: size % of routing step % would take % minutes; a size takes more than 0', NEW."size", NEW."routingOperationId", step_minutes + NEW."extraMinutes"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoutingOperationSizeTime_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RoutingOperationSizeTime"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "RoutingOperationSizeTime_no_truncate" BEFORE TRUNCATE ON "RoutingOperationSizeTime"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "RoutingOperationSizeTime_shape" BEFORE INSERT OR UPDATE ON "RoutingOperationSizeTime"
  FOR EACH ROW EXECUTE FUNCTION "factory_routing_size_time_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- OperationMachineSetting (PRD-118): of a library operation or of one routing step (then a part of its revision: the W1
-- part rule, which passes a library setting, whose revision is null), never moved, saying something.
CREATE FUNCTION "factory_operation_machine_setting_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."operationId", NEW."revisionId", NEW."routingOperationId") IS DISTINCT FROM (OLD."operationId", OLD."revisionId", OLD."routingOperationId") THEN
      RAISE EXCEPTION 'product: machine setting % never moves to another operation or routing step', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."operationId" IS NULL) = (NEW."routingOperationId" IS NULL) OR (NEW."revisionId" IS NULL) <> (NEW."routingOperationId" IS NULL) THEN
    RAISE EXCEPTION 'product: machine setting % belongs to a library operation or to one routing step (with its revision), exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR NEW."stitchesPerCm" <= 0 THEN
    RAISE EXCEPTION 'product: machine setting % has a place from 1, and stitches per centimetre above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW."stitchType", NEW."needle", NEW."thread", NEW."tension", NEW."foot", NEW."notes"]) AS t(v) WHERE t.v IS NOT NULL AND btrim(t.v) = '') THEN
    RAISE EXCEPTION 'product: machine setting % leaves a field empty rather than blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."machineClassId" IS NULL AND NEW."stitchesPerCm" IS NULL
     AND coalesce(NEW."stitchType", NEW."needle", NEW."thread", NEW."tension", NEW."foot", NEW."notes") IS NULL THEN
    RAISE EXCEPTION 'product: machine setting % says something: a machine class, a stitch, a needle, a thread, a tension, a foot or a note', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationMachineSetting_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OperationMachineSetting"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "OperationMachineSetting_no_truncate" BEFORE TRUNCATE ON "OperationMachineSetting"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "OperationMachineSetting_shape" BEFORE INSERT OR UPDATE ON "OperationMachineSetting"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_machine_setting_check"();

-- ---------------------------------------------------------------------------------------------------------------------
-- StyleRevision (…_product_guards), whole: as W1, but once out of DRAFT every column except the status and effectiveTo is
-- compared (as jsonb), so a column added later is frozen with a released revision unless a later migration names it.
CREATE OR REPLACE FUNCTION "factory_style_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a released or obsolete revision may still change: its status (RELEASED → OBSOLETE), its effectiveTo (by
  -- "StyleRevision_w2b4_effectivity"), the row's version and time; the tenant is the policies'.
  moves CONSTANT text[] := ARRAY['tenantId', 'status', 'effectiveTo', 'version', 'updatedAt'];
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

-- StyleRevision's effective days (PRD-124): its own trigger, named to fire after "StyleRevision_guard".
CREATE FUNCTION "factory_style_revision_effectivity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- A release that names no day takes the release's day, in the factory's time zone.
  IF NEW."status" = 'RELEASED' AND NEW."effectiveFrom" IS NULL AND NEW."releasedAt" IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT') THEN
    NEW."effectiveFrom" := (NEW."releasedAt" AT TIME ZONE 'Europe/Rome')::date;
  END IF;
  IF NEW."effectiveTo" IS NOT NULL AND (NEW."status" <> 'OBSOLETE' OR NEW."releasedAt" IS NULL) THEN
    RAISE EXCEPTION 'product: revision % ends its effective days only once a released revision is OBSOLETE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" THEN
    RAISE EXCEPTION 'product: the last effective day of revision % is set once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."effectiveTo" <= NEW."effectiveFrom" THEN
    RAISE EXCEPTION 'product: revision % stops applying (%) after it starts (%)', NEW."id", NEW."effectiveTo", NEW."effectiveFrom"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "StyleRevision_w2b4_effectivity" BEFORE INSERT OR UPDATE ON "StyleRevision"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_effectivity"();

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkInstruction (PRD-117)
CREATE FUNCTION "factory_work_instruction_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moves CONSTANT text[] := ARRAY['tenantId', 'status', 'version', 'updatedAt'];
  owner_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product: work instruction % is archived, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - moves) IS DISTINCT FROM (to_jsonb(OLD) - moves) THEN
      RAISE EXCEPTION 'product: work instruction % keeps its company, number, operation and revision; only its status changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."styleId" IS NULL) <> (NEW."styleRevisionId" IS NULL) THEN
    RAISE EXCEPTION 'product: work instruction % names a style revision with its style, or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT o."companyId" INTO owner_company FROM "Operation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."operationId";
  IF FOUND AND owner_company IS NOT NULL AND owner_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'product: work instruction % is for an operation of its company or a tenant-wide one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."styleId" IS NOT NULL THEN
    SELECT s."companyId" INTO owner_company FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF FOUND AND owner_company IS NOT NULL AND owner_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'product: work instruction % is for a style of its company or a tenant-wide one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkInstruction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkInstruction"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_instruction_guard"();
CREATE TRIGGER "WorkInstruction_no_truncate" BEFORE TRUNCATE ON "WorkInstruction"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_routings_refuse_truncate"();
CREATE TRIGGER "WorkInstruction_number" BEFORE INSERT OR UPDATE ON "WorkInstruction"
  FOR EACH ROW EXECUTE FUNCTION "factory_document_number_guard"('work instruction', 'WORK_INSTRUCTION');

-- One ACTIVE instruction per company and operation for every style, and per company, operation and revision: the floor's
-- lookup has one answer. Archive the old one first.
CREATE UNIQUE INDEX "WorkInstruction_one_active_per_operation" ON "WorkInstruction" ("tenantId", "companyId", "operationId")
  WHERE "status" = 'ACTIVE' AND "styleRevisionId" IS NULL;
CREATE UNIQUE INDEX "WorkInstruction_one_active_per_revision" ON "WorkInstruction" ("tenantId", "companyId", "operationId", "styleRevisionId")
  WHERE "status" = 'ACTIVE' AND "styleRevisionId" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkInstructionVersion (PRD-117, MES-110)
CREATE FUNCTION "factory_work_instruction_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- Out of DRAFT only the status and its time move; the tenant is the policies'.
  moves CONSTANT text[] := ARRAY['tenantId', 'status', 'supersededAt', 'version', 'updatedAt'];
  -- In DRAFT the words, the acknowledgement flag and the publication move too.
  drafting CONSTANT text[] := ARRAY['tenantId', 'status', 'changeNote', 'acknowledgementRequired', 'approvedById', 'publishedAt', 'supersededAt', 'version', 'updatedAt'];
  instruction_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product: instruction version % is kept, never deleted (a draft nobody wants is DISCARDED)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."approvedById" IS NOT NULL OR NEW."publishedAt" IS NOT NULL OR NEW."supersededAt" IS NOT NULL OR NEW."number" < 1 THEN
      RAISE EXCEPTION 'product: instruction version % starts DRAFT, unpublished, with a number from 1', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - (CASE WHEN OLD."status" = 'DRAFT' THEN drafting ELSE moves END))
     IS DISTINCT FROM (to_jsonb(OLD) - (CASE WHEN OLD."status" = 'DRAFT' THEN drafting ELSE moves END)) THEN
    RAISE EXCEPTION 'product: instruction version % is %; % (a change is a new version)', OLD."id", OLD."status",
      CASE WHEN OLD."status" = 'DRAFT' THEN 'its instruction, number and author never change' ELSE 'nothing but its status changes' END
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PUBLISHED', 'DISCARDED'))
              OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'product: instruction version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PUBLISHED', 'SUPERSEDED')) <> (NEW."approvedById" IS NOT NULL AND NEW."publishedAt" IS NOT NULL)
     OR (NEW."status" IN ('DRAFT', 'DISCARDED') AND (NEW."approvedById" IS NOT NULL OR NEW."publishedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'product: instruction version % is published exactly with who approved it and from when', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvedById" = NEW."authorId" THEN
    RAISE EXCEPTION 'product: instruction version % is approved by someone who did not write it (four eyes)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'SUPERSEDED') <> (NEW."supersededAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: instruction version % is superseded exactly with when', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' THEN
    SELECT i."status"::text INTO instruction_state FROM "WorkInstruction" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."instructionId";
    IF FOUND AND instruction_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'product: instruction version % is published only on an ACTIVE instruction', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."number" > 1 AND (NEW."changeNote" IS NULL OR btrim(NEW."changeNote") = '') THEN
      RAISE EXCEPTION 'product: instruction version % says what changed before it is published', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "WorkInstructionStep" s WHERE s."tenantId" = NEW."tenantId" AND s."versionId" = NEW."id") THEN
      RAISE EXCEPTION 'product: instruction version % has at least one step before it is published', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "WorkInstructionMedia" m JOIN "StoredFile" f ON f."tenantId" = m."tenantId" AND f."id" = m."fileId"
                WHERE m."tenantId" = NEW."tenantId" AND m."versionId" = NEW."id" AND f."status"::text <> 'AVAILABLE') THEN
      RAISE EXCEPTION 'product: instruction version % is published once every photo and video of it is available (uploaded and checked)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkInstructionVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkInstructionVersion"
  FOR EACH ROW EXECUTE FUNCTION "factory_work_instruction_version_guard"();
CREATE TRIGGER "WorkInstructionVersion_no_truncate" BEFORE TRUNCATE ON "WorkInstructionVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_routings_refuse_truncate"();

-- One PUBLISHED version per instruction: publishing the next supersedes the old one first, in one transaction.
CREATE UNIQUE INDEX "WorkInstructionVersion_one_published" ON "WorkInstructionVersion" ("tenantId", "instructionId")
  WHERE "status" = 'PUBLISHED';

-- ---------------------------------------------------------------------------------------------------------------------
-- WorkInstructionStep and WorkInstructionMedia: the parts of a DRAFT version.

-- Words per language: a JSON object of language codes ("it", "en", "zh-Hans") to non-blank strings, at least one.
CREATE FUNCTION "factory_instruction_words_ok"(words jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(words) = 'object'
     AND EXISTS (SELECT 1 FROM jsonb_each(words))
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(words) AS w(lang, text)
                      WHERE w.lang !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$' OR jsonb_typeof(w.text) <> 'string' OR btrim(w.text #>> '{}') = '')
$$;

-- A part of a version: only while it is DRAFT; never moved to another version; its versionStatus moves only with the
-- version's (the reference's ON UPDATE CASCADE, an UPDATE of that column alone, which the reference itself checks).
CREATE FUNCTION "factory_instruction_part_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD OR (to_jsonb(NEW) - 'versionStatus') = (to_jsonb(OLD) - 'versionStatus') THEN
      RETURN NEW;
    END IF;
    IF NEW."versionId" IS DISTINCT FROM OLD."versionId" OR NEW."versionStatus" IS DISTINCT FROM OLD."versionStatus" THEN
      RAISE EXCEPTION 'product: a row of "%" never moves to another version; its version''s status moves it', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."versionStatus" <> 'DRAFT' THEN
    RAISE EXCEPTION 'product: a row of "%" is added only to a DRAFT version', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  part_of := CASE WHEN TG_OP = 'INSERT' THEN NEW."versionId" ELSE OLD."versionId" END;
  SELECT v."status"::text INTO state FROM "WorkInstructionVersion" v
    WHERE v."tenantId" = (CASE WHEN TG_OP = 'INSERT' THEN NEW."tenantId" ELSE OLD."tenantId" END) AND v."id" = part_of FOR SHARE;
  IF state IS NOT NULL AND state <> 'DRAFT' THEN
    RAISE EXCEPTION 'product: instruction version % is %; its "%" rows never change, a change is a new version', part_of, state, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_instruction_step_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW IS NOT DISTINCT FROM OLD OR (to_jsonb(NEW) - 'versionStatus') = (to_jsonb(OLD) - 'versionStatus')) THEN
    RETURN NEW;
  END IF;
  IF NEW."code" !~ '^\S+$' OR NEW."sortOrder" < 0 OR (NEW."icon" IS NOT NULL AND NEW."icon" !~ '^[a-z][a-z0-9-]*$') THEN
    RAISE EXCEPTION 'product: instruction step % has a code without spaces, a place from 0 and an icon key in lower case', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_instruction_words_ok"(NEW."textI18n")
     OR (NEW."safetyNoteI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."safetyNoteI18n")) THEN
    RAISE EXCEPTION 'product: instruction step % says its words (and its safety note) per language: {"it": "…", "en": "…"}, none blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkInstructionStep_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "WorkInstructionStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_part_guard"();
CREATE TRIGGER "WorkInstructionStep_shape" BEFORE INSERT OR UPDATE ON "WorkInstructionStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_step_check"();
CREATE TRIGGER "WorkInstructionStep_no_truncate" BEFORE TRUNCATE ON "WorkInstructionStep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_routings_refuse_truncate"();

CREATE FUNCTION "factory_instruction_media_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content_type text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW IS NOT DISTINCT FROM OLD OR (to_jsonb(NEW) - 'versionStatus') = (to_jsonb(OLD) - 'versionStatus')) THEN
    RETURN NEW;
  END IF;
  IF NEW."sortOrder" < 0 OR (NEW."captionI18n" IS NOT NULL AND NOT "factory_instruction_words_ok"(NEW."captionI18n")) THEN
    RAISE EXCEPTION 'product: instruction medium % has a place from 0 and its caption per language, none blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."contentType" INTO content_type FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND NOT ((NEW."kind" = 'PHOTO' AND content_type LIKE 'image/%') OR (NEW."kind" = 'VIDEO' AND content_type LIKE 'video/%')) THEN
    RAISE EXCEPTION 'product: instruction medium % is a %, so its file is % (this one is %)', NEW."id", NEW."kind",
      CASE WHEN NEW."kind" = 'PHOTO' THEN 'an image' ELSE 'a video' END, content_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WorkInstructionMedia_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "WorkInstructionMedia"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_part_guard"();
CREATE TRIGGER "WorkInstructionMedia_shape" BEFORE INSERT OR UPDATE ON "WorkInstructionMedia"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_media_check"();
CREATE TRIGGER "WorkInstructionMedia_no_truncate" BEFORE TRUNCATE ON "WorkInstructionMedia"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_routings_refuse_truncate"();

-- ---------------------------------------------------------------------------------------------------------------------
-- InstructionAcknowledgement (MES-119): append-only; INSERT of a published version by the worker's own sign-in.
CREATE FUNCTION "factory_instruction_ack_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'product: "%" is append-only; % is refused (an acknowledgement is never changed or removed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_instruction_ack_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  -- A row of a site this session cannot see is left to the policies.
  IF NOT "factory_floor_work_visible"(NEW."tenantId", NEW."siteId") THEN
    RETURN NEW;
  END IF;
  SELECT v."status"::text INTO state FROM "WorkInstructionVersion" v WHERE v."tenantId" = NEW."tenantId" AND v."id" = NEW."versionId";
  -- On its own site, a version the session cannot see is one the floor may not read: neither published nor superseded.
  IF state IS NULL OR state NOT IN ('PUBLISHED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'product: acknowledgement % is of a published instruction version (this one is %)', NEW."id", coalesce(state, 'not published')
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM "factory_floor_work_employee_check"(NEW."tenantId", NEW."workerId", NEW."employeeId", 'acknowledgement', NEW."id");
  IF NEW."locale" !~ '^[a-z]{2}$' THEN
    RAISE EXCEPTION 'product: acknowledgement % names the language it was shown in by its ISO 639-1 code ("it")', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deviceId" IS NULL AND (NEW."clientEventId" IS NOT NULL OR NEW."deviceTime" IS NOT NULL) THEN
    RAISE EXCEPTION 'product: acknowledgement % has a client event id and a device clock only with its device', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clientEventId" IS NOT NULL AND btrim(NEW."clientEventId") = '' THEN
    RAISE EXCEPTION 'product: acknowledgement % has no blank client event id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime' AND NEW."deviceId" IS NULL THEN
    RAISE EXCEPTION 'product: acknowledgement % from a floor session names the device it was seen on', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InstructionAcknowledgement_check" BEFORE INSERT ON "InstructionAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_ack_check"();
CREATE TRIGGER "InstructionAcknowledgement_append_only" BEFORE UPDATE OR DELETE ON "InstructionAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION "factory_instruction_ack_refuse_change"();
CREATE TRIGGER "InstructionAcknowledgement_no_truncate" BEFORE TRUNCATE ON "InstructionAcknowledgement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_instruction_ack_refuse_change"();
