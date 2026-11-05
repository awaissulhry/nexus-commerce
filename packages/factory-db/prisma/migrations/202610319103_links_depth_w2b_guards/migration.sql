-- Written by hand (Prisma does not model triggers), after the generated 202610319102_links_depth_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- W2b schema wave 19/22 (B-W2b-154): links in depth (features COL-051, COL-061, COL-062, COL-064, QHS-085, SAL-222,
-- SAL-294, MES-274; design 02 portal-links "Link pages"). Every link keeps W0's rules: one record, one party, an expiry,
-- a use limit, evidence per use. New: the password (its hash only) and its tries, the receipt, the contact and the
-- renewed link on OneOffLink; a link's set of files; a long form's draft kept with us, sealed; record shares; approval
-- requests with their answer; the customer's own answer to an NCR concession. No pay figure ever goes by link (Owner,
-- 11-02): no link, file set, share or approval names a record that holds pay figures.
--
-- apps/factory-api checks all of this first, in words; these rules hold for every login, the owner included. Row rules
-- are a check_violation, refused moves a restrict_violation (as …_links_guards). The guards of the new tables are AFTER
-- triggers, as the link's own: for the runtime roles the row-level-security policies speak first (a row moved to another
-- tenant or party fails their WITH CHECK), then the guard holds for every login. A rule that reads another row reads
-- only what the role that fires it may read (the partner role: its own party's links, files and requests), and skips a
-- row this session cannot see. An UPDATE that changes nothing passes.
--
-- Earlier functions redefined here, each its whole body:
--   factory_guard_link_change      (…_links_guards, W0; not redefined since): the new columns of OneOffLink, and no link
--                                  of a pay record.
--   factory_ncr_concession_guard   (…_quality_problems_w2b_guards, wave 11/16): the approval request it names, and the
--                                  customer's own answer (the partner role writes the answer columns only, after the
--                                  request's answer).

-- =====================================================================================================================
-- Pay figures never go by link (Owner, 11-02; plan B-W2b-163 "the link maker refuses any record or file that carries the
-- pay grain"). The record types of pay.prisma whose rows hold pay figures (`@grain pay` columns) or print them: the
-- piece rates and their published sheets and signed receipts, the incentive schemes, the pay periods, the earnings and
-- the workers' statements. PayrollExport is left out on purpose: B-W2b-54 sends its file by a link today, and whether an
-- hours-only payroll file may still go is the Owner's W2b-2 question 2; the API's link maker decides it per file
-- (B-W2b-163). src/links-depth-w2b.pg.vitest.test.ts keeps this list equal to the schema's pay models.
CREATE FUNCTION "factory_link_pay_record"(record_type text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT record_type = ANY (ARRAY['PieceRateTable', 'PieceRateVersion', 'PieceRateEntry', 'RatePublication', 'RateAcknowledgement',
                                  'IncentiveScheme', 'PayPeriod', 'EarningsEntry', 'WorkerStatement'])
$$;

CREATE FUNCTION "factory_links_depth_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'links: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['LinkFile', 'LinkDraft', 'RecordShare', 'ApprovalRequest'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_links_depth_refuse_truncate"()', name || '_no_truncate', name);
  END LOOP;
END
$$;

-- =====================================================================================================================
-- OneOffLink (links.prisma), redefined whole from …_links_guards (W0). Kept: one purpose, one record, one party, one
-- token, one expiry, one use limit; uses up one at a time to the limit, never on a revoked link; the revocation final;
-- never deleted. New:
--   INSERT    no receipt and no wrong password yet; a password only on a DOCUMENT_VIEW or SECURE_FILE link, and only
--             as a scrypt hash in the PHC string format (never a plain password); never a record that holds pay figures;
--             a renewal renews another link of the same company, party (its reference), purpose and record.
--   UPDATE    the password, the contact and the renewed link are fixed with the rest. The receipt (receivedAt, its
--             name) is written once, on a SECURE_FILE link that is not revoked, never changed. The wrong passwords go up
--             one at a time to 5, or start again at 0 (a right password), or at 1 once a hold passed; the fifth holds the
--             link for up to 15 minutes from now (set exactly at 5; one minute of slack, as the column keeps milliseconds
--             and the API's clock may run a little ahead of the database's), and nothing moves them while it holds. Only
--             a link with a password counts them.
CREATE OR REPLACE FUNCTION "factory_guard_link_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  renewed_company uuid;
  renewed_purpose text;
  renewed_type text;
  renewed_record uuid;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'links: TRUNCATE on "%" is refused', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: link % is never deleted; revoke it', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."uses" <> 0 OR NEW."lastUsedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."revokedById" IS NOT NULL
       OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'links: a new link is unused, not revoked, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."maxUses" < 1 OR NEW."expiresAt" <= NEW."createdAt" THEN
      RAISE EXCEPTION 'links: a new link allows at least one use and expires after it was made'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."receivedAt" IS NOT NULL OR NEW."receivedName" IS NOT NULL OR NEW."passwordTries" <> 0 OR NEW."passwordHeldUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'links: a new link has no receipt and no wrong password yet'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."passwordHash" IS NOT NULL AND NEW."purpose"::text NOT IN ('DOCUMENT_VIEW', 'SECURE_FILE') THEN
      RAISE EXCEPTION 'links: only a DOCUMENT_VIEW or SECURE_FILE link takes a password (link %, %)', NEW."id", NEW."purpose"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."passwordHash" !~ '^[$]scrypt[$]ln=[0-9]{1,2},r=[0-9]{1,2},p=[0-9]{1,2}[$][A-Za-z0-9_-]{16,64}[$][A-Za-z0-9_-]{32,128}$' THEN
      RAISE EXCEPTION 'links: the password of link % is stored as its scrypt hash (PHC string format), never as typed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_link_pay_record"(NEW."recordType") THEN
      RAISE EXCEPTION 'links: a link never opens a % (it holds pay figures, which never go by link)', NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."renewalOfId" IS NOT NULL THEN
      IF NEW."renewalOfId" = NEW."id" THEN
        RAISE EXCEPTION 'links: link % cannot renew itself', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT l."companyId", l."purpose"::text, l."recordType", l."recordId" INTO renewed_company, renewed_purpose, renewed_type, renewed_record
        FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."renewalOfId";
      IF FOUND AND (renewed_company, renewed_purpose, renewed_type, renewed_record) IS DISTINCT FROM (NEW."companyId", NEW."purpose"::text, NEW."recordType", NEW."recordId") THEN
        RAISE EXCEPTION 'links: link % renews link %, which opens another record or serves another purpose', NEW."id", NEW."renewalOfId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF (NEW."id", NEW."tenantId", NEW."companyId", NEW."partyId", NEW."purpose", NEW."recordType", NEW."recordId",
      NEW."tokenHash", NEW."email", NEW."expiresAt", NEW."maxUses", NEW."createdAt", NEW."createdById",
      NEW."passwordHash", NEW."contactId", NEW."renewalOfId")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."companyId", OLD."partyId", OLD."purpose", OLD."recordType", OLD."recordId",
      OLD."tokenHash", OLD."email", OLD."expiresAt", OLD."maxUses", OLD."createdAt", OLD."createdById",
      OLD."passwordHash", OLD."contactId", OLD."renewalOfId") THEN
    RAISE EXCEPTION 'links: link % is fixed once made; only its uses, its revocation, its note, its wrong passwords and its receipt may change', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."uses" < OLD."uses" OR NEW."uses" > OLD."uses" + 1 OR NEW."uses" > NEW."maxUses" THEN
    RAISE EXCEPTION 'links: the uses of link % go up one at a time, to at most %', OLD."id", OLD."maxUses"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."uses" > OLD."uses" AND OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'links: link % is revoked; it is not used any more', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL
     AND (NEW."revokedAt", NEW."revokedById") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById") THEN
    RAISE EXCEPTION 'links: the revocation of link % is final', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."revokedAt" IS NULL AND NEW."revokedById" IS NOT NULL THEN
    RAISE EXCEPTION 'links: link % names who revoked it but is not revoked', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
    RAISE EXCEPTION 'links: the version of link % goes up by one', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- The receipt.
  IF (NEW."receivedAt", NEW."receivedName") IS DISTINCT FROM (OLD."receivedAt", OLD."receivedName") THEN
    IF OLD."receivedAt" IS NOT NULL OR OLD."receivedName" IS NOT NULL THEN
      RAISE EXCEPTION 'links: the receipt of link % is written once', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."purpose"::text <> 'SECURE_FILE' THEN
      RAISE EXCEPTION 'links: only a SECURE_FILE link takes the receipt "I received these files" (link %, %)', OLD."id", OLD."purpose"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'links: link % is revoked; it takes no receipt', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."receivedAt" IS NULL OR NEW."receivedAt" < NEW."createdAt"
       OR (NEW."receivedName" IS NOT NULL AND (btrim(NEW."receivedName") = '' OR length(NEW."receivedName") > 200)) THEN
      RAISE EXCEPTION 'links: the receipt of link % has its time (after the link was made) and, when given, a name of up to 200 characters', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The wrong passwords.
  IF (NEW."passwordTries", NEW."passwordHeldUntil") IS DISTINCT FROM (OLD."passwordTries", OLD."passwordHeldUntil") THEN
    IF NEW."passwordHash" IS NULL THEN
      RAISE EXCEPTION 'links: link % has no password; it counts no wrong password', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."passwordHeldUntil" IS NOT NULL AND now() < OLD."passwordHeldUntil" THEN
      RAISE EXCEPTION 'links: link % is held after five wrong passwords until %', OLD."id", OLD."passwordHeldUntil"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT (NEW."passwordTries" = OLD."passwordTries" + 1 OR NEW."passwordTries" = 0 OR (OLD."passwordTries" = 5 AND NEW."passwordTries" = 1))
       OR NEW."passwordTries" > 5 THEN
      RAISE EXCEPTION 'links: the wrong passwords of link % go up one at a time to 5, or start again', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW."passwordHeldUntil" IS NOT NULL) <> (NEW."passwordTries" = 5)
       OR (NEW."passwordHeldUntil" IS NOT NULL AND (NEW."passwordHeldUntil" <= now() OR NEW."passwordHeldUntil" > now() + interval '16 minutes')) THEN
      RAISE EXCEPTION 'links: the fifth wrong password holds link % for up to 15 minutes from now, and only the fifth', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- LinkFile (links-depth.prisma; COL-051, MES-274)
