-- Written by hand (Prisma does not model triggers, partial indexes or deferred constraint triggers), after the generated
-- 202610319002_files_depth_w2b_schema and before the policy migration. When the migrations are renumbered, keep this
-- file as it is under its new timestamp.

-- W2b schema wave 18/22 (B-W2b-153): files in depth: versions (a new version is a new row and a new object: nothing in
-- the store is overwritten), copies that name their source, expiry and its reminders, thumbnails without location data,
-- large uploads in parts, markups, and the documents a record type must have before a status move (features COL-046,
-- COL-048, COL-049, COL-052, COL-055, COL-058, PLT-216, PRD-227). apps/factory-api's platform/files checks all of this
-- first, in words; these rules hold for every login, the owner included. A row rule is a check_violation (SQLSTATE
-- 23514), a refused move a restrict_violation (23001), as in …_files_guards.
--
-- As in every guards migration: the tenant of a row is held by the policies (USING and WITH CHECK) and the references,
-- not here; a rule that reads another row runs only for a row inside the session's tenant ("factory_quality_plant_in_scope"
-- of …_quality_plant_w2a_guards), so a row of another tenant meets row-level security first; a floor session never takes
-- those reads (the floor makes no versions and no copies: it has no grant on seriesId or sourceFileId); an UPDATE that
-- changes nothing passes. "Everything but these columns" is compared as jsonb, so a column added later is frozen too
-- unless a later migration names it.
--
-- Earlier function redefined here, its whole body:
--   factory_stored_file_guard  (…_platform_w2a_guards, the newest body: …_files_guards plus the virus scan): the content
--                              columns now include the version (seriesId, versionNo) and the source of a copy; only the
--                              new columns that may move move, forward only: superseded once, the expiry date while the
--                              file is current with its reminder moving later, the thumbnail once; a superseded version
--                              stays read-only; a deleted file's new columns change no more either.
-- New triggers on an earlier table: "StoredFile_one_current_version" and "StoredFile_one_current_version_insert" (deferred:
-- one AVAILABLE version of a series is current at commit). New partial unique index "StoredFile_one_number_per_version".
-- No other earlier function or trigger is touched: the floor's (…_plant_care_w2b_guards, which freezes every new column of
-- a floor UPDATE by itself) and the protected files' (…_protected_safety_w2b_guards) stay as they are.

-- =====================================================================================================================
-- StoredFile (files.prisma): factory_stored_file_guard of …_platform_w2a_guards, redefined whole, with files in depth:
--   every row  as before (the office always sees it; the floor and party keys exactly with their audiences; the fiscal
--              archive's store and retention; a time or reason per status; the scan's verdict with its time and scanner;
--              an infected file never AVAILABLE), and now: a version number from 1, with a series exactly from 2 (a first
--              version names no series, a later one names the first, never itself); a copy never names itself as its
--              source; an expiry reminder only with an expiry date; the thumbnail and its EXIF stripping together, the
--              thumbnail's key not blank, not the file's own key, never in the legal store.
--   INSERT     as before (born PENDING_UPLOAD or AVAILABLE, NOT_SCANNED), and now: never born superseded nor reminded of its
--              expiry; a thumbnail only on a file born AVAILABLE. A later version is of its first version's record,
--              company and kind (never a fiscal archive file), takes the series' highest number plus one, and waits until
--              no version of the series is still an announced upload (PENDING_UPLOAD). A copy has its source's bytes
--              (SHA-256, size and type), and its source is AVAILABLE.
--   UPDATE     the content never changes, now with the version and the source of a copy (a new version is a new file);
--              superseded is set once, never cleared, and only while a later version of the series is AVAILABLE (a
--              DELETED file is not superseded); a superseded version stays read-only: only its deletion, its scan
--              (and the quarantine or availability the scan moves), its retention and legal hold, its thumbnail and a
--              narrower sharing (never a new audience, another floor or another party) change. The expiry date may move
--              while the file is current, and then starts without a reminder; the reminder only moves later while the date
--              stays. The thumbnail is set once, with its EXIF stripping, while the file is AVAILABLE, and never changes.
--              A DELETED file changes no more (its new columns too). The rest as before.
--   DELETE     refused: a deleted file keeps its row (status DELETED).
--   TRUNCATE   refused.
CREATE OR REPLACE FUNCTION "factory_stored_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- What a superseded version may still change (everything else stays as it was when it was superseded).
  superseded_moves CONSTANT text[] := ARRAY['status', 'availableAt', 'deletedAt', 'quarantineReason', 'visibility', 'floorSiteId', 'partyId',
                                            'retainUntil', 'legalHold', 'scanStatus', 'scannedAt', 'scanEngine', 'scanFinding',
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

-- A series has its version numbers once (the series' first version is number 1 and names no series).
CREATE UNIQUE INDEX "StoredFile_one_number_per_version" ON "StoredFile" ("tenantId", "seriesId", "versionNo") WHERE "seriesId" IS NOT NULL;

-- One current version per series, at commit (a deferred constraint trigger): when a version becomes AVAILABLE, no other
-- AVAILABLE version of its series is left unsuperseded, so the command that makes a new version available supersedes the
-- one it replaces in the same transaction (the new version first: a version is superseded only once a later one is
-- AVAILABLE). A floor session is left out: the floor makes no versions
-- (it has no grant on seriesId), and a later version cannot be added while an earlier one is still an announced upload,
-- so a file the floor confirms has no later version; its read would also need the seriesId the floor may not read.
CREATE FUNCTION "factory_stored_file_one_current_version"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  root uuid := coalesce(NEW."seriesId", NEW."id");
  current_versions integer;
BEGIN
  IF current_user = 'factory_floor_runtime' OR "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO current_versions FROM "StoredFile" f
   WHERE f."tenantId" = NEW."tenantId" AND (f."id" = root OR f."seriesId" = root) AND f."status" = 'AVAILABLE' AND f."supersededAt" IS NULL;
  IF current_versions > 1 THEN
    RAISE EXCEPTION 'files: the series of file % has % current versions; the one a new version replaces is superseded in the same command', NEW."id", current_versions
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "StoredFile_one_current_version" AFTER UPDATE ON "StoredFile"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'AVAILABLE' AND OLD."status" <> 'AVAILABLE')
  EXECUTE FUNCTION "factory_stored_file_one_current_version"();
CREATE CONSTRAINT TRIGGER "StoredFile_one_current_version_insert" AFTER INSERT ON "StoredFile"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'AVAILABLE' AND NEW."seriesId" IS NOT NULL)
  EXECUTE FUNCTION "factory_stored_file_one_current_version"();

