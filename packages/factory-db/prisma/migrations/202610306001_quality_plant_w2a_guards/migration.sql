-- Written by hand (Prisma does not model triggers, partial indexes or deferred constraint triggers), after the generated
-- 202610306000_quality_plant_w2a_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2a schema wave 6/7 (B-W2a-06): the defect library and disposition codes, quality holds, nonconformances, the
-- machine register and its maintenance, DDTs for other reasons, the freight charge and the intra-EU transport evidence
-- (features QHS-001, QHS-005, QHS-074, MES-008, QHS-080 … QHS-090, QHS-162, QHS-178, QHS-184, LOG-056, LOG-090,
-- LOG-105; Owner answer H1; Reg. (EU) 2016/425 art. 8; D.Lgs. 81/2008 art. 71; DPR 472/1996; art. 41 DL 331/93).
-- apps/factory-api's modules check all of this first, in words; these rules hold for every login, the owner included.
-- Every refusal is a check_violation (SQLSTATE 23514).
--
-- As in every guards migration: the tenant and site of a row are held by the policies (USING and WITH CHECK) and the
-- references, not here (no trigger compares "tenantId" or "siteId" of the row it guards, so a row moved out of a
-- session's scope meets row-level security first); a rule that reads another row skips a row this session cannot see
-- (another tenant's or site's: the policies refuse that write anyway); an UPDATE that changes nothing passes. A trigger
-- reads only tables (and columns) the role that fires it may read, and locks a row FOR SHARE or FOR UPDATE only where
-- that role may update it. "Everything but these columns" is compared as jsonb, so a column added later is frozen too
-- unless a later migration names it.
--
-- What blocks what while a quality hold is ACTIVE (QHS-074, MES-008; B-W2a-26 says it first, in words):
--   Lot, Hide        an ISSUE of its stock (StockMove_awaits_quality_hold) and a cut of it (CutLog_awaits_quality_hold).
--   WorkOrder        an issue to it, a cut, a scan or a release of its garments, packing them (a shipment line of it)
--                    and the shipment that holds them from being PACKED or SHIPPED; its floor work also waits on the work
--                    order's own ON_HOLD status (wave 5/7's …_production_w2a_guards), which the hold's command sets.
--   Bundle           a scan of it (OperationScan_awaits_quality_hold).
--   GarmentSerial    its release (MADE → RELEASED) and its packing (GarmentSerial_awaits_quality_hold), and its
--                    shipment from being PACKED or SHIPPED.
--   Shipment, Parcel packing lines into them, and the shipment from being PACKED or SHIPPED
--                    (Shipment_awaits_quality_hold).
-- A hold and the work it blocks take turns: placing a hold takes, for each record it holds (in id order), a transaction
-- advisory lock 'factory.quality-hold|<tenant>|<record id>' EXCLUSIVE; each blocked write takes the same locks SHARED
-- (in id order), then reads the holds (READ COMMITTED: each statement sees what committed before it). So a write in
-- flight finishes before the hold is placed, and a write after it waits and then sees it. Each blocked write's trigger
-- fires before that table's other locking triggers (by name: "…_awaits_quality_hold"), so hold locks come before the
-- work order, stock and cell locks everywhere; a command that holds a work order and puts it ON_HOLD (wave 5/7's gate
-- lock) moves the work order first and places the hold after.

CREATE FUNCTION "factory_quality_plant_w2a_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quality and plant: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['DefectCode', 'DispositionCode', 'QualityHold', 'Nonconformance', 'NcrContainmentAction', 'NcrDispositionLine',
                              'NcrLink', 'MachineClass', 'MachineSymptom', 'Machine', 'MaintenanceRequest', 'MaintenanceJob'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_quality_plant_w2a_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- Is a row of this tenant and site inside the session's scope? The owner (no tenant scope) sees every row; a floor
-- session only its site's. A check that finds nothing reads it to tell "not there" (refused) from "not visible" (left to
-- the policies).
CREATE FUNCTION "factory_quality_plant_in_scope"(tenant uuid, site uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('factory.tenant_id', true), '') IS NULL
      OR (tenant = NULLIF(current_setting('factory.tenant_id', true), '')::uuid
          AND (current_user <> 'factory_floor_runtime' OR site = NULLIF(current_setting('factory.site_id', true), '')::uuid))
$$;