--   INSERT     position 1 or more; the link is a DOCUMENT_VIEW or SECURE_FILE link, unused and not revoked (its files are
--              added in the command that makes it); the file is AVAILABLE, of the link's company or tenant-wide, and never
--              a file of a pay record.
--   UPDATE     refused: a link's files never change. DELETE refused: its evidence names what it shared. TRUNCATE refused.
CREATE FUNCTION "factory_link_file_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  link_purpose text;
  link_company uuid;
  link_uses integer;
  link_revoked timestamptz;
  file_company uuid;
  file_status text;
  file_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: file % of link % is never removed (the link''s evidence names what it shared)', OLD."fileId", OLD."linkId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'links: the files of link % never change', OLD."linkId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."position" < 1 THEN
    RAISE EXCEPTION 'links: the files of link % are numbered from 1', NEW."linkId"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."purpose"::text, l."companyId", l."uses", l."revokedAt" INTO link_purpose, link_company, link_uses, link_revoked
    FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."linkId";
  IF FOUND THEN
    IF link_purpose NOT IN ('DOCUMENT_VIEW', 'SECURE_FILE') THEN
      RAISE EXCEPTION 'links: only a DOCUMENT_VIEW or SECURE_FILE link has a set of files (link %, %)', NEW."linkId", link_purpose
        USING ERRCODE = 'check_violation';
    END IF;
    IF link_uses > 0 OR link_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'links: link % is used or revoked; its files are fixed', NEW."linkId"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  SELECT f."companyId", f."status"::text, f."recordType" INTO file_company, file_status, file_type
    FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF FOUND THEN
    IF file_status <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'links: file % is %; a link shares an available file only', NEW."fileId", file_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF file_company IS NOT NULL AND link_company IS NOT NULL AND file_company <> link_company THEN
      RAISE EXCEPTION 'links: file % is another company''s; link % shares its own company''s files', NEW."fileId", NEW."linkId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_link_pay_record"(file_type) THEN
      RAISE EXCEPTION 'links: file % is a file of a % (pay figures never go by link)', NEW."fileId", file_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LinkFile_guard" AFTER INSERT OR UPDATE OR DELETE ON "LinkFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_link_file_guard"();

