-- Written by hand (Prisma does not model triggers), after the generated 202611140102_followups_sales_w2b5_schema and
-- before the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The W2b-5 follow-ups for sales, buying and approvals, W2b-6 schema wave 45/57 (B-W2b-363): the schema needs the W2b-5
-- notes named, each checked still real on main. The readers are B-W2b-368, -371, -374, -377, -380 and -396; they check all
-- of this first and answer in words; these rules are the last word, for every login, the owner included.
--
--   ReturnAuthorisation  REDEFINED `factory_return_request_check` (…_portal_followups_w2b_guards, word for word) with one
--                        change allowed: the wish set to REMAKE once, by the office on its RMA, while REQUESTED, AUTHORISED or
--                        RECEIVED (B-W2b-346's ask as a column); a REMAKE wish never changes after.
--   StoredFile           REDEFINED `factory_stored_file_guard` (…_files_depth_w2b_guards, word for word) with the delete
--                        date among what a superseded version still changes. Its own trigger StoredFile_w2b6_check: an
--                        MTM_PHOTO is a PHOTO of a MeasurementProfile, a FITTING_PHOTO a PHOTO of a FittingResult, both the
--                        office's only (never shared with a floor, a portal or a link); a delete date only on those two,
--                        not before the retention date, moved but never cleared, fixed once the file is DELETED; a document
--                        type only on a file of a vault category (SUPPLIER_CERTIFICATE, TEST_REPORT, DECLARATION), a code's
--                        shape, an ACTIVE code of the SUPPLIER_DOCUMENT_TYPE reason list when named.
--   OptionGroup,         own triggers: a COLOUR group's chosen options name no material, a MATERIAL group's no library
--   QuoteLineOption,     colour (checked when an option is written or its group, colour or material change); a group takes
--   SalesOrderLineOption COLOUR or MATERIAL only while none of its chosen options names the other kind.
--   GeneratedDocument    REDEFINED `factory_generated_document_check` (…_mtm_office_w2b_guards' body, word for word) with one
--                        more kind: PRICE_LIST of a PriceListVersion, of its list's company (any company of the tenant for a
--                        tenant-wide list), no site.
--   QuoteApproval        own trigger QuoteApproval_not_own (W1's guard untouched): an APPROVED or REJECTED decision is never
--                        by the office user who asked (Owner answer Q3 of W2b-5 = A, the Owner included; a WITHDRAWN one may
--                        be: a reopen).
--   TimesheetApproval    own trigger TimesheetApproval_not_own (the time wave's guard untouched): the lead's approval and
--                        HR's are never given by the person's own office account (the Employee's, or a floor worker's of
--                        that employee).
--   GoodsReceiptLine,    own triggers: a line held for a yes (heldForApprovalAt, beyond its delivery tolerance) is held at a
--   GoodsReceipt         time not in the future (W1's line guard keeps it to an OPEN receipt); a receipt with a held line is
--                        never POSTED.
--   PurchasingSettings   own trigger: the confirm-by 1 to 720 hours, the reminder cadence 1 to 30 days (null: not set here).
--   PurchaseOrderReminder own trigger PurchaseOrderReminder_chase_check (W2a's check untouched): a CHASE goes only to an order
--                        that waits for goods (SENT, CONFIRMED, CHANGES_PROPOSED, PARTLY_RECEIVED), for its current revision.
--   SupplierBankAccount  no rule here: the partner's IBAN is write-only (ownership `writeOnlyColumns`, the policy migration);
--                        an IBAN open once per party stays the API's (the isolation tests' copy of the first seeded row
--                        repeats its IBAN; the portal compares the country and last four characters it reads).
--   SalesOrderLine       REDEFINED `factory_sales_order_line_guard` (…_sales_orders_depth_w2b_guards' body, word for word):
--                        the fee credit columns change whatever the order's state. Its own trigger SalesOrderLine_fee_credit:
--                        only a FEE line is credited, against another order of its company and customer (the reference)
--                        with goods lines, not CANCELLED when named; credited (not in the future) only with that order named;
--                        once credited, both fixed.
--   ReasonCode           own trigger: a group's words 1 to 120 characters of one line, no space at either end.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first); the redefined functions keep their triggers. A rule that reads another row skips a row this session
-- cannot see. An UPDATE that changes nothing passes. No data to copy: every new column is null on the rows before it, and
-- none of them breaks a new rule (no file has a new category, no group takes anything, no line is held or credited).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future" (…_recall_claims_w2b_guards).

-- =====================================================================================================================
-- 1. ReturnAuthorisation: REMAKE as what the customer would like (B-W2b-346, -360, -362)
-- =====================================================================================================================

CREATE OR REPLACE FUNCTION "factory_return_request_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- W2b-6 (wave 45/57): the one change, a remake the office marks on its RMA (B-W2b-346's ask): once, while REQUESTED,
    -- AUTHORISED or RECEIVED; a REMAKE wish never changes after.
    IF (NEW."channel", NEW."customerNote") IS DISTINCT FROM (OLD."channel", OLD."customerNote")
       OR (NEW."outcomeWanted" IS DISTINCT FROM OLD."outcomeWanted"
           AND NOT (NEW."outcomeWanted" = 'REMAKE' AND OLD."outcomeWanted" IS DISTINCT FROM 'REMAKE'
                    AND OLD."status" IN ('REQUESTED', 'AUTHORISED', 'RECEIVED'))) THEN
      RAISE EXCEPTION 'sales: how return % was asked for, what the customer would like and their words never change (the office marks a remake once, while it is REQUESTED, AUTHORISED or RECEIVED)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW."channel" IN ('PORTAL', 'LINK') AND NEW."status" <> 'REQUESTED' THEN
    RAISE EXCEPTION 'sales: return % came from the customer (%): it starts REQUESTED, the office authorises it', NEW."id", NEW."channel"
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(coalesce(NEW."customerNote", 'x')) = '' OR length(NEW."customerNote") > 2000 THEN
    RAISE EXCEPTION 'sales: the customer''s words on return % are not blank, up to 2000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- 2. StoredFile: the made-to-measure photos with their delete date, a supplier document's type (B-W2b-297, -315, -360)
-- =====================================================================================================================

-- REDEFINES factory_stored_file_guard (202610319003_files_depth_w2b_guards), its whole body: one more column a superseded
-- version still changes, the delete date (a retake's older version is deleted with it). The trigger StoredFile_guard stays.
CREATE OR REPLACE FUNCTION "factory_stored_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a superseded version may still change (everything else stays as it was when it was superseded).
  superseded_moves CONSTANT text[] := ARRAY['status', 'availableAt', 'deletedAt', 'quarantineReason', 'visibility', 'floorSiteId', 'partyId',
                                            'retainUntil', 'deleteAfter', 'legalHold', 'scanStatus', 'scannedAt', 'scanEngine', 'scanFinding',
                                            'thumbnailKey', 'exifStrippedAt', 'version', 'updatedAt'];
  root uuid;
  first_series uuid;
  first_company uuid;
  first_record_type text;
  first_record uuid;
  first_kind text;
  next_number integer;
  source_sha256 text;
  source_size integer;
  source_type text;
  source_status text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'files: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'files: file % is never deleted; it keeps its row in status DELETED', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."visibility" IS NULL OR NOT ('OFFICE' = ANY (NEW."visibility")) THEN
    RAISE EXCEPTION 'files: file % must be visible to the office', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ('FLOOR' = ANY (NEW."visibility")) <> (NEW."floorSiteId" IS NOT NULL) THEN
    RAISE EXCEPTION 'files: file % names a floor site exactly when it is shared with the floor', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."floorSiteId" IS NOT NULL AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'files: file % is shared with a floor, so it belongs to that site''s company', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF ('PARTNER' = ANY (NEW."visibility") OR 'LINK' = ANY (NEW."visibility")) <> (NEW."partyId" IS NOT NULL) THEN
    RAISE EXCEPTION 'files: file % names a party exactly when it is shared with a portal or a link', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind" = 'FISCAL_ARCHIVE') <> (NEW."storageKey" LIKE 'legal/%') THEN
    RAISE EXCEPTION 'files: file % is in the legal store exactly when it is a fiscal archive file', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'FISCAL_ARCHIVE' AND NEW."retainUntil" IS NULL THEN
    RAISE EXCEPTION 'files: fiscal archive file % needs its retention date', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sizeBytes" < 1 THEN
    RAISE EXCEPTION 'files: file % has no content', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'AVAILABLE' AND NEW."availableAt" IS NULL)
     OR (NEW."status" = 'QUARANTINED' AND NEW."quarantineReason" IS NULL)
     OR ((NEW."status" = 'DELETED') <> (NEW."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'files: file % is % without its time or reason', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED')) <> (NEW."scannedAt" IS NOT NULL)
     OR (NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED')) <> (NEW."scanEngine" IS NOT NULL AND btrim(NEW."scanEngine") <> '')
     OR (NEW."scanStatus" IN ('INFECTED', 'FAILED')) <> (NEW."scanFinding" IS NOT NULL AND btrim(NEW."scanFinding") <> '') THEN
    RAISE EXCEPTION 'files: the scan of file % (%) has its time and scanner exactly with a verdict, and says what it found exactly when INFECTED or FAILED', NEW."id", NEW."scanStatus"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'AVAILABLE' AND NEW."scanStatus" = 'INFECTED' THEN
    RAISE EXCEPTION 'files: file % is infected; it is never available', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- W2b wave 18/22: versions, copies, expiry, thumbnails.
  IF NEW."versionNo" < 1 OR (NEW."seriesId" IS NULL) <> (NEW."versionNo" = 1) OR NEW."seriesId" = NEW."id" THEN
    RAISE EXCEPTION 'files: file % is version %; a first version (1) names no series, a later one (2 and on) names its series'' first version, never itself', NEW."id", NEW."versionNo"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceFileId" = NEW."id" THEN
    RAISE EXCEPTION 'files: file % is not a copy of itself', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expiryRemindedAt" IS NOT NULL AND NEW."expiresOn" IS NULL THEN
    RAISE EXCEPTION 'files: file % has an expiry reminder but no expiry date', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."thumbnailKey" IS NULL) <> (NEW."exifStrippedAt" IS NULL)
     OR (NEW."thumbnailKey" IS NOT NULL AND (btrim(NEW."thumbnailKey") = '' OR NEW."thumbnailKey" = NEW."storageKey" OR NEW."thumbnailKey" LIKE 'legal/%')) THEN
    RAISE EXCEPTION 'files: the thumbnail of file % is a second object of its own (not blank, not the file''s key, never in the legal store), made with the EXIF and location data stripped (both or neither)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PENDING_UPLOAD', 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: a new file is PENDING_UPLOAD or AVAILABLE, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."scanStatus" <> 'NOT_SCANNED' THEN
      RAISE EXCEPTION 'files: a new file is NOT_SCANNED (its scan starts when the upload is confirmed), not %', NEW."scanStatus"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersededAt" IS NOT NULL OR NEW."expiryRemindedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'files: a new file % is neither superseded nor reminded of its expiry yet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."thumbnailKey" IS NOT NULL AND NEW."status" <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'files: a new file % has a thumbnail only when it is born AVAILABLE (a document the system made)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS TRUE THEN
      IF NEW."seriesId" IS NOT NULL THEN
        SELECT f."seriesId", f."companyId", f."recordType", f."recordId", f."kind"::text
          INTO first_series, first_company, first_record_type, first_record, first_kind
          FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."seriesId";
        IF NOT FOUND OR first_series IS NOT NULL THEN
          RAISE EXCEPTION 'files: version % of file % names a series by its first version, which is not there', NEW."versionNo", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (first_company, first_record_type, first_record, first_kind) IS DISTINCT FROM (NEW."companyId", NEW."recordType", NEW."recordId", NEW."kind"::text) THEN
          RAISE EXCEPTION 'files: a version (file %) is of its first version''s record, company and kind', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF first_kind = 'FISCAL_ARCHIVE' THEN
          RAISE EXCEPTION 'files: a fiscal archive file has no later version (file %); a correction is a new document', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM "StoredFile" v
                    WHERE v."tenantId" = NEW."tenantId" AND (v."id" = NEW."seriesId" OR v."seriesId" = NEW."seriesId") AND v."status" = 'PENDING_UPLOAD') THEN
          RAISE EXCEPTION 'files: a new version (file %) waits until the upload of the series'' earlier version is confirmed or given up', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        SELECT max(v."versionNo") + 1 INTO next_number FROM "StoredFile" v
         WHERE v."tenantId" = NEW."tenantId" AND (v."id" = NEW."seriesId" OR v."seriesId" = NEW."seriesId");
        IF NEW."versionNo" <> next_number THEN
          RAISE EXCEPTION 'files: the next version of the series is %, not % (file %)', next_number, NEW."versionNo", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW."sourceFileId" IS NOT NULL THEN
        SELECT s."sha256", s."sizeBytes", s."contentType", s."status"::text INTO source_sha256, source_size, source_type, source_status
          FROM "StoredFile" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sourceFileId";
        IF NOT FOUND OR source_status <> 'AVAILABLE' THEN
          RAISE EXCEPTION 'files: copy % names a source that is not an available file', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        IF (source_sha256, source_size, source_type) IS DISTINCT FROM (NEW."sha256", NEW."sizeBytes", NEW."contentType") THEN
          RAISE EXCEPTION 'files: copy % has its source''s bytes (the same SHA-256, size and type)', NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."kind", NEW."originalName", NEW."contentType",
      NEW."sizeBytes", NEW."sha256", NEW."storeAccountId", NEW."storageKey", NEW."createdAt", NEW."createdById",
      NEW."seriesId", NEW."versionNo", NEW."sourceFileId")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."kind", OLD."originalName", OLD."contentType",
      OLD."sizeBytes", OLD."sha256", OLD."storeAccountId", OLD."storageKey", OLD."createdAt", OLD."createdById",
      OLD."seriesId", OLD."versionNo", OLD."sourceFileId") THEN
    RAISE EXCEPTION 'files: the content of file % never changes; a new version is a new file', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DELETED'
     AND (NEW."status", NEW."visibility", NEW."floorSiteId", NEW."partyId", NEW."retainUntil", NEW."legalHold",
          NEW."quarantineReason", NEW."availableAt", NEW."deletedAt", NEW."scanStatus", NEW."scannedAt", NEW."scanEngine", NEW."scanFinding",
          NEW."supersededAt", NEW."expiresOn", NEW."expiryRemindedAt", NEW."thumbnailKey", NEW."exifStrippedAt")
         IS DISTINCT FROM
         (OLD."status", OLD."visibility", OLD."floorSiteId", OLD."partyId", OLD."retainUntil", OLD."legalHold",
          OLD."quarantineReason", OLD."availableAt", OLD."deletedAt", OLD."scanStatus", OLD."scannedAt", OLD."scanEngine", OLD."scanFinding",
          OLD."supersededAt", OLD."expiresOn", OLD."expiryRemindedAt", OLD."thumbnailKey", OLD."exifStrippedAt") THEN
    RAISE EXCEPTION 'files: file % is deleted; it changes no more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."scanStatus" <> OLD."scanStatus"
     AND NOT ((OLD."scanStatus" = 'NOT_SCANNED' AND NEW."scanStatus" = 'PENDING')
              OR (OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED'))
              OR (OLD."scanStatus" IN ('CLEAN', 'FAILED') AND NEW."scanStatus" = 'PENDING')) THEN
    RAISE EXCEPTION 'files: the scan of file % cannot move from % to %', OLD."id", OLD."scanStatus", NEW."scanStatus"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED', 'DELETED'))
              OR (OLD."status" IN ('AVAILABLE', 'QUARANTINED') AND NEW."status" = 'DELETED')
              OR (OLD."status" = 'QUARANTINED' AND NEW."status" = 'AVAILABLE' AND OLD."quarantineReason" = 'scan_pending'
                  AND OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" = 'CLEAN')
              OR (OLD."status" = 'AVAILABLE' AND NEW."status" = 'QUARANTINED' AND NEW."scanStatus" = 'INFECTED')) THEN
    RAISE EXCEPTION 'files: file % cannot move from % to %', OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'AVAILABLE' AND OLD."status" <> 'AVAILABLE' AND NEW."scanStatus" NOT IN ('NOT_SCANNED', 'CLEAN') THEN
    RAISE EXCEPTION 'files: file % becomes available only unscanned (no scanner) or clean, not %', OLD."id", NEW."scanStatus"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'DELETED' AND OLD."status" <> 'DELETED'
     AND (NEW."legalHold" OR (NEW."retainUntil" IS NOT NULL AND NEW."retainUntil" > now())) THEN
    RAISE EXCEPTION 'files: file % is retained (legal hold or retention date); it cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."retainUntil" IS NOT NULL AND (NEW."retainUntil" IS NULL OR NEW."retainUntil" < OLD."retainUntil") THEN
    RAISE EXCEPTION 'files: the retention date of file % only moves later', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- W2b wave 18/22.
  IF OLD."supersededAt" IS NOT NULL THEN
    IF (to_jsonb(NEW) - superseded_moves) IS DISTINCT FROM (to_jsonb(OLD) - superseded_moves) THEN
      RAISE EXCEPTION 'files: file % is a superseded version: it stays as it is (only its deletion, scan, retention, thumbnail and a narrower sharing change)', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT (NEW."visibility" <@ OLD."visibility")
       OR (NEW."floorSiteId" IS NOT NULL AND NEW."floorSiteId" IS DISTINCT FROM OLD."floorSiteId")
       OR (NEW."partyId" IS NOT NULL AND NEW."partyId" IS DISTINCT FROM OLD."partyId") THEN
      RAISE EXCEPTION 'files: file % is a superseded version: it is never shared more widely (no new audience, floor or party)', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."supersededAt" IS NOT NULL AND "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS TRUE THEN
    root := coalesce(OLD."seriesId", OLD."id");
    IF NOT EXISTS (SELECT 1 FROM "StoredFile" l
                    WHERE l."tenantId" = NEW."tenantId" AND (l."id" = root OR l."seriesId" = root)
                      AND l."versionNo" > OLD."versionNo" AND l."status" = 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: file % is superseded only once a later version of its series is available', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."expiresOn" IS DISTINCT FROM OLD."expiresOn" THEN
    IF NEW."expiryRemindedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'files: a new expiry date of file % starts without a reminder', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF OLD."expiryRemindedAt" IS NOT NULL AND (NEW."expiryRemindedAt" IS NULL OR NEW."expiryRemindedAt" < OLD."expiryRemindedAt") THEN
    RAISE EXCEPTION 'files: the expiry reminder of file % only moves later', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."thumbnailKey", NEW."exifStrippedAt") IS DISTINCT FROM (OLD."thumbnailKey", OLD."exifStrippedAt")
     AND (OLD."thumbnailKey" IS NOT NULL OR NEW."status" <> 'AVAILABLE') THEN
    RAISE EXCEPTION 'files: the thumbnail of file % is made once, while the file is AVAILABLE, and never changes', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- StoredFile (new triggers StoredFile_w2b6_check, StoredFile_w2b6_change; the files guard above does the rest).
CREATE FUNCTION "factory_stored_file_w2b6_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  photo boolean := NEW."category" IN ('MTM_PHOTO', 'FITTING_PHOTO');
BEGIN
  IF photo THEN
    IF NEW."kind" <> 'PHOTO'
       OR (NEW."category" = 'MTM_PHOTO' AND NEW."recordType" <> 'MeasurementProfile')
       OR (NEW."category" = 'FITTING_PHOTO' AND NEW."recordType" <> 'FittingResult') THEN
      RAISE EXCEPTION 'files: file % is a % of a %; a made-to-measure photo is a PHOTO of a MeasurementProfile (MTM_PHOTO) or of a FittingResult (FITTING_PHOTO)', NEW."id", NEW."category", NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."visibility" <> ARRAY['OFFICE']::"FileAudience"[] THEN
      RAISE EXCEPTION 'files: file % is a rider''s photo (%): the office''s only, never shared with a floor, a portal or a link', NEW."id", NEW."category"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."deleteAfter" IS NOT NULL THEN
    IF NOT photo THEN
      RAISE EXCEPTION 'files: file % takes no delete date: only a made-to-measure photo (MTM_PHOTO, FITTING_PHOTO) has one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retainUntil" IS NOT NULL AND NEW."deleteAfter" < NEW."retainUntil" THEN
      RAISE EXCEPTION 'files: file % is deleted from % on, never before it is retained until %', NEW."id", NEW."deleteAfter", NEW."retainUntil"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."deleteAfter" IS NOT NULL AND NEW."deleteAfter" IS DISTINCT FROM OLD."deleteAfter"
     AND (NEW."deleteAfter" IS NULL OR OLD."status" = 'DELETED') THEN
    RAISE EXCEPTION 'files: the delete date of file % moves but is never cleared, and a deleted file''s stays as it is', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."documentTypeCode" IS NOT NULL THEN
    IF NEW."category" IS NULL OR NEW."category" NOT IN ('SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION') THEN
      RAISE EXCEPTION 'files: file % names a document type (%) only as a supplier certificate, a test report or a declaration', NEW."id", NEW."documentTypeCode"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."documentTypeCode" !~ '^[A-Z][A-Z0-9_]{0,59}$' THEN
      RAISE EXCEPTION 'files: the document type of file % is a code (upper-case letters, digits and underscores, at most 60), not %', NEW."id", NEW."documentTypeCode"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (TG_OP = 'INSERT' OR NEW."documentTypeCode" IS DISTINCT FROM OLD."documentTypeCode")
       AND NOT EXISTS (SELECT 1 FROM "ReasonCode" r
                        WHERE r."tenantId" = NEW."tenantId" AND r."list" = 'SUPPLIER_DOCUMENT_TYPE' AND r."code" = NEW."documentTypeCode" AND r."active") THEN
      RAISE EXCEPTION 'files: % is not an active document type of the tenant (the SUPPLIER_DOCUMENT_TYPE reasons)', NEW."documentTypeCode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StoredFile_w2b6_check" AFTER INSERT ON "StoredFile"
  FOR EACH ROW WHEN (NEW."category" IN ('MTM_PHOTO', 'FITTING_PHOTO') OR NEW."deleteAfter" IS NOT NULL OR NEW."documentTypeCode" IS NOT NULL)
  EXECUTE FUNCTION "factory_stored_file_w2b6_check"();
CREATE TRIGGER "StoredFile_w2b6_change" AFTER UPDATE OF "category", "visibility", "deleteAfter", "documentTypeCode", "retainUntil" ON "StoredFile"
  FOR EACH ROW WHEN ((NEW."category", NEW."visibility", NEW."deleteAfter", NEW."documentTypeCode", NEW."retainUntil")
                     IS DISTINCT FROM (OLD."category", OLD."visibility", OLD."deleteAfter", OLD."documentTypeCode", OLD."retainUntil"))
  EXECUTE FUNCTION "factory_stored_file_w2b6_check"();

-- =====================================================================================================================
-- 3. Option groups that take a colour or a material (B-W2b-340)
-- =====================================================================================================================

-- QuoteLineOption, SalesOrderLineOption (new triggers; the sales pricing guards untouched): a COLOUR group's option names
-- no material, a MATERIAL group's no library colour; checked when the option is written or its group, colour or material
-- change (an option written before its group took one stays as it is).
CREATE FUNCTION "factory_line_option_takes_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  group_takes text;
  group_code text;
BEGIN
  SELECT g."takes"::text, g."code" INTO group_takes, group_code FROM "OptionGroup" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."groupId";
  IF group_takes = 'COLOUR' AND NEW."itemId" IS NOT NULL THEN
    RAISE EXCEPTION 'options: % % is of group %, which takes a colour of the library: it picks no material', TG_TABLE_NAME, NEW."id", group_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF group_takes = 'MATERIAL' AND NEW."colourId" IS NOT NULL THEN
    RAISE EXCEPTION 'options: % % is of group %, which takes a material and its colour: it picks no library colour', TG_TABLE_NAME, NEW."id", group_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteLineOption_takes_check" AFTER INSERT OR UPDATE OF "groupId", "colourId", "itemId" ON "QuoteLineOption"
  FOR EACH ROW WHEN (NEW."colourId" IS NOT NULL OR NEW."itemId" IS NOT NULL)
  EXECUTE FUNCTION "factory_line_option_takes_check"();
CREATE TRIGGER "SalesOrderLineOption_takes_check" AFTER INSERT OR UPDATE OF "groupId", "colourId", "itemId" ON "SalesOrderLineOption"
  FOR EACH ROW WHEN (NEW."colourId" IS NOT NULL OR NEW."itemId" IS NOT NULL)
  EXECUTE FUNCTION "factory_line_option_takes_check"();

-- OptionGroup (new trigger OptionGroup_takes_check; the BOM options guards untouched): a group takes COLOUR only while none
-- of its chosen options (quote or order line) names a material, MATERIAL only while none names a library colour.
CREATE FUNCTION "factory_option_group_takes_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."takes" = 'COLOUR'
      AND (EXISTS (SELECT 1 FROM "QuoteLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."itemId" IS NOT NULL)
           OR EXISTS (SELECT 1 FROM "SalesOrderLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."itemId" IS NOT NULL)))
     OR (NEW."takes" = 'MATERIAL'
      AND (EXISTS (SELECT 1 FROM "QuoteLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."colourId" IS NOT NULL)
           OR EXISTS (SELECT 1 FROM "SalesOrderLineOption" o WHERE o."tenantId" = NEW."tenantId" AND o."groupId" = NEW."id" AND o."colourId" IS NOT NULL))) THEN
    RAISE EXCEPTION 'options: group % takes a % only once none of its chosen options picks %', NEW."code",
      CASE NEW."takes" WHEN 'COLOUR' THEN 'colour of the library' ELSE 'material' END,
      CASE NEW."takes" WHEN 'COLOUR' THEN 'a material' ELSE 'a library colour' END
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OptionGroup_takes_check" AFTER UPDATE OF "takes" ON "OptionGroup"
  FOR EACH ROW WHEN (NEW."takes" IS NOT NULL AND NEW."takes" IS DISTINCT FROM OLD."takes")
  EXECUTE FUNCTION "factory_option_group_takes_check"();

-- =====================================================================================================================
-- 4. GeneratedDocument: the price list PDF (B-W2b-325, -343)
-- =====================================================================================================================

-- REDEFINES factory_generated_document_check (202611011803_mtm_office_w2b_guards, the last to redefine it), its whole body:
-- PRICE_LIST of a PriceListVersion. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_generated_document_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_company uuid;
  record_site uuid;
  record_kind text;
  file record;
BEGIN
  IF NEW."version" < 1 OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' OR NEW."language" !~ '^[a-z]{2}$'
     OR btrim(coalesce(NEW."layout", 'x')) = '' OR btrim(coalesce(NEW."number", 'x')) = '' THEN
    RAISE EXCEPTION 'documents: generated document % has a version from 1, a SHA-256 fingerprint (lower-case hex), its two-letter language and, when given, a layout and a number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW."kind" = 'PACKING_LIST' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'CLAIM_LETTER' AND NEW."recordType" = 'SupplierClaim')
          OR (NEW."kind" = 'JOB_SHEET' AND NEW."recordType" IN ('SubcontractOrder', 'MaintenanceJob'))
          OR (NEW."kind" = 'RMA_SHEET' AND NEW."recordType" = 'ReturnAuthorisation')
          OR (NEW."kind" = 'INSPECTION_REPORT' AND NEW."recordType" IN ('Inspection', 'IncomingInspection'))
          OR (NEW."kind" = 'CERTIFICATE_OF_CONFORMITY' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'NCR_REPORT' AND NEW."recordType" = 'Nonconformance')
          OR (NEW."kind" = 'EIGHT_D' AND NEW."recordType" = 'Capa')
          OR (NEW."kind" = 'COMPLAINT_ANSWER' AND NEW."recordType" = 'Complaint')
          OR (NEW."kind" = 'CHECK_REPORT' AND NEW."recordType" = 'MachineCheckResult')
          OR (NEW."kind" = 'DVR_FROZEN' AND NEW."recordType" = 'RiskAssessmentVersion')
          OR (NEW."kind" = 'PPE_RECEIPT' AND NEW."recordType" = 'PpeIssue')
          OR (NEW."kind" = 'COMPLIANCE_PACK' AND NEW."recordType" = 'Shipment')
          OR (NEW."kind" = 'EVIDENCE_PACK' AND NEW."recordType" = 'EvidencePack')
          OR (NEW."kind" = 'TECH_PACK' AND NEW."recordType" = 'StyleRevision')
          OR (NEW."kind" = 'USER_INFORMATION' AND NEW."recordType" = 'ComplianceDocument')
          OR (NEW."kind" = 'ORDER_CONFIRMATION' AND NEW."recordType" = 'SalesOrder')
          OR (NEW."kind" = 'MTM_WORKSHEET' AND NEW."recordType" = 'MeasurementProfile')
          OR (NEW."kind" = 'PRICE_LIST' AND NEW."recordType" = 'PriceListVersion')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s, a compliance pack a Shipment''s, an evidence pack an EvidencePack''s, a tech pack a StyleRevision''s, a user information leaflet a ComplianceDocument''s, an order confirmation a SalesOrder''s, a made-to-measure worksheet a MeasurementProfile''s, a price list a PriceListVersion''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
    -- W2b-6 wave 45/57 (B-W2b-363): a price list is of its version's list's company, or of any company of the tenant for a
    -- tenant-wide list (the company whose papers it is); a price list has no site.
    WHEN 'PriceListVersion' THEN
      SELECT coalesce(l."companyId", NEW."companyId"), NULL::uuid INTO record_company, record_site
        FROM "PriceListVersion" r JOIN "PriceList" l ON l."tenantId" = r."tenantId" AND l."id" = r."listId"
       WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-5 wave 44/44 (B-W2b-297): a made-to-measure worksheet is of a profile, which has no company (a rider's profile is
    -- the party's, tenant-wide): the document is of the company whose papers it is, any company of the tenant; no site.
    WHEN 'MeasurementProfile' THEN
      SELECT NEW."companyId", NULL::uuid INTO record_company, record_site FROM "MeasurementProfile" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-5 wave 39/44 (B-W2b-281): an order confirmation is of its order's company; an order has no site.
    WHEN 'SalesOrder' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "SalesOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b-4 wave 32/33 (B-W2b-218): an evidence pack is of its company; a tech pack of its revision's style's company and a
    -- leaflet of its document's company, either for any company of the tenant when the style or document is tenant-wide; the
    -- leaflet's document is user information. None of them has a site.
    WHEN 'EvidencePack' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "EvidencePack" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'StyleRevision' THEN
      SELECT coalesce(s."companyId", NEW."companyId"), NULL::uuid INTO record_company, record_site
        FROM "StyleRevision" r JOIN "Style" s ON s."tenantId" = r."tenantId" AND s."id" = r."styleId"
       WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'ComplianceDocument' THEN
      SELECT coalesce(r."companyId", NEW."companyId"), NULL::uuid, r."kind"::text INTO record_company, record_site, record_kind
        FROM "ComplianceDocument" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
      IF FOUND AND record_kind <> 'USER_INFORMATION' THEN
        RAISE EXCEPTION 'documents: generated document % is a user information leaflet of a ComplianceDocument of kind USER_INFORMATION (this one is %)', NEW."id", record_kind
          USING ERRCODE = 'check_violation';
      END IF;
    -- W2b wave 15/16 (B-W2b-87): a frozen risk assessment is of its version's company and site, a PPE receipt of its issue's.
    WHEN 'RiskAssessmentVersion' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "RiskAssessmentVersion" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'PpeIssue' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "PpeIssue" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- W2b wave 14/16 (B-W2b-86): a check report is of its result's company and site.
    WHEN 'MachineCheckResult' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MachineCheckResult" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    -- A record of the whole company has no site, and neither has its document.
    WHEN 'Capa' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Capa" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Complaint' THEN
      SELECT r."companyId", NULL::uuid INTO record_company, record_site FROM "Complaint" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Inspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Inspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'IncomingInspection' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "IncomingInspection" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Nonconformance' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Nonconformance" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'Shipment' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "Shipment" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SupplierClaim' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SupplierClaim" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'SubcontractOrder' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "SubcontractOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    WHEN 'MaintenanceJob' THEN
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "MaintenanceJob" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
    ELSE
      SELECT r."companyId", r."siteId" INTO record_company, record_site FROM "ReturnAuthorisation" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."recordId";
  END CASE;
  IF FOUND AND (record_company, record_site) IS DISTINCT FROM (NEW."companyId", NEW."siteId") THEN
    RAISE EXCEPTION 'documents: generated document % is of the company and site of its % %', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."recordType", f."recordId", f."companyId" INTO file FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND AND (file."recordType", file."recordId", file."companyId") IS DISTINCT FROM (NEW."recordType", NEW."recordId", NEW."companyId") THEN
    RAISE EXCEPTION 'documents: the file of generated document % is a file of its own record (% %) and company', NEW."id", NEW."recordType", NEW."recordId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- =====================================================================================================================
-- 5. Nobody approves their own request: quote and timesheet approvals (B-W2b-276, -282; Owner answer Q3 of W2b-5 = A)
-- =====================================================================================================================

-- QuoteApproval (new trigger QuoteApproval_not_own; W1's guard untouched): an APPROVED or REJECTED decision is never by the
-- office user who asked (createdById), the Owner included. Checked when it is decided (or written decided): a WITHDRAWN one
-- may be by the asker (a reopen), and a decision written before this rule stays as it is.
CREATE FUNCTION "factory_quote_approval_not_own"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."decidedById" = NEW."createdById" THEN
    RAISE EXCEPTION 'sales: quote approval % is decided by another person than the one who asked for it: nobody approves their own request, the Owner included (Owner answer Q3)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteApproval_not_own" AFTER INSERT ON "QuoteApproval"
  FOR EACH ROW WHEN (NEW."status" IN ('APPROVED', 'REJECTED'))
  EXECUTE FUNCTION "factory_quote_approval_not_own"();
CREATE TRIGGER "QuoteApproval_not_own_decision" AFTER UPDATE OF "status", "decidedById", "createdById" ON "QuoteApproval"
  FOR EACH ROW WHEN (NEW."status" IN ('APPROVED', 'REJECTED') AND (OLD."status" = 'PENDING' OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById"))
  EXECUTE FUNCTION "factory_quote_approval_not_own"();

-- TimesheetApproval (new trigger TimesheetApproval_not_own; the time wave's guard untouched): the lead's approval and HR's,
-- when given, are never by the person's own office account: the Employee's userId, or the userId of a floor worker of that
-- employee (the people guards keep the two the same). Checked when an approval is given; one given before stays as it is.
CREATE FUNCTION "factory_timesheet_approval_not_own"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approver uuid;
BEGIN
  FOREACH approver IN ARRAY ARRAY[CASE WHEN NEW."leadApprovedById" IS DISTINCT FROM OLD."leadApprovedById" THEN NEW."leadApprovedById" END,
                                  CASE WHEN NEW."hrApprovedById" IS DISTINCT FROM OLD."hrApprovedById" THEN NEW."hrApprovedById" END] LOOP
    IF approver IS NOT NULL
       AND (EXISTS (SELECT 1 FROM "Employee" e WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."employeeId" AND e."userId" = approver)
            OR EXISTS (SELECT 1 FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."employeeId" = NEW."employeeId" AND w."userId" = approver)) THEN
      RAISE EXCEPTION 'timesheet: timesheet % is approved by another person than its own (D.Lgs. 152/1997 art. 1-bis): nobody approves their own timesheet, the Owner included', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER "TimesheetApproval_not_own" AFTER UPDATE OF "leadApprovedById", "hrApprovedById" ON "TimesheetApproval"
  FOR EACH ROW WHEN ((NEW."leadApprovedById", NEW."hrApprovedById") IS DISTINCT FROM (OLD."leadApprovedById", OLD."hrApprovedById"))
  EXECUTE FUNCTION "factory_timesheet_approval_not_own"();

-- =====================================================================================================================
-- 6. A receipt beyond its tolerance waits for a yes (B-W2b-296, -354)
-- =====================================================================================================================

-- GoodsReceiptLine (new trigger GoodsReceiptLine_held_check; W1's line guard keeps every change to an OPEN receipt): held
-- at a time not in the future.
CREATE FUNCTION "factory_goods_receipt_line_held_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "factory_recall_not_future"(NEW."heldForApprovalAt") THEN
    RAISE EXCEPTION 'inventory: goods receipt line % is held for a yes from a time not in the future, not %', NEW."id", NEW."heldForApprovalAt"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GoodsReceiptLine_held_check" AFTER INSERT OR UPDATE OF "heldForApprovalAt" ON "GoodsReceiptLine"
  FOR EACH ROW WHEN (NEW."heldForApprovalAt" IS NOT NULL)
  EXECUTE FUNCTION "factory_goods_receipt_line_held_check"();

-- GoodsReceipt (new trigger GoodsReceipt_held_lines; W1's receipt guard untouched): a receipt is POSTED only while none of
-- its lines is held for a yes.
CREATE FUNCTION "factory_goods_receipt_held_lines"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  held integer;
BEGIN
  SELECT count(*) INTO held FROM "GoodsReceiptLine" l WHERE l."tenantId" = NEW."tenantId" AND l."receiptId" = NEW."id" AND l."heldForApprovalAt" IS NOT NULL;
  IF held > 0 THEN
    RAISE EXCEPTION 'inventory: goods receipt % has % line(s) beyond the delivery tolerance waiting for a yes; it is posted once they are approved or corrected', NEW."number", held
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "GoodsReceipt_held_lines" AFTER UPDATE OF "status" ON "GoodsReceipt"
  FOR EACH ROW WHEN (NEW."status" = 'POSTED' AND OLD."status" <> 'POSTED')
  EXECUTE FUNCTION "factory_goods_receipt_held_lines"();

-- =====================================================================================================================
-- 7. Chase reminders and the confirm-by setting (B-W2b-305, -333, -354)
-- =====================================================================================================================

-- PurchasingSettings (new trigger PurchasingSettings_reminder_check; the settings' guard untouched): the confirm-by 1 to 720
-- hours, the cadence 1 to 30 days; null: not set on this row.
CREATE FUNCTION "factory_purchasing_settings_reminder_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."confirmByHours" NOT BETWEEN 1 AND 720 OR NEW."reminderCadenceDays" NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'purchasing: the purchasing settings % ask suppliers to confirm within 1 to 720 hours and remind them every 1 to 30 days (null: not set here), not % hours and % days', NEW."id", NEW."confirmByHours", NEW."reminderCadenceDays"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PurchasingSettings_reminder_check" AFTER INSERT OR UPDATE OF "confirmByHours", "reminderCadenceDays" ON "PurchasingSettings"
  FOR EACH ROW WHEN (NEW."confirmByHours" IS NOT NULL OR NEW."reminderCadenceDays" IS NOT NULL)
  EXECUTE FUNCTION "factory_purchasing_settings_reminder_check"();

-- PurchaseOrderReminder (new trigger PurchaseOrderReminder_chase_check; W2a's check of a CONFIRMATION untouched): a CHASE
-- goes only to an order that waits for goods from its supplier, for its current revision.
CREATE FUNCTION "factory_purchase_order_chase_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state text;
  current_revision integer;
BEGIN
  SELECT o."status"::text, o."revision" INTO state, current_revision
    FROM "PurchaseOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."purchaseOrderId";
  IF FOUND AND (state NOT IN ('SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED') OR NEW."revision" <> current_revision) THEN
    RAISE EXCEPTION 'supply: purchase order % is % (revision %); a chase goes only to an order that waits for goods (SENT, CONFIRMED, CHANGES_PROPOSED, PARTLY_RECEIVED), for its current revision', NEW."purchaseOrderId", state, current_revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "PurchaseOrderReminder_chase_check" AFTER INSERT ON "PurchaseOrderReminder"
  FOR EACH ROW WHEN (NEW."kind" = 'CHASE')
  EXECUTE FUNCTION "factory_purchase_order_chase_check"();

-- =====================================================================================================================
-- 8. A FEE line credited against the bulk order (B-W2b-280, -294, -316, -330; SAL-181)
-- =====================================================================================================================

-- REDEFINES factory_sales_order_line_guard (202611011303_sales_orders_depth_w2b_guards, the last to redefine it), its whole
-- body: an UPDATE that changes only the fee credit (and the version) passes whatever the order's state. The trigger stays.
CREATE OR REPLACE FUNCTION "factory_sales_order_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  short CONSTANT text[] := ARRAY['closedShortQuantity', 'closedShortAt', 'closedShortById', 'closeShortReason', 'closedShortReasonCode', 'version', 'updatedAt'];
  -- W2b-6 (wave 45/57): a FEE line's credit against the bulk order changes whatever its order's state.
  credit CONSTANT text[] := ARRAY['feeCreditOrderId', 'feeCreditedAt', 'version', 'updatedAt'];
  state text;
  part_of uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW."id" <> OLD."id" OR NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION 'sales: sales order line % never moves to another order', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    part_of := NEW."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."orderId" FOR SHARE;
  ELSE
    part_of := OLD."orderId";
    SELECT o."status"::text INTO state FROM "SalesOrder" o WHERE o."tenantId" = OLD."tenantId" AND o."id" = OLD."orderId" FOR SHARE;
  END IF;
  IF state IS NOT NULL AND state NOT IN ('PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY')
     AND NOT (TG_OP = 'UPDATE' AND state = 'PARTLY_SHIPPED' AND (to_jsonb(NEW) - short) = (to_jsonb(OLD) - short))
     AND NOT (TG_OP = 'UPDATE' AND (to_jsonb(NEW) - credit) = (to_jsonb(OLD) - credit)) THEN
    RAISE EXCEPTION 'sales: sales order % is %; its lines change only while it is CONFIRMED, IN_PRODUCTION or READY, or waits for a yes (once PARTLY_SHIPPED, a line is only closed short or reopened)', part_of, state
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."quantity" < 1
     OR (NEW."kind" = 'MADE_TO_MEASURE') <> (NEW."measurementProfileId" IS NOT NULL)
     OR (NEW."kind" = 'MADE_TO_MEASURE' AND NEW."quantity" <> 1) THEN
    RAISE EXCEPTION 'sales: sales order line % is a size grid of at least one piece, or one made-to-measure unit with its measurement profile', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedShortAt" IS NULL) <> (NEW."closedShortQuantity" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (NEW."closedShortById" IS NULL)
     OR (NEW."closedShortAt" IS NULL) <> (coalesce(btrim(NEW."closeShortReason"), '') = '') THEN
    RAISE EXCEPTION 'sales: sales order line % is closed short with its pieces, time, who and why, or not at all', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortQuantity" IS NOT NULL AND (NEW."closedShortQuantity" < 1 OR NEW."closedShortQuantity" > NEW."quantity") THEN
    RAISE EXCEPTION 'sales: sales order line % closes short 1 to % pieces, not %', NEW."id", NEW."quantity", NEW."closedShortQuantity"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."closedShortReasonCode" IS NOT NULL
     AND (NEW."closedShortAt" IS NULL OR NEW."closedShortReasonCode" !~ '^[A-Z][A-Z0-9_]*$') THEN
    RAISE EXCEPTION 'sales: sales order line % names a closed-short reason code (upper-case letters, digits and underscores) only while it is closed short', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- SalesOrderLine (new triggers SalesOrderLine_fee_credit, SalesOrderLine_fee_credit_change): only a FEE line names the bulk
-- order (another order of its company and customer: the reference), which has goods lines and is not CANCELLED when it is
-- named; the credit's time only with the order named, not in the future; once credited, both stay as they are.
CREATE FUNCTION "factory_sales_order_line_fee_credit"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bulk_state text;
  goods integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."feeCreditedAt" IS NOT NULL
     AND (NEW."feeCreditOrderId", NEW."feeCreditedAt") IS DISTINCT FROM (OLD."feeCreditOrderId", OLD."feeCreditedAt") THEN
    RAISE EXCEPTION 'sales: the fee of order line % was credited against its bulk order at %; that stays as it is', OLD."id", OLD."feeCreditedAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."feeCreditOrderId" IS NOT NULL AND (NEW."kind" <> 'FEE' OR NEW."feeCreditOrderId" = NEW."orderId") THEN
    RAISE EXCEPTION 'sales: order line % is credited against a bulk order only as a FEE line, and never against its own order', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."feeCreditedAt" IS NOT NULL AND (NEW."feeCreditOrderId" IS NULL OR NOT "factory_recall_not_future"(NEW."feeCreditedAt")) THEN
    RAISE EXCEPTION 'sales: the fee of order line % is credited at a time not in the future, against the bulk order it names', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."feeCreditOrderId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."feeCreditOrderId" IS DISTINCT FROM OLD."feeCreditOrderId") THEN
    SELECT o."status"::text INTO bulk_state FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."feeCreditOrderId";
    SELECT count(*) INTO goods FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."orderId" = NEW."feeCreditOrderId" AND l."kind" <> 'FEE';
    IF bulk_state IS NOT NULL AND (bulk_state = 'CANCELLED' OR goods = 0) THEN
      RAISE EXCEPTION 'sales: the fee of order line % is credited against a bulk order with goods lines that is not cancelled (this one is %, with % goods line(s))', NEW."id", bulk_state, goods
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrderLine_fee_credit" AFTER INSERT ON "SalesOrderLine"
  FOR EACH ROW WHEN (NEW."feeCreditOrderId" IS NOT NULL OR NEW."feeCreditedAt" IS NOT NULL)
  EXECUTE FUNCTION "factory_sales_order_line_fee_credit"();
CREATE TRIGGER "SalesOrderLine_fee_credit_change" AFTER UPDATE OF "feeCreditOrderId", "feeCreditedAt", "kind" ON "SalesOrderLine"
  FOR EACH ROW WHEN ((NEW."feeCreditOrderId", NEW."feeCreditedAt", NEW."kind") IS DISTINCT FROM (OLD."feeCreditOrderId", OLD."feeCreditedAt", OLD."kind"))
  EXECUTE FUNCTION "factory_sales_order_line_fee_credit"();

-- =====================================================================================================================
-- 9. Return reasons by group (B-W2b-348)
-- =====================================================================================================================

-- ReasonCode (new trigger ReasonCode_group_check; W2a's reason guard untouched): the group's words are 1 to 120 characters
-- of one line, with no space at either end (so the same words are the same group).
CREATE FUNCTION "factory_reason_code_group_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT "factory_recall_words_ok"(NEW."group", 120, false) OR NEW."group" <> btrim(NEW."group") THEN
    RAISE EXCEPTION 'reasons: the group of reason % % is 1 to 120 characters of one line, with no space at either end', NEW."list", NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ReasonCode_group_check" AFTER INSERT OR UPDATE OF "group" ON "ReasonCode"
  FOR EACH ROW WHEN (NEW."group" IS NOT NULL)
  EXECUTE FUNCTION "factory_reason_code_group_check"();