-- Words of a reason list or library: a code without spaces, Italian and English words, the other floor languages as
-- { "<language>": "<words>" }, a design-system icon id and a #RRGGBB swatch.
CREATE FUNCTION "factory_quality_plant_words_ok"(code text, label_it text, label_en text, label_i18n jsonb, icon text, colour text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(code) <> '' AND code !~ '\s' AND btrim(label_it) <> '' AND btrim(label_en) <> ''
     AND jsonb_typeof(label_i18n) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(label_i18n) e
                      WHERE e.key !~ '^[a-z]{2,3}$' OR jsonb_typeof(e.value) <> 'string' OR btrim(e.value #>> '{}') = '')
     AND (icon IS NULL OR icon ~ '^[a-z][a-z0-9-]*$')
     AND (colour IS NULL OR colour ~ '^#[0-9A-Fa-f]{6}$')
$$;

-- =====================================================================================================================
-- The defect library and the disposition codes (holds.prisma)

-- DefectCode (QHS-001)
--   UPDATE     the code, the category and the creation never change (inspection defects and NCRs keep the code).
--   every row  its words (as a reason list's); a zone id without spaces; two levels: a defect's category is a category
--              (it has no parent), never itself; a category has no class, a defect has its default class; the picture
--              is a file of this code (StoredFile recordType "DefectCode").
--   DELETE     a code nothing names (the references refuse the rest: retire it). TRUNCATE refused.
CREATE FUNCTION "factory_defect_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grand uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."code", NEW."parentId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."code", OLD."parentId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the code, the category and the creation of defect code % never change (inspections and NCRs keep the code; retire it and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_quality_plant_words_ok"(NEW."code", NEW."labelIt", NEW."labelEn", NEW."labelI18n", NEW."icon", NEW."colour")
     OR (NEW."zone" IS NOT NULL AND (btrim(NEW."zone") = '' OR NEW."zone" ~ '\s')) THEN
    RAISE EXCEPTION 'quality: defect code % has a code without spaces, Italian and English words, its other languages as { "<language>": "<words>" }, an icon id, a #RRGGBB colour and a zone id without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."parentId" IS NOT NULL THEN
    IF NEW."parentId" = NEW."id" THEN
      RAISE EXCEPTION 'quality: defect code % is not its own category', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT d."parentId" INTO grand FROM "DefectCode" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."parentId";
    IF FOUND AND grand IS NOT NULL THEN
      RAISE EXCEPTION 'quality: defect code % is filed under %, which is a defect itself; the library has two levels, category and defect (QHS-001)', NEW."id", NEW."parentId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."parentId" IS NULL) <> (NEW."severity" IS NULL) THEN
    RAISE EXCEPTION 'quality: defect code % is a %; a defect has its default class (CRITICAL, MAJOR, MINOR), a category none', NEW."id",
      CASE WHEN NEW."parentId" IS NULL THEN 'category' ELSE 'defect' END
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."pictureFileId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."pictureFileId" IS DISTINCT FROM OLD."pictureFileId")
     AND EXISTS (SELECT 1 FROM "StoredFile" f
                  WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."pictureFileId" AND (f."recordType" <> 'DefectCode' OR f."recordId" <> NEW."id")) THEN
    RAISE EXCEPTION 'quality: the picture of defect code % is a file of the code (recordType DefectCode)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DefectCode_guard" BEFORE INSERT OR UPDATE ON "DefectCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_defect_code_guard"();

-- DispositionCode (QHS-005)
--   UPDATE     the code, its outcome, the stock move and the follow-up it makes and the creation never change (the
--              decisions made with it keep them).
--   every row  its words; the move is one the ledger makes out of held stock (ISSUE, TRANSFER, ADJUSTMENT, SCRAP);
--              USE AS IS moves nothing and opens nothing; SCRAP posts a SCRAP move; an approval amount from 0.
--   DELETE     a code no decision names (the references refuse the rest: set it inactive). TRUNCATE refused.
CREATE FUNCTION "factory_disposition_code_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."code", NEW."outcome", NEW."stockMoveReason", NEW."followUp", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."code", OLD."outcome", OLD."stockMoveReason", OLD."followUp", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the code, outcome, stock move, follow-up and creation of disposition code % never change (decisions keep them; set it inactive and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_quality_plant_words_ok"(NEW."code", NEW."labelIt", NEW."labelEn", NEW."labelI18n", NEW."icon", NEW."colour") THEN
    RAISE EXCEPTION 'quality: disposition code % has a code without spaces, Italian and English words, its other languages as { "<language>": "<words>" }, an icon id and a #RRGGBB colour', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stockMoveReason" IS NOT NULL AND NEW."stockMoveReason"::text NOT IN ('ISSUE', 'TRANSFER', 'ADJUSTMENT', 'SCRAP') THEN
    RAISE EXCEPTION 'quality: disposition code % posts a % move; a disposition moves held stock out by an ISSUE, a TRANSFER, an ADJUSTMENT or a SCRAP', NEW."id", NEW."stockMoveReason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."outcome" = 'USE_AS_IS' AND (NEW."stockMoveReason" IS NOT NULL OR NEW."followUp" IS NOT NULL))
     OR (NEW."outcome" = 'SCRAP' AND NEW."stockMoveReason" IS DISTINCT FROM 'SCRAP') THEN
    RAISE EXCEPTION 'quality: disposition code % is %: USE AS IS moves and opens nothing, SCRAP posts a SCRAP move (QHS-005)', NEW."id", NEW."outcome"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvalAmount" IS NOT NULL AND NEW."approvalAmount" < 0 THEN
    RAISE EXCEPTION 'quality: the approval amount of disposition code % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DispositionCode_guard" BEFORE INSERT OR UPDATE ON "DispositionCode"
  FOR EACH ROW EXECUTE FUNCTION "factory_disposition_code_guard"();

-- =====================================================================================================================
-- Quality holds (holds.prisma)

-- Takes the hold locks of these records SHARED, in id order (see the top of this file).
CREATE FUNCTION "factory_quality_hold_wait"(tenant uuid, ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  subject uuid;
BEGIN
  FOR subject IN SELECT DISTINCT u FROM unnest(ids) u WHERE u IS NOT NULL ORDER BY u LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.quality-hold', tenant, subject), 0));
  END LOOP;
END
$$;

-- The first ACTIVE hold of one of these records of this type, or null.
CREATE FUNCTION "factory_quality_hold_of"(tenant uuid, subject_type text, ids uuid[]) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT h."id" FROM "QualityHold" h
   WHERE h."tenantId" = tenant AND h."status" = 'ACTIVE' AND h."subjectType" = subject_type
     AND h."subjectIds" && array_remove(ids, NULL)
   ORDER BY h."id" LIMIT 1
$$;

-- QualityHold (QHS-074, MES-008)
--   INSERT     ACTIVE, with nothing released or closed; it takes its records' hold locks EXCLUSIVE (in id order). A floor
--              session places the hold of the signed-in worker (never names an office user).
--   UPDATE     what it holds, why, who placed it and when, its source and its creation never change; ACTIVE → RELEASED
--              | CLOSED, both final (frozen); the NCR is set once; a floor session changes only the quarantine move and
--              the release (by a worker with the PIN), nothing else.
--   every row  one record type it can hold and one or more distinct ids of it, each a row of the hold's site in a state
--              it can hold (a lot not REJECTED, a hide not used up or scrapped, a work order neither CLOSED nor CANCELLED,
--              an ACTIVE bundle, a MADE or RELEASED serial, a DRAFT or PACKED shipment, a parcel of one); a reason code
--              without spaces; the source both or neither; at most one placer; the quarantine: MOVED exactly with when, a
--              place only when asked or moved, a QUARANTINE location; RELEASED exactly with when, one releaser and the
--              signature; CLOSED exactly with when, its NCR and why; ACTIVE with neither.
--   release    for held garments (a work order, its bundles or serials) the releaser made none of them, or signed that
--              they did not where the floor records do not name every maker (factory_quality_check_not_maker, the
--              final release's four-eyes rule).
--   DELETE     refused (released or closed). TRUNCATE refused.
CREATE FUNCTION "factory_quality_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'siteId', 'quarantine', 'quarantineLocationId', 'quarantineMovedAt', 'status', 'releasedAt',
                                         'releasedByWorkerId', 'releaseNote', 'releaseSignatureSha256', 'notMakerStatement', 'version', 'updatedAt'];
  wanted integer;
  found_count integer;
  subject uuid;
  location_kind text;
  work_order uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: hold % is released or closed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE'
       OR NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL OR NEW."releasedByWorkerId" IS NOT NULL OR NEW."releaseNote" IS NOT NULL
       OR NEW."releaseSignatureSha256" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."closeNote" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: hold % starts ACTIVE, with nothing released or closed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND (NEW."placedById" IS NOT NULL OR NEW."placedByWorkerId" IS NULL) THEN
      RAISE EXCEPTION 'quality: the floor places the hold of the signed-in worker (hold %), never an office user''s', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    FOR subject IN SELECT DISTINCT u FROM unnest(NEW."subjectIds") u WHERE u IS NOT NULL ORDER BY u LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.quality-hold', NEW."tenantId", subject), 0));
    END LOOP;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."subjectType", NEW."subjectIds", NEW."reasonCode", NEW."placedAt", NEW."placedById", NEW."placedByWorkerId",
        NEW."sourceType", NEW."sourceId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."subjectType", OLD."subjectIds", OLD."reasonCode", OLD."placedAt", OLD."placedById", OLD."placedByWorkerId",
        OLD."sourceType", OLD."sourceId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: what hold % holds, why, who placed it and when, its source and its creation never change (a hold of more goods is a new hold)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'ACTIVE' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: hold % is %; a released or closed hold never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."ncrId" IS NOT NULL AND NEW."ncrId" IS DISTINCT FROM OLD."ncrId" THEN
      RAISE EXCEPTION 'quality: hold % is decided in NCR %; its NCR is set once', OLD."id", OLD."ncrId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed)
            OR (NEW."status" <> OLD."status" AND NEW."status" <> 'RELEASED')
            OR NEW."releasedById" IS NOT NULL) THEN
      RAISE EXCEPTION 'quality: the floor confirms the quarantine move of hold % and releases it with the inspector''s PIN; nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."subjectType" NOT IN ('Lot', 'Hide', 'WorkOrder', 'Bundle', 'GarmentSerial', 'Shipment', 'Parcel') THEN
    RAISE EXCEPTION 'quality: hold % holds %; a hold holds lots, hides, work orders, bundles, garment serials, shipments or parcels (one kind per hold)', NEW."id", NEW."subjectType"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT u FROM unnest(NEW."subjectIds") u WHERE u IS NOT NULL));
  IF wanted = 0 OR wanted <> cardinality(NEW."subjectIds") THEN
    RAISE EXCEPTION 'quality: hold % holds one or more records, each named once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."reasonCode") = '' OR NEW."reasonCode" ~ '\s'
     OR (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) OR btrim(coalesce(NEW."sourceType", '-')) = ''
     OR (NEW."placedById" IS NOT NULL AND NEW."placedByWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: hold % has a reason code without spaces, its source as a type and an id or neither, and at most one person who placed it', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."quarantine" = 'MOVED') <> (NEW."quarantineMovedAt" IS NOT NULL)
     OR (NEW."quarantine" = 'MOVED' AND NEW."quarantineLocationId" IS NULL)
     OR (NEW."quarantine" = 'NOT_NEEDED' AND NEW."quarantineLocationId" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: hold % is % with the wrong quarantine move: moved exactly with its time and place, a place only when the move is asked or done', NEW."id", NEW."quarantine"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quarantineLocationId" IS NOT NULL THEN
    SELECT l."kind"::text INTO location_kind FROM "Location" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."quarantineLocationId";
    IF FOUND AND location_kind <> 'QUARANTINE' THEN
      RAISE EXCEPTION 'quality: hold % moves its goods to a % location; quarantine is a QUARANTINE location of the site', NEW."id", location_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."status" = 'RELEASED') <> (NEW."releasedAt" IS NOT NULL)
     OR (NEW."status" = 'RELEASED') <> ((NEW."releasedById" IS NULL) <> (NEW."releasedByWorkerId" IS NULL))
     OR (NEW."status" <> 'RELEASED' AND (NEW."releasedById" IS NOT NULL OR NEW."releasedByWorkerId" IS NOT NULL OR NEW."releaseNote" IS NOT NULL))
     OR (NEW."status" = 'RELEASED') <> (btrim(coalesce(NEW."releaseSignatureSha256", '')) <> '') THEN
    RAISE EXCEPTION 'quality: hold % is % with the wrong release: released exactly with its time, one releaser (an office user or a floor worker) and the signature', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."status" = 'CLOSED' AND (NEW."ncrId" IS NULL OR btrim(coalesce(NEW."closeNote", '')) = ''))
     OR (NEW."status" <> 'CLOSED' AND (NEW."closedById" IS NOT NULL OR NEW."closeNote" IS NOT NULL)) THEN
    RAISE EXCEPTION 'quality: hold % is % with the wrong closing: closed exactly with its time, the NCR that decided it and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What it holds: rows of its site, in a state a hold can hold (checked when it is placed; they never change after).
  IF TG_OP = 'INSERT' THEN
    found_count := CASE NEW."subjectType"
      WHEN 'Lot' THEN (SELECT count(*) FROM "Lot" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND x."qualityStatus" <> 'REJECTED')
      WHEN 'Hide' THEN (SELECT count(*) FROM "Hide" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND x."state" NOT IN ('CONSUMED', 'SCRAPPED'))
      WHEN 'WorkOrder' THEN (SELECT count(*) FROM "WorkOrder" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND x."status"::text NOT IN ('CLOSED', 'CANCELLED'))
      WHEN 'Bundle' THEN (SELECT count(*) FROM "Bundle" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND x."status" = 'ACTIVE')
      WHEN 'GarmentSerial' THEN (SELECT count(*) FROM "GarmentSerial" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND x."status" IN ('MADE', 'RELEASED'))
      WHEN 'Shipment' THEN (SELECT count(*) FROM "Shipment" x WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND x."status" IN ('DRAFT', 'PACKED'))
      ELSE (SELECT count(*) FROM "Parcel" x JOIN "Shipment" s ON s."tenantId" = x."tenantId" AND s."id" = x."shipmentId"
             WHERE x."tenantId" = NEW."tenantId" AND x."siteId" = NEW."siteId" AND x."id" = ANY(NEW."subjectIds") AND s."status" IN ('DRAFT', 'PACKED'))
    END;
    IF found_count <> wanted AND "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") THEN
      RAISE EXCEPTION 'quality: hold % names % record(s) of %; % of them are of its site in a state a hold holds (a lot not REJECTED, a hide not used up or scrapped, a work order neither CLOSED nor CANCELLED, an ACTIVE bundle, a MADE or RELEASED serial, a DRAFT or PACKED shipment or one of its parcels: what left is the PPE register''s)', NEW."id", wanted, NEW."subjectType", found_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The release of held garments: by someone who made none of them (four eyes, Reg. 2016/425).
  IF TG_OP = 'UPDATE' AND OLD."status" = 'ACTIVE' AND NEW."status" = 'RELEASED' AND NEW."subjectType" IN ('WorkOrder', 'Bundle', 'GarmentSerial') THEN
    FOR work_order IN
      SELECT DISTINCT w FROM (
        SELECT unnest(NEW."subjectIds") AS w WHERE NEW."subjectType" = 'WorkOrder'
        UNION SELECT b."workOrderId" FROM "Bundle" b WHERE NEW."subjectType" = 'Bundle' AND b."tenantId" = NEW."tenantId" AND b."id" = ANY(NEW."subjectIds")
        UNION SELECT g."workOrderId" FROM "GarmentSerial" g WHERE NEW."subjectType" = 'GarmentSerial' AND g."tenantId" = NEW."tenantId" AND g."id" = ANY(NEW."subjectIds")
      ) held ORDER BY w
    LOOP
      PERFORM "factory_quality_check_not_maker"(NEW."tenantId", work_order, NEW."releasedByWorkerId", NEW."releasedById", NEW."notMakerStatement", 'release of hold', NEW."id");
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityHold_guard" BEFORE INSERT OR UPDATE OR DELETE ON "QualityHold"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_hold_guard"();

-- What a hold blocks (see the top of this file). Each check takes the hold locks of the records it reads, SHARED.