-- =====================================================================================================================
-- The new tables (files-depth.prisma): TRUNCATE refused on all three (FileMarkup by its append-only function).
CREATE FUNCTION "factory_files_depth_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'files: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "FileUploadSession_no_truncate" BEFORE TRUNCATE ON "FileUploadSession"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_files_depth_refuse_truncate"();
CREATE TRIGGER "RequiredDocumentRule_no_truncate" BEFORE TRUNCATE ON "RequiredDocumentRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_files_depth_refuse_truncate"();

-- The parts a multipart upload has done, as FileUploadSession.partsDone holds them: an array of objects { partNumber,
-- etag, sizeBytes }, each part number from 1 to the file's count of parts once, its ETag a word of at most 200 characters,
-- its size the part size (the last part: the rest of the file).
CREATE FUNCTION "factory_upload_parts_ok"(parts jsonb, part_size integer, file_size integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(parts) = 'array'
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(parts) p(part)
            WHERE CASE
                    WHEN jsonb_typeof(part) <> 'object' OR jsonb_typeof(part -> 'partNumber') <> 'number' OR jsonb_typeof(part -> 'sizeBytes') <> 'number'
                         OR jsonb_typeof(part -> 'etag') <> 'string' THEN true
                    WHEN (part ->> 'partNumber') !~ '^[1-9][0-9]{0,4}$' OR (part ->> 'sizeBytes') !~ '^[1-9][0-9]{0,9}$' THEN true
                    WHEN btrim(part ->> 'etag') = '' OR length(part ->> 'etag') > 200 THEN true
                    WHEN (part ->> 'partNumber')::bigint > (file_size::bigint + part_size - 1) / part_size THEN true
                    WHEN (part ->> 'partNumber')::bigint = (file_size::bigint + part_size - 1) / part_size
                      THEN (part ->> 'sizeBytes')::bigint <> file_size::bigint - ((part ->> 'partNumber')::bigint - 1) * part_size
                    ELSE (part ->> 'sizeBytes')::bigint <> part_size
                  END)
     AND (SELECT count(DISTINCT p.part ->> 'partNumber') FROM jsonb_array_elements(parts) p(part)) = jsonb_array_length(parts)
$$;

