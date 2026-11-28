-- Written by hand (Prisma does not model triggers), after the generated 202611280900_production_floor_baskets_2_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Schema wave "floor baskets 2" (lane owb-, session S5 floor, PR owb-fl0; build/briefs/owb-fl0.md, LF _owb-fl-common.md § 1-4;
-- the Owner's yes of 2026-11-28 07:22 on LF plan.md). apps/factory-api checks all of this first and answers in words (fl1-fl4);
-- these rules are the last word, for every login, the owner included. The refusals are check_violation (SQLSTATE 23514); their
-- words name no customer and no person. The new checks are AFTER triggers (the policies speak first), but the spot's, which
-- keeps the BEFORE of its neighbour HelpCall_request. A rule that reads another row reads only what the role that fires it may
-- read: a file a row names as its photo or its voice note that this session cannot open is refused, never skipped; the work
-- order of a photo's step is read for its company and skipped when this session cannot see it (the reference holds it).
-- No column of StoredFile hidden from the floor role (legalHold, partyId, …) is read: the floor fires these triggers.
--
-- NEW here:
--   factory_basket_flag_guard                  + triggers BasketFlag_guard, BasketFlag_no_truncate (the base's
--                                              factory_order_workflow_refuse_truncate); index BasketFlag_one_open: a new
--                                              mark is open at version 1, on a basket of its work order at its site; an
--                                              open mark is only cleared, once (when: not before it was set; who: the
--                                              worker or the office person, when known), nothing else changes; a cleared
--                                              mark never changes; never deleted; one open mark per basket and kind.
--   FloorSuggestion (append-only)              triggers FloorSuggestion_append_only, FloorSuggestion_no_truncate
--                                              (factory_refuse_production_ledger_change, as BasketMove's), and
--   factory_floor_suggestion_check             + trigger FloorSuggestion_check: words of 1 to 1000, not blank, or none;
--                                              without the name no employee and no device; a client event id not blank;
--                                              the voice note an AUDIO file this session can open, of its own company or
--                                              the whole factory, neither deleted nor quarantined.
--   factory_operation_checklist_photo_check    + trigger OperationChecklistResult_photo_check (AFTER INSERT, WHEN it names
--                                              a photo): an image a browser shows that this session can open; never a
--                                              fiscal archive, a voice note, body data or a priced file, nor one deleted
--                                              or quarantined; of the work order's company or the whole factory.
--   constraint HelpCall_spot_range             the place on the picture: 0 to 8 (a 3 x 3 grid) or none.
--   factory_help_call_spot_check               + trigger HelpCall_spot (BEFORE UPDATE OF "spot"): the place changes only
--                                              while the call is open (not SOLVED or CANCELLED), as HelpCall_request's
--                                              details.
--
-- VERIFIED, NOT REDEFINED (each read in its newest body on main 4426c7253e):
--   factory_help_call_guard (…_floor_work_w2b_guards; no later migration redefines it): its UPDATE branch freezes only the
--   listed columns (type, station, line, caller, subject, sending, device, creation), the times set once, the escalation and
--   the outcome; "spot" is in none of them, so the API sets it on an OPEN call through the floor's table-wide UPDATE grant.
--   factory_help_call_request_check (…_followups_floor_w2b_guards) fires only on UPDATE OF "reasonCode", "requestedQuantity".
--   factory_operation_checklist_result_check and the OperationChecklistResult triggers (…_floor_work_w2b_guards): BEFORE
--   INSERT checks of the order, bundle, step code and subject, and append-only (factory_floor_work_refuse_change): a photo is
--   written with its tick, never added later. FloorSession has no trigger: its two new columns are kept by their references
--   (a department of the tenant, a station of the session's site); the department's kind and the station's state are the
--   API's (fl1, settle 2).
-- USED FROM EARLIER WAVES, as they are: "factory_refuse_production_ledger_change" (…_production_guards),
-- "factory_order_workflow_refuse_truncate" (…_order_workflow_guards), "factory_files_type_of" and
-- "factory_files_is_design_type" (…_files_measurements_th_guards).

-- =====================================================================================================================
-- BasketFlag (baskets.prisma; owb-fl0 row 3): "Do this first", set and cleared on the floor.
--   INSERT    open (not cleared, by nobody), at version 1; the basket of the mark's work order and site (the references
--             hold it too; this says it in words); a client event id, when given, not blank.
--   UPDATE    an open mark is only cleared, once: clearedAt set (not before setAt), with who cleared it when known
--             (clearedByUserId, clearedByWorkerId), the version up by one (or kept); nothing else changes. A cleared mark
--             never changes again.
--   every row one open mark per basket and kind (the partial unique index BasketFlag_one_open).
--   DELETE    refused. TRUNCATE refused.
CREATE FUNCTION "factory_basket_flag_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  clear CONSTANT text[] := ARRAY['clearedAt', 'clearedByUserId', 'clearedByWorkerId', 'version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: basket mark % is cleared, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."clearedAt" IS NOT NULL OR NEW."clearedByUserId" IS NOT NULL OR NEW."clearedByWorkerId" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new basket mark is open (not cleared), at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."bundleId" AND b."siteId" = NEW."siteId" AND b."workOrderId" = NEW."workOrderId") THEN
      RAISE EXCEPTION 'production: basket mark % marks a basket of its work order at its site', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."clientEventId" IS NOT NULL AND btrim(NEW."clientEventId") = '' THEN
      RAISE EXCEPTION 'production: basket mark % names a client event id that is not blank, or none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF OLD."clearedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'production: basket mark % was cleared; it never changes again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clearedAt" IS NULL OR NEW."clearedAt" < OLD."setAt"
     OR (NEW."version" <> OLD."version" + 1 AND NEW."version" <> OLD."version")
     OR (to_jsonb(NEW) - clear - 'tenantId') IS DISTINCT FROM (to_jsonb(OLD) - clear - 'tenantId') THEN
    RAISE EXCEPTION 'production: basket mark % is only cleared, once, with when (not before it was set) and who; nothing else of it changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "BasketFlag_guard" AFTER INSERT OR UPDATE OR DELETE ON "BasketFlag"
  FOR EACH ROW EXECUTE FUNCTION "factory_basket_flag_guard"();
CREATE TRIGGER "BasketFlag_no_truncate" BEFORE TRUNCATE ON "BasketFlag"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- One open mark per basket and kind: a second "Do this first" on a marked basket is refused (the API answers that it is
-- marked already); a cleared mark frees it.
CREATE UNIQUE INDEX "BasketFlag_one_open" ON "BasketFlag" ("tenantId", "bundleId", "kind") WHERE "clearedAt" IS NULL;

-- =====================================================================================================================
-- FloorSuggestion (baskets.prisma; owb-fl0 row 4): append-only (scripts/factory/check-append-only.mjs) and its INSERT rules.
CREATE TRIGGER "FloorSuggestion_append_only" BEFORE UPDATE OR DELETE ON "FloorSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "FloorSuggestion_no_truncate" BEFORE TRUNCATE ON "FloorSuggestion"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

-- "Tell the office": a worker's idea, "something is wrong" or thank-you, with or without their name.
--   INSERT    words of 1 to 1000 characters, not blank, or none; sent without a name (no worker) it names no employee and
--             no device (a PHONE device is one person's own: Device.personalWorkerId), so it stays without a name; a client
--             event id not blank; the voice note, when given, an AUDIO file this session can open (the floor: a file shared
--             with its site), of the suggestion's company or of the whole factory, neither deleted nor quarantined.
CREATE FUNCTION "factory_floor_suggestion_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  voice record;
BEGIN
  IF NEW."words" IS NOT NULL AND (btrim(NEW."words") = '' OR length(NEW."words") > 1000) THEN
    RAISE EXCEPTION 'floor: suggestion % has words of 1 to 1000 characters, not blank, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."workerId" IS NULL AND (NEW."employeeId" IS NOT NULL OR NEW."deviceId" IS NOT NULL) THEN
    RAISE EXCEPTION 'floor: suggestion % is sent without a name: it names no employee and no device (only beside the worker who gave their name)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."clientEventId") = '' THEN
    RAISE EXCEPTION 'floor: suggestion % names a client event id that is not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."voiceFileId" IS NOT NULL THEN
    SELECT f."companyId" AS company, f."kind"::text AS kind, f."status"::text AS status
      INTO voice
      FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."voiceFileId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'floor: the voice note of suggestion % is a file this person can open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF voice.kind <> 'AUDIO' OR voice.status IN ('DELETED', 'QUARANTINED')
       OR (voice.company IS NOT NULL AND voice.company <> NEW."companyId") THEN
      RAISE EXCEPTION 'floor: the voice note of suggestion % is a voice note (AUDIO) of its own company or the whole factory, neither deleted nor quarantined', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "FloorSuggestion_check" AFTER INSERT ON "FloorSuggestion"
  FOR EACH ROW EXECUTE FUNCTION "factory_floor_suggestion_check"();

-- =====================================================================================================================
-- OperationChecklistResult.fileId (labour.prisma; owb-fl0 row 2): the photo of a quality step, written with its tick (the row
-- is append-only). As the base's order picture check (factory_order_picture_check), for the floor's eyes:
--   INSERT    a file this session can open (the floor: a file shared with its site; one it cannot see is refused); an image
--             a browser shows (never a design file: download-only); never a fiscal archive or a voice note; never body data
--             (a measurement sheet, a body, made-to-measure or fitting photo); never a priced file (the floor sees no price);
--             neither deleted nor quarantined; of the work order's company or of the whole factory.
CREATE FUNCTION "factory_operation_checklist_photo_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  photo record;
  photo_type text;
  order_company uuid;
BEGIN
  SELECT f."companyId" AS company, f."kind"::text AS kind, f."category"::text AS category, f."contentType" AS content_type,
         f."status"::text AS status, f."priced" AS priced
    INTO photo
    FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'production: the photo of ticked step % is a file this person can open', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  photo_type := "factory_files_type_of"(photo.content_type);
  IF NOT (photo_type LIKE 'image/%' AND NOT "factory_files_is_design_type"(photo_type))
     OR photo.kind IN ('FISCAL_ARCHIVE', 'AUDIO')
     OR coalesce(photo.category IN ('MEASUREMENTS', 'BODY_PHOTO', 'MTM_PHOTO', 'FITTING_PHOTO'), false)
     OR photo.status IN ('DELETED', 'QUARANTINED')
     OR photo.priced THEN
    RAISE EXCEPTION 'production: the photo of ticked step % is an image: never a fiscal archive, a voice note, body data (measurements, a body, made-to-measure or fitting photo) or a priced file, nor one deleted or quarantined', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT w."companyId" INTO order_company FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
  IF FOUND AND photo.company IS NOT NULL AND photo.company <> order_company THEN
    RAISE EXCEPTION 'production: the photo of ticked step % is a file of its work order''s company or of the whole factory', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OperationChecklistResult_photo_check" AFTER INSERT ON "OperationChecklistResult"
  FOR EACH ROW WHEN (NEW."fileId" IS NOT NULL)
  EXECUTE FUNCTION "factory_operation_checklist_photo_check"();

-- =====================================================================================================================
-- HelpCall.spot (andon.prisma; owb-fl0 row 5): the place of a problem on the basket's picture. Every existing row passes (the
-- column is new and null).
ALTER TABLE "HelpCall" ADD CONSTRAINT "HelpCall_spot_range"
  CHECK ("spot" IS NULL OR ("spot" >= 0 AND "spot" <= 8));

-- The place is told when the call is sent or shown (and changed) while it is open; a SOLVED or CANCELLED call keeps its
-- place. Own trigger, as HelpCall_request's: the call's guard stays as it is.
CREATE FUNCTION "factory_help_call_spot_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."spot" IS DISTINCT FROM OLD."spot" AND OLD."status"::text IN ('SOLVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'andon: help call % is %; its place on the picture is shown while it is open', OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "HelpCall_spot" BEFORE UPDATE OF "spot" ON "HelpCall"
  FOR EACH ROW EXECUTE FUNCTION "factory_help_call_spot_check"();
