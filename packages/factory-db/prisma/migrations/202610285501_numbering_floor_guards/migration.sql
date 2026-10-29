-- Written by hand (Prisma does not model triggers), after the generated 202610285500_numbering_floor and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Floor numbering (design 02-sections-floor: "tags print offline from numbers reserved per tablet"; features PLT-126,
-- PLT-237). The scan-id kinds (BUNDLE, HIDE, GARMENT_SERIAL) have ONE counter per tenant, the NumberBlock ledger: every
-- reference handed out lies in one block, ONLINE (one command's) or DEVICE (one tablet's, for offline labels). The app
-- checks all of this first and answers in words (apps/factory-api src/platform/numbering/scan-ids.ts); these rules hold
-- for every login, the owner included:
--   - a scan-id kind never gets a NumberSeries (document numbers), and a document kind never gets a block;
--   - a block holds 1 to 1000 references, starts open, names its tablet exactly when it is a DEVICE block (an ACTIVE
--     tablet the session sees: a floor session sees only its own site's), and starts above every block of its tenant
--     and kind before it: the counter only moves forward, so nothing is handed out twice. Taken under the tenant's
--     `factory.scan-ids` lock for the kind (the API takes the same lock before it reads the highest block);
--   - a block never changes but for its closing (ACTIVE → CLOSED, with when and why) and is never deleted;
--   - NumberBlockUse is append-only; a used number lies in its block, of the block's kind, and the block is an open
--     DEVICE block of the same tablet (under the block's `factory.number-block` lock, which its closing takes too). That
--     a number is used once is the unique printed code (one-to-one with the kind and the reference, like
--     NumberAllocation's printed number with its value).
-- The tenant column is left to row-level security and the foreign keys: a row of another tenant than the session's is
-- refused by the policies, so the lookups below check only rows the session sees.

-- ---------------------------------------------------------------------------------------------------------------------
-- NumberSeries: document kinds only.
CREATE FUNCTION "factory_number_series_document_kind"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind"::text IN ('BUNDLE', 'HIDE', 'GARMENT_SERIAL') THEN
    RAISE EXCEPTION 'number series %: % is a scan-id kind; its numbers come from the tenant''s number blocks, never a series', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NumberSeries_document_kind" BEFORE INSERT OR UPDATE ON "NumberSeries"
  FOR EACH ROW EXECUTE FUNCTION "factory_number_series_document_kind"();

-- ---------------------------------------------------------------------------------------------------------------------
-- NumberBlock
CREATE FUNCTION "factory_number_block_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  session_tenant uuid := NULLIF(current_setting('factory.tenant_id', true), '')::uuid;
  device_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'number block %: a block is closed, never deleted (its numbers stay handed out)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."kind"::text NOT IN ('BUNDLE', 'HIDE', 'GARMENT_SERIAL') THEN
    RAISE EXCEPTION 'number block %: % is a document kind; its numbers come from a number series', NEW."id", NEW."kind"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW."kind", NEW."purpose", NEW."fromRef", NEW."toRef", NEW."deviceId", NEW."requestId", NEW."createdAt")
       IS DISTINCT FROM (OLD."kind", OLD."purpose", OLD."fromRef", OLD."toRef", OLD."deviceId", OLD."requestId", OLD."createdAt") THEN
      RAISE EXCEPTION 'number block %: its kind, purpose, range, tablet and origin never change; close it instead', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'CLOSED' AND (NEW."status", NEW."closedAt", NEW."closedReason") IS DISTINCT FROM (OLD."status", OLD."closedAt", OLD."closedReason") THEN
      RAISE EXCEPTION 'number block %: a closed block stays closed', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'CLOSED' AND OLD."status" = 'ACTIVE' THEN
      -- The same lock as a use of its numbers: a use in flight lands before the closing, or sees the block closed.
      PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.number-block', OLD."tenantId"::text, OLD."id"::text), 0));
    END IF;
  ELSE
    IF NEW."fromRef" < 1 OR NEW."toRef" < NEW."fromRef" OR NEW."toRef" - NEW."fromRef" + 1 > 1000 THEN
      RAISE EXCEPTION 'number block %: a block holds 1 to 1000 references from 1 up (% to %)', NEW."id", NEW."fromRef", NEW."toRef"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number block %: a block starts open', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."purpose" = 'DEVICE') <> (NEW."deviceId" IS NOT NULL) THEN
      RAISE EXCEPTION 'number block %: a DEVICE block names its tablet and an ONLINE block none', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'CLOSED' AND (NEW."closedAt" IS NULL OR NEW."closedReason" IS NULL OR btrim(NEW."closedReason") = '') THEN
    RAISE EXCEPTION 'number block %: a closed block says when and why it was closed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' AND (NEW."closedAt" IS NOT NULL OR NEW."closedReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'number block %: an open block has no closing time or reason', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- INSERT, in the session's own tenant (another tenant's row is left to row-level security).
  IF NEW."tenantId" IS NULL OR (session_tenant IS NOT NULL AND NEW."tenantId" IS DISTINCT FROM session_tenant) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-ids', NEW."tenantId"::text, NEW."kind"::text), 0));
  IF EXISTS (SELECT 1 FROM "NumberBlock" b WHERE b."tenantId" = NEW."tenantId" AND b."kind" = NEW."kind" AND b."toRef" >= NEW."fromRef") THEN
    RAISE EXCEPTION 'number block %: % references from % were handed out already; a block starts above every block of its kind', NEW."id", NEW."kind", NEW."fromRef"
      USING ERRCODE = 'unique_violation';
  END IF;
  IF NEW."purpose" = 'DEVICE' THEN
    SELECT d."status"::text INTO device_status FROM "Device" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."deviceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'number block %: tablet % is not one this session may reserve numbers for (unknown, or at another site)', NEW."id", NEW."deviceId"
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF device_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number block %: tablet % is %; only an enrolled, active tablet gets numbers', NEW."id", NEW."deviceId", device_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NumberBlock_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NumberBlock"
  FOR EACH ROW EXECUTE FUNCTION "factory_number_block_guard"();
CREATE TRIGGER "NumberBlock_no_truncate" BEFORE TRUNCATE ON "NumberBlock"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();

-- ---------------------------------------------------------------------------------------------------------------------
-- NumberBlockUse: append-only (scripts/factory/check-append-only.mjs; the audit module's function raises for any row
-- change or truncate), and its INSERT rule.
CREATE TRIGGER "NumberBlockUse_append_only" BEFORE UPDATE OR DELETE ON "NumberBlockUse"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_audit_change"();
CREATE TRIGGER "NumberBlockUse_no_truncate" BEFORE TRUNCATE ON "NumberBlockUse"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_audit_change"();

CREATE FUNCTION "factory_number_block_use_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  block record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.number-block', NEW."tenantId"::text, NEW."blockId"::text), 0));
  SELECT b."kind", b."purpose", b."fromRef", b."toRef", b."deviceId", b."status" INTO block
    FROM "NumberBlock" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."blockId";
  -- Not found: the foreign key refuses an unknown block; another tenant's is left to row-level security.
  IF FOUND THEN
    IF block."purpose" <> 'DEVICE' OR block."deviceId" IS DISTINCT FROM NEW."deviceId" THEN
      RAISE EXCEPTION 'number % (%): block % is not reserved for tablet %', NEW."code", NEW."ref", NEW."blockId", NEW."deviceId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF block."kind" <> NEW."kind" THEN
      RAISE EXCEPTION 'number % (%): block % holds % numbers, not %', NEW."code", NEW."ref", NEW."blockId", block."kind", NEW."kind"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."ref" < block."fromRef" OR NEW."ref" > block."toRef" THEN
      RAISE EXCEPTION 'number % (%): outside block % (% to %)', NEW."code", NEW."ref", NEW."blockId", block."fromRef", block."toRef"
        USING ERRCODE = 'check_violation';
    END IF;
    IF block."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'number % (%): block % is closed; its numbers are not used any more', NEW."code", NEW."ref", NEW."blockId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "NumberBlockUse_check" BEFORE INSERT ON "NumberBlockUse"
  FOR EACH ROW EXECUTE FUNCTION "factory_number_block_use_check"();