-- FileUploadSession (COL-052)
--   every row  the part size at least 5 MiB (the store's rule; with a file's size an Int, never more than 410 parts, well
--              under the store's 10 000); the store's upload id not blank (at most 1024 characters); it expires
--              after it started, at most seven days later; the parts done valid (factory_upload_parts_ok) against the
--              file's size; endedAt exactly when not OPEN; COMPLETED only with every part.
--   INSERT     born OPEN with no part, for an announced file (PENDING_UPLOAD).
--   UPDATE     the file, the upload id, the part size, the expiry and the creation never change; OPEN → COMPLETED |
--              ABORTED | EXPIRED, final; parts are only added (a part done stays as it is), only while OPEN and while the
--              file is still PENDING_UPLOAD.
--   DELETE     no role has the grant. TRUNCATE refused.
CREATE FUNCTION "factory_file_upload_session_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file_size integer;
  file_status text;
  in_scope boolean := "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS TRUE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."partSizeBytes" < 5242880 OR btrim(NEW."uploadId") = '' OR length(NEW."uploadId") > 1024
     OR NEW."expiresAt" <= NEW."createdAt" OR NEW."expiresAt" > NEW."createdAt" + interval '7 days'
     OR (NEW."status" = 'OPEN') <> (NEW."endedAt" IS NULL) OR (NEW."endedAt" IS NOT NULL AND NEW."endedAt" < NEW."createdAt") THEN
    RAISE EXCEPTION 'files: upload session % has parts of at least 5 MiB, the store''s upload id, an expiry after its start (at most seven days), and an end exactly when it is no longer OPEN', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."fileId", NEW."uploadId", NEW."partSizeBytes", NEW."expiresAt", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM (OLD."fileId", OLD."uploadId", OLD."partSizeBytes", OLD."expiresAt", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'files: upload session % keeps its file, upload id, part size, expiry and creation', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF in_scope THEN
    SELECT f."sizeBytes", f."status"::text INTO file_size, file_status FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'files: upload session % fills a file that is not there', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT "factory_upload_parts_ok"(NEW."partsDone", NEW."partSizeBytes", file_size) THEN
      RAISE EXCEPTION 'files: the parts done of upload session % are not the file''s parts (each from 1 to its count once, with its ETag and its size)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'COMPLETED' AND jsonb_array_length(NEW."partsDone") <> (file_size::bigint + NEW."partSizeBytes" - 1) / NEW."partSizeBytes" THEN
      RAISE EXCEPTION 'files: upload session % is completed only with every part done', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."partsDone" <> '[]'::jsonb THEN
      RAISE EXCEPTION 'files: upload session % is born OPEN with no part done', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF in_scope AND file_status <> 'PENDING_UPLOAD' THEN
      RAISE EXCEPTION 'files: upload session % is for an announced file (PENDING_UPLOAD), not one that is %', NEW."id", file_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'OPEN' AND (NEW."status", NEW."partsDone", NEW."endedAt") IS DISTINCT FROM (OLD."status", OLD."partsDone", OLD."endedAt") THEN
    RAISE EXCEPTION 'files: upload session % is % and changes no more', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."partsDone" IS DISTINCT FROM OLD."partsDone" THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD."partsDone") o(part) WHERE NOT (NEW."partsDone" @> jsonb_build_array(o.part))) THEN
      RAISE EXCEPTION 'files: a part done of upload session % stays as it is; parts are only added', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF in_scope AND file_status <> 'PENDING_UPLOAD' THEN
      RAISE EXCEPTION 'files: upload session % takes parts only while its file is an announced upload (not %)', OLD."id", file_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FileUploadSession_guard" BEFORE INSERT OR UPDATE ON "FileUploadSession"
  FOR EACH ROW EXECUTE FUNCTION "factory_file_upload_session_guard"();

-- FileMarkup (COL-055), append-only
--   INSERT     on the current version of a file (AVAILABLE, not superseded) that is a picture (image/…) or a PDF; a page
--              (1 to 10 000) exactly on a PDF; 1 to 200 shapes, each an object, at most 64 KB; a note of words (at most 2000
--              characters) or none; it names who drew it (a user, a party, or both); from outside (a party), only on a file
--              shared with that party's portal or links. The new version it made: only on a picture, a later version of the
--              same series, a picture too, not a copy (other bytes), announced or available; a PDF keeps an overlay.
--   UPDATE, DELETE, TRUNCATE  refused for every login.
CREATE FUNCTION "factory_file_markup_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'files: a markup is never changed or removed (%); a new markup is a new row', TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_file_markup_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  file_status text;
  file_superseded timestamptz;
  file_type text;
  file_series uuid;
  file_number integer;
  file_visibility text[];
  file_party uuid;
  result_series uuid;
  result_number integer;
  result_type text;
  result_source uuid;
  result_status text;