-- =====================================================================================================================
-- LinkDraft (links-depth.prisma; design links.frame "Finish later")
--   INSERT     at version 1.
--   UPDATE     its link, party, purge time and creation never change; the version goes up by one with every save.
--   every row  the data sealed (AES-256-GCM, `<key>.<iv>.<ciphertext>.<tag>` base64url, as sessions/secrets seal()
--              writes it), never plain, at most 256 KiB; its link is a long form's (MEASUREMENTS, CLAIM,
--              SUPPLIER_ONBOARD) and still opens: not revoked, before its expiry, uses left (a save is not a counted
--              use); purged exactly 7 days after the link expires.
--   DELETE     passes: the link session drops it when the form is sent, the purge job after purgeAfter. TRUNCATE refused.
CREATE FUNCTION "factory_link_draft_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  link_purpose text;
  link_expires timestamptz;
  link_uses integer;
  link_max integer;
  link_revoked timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."partyId", NEW."linkId", NEW."purgeAfter", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."partyId", OLD."linkId", OLD."purgeAfter", OLD."createdAt") THEN
      RAISE EXCEPTION 'links: draft % stays with its link; only its data is saved again', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION 'links: the version of draft % goes up by one with every save', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'links: a new draft is at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(NEW."dataEnc") > 262144
     OR NEW."dataEnc" !~ '^[a-z][a-z0-9]{0,7}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'links: draft % is sealed (AES-256-GCM: key, iv, ciphertext, tag), never plain, and at most 256 KiB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT l."purpose"::text, l."expiresAt", l."uses", l."maxUses", l."revokedAt" INTO link_purpose, link_expires, link_uses, link_max, link_revoked
    FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."linkId";
  IF FOUND THEN
    IF link_purpose NOT IN ('MEASUREMENTS', 'CLAIM', 'SUPPLIER_ONBOARD') THEN
      RAISE EXCEPTION 'links: only a long form keeps a draft (MEASUREMENTS, CLAIM, SUPPLIER_ONBOARD), not link % (%)', NEW."linkId", link_purpose
        USING ERRCODE = 'check_violation';
    END IF;
    IF link_revoked IS NOT NULL OR now() >= link_expires OR link_uses >= link_max THEN
      RAISE EXCEPTION 'links: link % no longer opens; its draft is not saved', NEW."linkId"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."purgeAfter" <> link_expires + interval '7 days' THEN
      RAISE EXCEPTION 'links: draft % is purged 7 days after its link expires (%)', NEW."id", link_expires + interval '7 days'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LinkDraft_guard" AFTER INSERT OR UPDATE ON "LinkDraft"
  FOR EACH ROW EXECUTE FUNCTION "factory_link_draft_guard"();