-- StockMove: an ISSUE (not a reversal) of a held lot or hide, or to a held work order.
CREATE FUNCTION "factory_stock_move_quality_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held uuid;
BEGIN
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."lotId", NEW."hideId", NEW."workOrderId"]);
  held := "factory_quality_hold_of"(NEW."tenantId", 'Lot', ARRAY[NEW."lotId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: lot % is on hold (hold %); its stock is not issued until the hold is released (QHS-074)', NEW."lotId", held
      USING ERRCODE = 'check_violation';
  END IF;
  held := "factory_quality_hold_of"(NEW."tenantId", 'Hide', ARRAY[NEW."hideId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: hide % is on hold (hold %); it is not issued until the hold is released (QHS-074)', NEW."hideId", held
      USING ERRCODE = 'check_violation';
  END IF;
  held := "factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', ARRAY[NEW."workOrderId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: work order % is on hold (hold %); nothing is issued to it until the hold is released (MES-008)', NEW."workOrderId", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Fires before the move's work order and stock locks (triggers of one event fire in name order).
CREATE TRIGGER "StockMove_awaits_quality_hold" BEFORE INSERT ON "StockMove"
  FOR EACH ROW WHEN (NEW."reason" = 'ISSUE' AND NEW."reversalOfId" IS NULL)
  EXECUTE FUNCTION "factory_stock_move_quality_hold_check"();

-- CutLog: a cut (not a reversal) of a held hide or of a hide of a held lot, or for a held work order.
CREATE FUNCTION "factory_cut_log_quality_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held uuid;
BEGIN
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."lotId", NEW."hideId", NEW."workOrderId"]);
  held := coalesce("factory_quality_hold_of"(NEW."tenantId", 'Hide', ARRAY[NEW."hideId"]), "factory_quality_hold_of"(NEW."tenantId", 'Lot', ARRAY[NEW."lotId"]));
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: hide % (lot %) is on hold (hold %); it is not cut until the hold is released (QHS-074)', NEW."hideId", NEW."lotId", held
      USING ERRCODE = 'check_violation';
  END IF;
  held := "factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', ARRAY[NEW."workOrderId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: work order % is on hold (hold %); nothing is cut for it until the hold is released (MES-008)', NEW."workOrderId", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutLog_awaits_quality_hold" BEFORE INSERT ON "CutLog"
  FOR EACH ROW WHEN (NEW."reversalOfId" IS NULL)
  EXECUTE FUNCTION "factory_cut_log_quality_hold_check"();

-- OperationScan: any scan of a held bundle, or of a bundle of a held work order.
CREATE FUNCTION "factory_operation_scan_quality_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held uuid;
BEGIN
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."bundleId", NEW."workOrderId"]);
  held := "factory_quality_hold_of"(NEW."tenantId", 'Bundle', ARRAY[NEW."bundleId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: bundle % is on hold (hold %); it is not scanned until the hold is released (MES-008)', NEW."bundleId", held
      USING ERRCODE = 'check_violation';
  END IF;
  held := "factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', ARRAY[NEW."workOrderId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: work order % is on hold (hold %); its bundles are not scanned until the hold is released (MES-008)', NEW."workOrderId", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OperationScan_awaits_quality_hold" BEFORE INSERT ON "OperationScan"
  FOR EACH ROW EXECUTE FUNCTION "factory_operation_scan_quality_hold_check"();

-- QualityRelease: a release of a held work order's garments.
CREATE FUNCTION "factory_quality_release_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held uuid;
BEGIN
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."workOrderId"]);
  held := "factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', ARRAY[NEW."workOrderId"]);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: work order % is on hold (hold %); its garments are not released until the hold is released (QHS-074)', NEW."workOrderId", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "QualityRelease_awaits_quality_hold" BEFORE INSERT ON "QualityRelease"
  FOR EACH ROW EXECUTE FUNCTION "factory_quality_release_hold_check"();

-- GarmentSerial: a held serial (or one of a held work order) is neither released (MADE → RELEASED) nor packed.
CREATE FUNCTION "factory_garment_serial_quality_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held uuid;
BEGIN
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."id", NEW."workOrderId"]);
  held := coalesce("factory_quality_hold_of"(NEW."tenantId", 'GarmentSerial', ARRAY[NEW."id"]), "factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', ARRAY[NEW."workOrderId"]));
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: garment serial % is on hold (hold %); it is neither released nor packed until the hold is released (QHS-074)', NEW."serial", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "GarmentSerial_awaits_quality_hold" BEFORE UPDATE ON "GarmentSerial"
  FOR EACH ROW WHEN ((NEW."status" = 'RELEASED' AND OLD."status" <> 'RELEASED')
                     OR (NEW."shipmentLineId" IS NOT NULL AND NEW."shipmentLineId" IS DISTINCT FROM OLD."shipmentLineId"))
  EXECUTE FUNCTION "factory_garment_serial_quality_hold_check"();

-- ShipmentLine: packing a held work order's garments, or into a held shipment or parcel (a new line, more garments, or
-- a line put into a parcel).
CREATE FUNCTION "factory_shipment_line_quality_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."quantity" <= OLD."quantity" AND (NEW."parcelId" IS NULL OR NEW."parcelId" IS NOT DISTINCT FROM OLD."parcelId") THEN
    -- Less, unpacked or unchanged: nothing more goes out.
    RETURN NEW;
  END IF;
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."workOrderId", NEW."shipmentId", NEW."parcelId"]);
  held := coalesce("factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', ARRAY[NEW."workOrderId"]),
                   "factory_quality_hold_of"(NEW."tenantId", 'Shipment', ARRAY[NEW."shipmentId"]),
                   "factory_quality_hold_of"(NEW."tenantId", 'Parcel', ARRAY[NEW."parcelId"]));
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: shipment line % packs goods on hold (hold %: its work order, shipment or parcel); packing waits until the hold is released (QHS-074)', NEW."id", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShipmentLine_awaits_quality_hold" BEFORE INSERT OR UPDATE ON "ShipmentLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipment_line_quality_hold_check"();

-- Shipment: PACKED or SHIPPED while it, a parcel of it, a work order of its lines or a serial packed in it is on hold.
CREATE FUNCTION "factory_shipment_quality_hold_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parcels uuid[];
  orders uuid[];
  serials uuid[];
  held uuid;
