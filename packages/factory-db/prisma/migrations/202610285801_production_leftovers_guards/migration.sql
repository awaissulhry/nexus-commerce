-- Written by hand (Prisma does not model triggers), after the generated 202610285800_production_leftovers and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Production leftovers (B-W1-40, B-W1-41; MES-065, MES-073, MES-184): the hand-written rules of what
-- 202610285800_production_leftovers made, for every login (the owner included). The API answers each refusal first, in
-- words (apps/factory-api modules/production/{settings,bundles,cutting}, platform/print); these are the last word. The
-- tenant, company and site of a row are left to the policies and the references: a rule that reads another row skips a
-- row this session cannot see (the policies refuse that write anyway).
--
--   ProductionSettings  the standard bundle size is 1 to 500 garments. REDEFINES factory_production_settings_guard
--                       (202610283801_production_guards): its whole body, plus that one rule.
--   Bundle              a client event id is not blank, and never changes (the frozen columns); a reprint's new code
--                       comes with its BundleReprint row (the reason). REDEFINES factory_bundle_guard
--                       (202610283801_production_guards): its whole body, plus those two rules.
--   BundleReprint       append-only. It says why; its new code is not the code it replaced; it reprints the ticket of an
--                       ACTIVE bundle, on a label printer; by the end of its transaction the bundle carries the new code
--                       and the replaced one among its replaced codes (a deferred check: an entry without its reprint is
--                       refused).
--   Station             its label printer (MES-184) is a label printer (LABEL_ZPL) that is not archived.
--   Hide                CONSUMED names its closing cut log entry (a live entry of the hide); CONSUMED stays final but for
--                       one move: back to PARTLY_CUT, its closing entry cleared, once that entry is reversed. REDEFINES
--                       factory_hide_guard (202610283701_supply_guards): its whole body, with the closing entry and the
--                       one move out of CONSUMED.
--   CutLog              a reversal of an entry of a CONSUMED hide reverses only its closing entry, and opens the hide
--                       again in the same transaction (a deferred check).

-- ---------------------------------------------------------------------------------------------------------------------
-- ProductionSettings (B-W1-37, SCR-074, MES-278; MES-065 the standard bundle size)
--   UPDATE     an UPDATE that changes nothing passes; the company and creation never change.
--   every row  the legal basis, its reference and when it was recorded go together (all or none); the standard bundle
--              size is 1 to 500 garments.
--   DELETE     refused (the rules are changed, never removed). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_production_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: the floor rules % are changed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company and creation of the floor rules % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."monitoringBasis" IS NULL) <> (NEW."monitoringRecordedAt" IS NULL)
     OR (NEW."monitoringBasis" IS NULL) <> (btrim(coalesce(NEW."monitoringReference", '')) = '') THEN
    RAISE EXCEPTION 'production: the floor rules % record a legal basis with its reference and time, or none of them (MES-278)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."standardBundleSize" < 1 OR NEW."standardBundleSize" > 500 THEN
    RAISE EXCEPTION 'production: the floor rules % bundle by 1 to 500 garments, not % (MES-065)', NEW."id", NEW."standardBundleSize"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Bundle (MES-065, MES-068, MES-073)