-- =====================================================================================================================
-- RecordShare (links-depth.prisma; COL-061, COL-062)
--   INSERT     live (not revoked) at version 1; never a record that holds pay figures.
--   UPDATE     the company, record, party, contact, address and creation never change; a revoked share never changes;
--              the revocation names its time with whoever revoked it; the link is set once; the version goes up by at
--              most one. A partner session (the invited party) changes notifyByEmail only.
--   every row  VIEW allowed, each permission once; the address trimmed, lower case, one @; it ends after it was made, at
--              most 180 days after; its link, when set, is a RECORD_INVITE link of the same company and record, not
--              revoked when set, and never outlives the share.
--   DELETE     refused (revoked instead). TRUNCATE refused.
CREATE FUNCTION "factory_record_share_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner_columns CONSTANT text[] := ARRAY['notifyByEmail', 'version', 'updatedAt'];
  link_purpose text;
  link_company uuid;
  link_type text;
  link_record uuid;
  link_expires timestamptz;
  link_revoked timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: share % is revoked, never deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."revokedAt" IS NOT NULL OR NEW."revokedById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'links: a new share is live, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_link_pay_record"(NEW."recordType") THEN
      RAISE EXCEPTION 'links: a % is never shared outside (it holds pay figures)', NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."partyId", NEW."contactId", NEW."email", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."partyId", OLD."contactId", OLD."email", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'links: the record, party, contact, address and creation of share % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'links: share % is revoked; it never changes again', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."linkId" IS NOT NULL AND NEW."linkId" IS DISTINCT FROM OLD."linkId" THEN
      RAISE EXCEPTION 'links: the link of share % is set once', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'links: the version of share % goes up by one', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (to_jsonb(NEW) - partner_columns) IS DISTINCT FROM (to_jsonb(OLD) - partner_columns) THEN
      RAISE EXCEPTION 'links: a partner session only switches the e-mail of new messages of its share (share %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."revokedAt" IS NULL AND NEW."revokedById" IS NOT NULL THEN
    RAISE EXCEPTION 'links: share % names who revoked it but is not revoked', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."permissions" IS NULL OR NOT ('VIEW' = ANY (NEW."permissions"))
     OR cardinality(NEW."permissions") <> (SELECT count(DISTINCT p) FROM unnest(NEW."permissions") AS p) THEN
    RAISE EXCEPTION 'links: share % allows VIEW, and COMMENT and UPLOAD at most once each', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."email" <> lower(btrim(NEW."email")) OR NEW."email" !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR length(NEW."email") > 254 THEN
    RAISE EXCEPTION 'links: the address of share % is one address, trimmed and lower case', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expiresAt" <= NEW."createdAt" OR NEW."expiresAt" > NEW."createdAt" + interval '180 days' THEN
    RAISE EXCEPTION 'links: share % ends after it was made, at most 180 days after', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."linkId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."linkId" IS NULL) THEN
    SELECT l."purpose"::text, l."companyId", l."recordType", l."recordId", l."expiresAt", l."revokedAt"
      INTO link_purpose, link_company, link_type, link_record, link_expires, link_revoked
      FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."linkId";
    IF FOUND THEN
      IF link_purpose <> 'RECORD_INVITE' OR (link_company, link_type, link_record) IS DISTINCT FROM (NEW."companyId", NEW."recordType", NEW."recordId") THEN
        RAISE EXCEPTION 'links: the link of share % is a RECORD_INVITE link of the shared record', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF link_revoked IS NOT NULL OR link_expires > NEW."expiresAt" THEN
        RAISE EXCEPTION 'links: the link of share % is not revoked and never outlives the share', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RecordShare_guard" AFTER INSERT OR UPDATE OR DELETE ON "RecordShare"
  FOR EACH ROW EXECUTE FUNCTION "factory_record_share_guard"();