BEGIN
  parcels := ARRAY(SELECT p."id" FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id");
  orders := ARRAY(SELECT DISTINCT l."workOrderId" FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id");
  serials := ARRAY(SELECT g."id" FROM "GarmentSerial" g JOIN "ShipmentLine" l ON l."tenantId" = g."tenantId" AND l."id" = g."shipmentLineId"
                    WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id");
  PERFORM "factory_quality_hold_wait"(NEW."tenantId", ARRAY[NEW."id"] || parcels || orders || serials);
  held := coalesce("factory_quality_hold_of"(NEW."tenantId", 'Shipment', ARRAY[NEW."id"]),
                   "factory_quality_hold_of"(NEW."tenantId", 'Parcel', parcels),
                   "factory_quality_hold_of"(NEW."tenantId", 'WorkOrder', orders),
                   "factory_quality_hold_of"(NEW."tenantId", 'GarmentSerial', serials));
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'quality: shipment % holds goods on hold (hold %); it is neither % nor sent until the hold is released (QHS-074)', NEW."id", held,
      CASE WHEN NEW."status" = 'PACKED' THEN 'packed' ELSE 'shipped' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Shipment_awaits_quality_hold" BEFORE UPDATE OF "status" ON "Shipment"
  FOR EACH ROW WHEN (NEW."status" IN ('PACKED', 'SHIPPED') AND NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION "factory_shipment_quality_hold_check"();

-- =====================================================================================================================
-- Inspections (quality.prisma, the wave's columns)

-- Inspection: the assigned inspector is one person (an office user or a worker of the site, the reference holds the
-- site), and only the office assigns (a floor session neither sets nor changes it). A decided inspection keeps it (W1's
-- factory_inspection_guard freezes it).
CREATE FUNCTION "factory_inspection_assignment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."assignedInspectorId" IS NOT NULL AND NEW."assignedInspectorWorkerId" IS NOT NULL THEN
    RAISE EXCEPTION 'quality: inspection % is assigned to one inspector: an office user or a worker of the site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'factory_floor_runtime'
     AND ((TG_OP = 'INSERT' AND (NEW."assignedInspectorId" IS NOT NULL OR NEW."assignedInspectorWorkerId" IS NOT NULL))
          OR (TG_OP = 'UPDATE' AND (NEW."assignedInspectorId", NEW."assignedInspectorWorkerId") IS DISTINCT FROM (OLD."assignedInspectorId", OLD."assignedInspectorWorkerId"))) THEN
    RAISE EXCEPTION 'quality: the office assigns inspection % to its inspector; the floor does not', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Inspection_assignment_guard" BEFORE INSERT OR UPDATE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_assignment_guard"();

-- InspectionDefect: a defect picked from the library is a defect (not a category), active when picked, and the row's
-- code is the library's; a zone id has no spaces. W1's factory_inspection_defect_guard keeps the rest (only while OPEN).
CREATE FUNCTION "factory_inspection_defect_library_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  library record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."zone" IS NOT NULL AND (btrim(NEW."zone") = '' OR NEW."zone" ~ '\s') THEN
    RAISE EXCEPTION 'quality: the zone of defect % is a zone id without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defectCodeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."defectCodeId" IS DISTINCT FROM OLD."defectCodeId" OR NEW."code" IS DISTINCT FROM OLD."code") THEN
    SELECT d."code", d."parentId", d."active" INTO library FROM "DefectCode" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."defectCodeId";
    IF FOUND THEN
      IF library."parentId" IS NULL THEN
        RAISE EXCEPTION 'quality: defect % names the category %; an inspection records a defect of the library', NEW."id", library."code"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT library."active" AND (TG_OP = 'INSERT' OR NEW."defectCodeId" IS DISTINCT FROM OLD."defectCodeId") THEN
        RAISE EXCEPTION 'quality: defect code % is retired; it is no longer picked', library."code"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."code" <> library."code" THEN
        RAISE EXCEPTION 'quality: defect % is of the library''s %: its code is %, not %', NEW."id", NEW."defectCodeId", library."code", NEW."code"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InspectionDefect_library_guard" BEFORE INSERT OR UPDATE ON "InspectionDefect"
  FOR EACH ROW EXECUTE FUNCTION "factory_inspection_defect_library_guard"();

-- =====================================================================================================================
-- Nonconformances (ncr.prisma)

-- Nonconformance (QHS-080 … QHS-090)
--   INSERT     OPEN, nothing contained, decided, closed or cancelled.
--   UPDATE     the company, number and creation never change; OPEN → CONTAINED | CANCELLED, CONTAINED → DECIDED |
--              CANCELLED, DECIDED → CLOSED; CLOSED and CANCELLED never change; the problem changes only while OPEN or
--              CONTAINED (once DECIDED only the stage, the closing, the owner and the containment due time do).
--   moves      CONTAINED: at least one containment action, every one DONE or CANCELLED and one DONE. DECIDED: its
--              decisions add up to the quantity affected and each that needs approval is approved. CLOSED: every
--              decision carried out and no hold it decides still ACTIVE. CANCELLED: no decision carried out. (Write the
--              actions and decisions first: these read them at the NCR's UPDATE.)
--   every row  a number and a title; affected above 0, suspect from 0; the source a type and an id or neither; at most
--              one finder; a colourway with its style, a lot with its item; a zone id without spaces; the defect a
--              defect of the library (not a category), active when it is set; containedAt from CONTAINED on (never on
--              OPEN), decidedAt exactly from DECIDED on, closed (time, who, signature) exactly when CLOSED, cancelled
--              (time, reason) exactly when CANCELLED; the stage times are set once.
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_nonconformance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  decided_movable CONSTANT text[] := ARRAY['tenantId', 'siteId', 'stage', 'closedAt', 'closedById', 'closeNote', 'closeSignatureSha256', 'ownerId',
                                           'containmentDueAt', 'version', 'updatedAt'];
  actions bigint;
  open_actions bigint;
  done_actions bigint;
  decided numeric;
  unapproved bigint;
  undone bigint;
  library record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: NCR % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."stage" <> 'OPEN' OR NEW."containedAt" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: NCR % starts OPEN, nothing contained or decided', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, number and creation of NCR % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."stage" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: NCR % is %; it never changes', OLD."id", OLD."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."stage" <> OLD."stage"
       AND NOT ((OLD."stage" = 'OPEN' AND NEW."stage" IN ('CONTAINED', 'CANCELLED'))
                OR (OLD."stage" = 'CONTAINED' AND NEW."stage" IN ('DECIDED', 'CANCELLED'))
                OR (OLD."stage" = 'DECIDED' AND NEW."stage" = 'CLOSED')) THEN
      RAISE EXCEPTION 'quality: NCR % cannot move from % to % (OPEN → CONTAINED → DECIDED → CLOSED; cancelled while OPEN or CONTAINED)', OLD."id", OLD."stage", NEW."stage"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."stage" = 'DECIDED' AND (to_jsonb(NEW) - decided_movable) IS DISTINCT FROM (to_jsonb(OLD) - decided_movable) THEN
      RAISE EXCEPTION 'quality: NCR % is DECIDED; its problem is read-only now (only its closing, owner and containment due time change)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."containedAt" IS NOT NULL AND NEW."containedAt" IS DISTINCT FROM OLD."containedAt")
       OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
       OR (NEW."stage" = OLD."stage" AND (NEW."containedAt" IS DISTINCT FROM OLD."containedAt" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")) THEN
      RAISE EXCEPTION 'quality: NCR % records when it was contained and decided in those moves, once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR btrim(NEW."title") = '' OR NEW."quantityAffected" <= 0 OR coalesce(NEW."quantitySuspect", 0) < 0 THEN
    RAISE EXCEPTION 'quality: NCR % has a number, a title, a quantity affected above 0 and a quantity suspect from 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) OR btrim(coalesce(NEW."sourceType", '-')) = ''
     OR (NEW."foundById" IS NOT NULL AND NEW."foundByWorkerId" IS NOT NULL)
     OR (NEW."colourwayId" IS NOT NULL AND NEW."styleId" IS NULL) OR (NEW."lotId" IS NOT NULL AND NEW."itemId" IS NULL)
     OR (NEW."zone" IS NOT NULL AND (btrim(NEW."zone") = '' OR NEW."zone" ~ '\s')) THEN
    RAISE EXCEPTION 'quality: NCR % names its source as a type and an id or neither, at most one finder, a colourway with its style, a lot with its item and a zone id without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."stage" IN ('CONTAINED', 'DECIDED', 'CLOSED') AND NEW."containedAt" IS NULL) OR (NEW."stage" = 'OPEN' AND NEW."containedAt" IS NOT NULL)
     OR (NEW."stage" IN ('DECIDED', 'CLOSED')) <> (NEW."decidedAt" IS NOT NULL)
     OR (NEW."stage" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."stage" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."stage" = 'CLOSED') <> (btrim(coalesce(NEW."closeSignatureSha256", '')) <> '')
     OR (NEW."stage" <> 'CLOSED' AND NEW."closeNote" IS NOT NULL)
     OR (NEW."stage" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."stage" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'quality: NCR % is % with the wrong times: contained from CONTAINED on, decided from DECIDED on, closed (time, who, signature) exactly when CLOSED, cancelled (time, reason) exactly when CANCELLED', NEW."id", NEW."stage"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."defectCodeId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."defectCodeId" IS DISTINCT FROM OLD."defectCodeId") THEN
    SELECT d."code", d."parentId", d."active" INTO library FROM "DefectCode" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."defectCodeId";
    IF FOUND THEN
      IF library."parentId" IS NULL OR NOT library."active" THEN
        RAISE EXCEPTION 'quality: NCR % names defect code %, which is a category or retired; an NCR names an active defect of the library', NEW."id", library."code"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."stage" <> OLD."stage" THEN
    IF NEW."stage" = 'CONTAINED' THEN
      SELECT count(*), count(*) FILTER (WHERE a."status" = 'OPEN'), count(*) FILTER (WHERE a."status" = 'DONE')
        INTO actions, open_actions, done_actions
        FROM "NcrContainmentAction" a WHERE a."tenantId" = NEW."tenantId" AND a."ncrId" = NEW."id";
      IF done_actions = 0 OR open_actions > 0 THEN
        RAISE EXCEPTION 'quality: NCR % is contained once its containment actions are done (% action(s), % open, % done; QHS-082)', NEW."id", actions, open_actions, done_actions
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."stage" = 'DECIDED' THEN
      SELECT coalesce(sum(l."quantity"), 0), count(*) FILTER (WHERE l."approvalRequired" AND l."approvedAt" IS NULL)
        INTO decided, unapproved
        FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."id";
      IF decided <> NEW."quantityAffected" OR unapproved > 0 THEN
        RAISE EXCEPTION 'quality: NCR % is decided once its whole quantity is (% of % decided) and every decision that needs approval is approved (% waiting; QHS-083)', NEW."id", decided, NEW."quantityAffected", unapproved
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."stage" = 'CLOSED' THEN
      SELECT count(*) INTO undone FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."id" AND l."doneAt" IS NULL;
      IF undone > 0 THEN
        RAISE EXCEPTION 'quality: NCR % closes once every decision is carried out (% waiting for its stock move or follow-up; QHS-090)', NEW."id", undone
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM "QualityHold" h WHERE h."tenantId" = NEW."tenantId" AND h."ncrId" = NEW."id" AND h."status" = 'ACTIVE') THEN
        RAISE EXCEPTION 'quality: NCR % still decides a hold that is ACTIVE; release or close it first (QHS-090)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."stage" = 'CANCELLED' THEN
      IF EXISTS (SELECT 1 FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."id" AND l."doneAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'quality: NCR % has a decision carried out; it is closed, not cancelled', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Nonconformance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Nonconformance"
  FOR EACH ROW EXECUTE FUNCTION "factory_nonconformance_guard"();

-- NcrContainmentAction (QHS-082)
--   INSERT, UPDATE, DELETE  only while the NCR is OPEN or CONTAINED (its row locked FOR SHARE); an action never moves
--                           to another NCR; OPEN → DONE | CANCELLED, both final.
--   every row               OTHER says what in words; DONE exactly with its time (who only with it) and its evidence:
--                           a note or a file of the action (StoredFile recordType "NcrContainmentAction"); the record a
--                           type and an id or neither; a HOLD_STOCK action done names its hold, a hold this NCR decides.
--   TRUNCATE                refused.
CREATE FUNCTION "factory_ncr_containment_action_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part_of uuid;
  stage text;
  hold_ncr uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."ncrId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."ncrId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: containment action % never moves to another NCR; its creation never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - ARRAY['tenantId', 'siteId']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['tenantId', 'siteId']) THEN
      RAISE EXCEPTION 'quality: containment action % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  part_of := CASE WHEN TG_OP = 'DELETE' THEN OLD."ncrId" ELSE NEW."ncrId" END;
  SELECT n."stage"::text INTO stage FROM "Nonconformance" n
   WHERE n."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END AND n."id" = part_of FOR SHARE;
  IF stage IS NOT NULL AND stage NOT IN ('OPEN', 'CONTAINED') THEN
    RAISE EXCEPTION 'quality: NCR % is %; its containment actions change only while it is OPEN or CONTAINED', part_of, stage
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF (NEW."kind" = 'OTHER' AND btrim(coalesce(NEW."description", '')) = '')
     OR (NEW."recordType" IS NULL) <> (NEW."recordId" IS NULL) OR btrim(coalesce(NEW."recordType", '-')) = '' THEN
    RAISE EXCEPTION 'quality: containment action % says what in words (OTHER) and names its record as a type and an id or neither', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'DONE') <> (NEW."doneAt" IS NOT NULL) OR (NEW."doneById" IS NOT NULL AND NEW."doneAt" IS NULL) THEN
    RAISE EXCEPTION 'quality: containment action % is % with the wrong completion: done exactly with its time (and who only with it)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'DONE' AND (TG_OP = 'INSERT' OR OLD."status" <> 'DONE') THEN
    IF btrim(coalesce(NEW."evidenceNote", '')) = ''
       AND NOT EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."recordType" = 'NcrContainmentAction' AND f."recordId" = NEW."id") THEN
      RAISE EXCEPTION 'quality: containment action % is done with its evidence: a note or a file of the action (QHS-082)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'HOLD_STOCK' THEN
      IF NEW."recordType" IS DISTINCT FROM 'QualityHold' THEN
        RAISE EXCEPTION 'quality: containment action % holds stock; done, it names its hold (recordType QualityHold)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT h."ncrId" INTO hold_ncr FROM "QualityHold" h WHERE h."tenantId" = NEW."tenantId" AND h."id" = NEW."recordId";
      IF (FOUND AND hold_ncr IS DISTINCT FROM NEW."ncrId") OR (NOT FOUND AND "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId")) THEN
        RAISE EXCEPTION 'quality: containment action % names hold %, which is not a hold this NCR decides', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NcrContainmentAction_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcrContainmentAction"
  FOR EACH ROW EXECUTE FUNCTION "factory_ncr_containment_action_guard"();

-- NcrDispositionLine (QHS-083, QHS-005, QHS-002)
--   INSERT, DELETE  only while the NCR is OPEN or CONTAINED (its row locked FOR UPDATE: two decisions of one NCR take
--                   turns); a new decision is neither approved nor carried out.
--   UPDATE          the NCR, the decision's time and who decided, and the creation never change; what is decided (code,
--                   quantity, note, approval rule) changes only while the NCR is OPEN or CONTAINED and the decision is
--                   neither approved nor carried out; the approval is set once, while the NCR is OPEN or CONTAINED; the
--                   carrying out (time, stock move, follow-up) is set once, until the NCR is CLOSED; nothing changes once
--                   the NCR is CLOSED or CANCELLED.
--   every row       above 0; the code active when it is chosen; USE AS IS only on a MINOR nonconformance (QHS-002); the
--                   approval only when one is needed, both or neither, never by who decided; carried out only once
--                   approved (when needed), with the stock move of the code's reason (a move of the NCR's site) when the
--                   code posts one and only then, with its follow-up record (a type and an id) when the code opens one;
--                   the NCR's decisions never pass its quantity affected.
--   TRUNCATE        refused.
CREATE FUNCTION "factory_ncr_disposition_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part_of uuid;
  ncr_stage text;
  ncr_severity text;
  affected numeric;
  code record;
  move_reason text;
  others numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."ncrId", NEW."decidedAt", NEW."decidedById", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."ncrId", OLD."decidedAt", OLD."decidedById", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: decision % never moves to another NCR; who decided it, when, and its creation never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  part_of := CASE WHEN TG_OP = 'DELETE' THEN OLD."ncrId" ELSE NEW."ncrId" END;
  SELECT n."stage"::text, n."severity"::text, n."quantityAffected" INTO ncr_stage, ncr_severity, affected
    FROM "Nonconformance" n
   WHERE n."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END AND n."id" = part_of FOR UPDATE;
  IF FOUND THEN
    IF TG_OP IN ('INSERT', 'DELETE') AND ncr_stage NOT IN ('OPEN', 'CONTAINED') THEN
      RAISE EXCEPTION 'quality: NCR % is %; decisions are added and removed while it is OPEN or CONTAINED', part_of, ncr_stage
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF ncr_stage IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'quality: NCR % is %; its decisions never change', part_of, ncr_stage
          USING ERRCODE = 'check_violation';
      END IF;
      IF (NEW."dispositionCodeId", NEW."quantity", NEW."note", NEW."approvalRequired", NEW."seq")
         IS DISTINCT FROM (OLD."dispositionCodeId", OLD."quantity", OLD."note", OLD."approvalRequired", OLD."seq")
         AND (ncr_stage NOT IN ('OPEN', 'CONTAINED') OR OLD."approvedAt" IS NOT NULL OR OLD."doneAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'quality: decision % is approved, carried out or its NCR decided; what it decides no longer changes (remove it while the NCR is open instead)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (OLD."approvedAt" IS NOT NULL AND (NEW."approvedAt", NEW."approvedById") IS DISTINCT FROM (OLD."approvedAt", OLD."approvedById"))
         OR (OLD."approvedAt" IS NULL AND NEW."approvedAt" IS NOT NULL AND ncr_stage NOT IN ('OPEN', 'CONTAINED')) THEN
        RAISE EXCEPTION 'quality: decision % is approved once, while its NCR is OPEN or CONTAINED', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."doneAt" IS NOT NULL AND (NEW."doneAt", NEW."stockMoveId", NEW."followUpType", NEW."followUpId") IS DISTINCT FROM (OLD."doneAt", OLD."stockMoveId", OLD."followUpType", OLD."followUpId") THEN
        RAISE EXCEPTION 'quality: decision % is carried out; its stock move and follow-up are set once', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."doneAt" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: decision % is carried out; it is kept', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND (NEW."approvedAt" IS NOT NULL OR NEW."doneAt" IS NOT NULL OR NEW."stockMoveId" IS NOT NULL OR NEW."followUpType" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: decision % starts neither approved nor carried out', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'quality: decision % decides a quantity above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL) OR (NEW."approvedAt" IS NOT NULL AND NOT NEW."approvalRequired")
     OR (NEW."approvedById" IS NOT NULL AND NEW."approvedById" = NEW."decidedById") THEN
    RAISE EXCEPTION 'quality: decision % is approved only when it needs approval, with when and by whom, and never by who decided it (four eyes)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."followUpType" IS NULL) <> (NEW."followUpId" IS NULL) OR btrim(coalesce(NEW."followUpType", '-')) = ''
     OR (NEW."doneAt" IS NULL AND (NEW."stockMoveId" IS NOT NULL OR NEW."followUpType" IS NOT NULL))
     OR (NEW."doneAt" IS NOT NULL AND NEW."approvalRequired" AND NEW."approvedAt" IS NULL) THEN
    RAISE EXCEPTION 'quality: decision % is carried out (with its stock move and follow-up record, as a type and an id) only once approved when it needs approval', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT c."code", c."outcome"::text AS outcome, c."stockMoveReason"::text AS reason, c."followUp"::text AS follow_up, c."active" INTO code
    FROM "DispositionCode" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."dispositionCodeId";
  IF FOUND THEN
    IF NOT code.active AND (TG_OP = 'INSERT' OR NEW."dispositionCodeId" IS DISTINCT FROM OLD."dispositionCodeId") THEN
      RAISE EXCEPTION 'quality: disposition code % is inactive; it is no longer chosen', code.code
        USING ERRCODE = 'check_violation';
    END IF;
    IF code.outcome = 'USE_AS_IS' AND ncr_severity IS NOT NULL AND ncr_severity <> 'MINOR' THEN
      RAISE EXCEPTION 'quality: NCR % is %; its goods are never used as they are (QHS-002: a critical defect is never accepted, a major one is not used as is)', part_of, ncr_severity
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."doneAt" IS NOT NULL THEN
      IF (code.reason IS NULL) <> (NEW."stockMoveId" IS NULL) THEN
        RAISE EXCEPTION 'quality: decision % with % is carried out % a stock move', NEW."id", code.code,
          CASE WHEN code.reason IS NULL THEN 'without' ELSE 'with its ' || code.reason END
          USING ERRCODE = 'check_violation';
      END IF;
      IF code.follow_up IS NOT NULL AND NEW."followUpType" IS NULL THEN
        RAISE EXCEPTION 'quality: decision % with % is carried out with its follow-up record (%)', NEW."id", code.code, code.follow_up
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."stockMoveId" IS NOT NULL THEN
        SELECT m."reason"::text INTO move_reason FROM "StockMove" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."stockMoveId";
        IF FOUND AND move_reason <> code.reason THEN
          RAISE EXCEPTION 'quality: decision % with % posts a % move, not %', NEW."id", code.code, code.reason, move_reason
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
  END IF;

  IF affected IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."quantity" <> OLD."quantity") THEN
    SELECT coalesce(sum(l."quantity"), 0) INTO others
      FROM "NcrDispositionLine" l WHERE l."tenantId" = NEW."tenantId" AND l."ncrId" = NEW."ncrId" AND l."id" <> NEW."id";
    IF others + NEW."quantity" > affected THEN
      RAISE EXCEPTION 'quality: NCR % has % affected; its decisions would decide % (QHS-083)', NEW."ncrId", affected, others + NEW."quantity"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NcrDispositionLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcrDispositionLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_ncr_disposition_line_guard"();

-- NcrLink: a record type without spaces; links are added and removed while the NCR is neither CLOSED nor CANCELLED (its
-- row locked FOR SHARE); a link is never changed (removed and made again). TRUNCATE refused.
CREATE FUNCTION "factory_ncr_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  part_of uuid;
  stage text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'quality: link % of an NCR is never changed; unlink it and link again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  part_of := CASE WHEN TG_OP = 'DELETE' THEN OLD."ncrId" ELSE NEW."ncrId" END;
  SELECT n."stage"::text INTO stage FROM "Nonconformance" n
   WHERE n."tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END AND n."id" = part_of FOR SHARE;
  IF stage IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'quality: NCR % is %; its links never change', part_of, stage
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF btrim(NEW."recordType") = '' OR NEW."recordType" ~ '\s' THEN
    RAISE EXCEPTION 'quality: link % names its record''s type, without spaces', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NcrLink_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcrLink"
  FOR EACH ROW EXECUTE FUNCTION "factory_ncr_link_guard"();

-- =====================================================================================================================
-- Machines and maintenance (plant.prisma)

-- MachineClass, MachineSymptom: their words; the code, the class of a symptom and the creation never change; never
-- deleted (set inactive). TRUNCATE refused.
CREATE FUNCTION "factory_machine_list_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: % % is set inactive, never deleted', TG_TABLE_NAME, OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) -> 'code', to_jsonb(NEW) -> 'classId', NEW."id", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (to_jsonb(OLD) -> 'code', to_jsonb(OLD) -> 'classId', OLD."id", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the code, class and creation of % % never change (requests keep them)', TG_TABLE_NAME, OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_quality_plant_words_ok"(NEW."code", NEW."labelIt", NEW."labelEn", NEW."labelI18n", NEW."icon", to_jsonb(NEW) ->> 'colour') THEN
    RAISE EXCEPTION 'plant: % % has a code without spaces, Italian and English words, its other languages as { "<language>": "<words>" }, an icon id and a #RRGGBB colour', TG_TABLE_NAME, NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MachineClass_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MachineClass"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_list_guard"();
CREATE TRIGGER "MachineSymptom_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MachineSymptom"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_list_guard"();

-- An unsafe request of this machine not signed safe yet (the lock of Owner answer H1), or null.
CREATE FUNCTION "factory_machine_lock_of"(tenant uuid, machine uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT r."id" FROM "MaintenanceRequest" r
   WHERE r."tenantId" = tenant AND r."machineId" = machine AND r."unsafe" AND r."signedSafeAt" IS NULL
   ORDER BY r."reportedAt", r."id" LIMIT 1
$$;

-- Machine (QHS-162, H1)
--   INSERT     not RETIRED.
--   UPDATE     the company, asset number and creation never change; a RETIRED machine changes only its note; a floor
--              session changes only the status (with its time and reason), never to or from RETIRED.
--   every row  an asset number without spaces; a year from 1900 to 2100; a cost from 0; DO_NOT_USE with its reason.
--   lock       (at commit) a machine with an unsafe request not signed safe stays DO_NOT_USE (or RETIRED): only a
--              technician's sign-safe lifts the lock (H1; D.Lgs. 81/2008 art. 71).
--   DELETE     refused (retired). TRUNCATE refused.
CREATE FUNCTION "factory_machine_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'siteId', 'status', 'statusSince', 'statusReason', 'version', 'updatedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: machine % is retired, never deleted (its history stays)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'plant: machine % is registered in use; it is retired later', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."assetNumber", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."assetNumber", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the company, asset number and creation of machine % never change (its tag carries the number)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'RETIRED'
       AND (to_jsonb(NEW) - (kept || ARRAY['note', 'version', 'updatedAt'])) IS DISTINCT FROM (to_jsonb(OLD) - (kept || ARRAY['note', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'plant: machine % is RETIRED; only its note changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed) OR NEW."status" = 'RETIRED') THEN
      RAISE EXCEPTION 'plant: the floor changes only the status of machine % (down or unsafe from a report, under maintenance and running from a job), never retires it', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."assetNumber") = '' OR NEW."assetNumber" ~ '\s' OR (NEW."year" IS NOT NULL AND (NEW."year" < 1900 OR NEW."year" > 2100))
     OR coalesce(NEW."purchaseCost", 0) < 0 OR (NEW."status" = 'DO_NOT_USE' AND btrim(coalesce(NEW."statusReason", '')) = '') THEN
    RAISE EXCEPTION 'plant: machine % has an asset number without spaces, a year from 1900 to 2100, a cost from 0, and a reason when it is DO_NOT_USE', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Machine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Machine"
  FOR EACH ROW EXECUTE FUNCTION "factory_machine_guard"();

CREATE FUNCTION "factory_machine_lock_kept"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lock_request uuid;
  state text;
BEGIN
  SELECT m."status"::text INTO state FROM "Machine" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."id";
  IF FOUND AND state NOT IN ('DO_NOT_USE', 'RETIRED') THEN
    lock_request := "factory_machine_lock_of"(NEW."tenantId", NEW."id");
    IF lock_request IS NOT NULL THEN
      RAISE EXCEPTION 'plant: machine % is locked as unsafe by request %; it stays DO_NOT_USE until a technician signs it safe (Owner answer H1; D.Lgs. 81/2008 art. 71)', NEW."id", lock_request
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "Machine_lock_kept" AFTER UPDATE OF "status" ON "Machine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" NOT IN ('DO_NOT_USE', 'RETIRED'))
  EXECUTE FUNCTION "factory_machine_lock_kept"();

-- MaintenanceRequest (QHS-178, H1)
--   INSERT     NEW, untriaged and not signed safe; a floor session names a worker or the station, never an office user.
--   UPDATE     the machine, whether it is unsafe, who reported it and when (station, tablet) and the creation never
--              change; NEW → ACKNOWLEDGED | JOB_MADE | MERGED | CLOSED, ACKNOWLEDGED → JOB_MADE | MERGED | CLOSED;
--              JOB_MADE, MERGED and CLOSED change only by the sign-safe; the acknowledgement and the sign-safe are set
--              once; a floor session changes only the sign-safe (a technician with the PIN, as a worker).
--   every row  at least one reporter (an office user, a worker, the station) and at most one person; acknowledged from
--              ACKNOWLEDGED on (who only with when, never on NEW); its job exactly while JOB_MADE (a job of the same
--              machine), the request it was merged into exactly while MERGED (another of the same machine), closed (when,
--              by whom) exactly when MERGED or CLOSED, why exactly when CLOSED (in words for OTHER); the sign-safe only on
--              an unsafe request, all at once: when, one technician and what was checked; an unsafe request not signed
--              safe is neither merged nor closed.
--   lock       (at commit) an unsafe request not signed safe keeps its machine DO_NOT_USE (or RETIRED).
--   DELETE     refused (closed). TRUNCATE refused.
CREATE FUNCTION "factory_maintenance_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  sign_safe CONSTANT text[] := ARRAY['tenantId', 'siteId', 'signedSafeAt', 'signedSafeById', 'signedSafeByWorkerId', 'signedSafeNote', 'version', 'updatedAt'];
  other_machine uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: request % is closed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'NEW' OR NEW."acknowledgedAt" IS NOT NULL OR NEW."jobId" IS NOT NULL OR NEW."mergedIntoId" IS NOT NULL OR NEW."closedAt" IS NOT NULL
       OR NEW."signedSafeAt" IS NOT NULL THEN
      RAISE EXCEPTION 'plant: request % starts NEW, untriaged and not signed safe', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND NEW."reportedById" IS NOT NULL THEN
      RAISE EXCEPTION 'plant: the floor reports request % as a worker or as the station, never as an office user', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."machineId", NEW."unsafe", NEW."reportedAt", NEW."reportedById", NEW."reportedByWorkerId", NEW."stationId", NEW."deviceId",
        NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."machineId", OLD."unsafe", OLD."reportedAt", OLD."reportedById", OLD."reportedByWorkerId", OLD."stationId", OLD."deviceId",
        OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the machine of request %, whether it is unsafe, who reported it and when never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT (OLD."status" IN ('NEW', 'ACKNOWLEDGED') AND NEW."status" IN ('ACKNOWLEDGED', 'JOB_MADE', 'MERGED', 'CLOSED')) THEN
      RAISE EXCEPTION 'plant: request % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('JOB_MADE', 'MERGED', 'CLOSED') AND (to_jsonb(NEW) - sign_safe) IS DISTINCT FROM (to_jsonb(OLD) - sign_safe) THEN
      RAISE EXCEPTION 'plant: request % is %; only its sign-safe is still written', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."acknowledgedAt" IS NOT NULL AND (NEW."acknowledgedAt", NEW."acknowledgedById") IS DISTINCT FROM (OLD."acknowledgedAt", OLD."acknowledgedById"))
       OR (OLD."signedSafeAt" IS NOT NULL
           AND (NEW."signedSafeAt", NEW."signedSafeById", NEW."signedSafeByWorkerId", NEW."signedSafeNote")
               IS DISTINCT FROM (OLD."signedSafeAt", OLD."signedSafeById", OLD."signedSafeByWorkerId", OLD."signedSafeNote")) THEN
      RAISE EXCEPTION 'plant: the acknowledgement and the sign-safe of request % are written once', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime' AND ((to_jsonb(NEW) - sign_safe) IS DISTINCT FROM (to_jsonb(OLD) - sign_safe) OR NEW."signedSafeById" IS NOT NULL) THEN
      RAISE EXCEPTION 'plant: the floor signs request % safe (a technician with the PIN); nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."reportedById" IS NULL AND NEW."reportedByWorkerId" IS NULL AND NEW."stationId" IS NULL)
     OR (NEW."reportedById" IS NOT NULL AND NEW."reportedByWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: request % names who reported it: an office user, a worker or the station (at most one person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'NEW' AND NEW."acknowledgedAt" IS NOT NULL) OR (NEW."status" = 'ACKNOWLEDGED' AND NEW."acknowledgedAt" IS NULL)
     OR (NEW."acknowledgedById" IS NOT NULL AND NEW."acknowledgedAt" IS NULL)
     OR (NEW."status" = 'JOB_MADE') <> (NEW."jobId" IS NOT NULL)
     OR (NEW."status" = 'MERGED') <> (NEW."mergedIntoId" IS NOT NULL) OR NEW."mergedIntoId" = NEW."id"
     OR (NEW."status" IN ('MERGED', 'CLOSED')) <> (NEW."closedAt" IS NOT NULL)
     OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL)
     OR (NEW."status" <> 'CLOSED' AND NEW."closeNote" IS NOT NULL)
     OR (NEW."closeReason" = 'OTHER' AND btrim(coalesce(NEW."closeNote", '')) = '') THEN
    RAISE EXCEPTION 'plant: request % is % with the wrong triage: acknowledged from ACKNOWLEDGED on, its job exactly while JOB_MADE, the request it joined exactly while MERGED, closed (when) exactly when MERGED or CLOSED, why exactly when CLOSED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."signedSafeAt" IS NOT NULL AND NOT NEW."unsafe")
     OR (NEW."signedSafeAt" IS NULL) <> (NEW."signedSafeById" IS NULL AND NEW."signedSafeByWorkerId" IS NULL)
     OR (NEW."signedSafeById" IS NOT NULL AND NEW."signedSafeByWorkerId" IS NOT NULL)
     OR (NEW."signedSafeAt" IS NULL) <> (btrim(coalesce(NEW."signedSafeNote", '')) = '') THEN
    RAISE EXCEPTION 'plant: request % is signed safe only when it was unsafe, all at once: when, one technician and what was checked (H1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."unsafe" AND NEW."signedSafeAt" IS NULL AND NEW."status" IN ('MERGED', 'CLOSED') THEN
    RAISE EXCEPTION 'plant: request % locked its machine as unsafe; it is neither merged nor closed before a technician signs the machine safe (H1)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."jobId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."jobId" IS DISTINCT FROM OLD."jobId") THEN
    SELECT j."machineId" INTO other_machine FROM "MaintenanceJob" j WHERE j."tenantId" = NEW."tenantId" AND j."id" = NEW."jobId";
    IF FOUND AND other_machine <> NEW."machineId" THEN
      RAISE EXCEPTION 'plant: request % is about machine %; its job % is about another machine', NEW."id", NEW."machineId", NEW."jobId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."mergedIntoId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."mergedIntoId" IS DISTINCT FROM OLD."mergedIntoId") THEN
    SELECT r."machineId" INTO other_machine FROM "MaintenanceRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."mergedIntoId";
    IF FOUND AND other_machine <> NEW."machineId" THEN
      RAISE EXCEPTION 'plant: request % joins a request of another machine', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MaintenanceRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MaintenanceRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_maintenance_request_guard"();

CREATE FUNCTION "factory_maintenance_request_locks_machine"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
BEGIN
  SELECT m."status"::text INTO state FROM "Machine" m WHERE m."tenantId" = NEW."tenantId" AND m."id" = NEW."machineId";
  IF FOUND AND state NOT IN ('DO_NOT_USE', 'RETIRED')
     AND EXISTS (SELECT 1 FROM "MaintenanceRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."id" AND r."unsafe" AND r."signedSafeAt" IS NULL) THEN
    RAISE EXCEPTION 'plant: request % marks machine % unsafe; the machine is DO_NOT_USE in the same transaction (Owner answer H1: at once)', NEW."id", NEW."machineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "MaintenanceRequest_locks_machine" AFTER INSERT OR UPDATE ON "MaintenanceRequest"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."unsafe" AND NEW."signedSafeAt" IS NULL)
  EXECUTE FUNCTION "factory_maintenance_request_locks_machine"();

-- MaintenanceJob (QHS-184)
--   INSERT     NEW or PLANNED, not started, handed back, closed or cancelled.
--   UPDATE     the company, number, machine, source and creation never change; the moves of MaintenanceJobStatus;
--              CLOSED and CANCELLED never change; the start time is set once; a floor session (a technician) only
--              starts, pauses for parts, hands back and takes back its work (the status among NEW, PLANNED,
--              IN_PROGRESS, WAITING_PARTS and HANDED_BACK, the start and the hand-back as a worker), nothing else.
--   every row  a number and a problem; at most one technician; started from IN_PROGRESS on (never while NEW or PLANNED);
--              the hand-back (when, one person, what was done, the machine after: RUNNING, DO_NOT_USE or RETIRED)
--              exactly while HANDED_BACK or CLOSED; closed exactly when CLOSED (who only with it); cancelled (when, why)
--              exactly when CANCELLED. Handed back RUNNING only once the machine has no unsafe request left that is not
--              signed safe (H1: sign it safe first).
--   DELETE     refused (cancelled). TRUNCATE refused.
CREATE FUNCTION "factory_maintenance_job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  floor_allowed CONSTANT text[] := ARRAY['tenantId', 'siteId', 'status', 'startedAt', 'handedBackAt', 'handedBackByWorkerId', 'workDone', 'machineAfter',
                                         'version', 'updatedAt'];
  lock_request uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plant: maintenance job % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('NEW', 'PLANNED') OR NEW."startedAt" IS NOT NULL OR NEW."handedBackAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION 'plant: maintenance job % starts NEW or PLANNED, not started', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."number", NEW."machineId", NEW."source", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."number", OLD."machineId", OLD."source", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'plant: the company, number, machine, source and creation of maintenance job % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'plant: maintenance job % is %; it never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'NEW' AND NEW."status" IN ('PLANNED', 'IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'PLANNED' AND NEW."status" IN ('NEW', 'IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('WAITING_PARTS', 'HANDED_BACK', 'CANCELLED'))
                OR (OLD."status" = 'WAITING_PARTS' AND NEW."status" IN ('IN_PROGRESS', 'CANCELLED'))
                OR (OLD."status" = 'HANDED_BACK' AND NEW."status" IN ('IN_PROGRESS', 'CLOSED'))) THEN
      RAISE EXCEPTION 'plant: maintenance job % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
      RAISE EXCEPTION 'plant: maintenance job % started at %; its start is set once', OLD."id", OLD."startedAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - floor_allowed) IS DISTINCT FROM (to_jsonb(OLD) - floor_allowed) OR NEW."status" IN ('CLOSED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'plant: the floor starts, pauses and hands back maintenance job % (a technician); closing, cancelling and planning it are the office''s', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."number") = '' OR btrim(NEW."problem") = '' OR (NEW."assigneeId" IS NOT NULL AND NEW."assigneeWorkerId" IS NOT NULL) THEN
    RAISE EXCEPTION 'plant: maintenance job % has a number, a problem and at most one technician', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('NEW', 'PLANNED') AND NEW."startedAt" IS NOT NULL)
     OR (NEW."status" IN ('IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK', 'CLOSED') AND NEW."startedAt" IS NULL) THEN
    RAISE EXCEPTION 'plant: maintenance job % is % with the wrong start: started from IN_PROGRESS on, never while NEW or PLANNED', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> (NEW."handedBackAt" IS NOT NULL)
     OR (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> (NEW."machineAfter" IS NOT NULL)
     OR (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> (btrim(coalesce(NEW."workDone", '')) <> '')
     OR (NEW."status" IN ('HANDED_BACK', 'CLOSED')) <> ((NEW."handedBackById" IS NULL) <> (NEW."handedBackByWorkerId" IS NULL))
     OR (NEW."status" NOT IN ('HANDED_BACK', 'CLOSED') AND (NEW."handedBackById" IS NOT NULL OR NEW."handedBackByWorkerId" IS NOT NULL))
     OR (NEW."machineAfter" IS NOT NULL AND NEW."machineAfter" NOT IN ('RUNNING', 'DO_NOT_USE', 'RETIRED')) THEN
    RAISE EXCEPTION 'plant: maintenance job % is % with the wrong hand-back: exactly while HANDED_BACK or CLOSED, with when, one person, what was done and the machine after (RUNNING, DO_NOT_USE or RETIRED)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'plant: maintenance job % is % with the wrong closing or cancellation', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."machineAfter" = 'RUNNING' AND NEW."status" IN ('HANDED_BACK', 'CLOSED') AND (TG_OP = 'INSERT' OR OLD."status" NOT IN ('HANDED_BACK', 'CLOSED') OR OLD."machineAfter" IS DISTINCT FROM 'RUNNING') THEN
    lock_request := "factory_machine_lock_of"(NEW."tenantId", NEW."machineId");
    IF lock_request IS NOT NULL THEN
      RAISE EXCEPTION 'plant: maintenance job % hands machine % back running, but request % locked it as unsafe and no technician signed it safe yet (H1: sign it safe first)', NEW."id", NEW."machineId", lock_request
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MaintenanceJob_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MaintenanceJob"
  FOR EACH ROW EXECUTE FUNCTION "factory_maintenance_job_guard"();

-- =====================================================================================================================
-- Shipping (shipping.prisma, the wave's columns)

-- ShippingSettings: the freight rule (LOG-105): NONE has no amounts; PER_SHIPMENT and PER_PARCEL their amount from 0; a
-- free-from value from 0, only with a charging rule.
CREATE FUNCTION "factory_shipping_settings_freight_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."freightRule" = 'NONE') <> (NEW."freightAmount" IS NULL)
     OR (NEW."freightRule" = 'NONE' AND NEW."freightFreeFrom" IS NOT NULL)
     OR coalesce(NEW."freightAmount", 0) < 0 OR coalesce(NEW."freightFreeFrom", 0) < 0 THEN
    RAISE EXCEPTION 'shipping: the freight rule of the shipping settings % is NONE without amounts, or a charge per shipment or per parcel with its amount from 0 (and a free-from value from 0)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ShippingSettings_freight_guard" BEFORE INSERT OR UPDATE ON "ShippingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_shipping_settings_freight_guard"();

-- Shipment (REDEFINES 202610283901_quality_shipping_guards' "factory_shipment_guard"; its rules and words kept, the
-- trigger stays): W2a adds the freight charged (from 0; it still changes after the goods left, until the shipment is
-- cancelled) and the intra-EU transport evidence (only once the goods left; COMPLETE exactly with when and who checked
-- it; it still changes after delivery). The floor's changes stay DRAFT ⇄ PACKED only (it cannot write the new columns:
-- freightCharge is not in its column grant).
CREATE OR REPLACE FUNCTION "factory_shipment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId', 'partyId'];
  -- W2a: what still changes once the goods left.
  after_leaving CONSTANT text[] := ARRAY['freightCharge', 'transportEvidence', 'transportEvidenceAt', 'transportEvidenceById', 'transportEvidenceNote'];
  order_state text;
  lines bigint;
  unpacked bigint;
  parcels bigint;
  unweighed bigint;
  unserialled bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shipping: shipment % is cancelled, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'shipping: shipment % starts as a DRAFT, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT o."status"::text INTO order_state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId";
    IF FOUND AND order_state IN ('CANCELLED', 'CLOSED') THEN
      RAISE EXCEPTION 'shipping: sales order % is %; nothing more ships for it', NEW."salesOrderId", order_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."salesOrderId", NEW."number", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."salesOrderId", OLD."number", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'shipping: the company, order, number and creation of shipment % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" IN ('PACKED', 'CANCELLED'))
                OR (OLD."status" = 'PACKED' AND NEW."status" IN ('DRAFT', 'SHIPPED', 'CANCELLED'))
                OR (OLD."status" = 'SHIPPED' AND NEW."status" IN ('DELIVERED', 'RETURNED'))) THEN
      RAISE EXCEPTION 'shipping: shipment % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CANCELLED'
       AND (to_jsonb(NEW) - (kept || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    -- W2a: after delivery (or the return) the freight charged and the transport evidence still change (LOG-105, LOG-090).
    IF OLD."status" IN ('DELIVERED', 'RETURNED')
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % is %; only its internal note changes (and, W2a, the freight charged and its transport evidence)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'SHIPPED'
       AND (to_jsonb(NEW) - (kept || after_leaving || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt']))
           IS DISTINCT FROM
           (to_jsonb(OLD) - (kept || after_leaving || ARRAY['status', 'deliveredAt', 'returnedAt', 'internalNote', 'version', 'updatedAt'])) THEN
      RAISE EXCEPTION 'shipping: shipment % left; only its delivery or return and its internal note change (and, W2a, the freight charged and its transport evidence)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_floor_runtime'
       AND ((to_jsonb(NEW) - (kept || ARRAY['status', 'packedAt', 'version', 'updatedAt']))
            IS DISTINCT FROM
            (to_jsonb(OLD) - (kept || ARRAY['status', 'packedAt', 'version', 'updatedAt']))
            OR (NEW."status" <> OLD."status"
                AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED') OR (OLD."status" = 'PACKED' AND NEW."status" = 'DRAFT')))) THEN
      RAISE EXCEPTION 'shipping: the floor packs and unpacks shipment % (DRAFT ⇄ PACKED), nothing else', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."status" = 'DRAFT' AND NEW."status" = 'PACKED' THEN
      SELECT count(*), count(*) FILTER (WHERE l."parcelId" IS NULL) INTO lines, unpacked
        FROM "ShipmentLine" l WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id";
      SELECT count(*), count(*) FILTER (WHERE p."grossWeightKg" IS NULL) INTO parcels, unweighed
        FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."id";
      IF lines = 0 OR unpacked > 0 OR parcels = 0 OR unweighed > 0 THEN
        RAISE EXCEPTION 'shipping: shipment % is PACKED with its lines, each in a parcel, and its parcels, each weighed (% line(s), % not in a parcel; % parcel(s), % not weighed)', NEW."id", lines, unpacked, parcels, unweighed
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO unserialled
        FROM "ShipmentLine" l
        JOIN "WorkOrder" w ON w."tenantId" = l."tenantId" AND w."id" = l."workOrderId"
        JOIN "Style" s ON s."tenantId" = w."tenantId" AND s."id" = w."styleId"
       WHERE l."tenantId" = NEW."tenantId" AND l."shipmentId" = NEW."id" AND s."garmentTracking" = 'SERIAL'
         AND l."quantity" <> (SELECT count(*) FROM "GarmentSerial" g WHERE g."tenantId" = l."tenantId" AND g."shipmentLineId" = l."id");
      IF unserialled > 0 THEN
        RAISE EXCEPTION 'shipping: shipment % has % line(s) of a serial-tracked style without a serial for each garment (Q31)', NEW."id", unserialled
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF btrim(NEW."number") = '' THEN
    RAISE EXCEPTION 'shipping: shipment % has a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" IN ('PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED') AND NEW."packedAt" IS NULL)
     OR (NEW."status" = 'DRAFT' AND NEW."packedAt" IS NOT NULL)
     OR (NEW."status" IN ('SHIPPED', 'DELIVERED', 'RETURNED')) <> (NEW."shippedAt" IS NOT NULL)
     OR (NEW."status" = 'DELIVERED') <> (NEW."deliveredAt" IS NOT NULL)
     OR (NEW."status" = 'RETURNED') <> (NEW."returnedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong packing, shipping, delivery or return time', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CANCELLED') <> (NEW."cancelledAt" IS NOT NULL)
     OR (NEW."status" = 'CANCELLED') <> (btrim(coalesce(NEW."cancelReason", '')) <> '') THEN
    RAISE EXCEPTION 'shipping: shipment % is % with the wrong cancellation (a cancelled shipment has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2a: the freight charged from 0 (LOG-105); transport evidence only once the goods left, COMPLETE exactly with when and
  -- who checked it (LOG-090; art. 41 DL 331/93).
  IF coalesce(NEW."freightCharge", 0) < 0 THEN
    RAISE EXCEPTION 'shipping: the freight charged for shipment % is 0 or more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."transportEvidence" <> 'NOT_NEEDED' AND NEW."status" NOT IN ('SHIPPED', 'DELIVERED', 'RETURNED'))
     OR (NEW."transportEvidence" = 'COMPLETE') <> (NEW."transportEvidenceAt" IS NOT NULL)
     OR (NEW."transportEvidence" = 'COMPLETE') <> (NEW."transportEvidenceById" IS NOT NULL) THEN
    RAISE EXCEPTION 'shipping: shipment % is % with transport evidence %: evidence is kept once the goods left, and COMPLETE exactly with when and who checked it', NEW."id", NEW."status", NEW."transportEvidence"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Ddt, INSERT (REDEFINES 202610283901_quality_shipping_guards' "factory_ddt_check"; every W1 rule and word kept, the
-- trigger and the append-only triggers stay): W2a (LOG-056) adds the DDT for another reason. Exactly one of a shipment
-- or a source record (type and id). A shipment's DDT keeps W1's rules (PACKED or SHIPPED, packages = parcels). A
-- source's DDT: the source is a SubcontractOrder (its kit, WORK_ON_ACCOUNT: conto lavorazione; ISSUED, AT_WORKSHOP or
-- PARTLY_RECEIVED), a SupplierClaim (RETURN to the supplier; SENT or ACCEPTED), a RepairOrder (REPAIR or
-- RETURN_FROM_WORK back to the customer; RECEIVED, ESTIMATED, REPAIRED, or SHIPPED for a replacement; a repaired PPE
-- garment only after a passed safety check made after the repair) or a ReturnAuthorisation (RETURN: goods sent back
-- unchanged; RECEIVED, INSPECTED or CLOSED); OTHER (in words) fits any; the source is of the DDT's company, site and
-- party. The number (the company's DDT series, gapless per year), the fields of DPR 472/1996, and that the DDT never
-- changes are W1's, for every DDT.
CREATE OR REPLACE FUNCTION "factory_ddt_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  series_kind text;
  state text;
  parcels bigint;
  source_found boolean := false;
  source_company uuid;
  source_site uuid;
  source_party uuid;
  source_state text;
  repaired_unchecked boolean := false;
BEGIN
  -- W2a (LOG-056): a shipment, or another source record, exactly one.
  IF (NEW."shipmentId" IS NULL) = (NEW."sourceType" IS NULL) OR (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL) THEN
    RAISE EXCEPTION 'shipping: DDT % carries the goods of a shipment or of another source record (a type and an id), exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."number") = '' OR btrim(NEW."appearance") = '' THEN
    RAISE EXCEPTION 'shipping: DDT % has a number and the goods'' appearance (DPR 472/1996)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" = 'OTHER' AND btrim(coalesce(NEW."reasonText", '')) = '' THEN
    RAISE EXCEPTION 'shipping: DDT % says its reason for the transport in words (causale OTHER)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."transportBy" = 'CARRIER'
     AND (NEW."carrier" IS NULL OR jsonb_typeof(NEW."carrier") <> 'object' OR btrim(coalesce(NEW."carrier" ->> 'name', '')) = '') THEN
    RAISE EXCEPTION 'shipping: DDT % names its carrier (DPR 472/1996: the carrier''s identity)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."packages" < 1 OR NEW."grossWeightKg" <= 0
     OR (NEW."netWeightKg" IS NOT NULL AND (NEW."netWeightKg" <= 0 OR NEW."netWeightKg" > NEW."grossWeightKg")) THEN
    RAISE EXCEPTION 'shipping: DDT % has packages from 1, a gross weight above 0 and a net weight above 0 and at most the gross', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(NEW."sender") <> 'object' OR jsonb_typeof(NEW."recipient") <> 'object'
     OR (NEW."destination" IS NOT NULL AND jsonb_typeof(NEW."destination") <> 'object')
     OR jsonb_typeof(NEW."lines") <> 'array' OR jsonb_array_length(NEW."lines") = 0 THEN
    RAISE EXCEPTION 'shipping: DDT % holds its sender, recipient (and place of delivery) as objects and its goods as a list of at least one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."kind"::text INTO series_kind FROM "NumberSeries" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."numberSeriesId";
  IF FOUND AND series_kind <> 'DDT' THEN
    RAISE EXCEPTION 'shipping: DDT % is numbered from a DDT series, not a % series', NEW."id", series_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."shipmentId" IS NOT NULL THEN
    SELECT sh."status"::text INTO state FROM "Shipment" sh WHERE sh."tenantId" = NEW."tenantId" AND sh."id" = NEW."shipmentId";
    IF FOUND THEN
      IF state NOT IN ('PACKED', 'SHIPPED') THEN
        RAISE EXCEPTION 'shipping: shipment % is %; a DDT is issued for a PACKED or SHIPPED shipment', NEW."shipmentId", state
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*) INTO parcels FROM "Parcel" p WHERE p."tenantId" = NEW."tenantId" AND p."shipmentId" = NEW."shipmentId";
      IF parcels > 0 AND NEW."packages" <> parcels THEN
        RAISE EXCEPTION 'shipping: DDT % states % package(s); shipment % has % parcel(s)', NEW."id", NEW."packages", NEW."shipmentId", parcels
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- W2a (LOG-056): a DDT for another reason. A sale travels with its shipment; each source gives its own reasons (OTHER,
  -- in words, always); the source is of the DDT's company, site and party, in a state its goods leave in.
  IF NEW."sourceType" NOT IN ('SubcontractOrder', 'SupplierClaim', 'RepairOrder', 'ReturnAuthorisation') THEN
    RAISE EXCEPTION 'shipping: DDT % carries the goods of a %; a DDT without a shipment carries a subcontract order''s kit, a supplier claim''s return, a repair or a return', NEW."id", NEW."sourceType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW."reason" = 'OTHER'
          OR (NEW."sourceType" = 'SubcontractOrder' AND NEW."reason" = 'WORK_ON_ACCOUNT')
          OR (NEW."sourceType" = 'SupplierClaim' AND NEW."reason" = 'RETURN')
          OR (NEW."sourceType" = 'RepairOrder' AND NEW."reason" IN ('REPAIR', 'RETURN_FROM_WORK'))
          OR (NEW."sourceType" = 'ReturnAuthorisation' AND NEW."reason" = 'RETURN')) THEN
    RAISE EXCEPTION 'shipping: DDT % of a % gives the reason %; a subcontract kit goes on conto lavorazione (WORK_ON_ACCOUNT), a supplier claim''s goods and a return go back as RETURN, a repair as REPAIR or RETURN_FROM_WORK (OTHER in words for anything else)', NEW."id", NEW."sourceType", NEW."reason"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceType" = 'SubcontractOrder' THEN
    SELECT o."companyId", o."siteId", o."partyId", o."status"::text, true
      INTO source_company, source_site, source_party, source_state, source_found
      FROM "SubcontractOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."sourceId";
    IF source_found AND source_state NOT IN ('ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED') THEN
      RAISE EXCEPTION 'shipping: subcontract order % is %; its kit travels while it is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED', NEW."sourceId", source_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."sourceType" = 'SupplierClaim' THEN
    SELECT c."companyId", c."siteId", c."partyId", c."status"::text, true
      INTO source_company, source_site, source_party, source_state, source_found
      FROM "SupplierClaim" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."sourceId";
    IF source_found AND source_state NOT IN ('SENT', 'ACCEPTED') THEN
      RAISE EXCEPTION 'shipping: supplier claim % is %; its goods go back once it is SENT or ACCEPTED', NEW."sourceId", source_state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."sourceType" = 'RepairOrder' THEN
    SELECT r."companyId", r."siteId", r."partyId", r."stage"::text, true,
           (r."stage" = 'REPAIRED' AND r."safetyCheckRequired"
            AND (r."safetyCheckResult" IS DISTINCT FROM 'PASS' OR r."safetyCheckedAt" IS NULL OR r."safetyCheckedAt" < r."repairedAt"))
      INTO source_company, source_site, source_party, source_state, source_found, repaired_unchecked
      FROM "RepairOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."sourceId";
    IF source_found AND source_state NOT IN ('RECEIVED', 'ESTIMATED', 'REPAIRED', 'SHIPPED') THEN
      RAISE EXCEPTION 'shipping: repair % is %; the garment goes back from RECEIVED, ESTIMATED or REPAIRED (a new DDT while SHIPPED replaces a cancelled one)', NEW."sourceId", source_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF source_found AND repaired_unchecked THEN
      RAISE EXCEPTION 'shipping: repair % is a repaired PPE garment; it goes back only after a passed safety check made after the repair', NEW."sourceId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT a."companyId", a."siteId", a."partyId", a."status"::text, true
      INTO source_company, source_site, source_party, source_state, source_found
      FROM "ReturnAuthorisation" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."sourceId";
    IF source_found AND source_state NOT IN ('RECEIVED', 'INSPECTED', 'CLOSED') THEN
      RAISE EXCEPTION 'shipping: return % is %; its goods are sent back once they arrived (RECEIVED, INSPECTED or CLOSED)', NEW."sourceId", source_state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF source_found AND (source_company <> NEW."companyId" OR source_site <> NEW."siteId" OR source_party <> NEW."partyId") THEN
    RAISE EXCEPTION 'shipping: DDT % is of the company, site and party of its % %', NEW."id", NEW."sourceType", NEW."sourceId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(source_found, false) AND "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") THEN
    RAISE EXCEPTION 'shipping: DDT % names % %, which is not a record of its tenant', NEW."id", NEW."sourceType", NEW."sourceId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- The PPE register (quality.prisma)

-- PpeRegisterEntry (REDEFINES 202610302201_sales_w2a_guards' "factory_ppe_register_entry_guard", whose body it keeps;
-- the trigger stays): one more source type, the Nonconformance (a nonconformity of PPE that may present a risk opens its
-- register entry, Reg. 2016/425 art. 8(4); B-W2a-47).
CREATE OR REPLACE FUNCTION "factory_ppe_register_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  wanted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: PPE register entry % is kept (closed), never deleted (Reg. 2016/425 art. 8(4))', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'quality: PPE register entry % starts OPEN, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."reference", NEW."kind", NEW."reportedAt", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."reference", OLD."kind", OLD."reportedAt", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'quality: the company, reference, kind, report time and creation of PPE register entry % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: PPE register entry % is CLOSED; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."reference") = '' OR btrim(NEW."description") = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % has a reference and a description', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'CLOSED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."status" = 'CLOSED') <> (NEW."closedById" IS NOT NULL)
     OR (NEW."status" = 'CLOSED') <> (NEW."closeReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'quality: PPE register entry % is % with the wrong closing: a closed entry has its time, who closed it and why', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The source, the authority's reference, the corrective action done.
  IF (NEW."sourceType" IS NULL) <> (NEW."sourceId" IS NULL)
     OR (NEW."sourceType" IS NOT NULL AND NEW."sourceType" NOT IN ('QualityReleaseReversal', 'QualityRelease', 'Inspection', 'Shipment', 'LabResult', 'Complaint', 'Nonconformance')) THEN
    RAISE EXCEPTION 'quality: PPE register entry % names its source as a known record type and an id, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."authorityReference" IS NOT NULL AND NEW."authorityNotifiedAt" IS NULL THEN
    RAISE EXCEPTION 'quality: PPE register entry % has an authority reference without the date the authority was told', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."actionCompletedAt" IS NOT NULL AND btrim(coalesce(NEW."actionTaken", '')) = '' THEN
    RAISE EXCEPTION 'quality: PPE register entry % marks a corrective action done without the action', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The id lists: rows of the entry's tenant and company (work orders also of its style).
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."lotIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Lot" l WHERE l."tenantId" = NEW."tenantId" AND l."companyId" = NEW."companyId" AND l."id" = ANY(NEW."lotIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a material lot that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."workOrderIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."companyId" = NEW."companyId" AND w."styleId" = NEW."styleId" AND w."id" = ANY(NEW."workOrderIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a work order that is not of its company and style', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  wanted := cardinality(ARRAY(SELECT DISTINCT unnest(coalesce(NEW."shipmentIds", '{}'::uuid[]))));
  IF wanted > 0 AND (SELECT count(*) FROM "Shipment" s WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" AND s."id" = ANY(NEW."shipmentIds")) <> wanted THEN
    RAISE EXCEPTION 'quality: PPE register entry % names a shipment that is not of its company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- OPEN → CLOSED: its duties met.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    IF btrim(NEW."closeReason") = '' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes with a reason', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'ASSESSING' THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its risk is decided (yes or no)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(coalesce(NEW."actionTaken", '')) = '' OR NEW."actionCompletedAt" IS NULL THEN
      RAISE EXCEPTION 'quality: PPE register entry % closes once its corrective action is written and done (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."risk" = 'YES' AND (NEW."authorityNotifiedAt" IS NULL OR btrim(coalesce(NEW."authorityReference", '')) = '') THEN
      RAISE EXCEPTION 'quality: PPE register entry % may present a risk: it closes once the authorities were told, with the date and their reference (Reg. 2016/425 art. 8(8))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."distributorsInformedAt" IS NULL AND EXISTS (
      SELECT 1
      FROM "ShipmentLine" sl
      JOIN "Shipment" s ON s."tenantId" = sl."tenantId" AND s."id" = sl."shipmentId"
      JOIN "WorkOrder" w ON w."tenantId" = sl."tenantId" AND w."id" = sl."workOrderId"
      WHERE sl."tenantId" = NEW."tenantId"
        AND s."companyId" = NEW."companyId"
        AND s."status" IN ('SHIPPED', 'DELIVERED')
        AND w."companyId" = NEW."companyId"
        AND w."styleId" = NEW."styleId"
        AND (
          w."id" = ANY(coalesce(NEW."workOrderIds", '{}'::uuid[]))
          OR w."batchNumber" = ANY(coalesce(NEW."batchNumbers", '{}'::text[]))
          OR s."id" = ANY(coalesce(NEW."shipmentIds", '{}'::uuid[]))
          OR EXISTS (
            SELECT 1 FROM "StockMove" m
            WHERE m."tenantId" = NEW."tenantId" AND m."companyId" = NEW."companyId" AND m."workOrderId" = w."id"
              AND m."lotId" = ANY(coalesce(NEW."lotIds", '{}'::uuid[])) AND m."reason" = 'ISSUE' AND m."reversalOfId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "StockMove" r WHERE r."tenantId" = m."tenantId" AND r."siteId" = m."siteId" AND r."reversalOfId" = m."id")
          )
          OR EXISTS (
            SELECT 1 FROM "GarmentSerial" g
            WHERE g."tenantId" = sl."tenantId" AND g."shipmentLineId" = sl."id" AND g."serial" = ANY(coalesce(NEW."serials", '{}'::text[]))
          )
        )
    ) THEN
      RAISE EXCEPTION 'quality: garments PPE register entry % concerns left for customers: it closes once the distributors were informed (Reg. 2016/425 art. 8(4))', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
