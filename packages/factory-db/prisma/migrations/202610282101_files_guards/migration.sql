-- Written by hand (Prisma does not model triggers), after the generated 202610282100_files_storage and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Files on R2 (plan A1 §3.6; PLAN §2.8; features COL-045, COL-050). apps/factory-api's platform/files checks all of this
-- first; these rules hold for every login, the owner included:
--   every row  the office always sees it (visibility has OFFICE); floorSiteId is set exactly when visibility has FLOOR
--              (and then the file belongs to a company: the site reference includes it), partyId exactly when it has
--              PARTNER or LINK; these are the floor and partner roles' policy keys, so a file reaches a floor or a
--              party only when it is shared with it. A FISCAL_ARCHIVE file has a retention date and a `legal/` key (the
--              locked bucket), and only it has one. AVAILABLE has availableAt, QUARANTINED its reason, and exactly
--              DELETED has deletedAt.
--   INSERT     a file is born PENDING_UPLOAD (an upload) or AVAILABLE (a document the system made), never
--              QUARANTINED or DELETED.
--   UPDATE     the content never changes: company, record, kind, name, type, size, SHA-256, store, key, creation (a
--              new version is a new file); the status moves only PENDING_UPLOAD → AVAILABLE | QUARANTINED | DELETED
--              and AVAILABLE | QUARANTINED → DELETED; a DELETED file changes no more; a file becomes DELETED only
--              when no legal hold is set and its retention date has passed; the retention date never moves earlier
--              and is never cleared. tenantId is held by the policies (USING and WITH CHECK on the tenant).
--   DELETE     refused: a deleted file keeps its row (status DELETED).
--   TRUNCATE   refused.
CREATE FUNCTION "factory_stored_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('PENDING_UPLOAD', 'AVAILABLE') THEN
      RAISE EXCEPTION 'files: a new file is PENDING_UPLOAD or AVAILABLE, not %', NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."kind", NEW."originalName", NEW."contentType",
      NEW."sizeBytes", NEW."sha256", NEW."storeAccountId", NEW."storageKey", NEW."createdAt", NEW."createdById")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."kind", OLD."originalName", OLD."contentType",
      OLD."sizeBytes", OLD."sha256", OLD."storeAccountId", OLD."storageKey", OLD."createdAt", OLD."createdById") THEN
    RAISE EXCEPTION 'files: the content of file % never changes; a new version is a new file', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DELETED'
     AND (NEW."status", NEW."visibility", NEW."floorSiteId", NEW."partyId", NEW."retainUntil", NEW."legalHold",
          NEW."quarantineReason", NEW."availableAt", NEW."deletedAt")
         IS DISTINCT FROM
         (OLD."status", OLD."visibility", OLD."floorSiteId", OLD."partyId", OLD."retainUntil", OLD."legalHold",
          OLD."quarantineReason", OLD."availableAt", OLD."deletedAt") THEN
    RAISE EXCEPTION 'files: file % is deleted; it changes no more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status"
     AND NOT ((OLD."status" = 'PENDING_UPLOAD' AND NEW."status" IN ('AVAILABLE', 'QUARANTINED', 'DELETED'))
              OR (OLD."status" IN ('AVAILABLE', 'QUARANTINED') AND NEW."status" = 'DELETED')) THEN
    RAISE EXCEPTION 'files: file % cannot move from % to %', OLD."id", OLD."status", NEW."status"
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
  RETURN NEW;
END
$$;

CREATE TRIGGER "StoredFile_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StoredFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_stored_file_guard"();
CREATE TRIGGER "StoredFile_no_truncate" BEFORE TRUNCATE ON "StoredFile"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_stored_file_guard"();