-- =====================================================================================================================
-- ApprovalRequest (links-depth.prisma; COL-064, QHS-085, SAL-222, SAL-294, B-W2b-122's outside signatures)
--   INSERT     OPEN, nothing answered or withdrawn, at version 1; never a record that holds pay figures. A CONCESSION
--              request names an NCR's concession (record type NcrConcession) of the same customer, while it is ASKED.
--   UPDATE     the company, record, party, kind and asking never change; OPEN → APPROVED | APPROVED_WITH_CHANGES |
--              REFUSED (the answer) | WITHDRAWN | EXPIRED (only once its due time passed); all five are final and never
--              change; the version goes up by at most one. A partner session (the party asked) only answers: OPEN to an
--              answer, writing the answer columns and nothing else.
--   every row  the question in words (up to 4000 characters); due after it was made; answered (time, typed name, the
--              request that wrote it, exactly one of the portal user and the link) exactly when APPROVED,
--              APPROVED_WITH_CHANGES or REFUSED, with their words for a change or a refusal, and nothing of an answer
--              otherwise; withdrawn (its time) exactly when WITHDRAWN. At the answer: a link is an APPROVAL link of the
--              request or of its record, not revoked; the markup is a file of the request.
--   DELETE     refused. TRUNCATE refused.
CREATE FUNCTION "factory_approval_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId'];
  answer_columns CONSTANT text[] := ARRAY['status', 'answer', 'typedName', 'markupFileId', 'answeredAt', 'answeredByUserId',
                                          'answeredViaLinkId', 'answerRequestId', 'answerIpHash', 'answerUserAgent', 'version', 'updatedAt'];
  answered boolean;
  concession_party uuid;
  concession_status text;
  link_purpose text;
  link_type text;
  link_record uuid;
  link_revoked timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'links: approval request % is withdrawn, never deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' OR NEW."answeredAt" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'links: a new approval request is OPEN, unanswered, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF "factory_link_pay_record"(NEW."recordType") THEN
      RAISE EXCEPTION 'links: no approval is asked outside on a % (it holds pay figures)', NEW."recordType"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."kind" = 'CONCESSION' THEN
      IF NEW."recordType" <> 'NcrConcession' THEN
        RAISE EXCEPTION 'links: a CONCESSION request names an NCR''s concession (record type NcrConcession), not a %', NEW."recordType"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT c."partyId", c."status"::text INTO concession_party, concession_status
        FROM "NcrConcession" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."recordId";
      IF FOUND AND (concession_party <> NEW."partyId" OR concession_status <> 'ASKED') THEN
        RAISE EXCEPTION 'links: request % asks concession % of its own customer, while the concession is ASKED', NEW."id", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."recordType", NEW."recordId", NEW."partyId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."recordType", OLD."recordId", OLD."partyId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'links: the record, party, kind and asking of approval request % never change', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'OPEN' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'links: approval request % is %; it never changes again', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'links: the version of approval request % goes up by one', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'EXPIRED' AND OLD."status" = 'OPEN' AND now() < NEW."dueAt" THEN
      RAISE EXCEPTION 'links: approval request % is due at %; it expires only after that', OLD."id", NEW."dueAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF current_user = 'factory_partner_runtime'
       AND (NEW."status" NOT IN ('APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED')
            OR (to_jsonb(NEW) - (kept || answer_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer_columns))) THEN
      RAISE EXCEPTION 'links: a partner session only answers its OPEN approval request (request %)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW."question") = '' OR length(NEW."question") > 4000 THEN
    RAISE EXCEPTION 'links: approval request % asks its question in words, up to 4000 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueAt" <= NEW."createdAt" THEN
    RAISE EXCEPTION 'links: approval request % is due after it was made', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  answered := NEW."status" IN ('APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED');
  IF answered <> (NEW."answeredAt" IS NOT NULL)
     OR answered <> (btrim(coalesce(NEW."typedName", '')) <> '')
     OR answered <> (btrim(coalesce(NEW."answerRequestId", '')) <> '')
     OR answered <> ((NEW."answeredByUserId" IS NULL) <> (NEW."answeredViaLinkId" IS NULL))
     OR (NOT answered AND (NEW."answer" IS NOT NULL OR NEW."markupFileId" IS NOT NULL OR NEW."answerIpHash" IS NOT NULL OR NEW."answerUserAgent" IS NOT NULL))
     OR (NEW."status" IN ('APPROVED_WITH_CHANGES', 'REFUSED') AND btrim(coalesce(NEW."answer", '')) = '')
     OR (answered AND NEW."answeredAt" < NEW."createdAt")
     OR length(NEW."typedName") > 200 OR length(NEW."answer") > 4000 OR length(NEW."answerRequestId") > 200 OR length(NEW."answerUserAgent") > 512 THEN
    RAISE EXCEPTION 'links: approval request % is % with the wrong answer: time, typed name, request and one answerer exactly when answered, words for a change or a refusal, nothing of an answer otherwise', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL)
     OR (NEW."withdrawnAt" IS NULL AND (NEW."withdrawnById" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'links: approval request % is % with the wrong withdrawal: its time exactly when WITHDRAWN', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF answered AND (TG_OP = 'INSERT' OR OLD."status" = 'OPEN') THEN
    IF NEW."answeredViaLinkId" IS NOT NULL THEN
      SELECT l."purpose"::text, l."recordType", l."recordId", l."revokedAt" INTO link_purpose, link_type, link_record, link_revoked
        FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."answeredViaLinkId";
      IF FOUND AND (link_purpose <> 'APPROVAL' OR link_revoked IS NOT NULL
                    OR NOT ((link_type = 'ApprovalRequest' AND link_record = NEW."id") OR (link_type = NEW."recordType" AND link_record = NEW."recordId"))) THEN
        RAISE EXCEPTION 'links: approval request % is answered through an APPROVAL link of it or of its record, not revoked', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."markupFileId" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."markupFileId"
                    AND (f."recordType" <> 'ApprovalRequest' OR f."recordId" <> NEW."id")) THEN
      RAISE EXCEPTION 'links: the markup of approval request % is a file of the request (record type ApprovalRequest)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ApprovalRequest_guard" AFTER INSERT OR UPDATE OR DELETE ON "ApprovalRequest"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_request_guard"();

-- =====================================================================================================================
-- NcrConcession (ncr.prisma), redefined whole from …_quality_problems_w2b_guards (wave 11/16). Kept: ASKED at insert while
-- the NCR is open; the NCR, number, customer, asking and creation never change; ASKED → ACCEPTED | REFUSED, both final;
-- an answered concession never changes; the answer's shape; the answer's file a file of the row; never deleted. New:
--   INSERT     no approval request yet (the concession is asked first; its request names it; then it names the request).
--   UPDATE     the approval request is set once, while ASKED, and is a CONCESSION request naming this concession.
--              A partner session (the customer, through the portal or the APPROVAL link; the partner role reads and
--              updates its own party's rows) only answers a concession its approval request asks: ASKED to ACCEPTED or
--              REFUSED, changing status, answer, answeredAt and answeredBy and nothing else (so never recordedById: null,
--              the customer; never the file), and only as the request was answered first: APPROVED or
--              APPROVED_WITH_CHANGES → ACCEPTED, REFUSED → REFUSED. Its party key is left to the policies (a partner
--              moving a row to another party meets their WITH CHECK first).
CREATE OR REPLACE FUNCTION "factory_ncr_concession_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  answer_columns CONSTANT text[] := ARRAY['status', 'answer', 'answeredAt', 'answeredBy', 'version', 'updatedAt'];
  kept text[] := ARRAY['tenantId', 'siteId'];
  stage text;
  request_kind text;
  request_type text;
  request_record uuid;
  request_status text;
BEGIN
  IF partner THEN
    kept := ARRAY['tenantId', 'siteId', 'partyId'];
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality: concession % is answered, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ASKED' THEN
      RAISE EXCEPTION 'quality: concession % starts ASKED', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvalRequestId" IS NOT NULL THEN
      RAISE EXCEPTION 'quality: concession % is asked first; its approval request names it, then it names the request', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT n."stage"::text INTO stage FROM "Nonconformance" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."ncrId" FOR SHARE;
    IF stage IN ('CLOSED', 'CANCELLED') THEN
      RAISE EXCEPTION 'quality: NCR % is %; no concession is asked any more', NEW."ncrId", stage
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."ncrId", NEW."seq", NEW."askedAt", NEW."askedById", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."ncrId", OLD."seq", OLD."askedAt", OLD."askedById", OLD."createdAt", OLD."createdById")
       OR (NOT partner AND NEW."partyId" IS DISTINCT FROM OLD."partyId") THEN
      RAISE EXCEPTION 'quality: the NCR, number, customer, asking and creation of concession % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'ASKED' AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'quality: concession % is %; an answered concession never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvalRequestId" IS DISTINCT FROM OLD."approvalRequestId" THEN
      IF OLD."approvalRequestId" IS NOT NULL OR OLD."status" <> 'ASKED' THEN
        RAISE EXCEPTION 'quality: the approval request of concession % is set once, while it is ASKED', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."kind"::text, r."recordType", r."recordId" INTO request_kind, request_type, request_record
        FROM "ApprovalRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."approvalRequestId";
      IF FOUND AND (request_kind <> 'CONCESSION' OR request_type <> 'NcrConcession' OR request_record <> NEW."id") THEN
        RAISE EXCEPTION 'quality: the approval request of concession % is a CONCESSION request that names it', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF partner AND (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      IF OLD."approvalRequestId" IS NULL
         OR NOT (OLD."status" = 'ASKED' AND NEW."status" IN ('ACCEPTED', 'REFUSED'))
         OR (to_jsonb(NEW) - (kept || answer_columns)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || answer_columns)) THEN
        RAISE EXCEPTION 'quality: the customer answers concession % only when its approval request asks it: from ASKED to ACCEPTED or REFUSED, with its words, time and name', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT r."status"::text INTO request_status
        FROM "ApprovalRequest" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = OLD."approvalRequestId";
      IF NOT FOUND
         OR NOT ((NEW."status" = 'ACCEPTED' AND request_status IN ('APPROVED', 'APPROVED_WITH_CHANGES'))
                 OR (NEW."status" = 'REFUSED' AND request_status = 'REFUSED')) THEN
        RAISE EXCEPTION 'quality: concession % is answered as its approval request was (approved: ACCEPTED, refused: REFUSED); answer the request first', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF btrim(NEW."ask") = '' OR btrim(NEW."proposal") = '' THEN
    RAISE EXCEPTION 'quality: concession % says what is asked and what is proposed, in words', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT partner AND (TG_OP = 'INSERT' OR NEW."partyId" IS DISTINCT FROM OLD."partyId")
     AND EXISTS (SELECT 1 FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId"
                  AND NOT ('CUSTOMER' = ANY (p."roles") OR 'BRAND' = ANY (p."roles"))) THEN
    RAISE EXCEPTION 'quality: concession % is asked of a party that is no customer or brand', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'ASKED') <> (NEW."answeredAt" IS NULL)
     OR (NEW."status" = 'ASKED') <> (btrim(coalesce(NEW."answeredBy", '')) = '')
     OR (NEW."status" = 'ASKED' AND (NEW."answer" IS NOT NULL OR NEW."answerFileId" IS NOT NULL OR NEW."recordedById" IS NOT NULL))
     OR (NEW."status" = 'REFUSED' AND btrim(coalesce(NEW."answer", '')) = '') THEN
    RAISE EXCEPTION 'quality: concession % is % with the wrong answer: when and the name of who answered exactly once answered, why when refused, nothing while asked', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."answerFileId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "StoredFile" f
                  WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."answerFileId" AND (f."recordType" <> 'NcrConcession' OR f."recordId" <> NEW."id")) THEN
    RAISE EXCEPTION 'quality: the answer of concession % is a file of the concession (recordType NcrConcession)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