--   INSERT     ACTIVE, with its first ticket (no replaced code), for a RELEASED or IN_PROGRESS work order; at least one
--              garment, exactly one for a made-to-measure unit (single-piece mode); its cut log entries are entries of
--              its work order, neither reversals nor named twice.
--   UPDATE     an UPDATE that changes nothing passes; only a reprint (a new code; the old one appended to the replaced
--              codes, MES-073) of an ACTIVE bundle, with its BundleReprint row (the reason), or ACTIVE → VOID with its
--              time and reason; a VOID bundle never changes. Its client event id never changes (a frozen column).
--   every row  VOID exactly with its time and reason; a client event id, when it has one, is not blank.
--   DELETE     refused (voided). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_bundle_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  changing CONSTANT text[] := ARRAY['code', 'replacedCodes', 'status', 'voidedAt', 'voidReason', 'version', 'updatedAt'];
  order_state text;
  order_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: bundle % is voided, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR cardinality(NEW."replacedCodes") > 0 THEN
      RAISE EXCEPTION 'production: bundle % starts ACTIVE with its first ticket', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."quantity" < 1 THEN
      RAISE EXCEPTION 'production: bundle % carries at least one garment', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT w."status"::text, w."kind"::text INTO order_state, order_kind
      FROM "WorkOrder" w WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."workOrderId";
    IF FOUND THEN
      IF order_state NOT IN ('RELEASED', 'IN_PROGRESS') THEN
        RAISE EXCEPTION 'production: work order % is %; bundles are made only for a RELEASED or IN_PROGRESS work order', NEW."workOrderId", order_state
          USING ERRCODE = 'check_violation';
      END IF;
      IF order_kind = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1 THEN
        RAISE EXCEPTION 'production: bundle % of made-to-measure work order % is the one garment (single-piece mode, MES-068)', NEW."id", NEW."workOrderId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF (SELECT count(DISTINCT x) FROM unnest(NEW."cutLogIds") AS x) <> cardinality(NEW."cutLogIds")
         OR EXISTS (SELECT 1 FROM unnest(NEW."cutLogIds") AS x(id)
                     WHERE NOT EXISTS (SELECT 1 FROM "CutLog" c
                                        WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."workOrderId" = NEW."workOrderId"
                                          AND c."id" = x.id AND c."reversalOfId" IS NULL)) THEN
        RAISE EXCEPTION 'production: bundle % names cut log entries of its work order, each once, none a reversal', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || changing)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || changing)) THEN
      RAISE EXCEPTION 'production: bundle % changes only by a reprint of its ticket or by being voided', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'production: bundle % is VOID; it never changes', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."code", NEW."replacedCodes") IS DISTINCT FROM (OLD."code", OLD."replacedCodes")
       AND (NEW."code" = OLD."code" OR NEW."replacedCodes" IS DISTINCT FROM (OLD."replacedCodes" || OLD."code")
            OR NEW."code" = ANY (NEW."replacedCodes") OR NEW."status" <> 'ACTIVE') THEN
      RAISE EXCEPTION 'production: a reprint of bundle % gives its ticket a new code and voids the old one (MES-073)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."code" IS DISTINCT FROM OLD."code"
       AND NOT EXISTS (SELECT 1 FROM "BundleReprint" r
                        WHERE r."tenantId" = NEW."tenantId" AND r."bundleId" = NEW."id" AND r."code" = NEW."code" AND r."replacedCode" = OLD."code") THEN
      RAISE EXCEPTION 'production: a reprint of bundle % says why: its BundleReprint row (% replacing %, with the reason) comes first (MES-073)', OLD."id", NEW."code", OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF btrim(NEW."code") = '' THEN
    RAISE EXCEPTION 'production: bundle % has a code', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."clientEventId" IS NOT NULL AND btrim(NEW."clientEventId") = '' THEN
    RAISE EXCEPTION 'production: bundle % has a client event id that is not blank, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'VOID') <> (NEW."voidedAt" IS NOT NULL)
     OR (NEW."status" = 'VOID') <> (btrim(coalesce(NEW."voidReason", '')) <> '') THEN
    RAISE EXCEPTION 'production: bundle % is % with the wrong void (a VOID bundle has its time and reason)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- BundleReprint (MES-073): append-only (scripts/factory/check-append-only.mjs), and its INSERT rules.
CREATE TRIGGER "BundleReprint_append_only" BEFORE UPDATE OR DELETE ON "BundleReprint"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "BundleReprint_no_truncate" BEFORE TRUNCATE ON "BundleReprint"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

--   INSERT     it says why; its codes are not blank and the new one is not the replaced one; the bundle (in the
--              session's scope) is ACTIVE and has the replaced code (its current one, or an earlier one: the generated
--              isolation tests insert a copy of an entry); its printer (in scope) is a label printer.
CREATE FUNCTION "factory_bundle_reprint_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bundle record;
  printer_kind text;
BEGIN
  IF btrim(NEW."reason") = '' THEN
    RAISE EXCEPTION 'production: reprint % of bundle % says why the ticket is printed again (lost, damaged, unreadable …; MES-073)', NEW."id", NEW."bundleId"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW."code") = '' OR btrim(NEW."replacedCode") = '' OR NEW."code" = NEW."replacedCode" THEN
    RAISE EXCEPTION 'production: reprint % of bundle % gives its ticket a new code, not the one it replaces', NEW."id", NEW."bundleId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT b."status"::text AS status, b."code", b."replacedCodes" INTO bundle
    FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
  -- Outside this session's scope the policies refuse the row.
  IF FOUND THEN
    IF bundle.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'production: bundle % is VOID; its ticket is not printed again', NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."replacedCode" <> bundle."code" AND NOT (NEW."replacedCode" = ANY (bundle."replacedCodes")) THEN
      RAISE EXCEPTION 'production: reprint % replaces code %, which is not a ticket of bundle %', NEW."id", NEW."replacedCode", NEW."bundleId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."printerId" IS NOT NULL THEN
    SELECT p."kind"::text INTO printer_kind FROM "Printer" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."printerId";
    IF FOUND AND printer_kind <> 'LABEL_ZPL' THEN
      RAISE EXCEPTION 'production: reprint % names printer %, which prints PDFs; a ticket prints on a label printer', NEW."id", NEW."printerId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "BundleReprint_check" BEFORE INSERT ON "BundleReprint"
  FOR EACH ROW EXECUTE FUNCTION "factory_bundle_reprint_check"();