BEGIN
  IF jsonb_typeof(NEW."shapes") <> 'array' OR jsonb_array_length(NEW."shapes") < 1 OR jsonb_array_length(NEW."shapes") > 200
     OR octet_length(NEW."shapes"::text) > 65536
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."shapes") s(shape) WHERE jsonb_typeof(s.shape) <> 'object') THEN
    RAISE EXCEPTION 'files: markup % holds 1 to 200 shapes (objects), at most 64 KB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 2000) THEN
    RAISE EXCEPTION 'files: the note of markup % is words, at most 2000 characters, or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."createdById" IS NULL AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'files: markup % names who drew it (a user or, from outside, the party)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."page" IS NOT NULL AND (NEW."page" < 1 OR NEW."page" > 10000) THEN
    RAISE EXCEPTION 'files: markup % is on a page from 1 to 10 000', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NULL) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  SELECT f."status"::text, f."supersededAt", f."contentType", f."seriesId", f."versionNo", f."visibility"::text[], f."partyId"
    INTO file_status, file_superseded, file_type, file_series, file_number, file_visibility, file_party
    FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF NOT FOUND OR file_status <> 'AVAILABLE' OR file_superseded IS NOT NULL THEN
    RAISE EXCEPTION 'files: markup % is on the current version of a file, available', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF file_type NOT LIKE 'image/%' AND file_type <> 'application/pdf' THEN
    RAISE EXCEPTION 'files: markup % is on a picture or a PDF, not %', NEW."id", file_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."page" IS NOT NULL) <> (file_type = 'application/pdf') THEN
    RAISE EXCEPTION 'files: markup % names a page exactly on a PDF', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS NOT NULL AND (file_party IS DISTINCT FROM NEW."partyId" OR NOT (file_visibility && ARRAY['PARTNER', 'LINK'])) THEN
    RAISE EXCEPTION 'files: a party marks up only a file shared with its portal or links (markup %)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."resultFileId" IS NOT NULL THEN
    IF file_type = 'application/pdf' THEN
      RAISE EXCEPTION 'files: markup % on a PDF stays an overlay; the document itself never changes', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT r."seriesId", r."versionNo", r."contentType", r."sourceFileId", r."status"::text
      INTO result_series, result_number, result_type, result_source, result_status
      FROM "StoredFile" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."resultFileId";
    IF NOT FOUND OR result_series IS DISTINCT FROM coalesce(file_series, NEW."fileId") OR result_number <= file_number
       OR result_type NOT LIKE 'image/%' OR result_source IS NOT NULL OR result_status NOT IN ('PENDING_UPLOAD', 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: the picture markup % made is a later version of the same series, a picture with the shapes drawn in (not a copy), announced or available', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FileMarkup_check" BEFORE INSERT ON "FileMarkup"
  FOR EACH ROW EXECUTE FUNCTION "factory_file_markup_check"();
CREATE TRIGGER "FileMarkup_append_only" BEFORE UPDATE OR DELETE ON "FileMarkup"
  FOR EACH ROW EXECUTE FUNCTION "factory_file_markup_append_only"();
CREATE TRIGGER "FileMarkup_no_truncate" BEFORE TRUNCATE ON "FileMarkup"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_file_markup_append_only"();

-- RequiredDocumentRule (COL-048)
--   every row  the record type a model name (a capital, then letters and digits, at most 64), the status a status value
--              (capitals, digits and _, at most 64).
--   UPDATE     the company and the creation never change (a rule of another company is a new rule).
--   one ACTIVE rule per company, record type, document, status and party role (none: every party): the partial unique
--              indexes "RequiredDocumentRule_one_active" and "RequiredDocumentRule_one_active_any_party".
--   DELETE     no role has the grant (switched off instead). TRUNCATE refused.
CREATE FUNCTION "factory_required_document_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF NEW."recordType" !~ '^[A-Z][A-Za-z0-9]{0,63}$' OR NEW."beforeStatus" !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'files: required document rule % names a record type (its model name) and a status (its value)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."companyId", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'files: required document rule % keeps its company and creation', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RequiredDocumentRule_guard" BEFORE INSERT OR UPDATE ON "RequiredDocumentRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_required_document_rule_guard"();

CREATE UNIQUE INDEX "RequiredDocumentRule_one_active" ON "RequiredDocumentRule" ("tenantId", "companyId", "recordType", "category", "beforeStatus", "partyRole")
  WHERE "active" AND "partyRole" IS NOT NULL;
CREATE UNIQUE INDEX "RequiredDocumentRule_one_active_any_party" ON "RequiredDocumentRule" ("tenantId", "companyId", "recordType", "category", "beforeStatus")
  WHERE "active" AND "partyRole" IS NULL;