--   at commit  the bundle (in scope) carries the new code, as its ticket's or (reprinted again since) among its replaced
--              codes, and the replaced code among its replaced codes: a reprint entry comes with the reprint itself.
CREATE FUNCTION "factory_bundle_reprint_applied"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bundle record;
BEGIN
  SELECT b."code", b."replacedCodes" INTO bundle
    FROM "Bundle" b WHERE b."tenantId" = NEW."tenantId" AND b."siteId" = NEW."siteId" AND b."id" = NEW."bundleId";
  IF FOUND AND ((NEW."code" <> bundle."code" AND NOT (NEW."code" = ANY (bundle."replacedCodes")))
                OR NOT (NEW."replacedCode" = ANY (bundle."replacedCodes"))) THEN
    RAISE EXCEPTION 'production: reprint % gives bundle % the code % in place of %, in the same transaction (MES-073)', NEW."id", NEW."bundleId", NEW."code", NEW."replacedCode"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "BundleReprint_applied" AFTER INSERT ON "BundleReprint"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_bundle_reprint_applied"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Station.labelPrinterId (MES-184: the station's label printer, where its devices' bundle tickets print)
--   INSERT, UPDATE of it  a label printer (LABEL_ZPL) that is not archived; the reference already pins the tenant,
--                         company and site.
CREATE FUNCTION "factory_station_label_printer_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  printer record;
BEGIN
  IF NEW."labelPrinterId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."labelPrinterId" IS NOT DISTINCT FROM OLD."labelPrinterId") THEN
    RETURN NEW;
  END IF;
  SELECT p."kind"::text AS kind, p."status"::text AS status INTO printer
    FROM "Printer" p WHERE p."tenantId" = NEW."tenantId" AND p."siteId" = NEW."siteId" AND p."id" = NEW."labelPrinterId";
  IF FOUND AND (printer.kind <> 'LABEL_ZPL' OR printer.status = 'ARCHIVED') THEN
    RAISE EXCEPTION 'core: station % prints its tickets on a label printer that is in use; printer % is % %', NEW."id", NEW."labelPrinterId", printer.kind, printer.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Station_label_printer_guard" BEFORE INSERT OR UPDATE OF "labelPrinterId" ON "Station"
  FOR EACH ROW EXECUTE FUNCTION "factory_station_label_printer_guard"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Hide (SCM-233, SCM-247, SCM-253; B-W1-40's correction of a closing cut)
--   INSERT     its item is tracked by HIDE; it has no closing cut log entry.
--   UPDATE     an UPDATE that changes nothing passes; only its grade, shade, thickness, defects, state and closing entry
--              change (its lot, tag and measured area never do: a correction is an adjustment move); the state never
--              goes back to FULL; a SCRAPPED hide never changes; a hide becomes CONSUMED with its closing entry (a live
--              cut log entry of it: neither a reversal nor reversed) and a hide in any other state has none; a CONSUMED
--              hide never changes but for one move: back to PARTLY_CUT, its closing entry cleared and nothing else
--              changed, once that entry is reversed (its area is at the work order again).
--   every row  an area above 0 in an area unit (M2, DM2, FT2), above 0 in the base unit; a thickness above 0.
--   DELETE     refused (scrapped). TRUNCATE refused.
CREATE OR REPLACE FUNCTION "factory_hide_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  described CONSTANT text[] := ARRAY['grade', 'shade', 'thicknessMm', 'defects', 'state', 'closingCutLogId', 'version', 'updatedAt'];
  reopening CONSTANT text[] := ARRAY['state', 'closingCutLogId', 'version', 'updatedAt'];
  item_tracking text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory: hide % is scrapped, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT i."tracking"::text INTO item_tracking FROM "Item" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
    IF FOUND AND item_tracking <> 'HIDE' THEN
      RAISE EXCEPTION 'inventory: item % is tracked by %; hides belong to an item tracked by HIDE (hide %)', NEW."itemId", item_tracking, NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."closingCutLogId" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: hide % is new; it has no closing cut log entry', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - (kept || described)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || described)) THEN
      RAISE EXCEPTION 'inventory: the lot, tag and measured area of hide % never change (a correction is an adjustment move)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'SCRAPPED' THEN
      RAISE EXCEPTION 'inventory: hide % is %; it never changes', OLD."id", OLD."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'CONSUMED' THEN
      IF NEW."state" <> 'PARTLY_CUT' OR NEW."closingCutLogId" IS NOT NULL
         OR (to_jsonb(NEW) - (kept || reopening)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || reopening)) THEN
        RAISE EXCEPTION 'inventory: hide % is CONSUMED; it never changes, but back to PARTLY_CUT when its closing cut is reversed', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."closingCutLogId" IS NULL
         OR NOT EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = OLD."tenantId" AND r."siteId" = OLD."siteId" AND r."reversalOfId" = OLD."closingCutLogId") THEN
        RAISE EXCEPTION 'inventory: hide % is CONSUMED; it opens again (PARTLY_CUT) only when its closing cut log entry % is reversed', OLD."id", coalesce(OLD."closingCutLogId"::text, '(none)')
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."state" = 'FULL' AND OLD."state" <> 'FULL' THEN
      RAISE EXCEPTION 'inventory: hide % was cut; it is never FULL again', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" = 'CONSUMED' THEN
      IF NEW."closingCutLogId" IS NULL
         OR NOT EXISTS (SELECT 1 FROM "CutLog" c
                         WHERE c."tenantId" = NEW."tenantId" AND c."siteId" = NEW."siteId" AND c."id" = NEW."closingCutLogId" AND c."hideId" = NEW."id"
                           AND c."reversalOfId" IS NULL
                           AND NOT EXISTS (SELECT 1 FROM "CutLog" r WHERE r."tenantId" = c."tenantId" AND r."siteId" = c."siteId" AND r."reversalOfId" = c."id")) THEN
        RAISE EXCEPTION 'inventory: hide % is used up (CONSUMED) with its closing cut log entry, a live entry of the hide', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."closingCutLogId" IS NOT NULL THEN
      RAISE EXCEPTION 'inventory: hide % is %; only a CONSUMED hide names its closing cut log entry', NEW."id", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."area" <= 0 OR NEW."baseArea" <= 0 OR NEW."areaUom" NOT IN ('M2', 'DM2', 'FT2') OR NEW."thicknessMm" <= 0 THEN
    RAISE EXCEPTION 'inventory: hide % has an area above 0 in M2, DM2 or FT2 (and in its base unit), and a thickness above 0', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- CutLog, a reversal of an entry of a used-up hide (B-W1-40's correction of a closing cut)
--   INSERT     a reversal of an entry whose hide (in scope) is CONSUMED reverses that hide's closing entry, no other:
--              the cuts of a used-up hide are final, but the one after which nothing was left.
--   at commit  a reversal of a CONSUMED hide's closing entry leaves the hide open again (PARTLY_CUT): the area it gives
--              back is at the work order, never on a used-up hide.
CREATE FUNCTION "factory_cut_log_closing_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hide record;
BEGIN
  IF NEW."reversalOfId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT h."state"::text AS state, h."closingCutLogId" INTO hide
    FROM "Hide" h WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
  IF FOUND AND hide.state = 'CONSUMED' AND hide."closingCutLogId" IS DISTINCT FROM NEW."reversalOfId" THEN
    RAISE EXCEPTION 'production: hide % is used up; its cuts are final but its closing entry % (reversing that one opens the hide again), not entry %', NEW."hideId", coalesce(hide."closingCutLogId"::text, '(none)'), NEW."reversalOfId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "CutLog_closing_check" BEFORE INSERT ON "CutLog"
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_log_closing_check"();

CREATE FUNCTION "factory_cut_log_reopens_hide"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hide record;
BEGIN
  IF NEW."reversalOfId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT h."state"::text AS state, h."closingCutLogId" INTO hide
    FROM "Hide" h WHERE h."tenantId" = NEW."tenantId" AND h."siteId" = NEW."siteId" AND h."id" = NEW."hideId";
  IF FOUND AND hide.state = 'CONSUMED' AND hide."closingCutLogId" = NEW."reversalOfId" THEN
    RAISE EXCEPTION 'production: cut log entry % reverses the closing entry of hide %; the hide opens again (PARTLY_CUT) in the same transaction', NEW."id", NEW."hideId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "CutLog_reopens_hide" AFTER INSERT ON "CutLog"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "factory_cut_log_reopens_hide"();
