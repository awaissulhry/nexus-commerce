-- Written by hand (Prisma does not model triggers), after 202611170311_threads_reads_th_guards and before the policy
-- migration; no schema folder of its own. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- A file is shared only with its record's own party, TH-2 (threads plan, follow-up WALL-G02 of TH-0 part A, B-TH-003; surface
-- W25). TH-0 part A made apps/factory-api's platform/files take a portal or link share's party from the record (the thread
-- resolver, platform/threads/records.ts) and refuse another; the files guard (…_files_guards) only says a file names a party
-- exactly when it is shared with a portal or a link. This guard holds the rest for every login and every path (a module's
-- own upload, a copy, a new version, a visibility change), the owner included:
--
--   StoredFile    a file that names a party (shared with a portal or a link), when it is written or its party changes, names
--                 its record's own party, wherever the record's table says whose it is: the record's "partyId" column, or
--                 the column the thread resolver reads for it (Party: the party itself; Style: brandPartyId; Invoice:
--                 buyerPartyId; Certificate: holderPartyId; Lot and GoodsReceipt: supplierId; Capa: customerId). A record of
--                 none (a prospect's request, our own style, an internal CAPA) shares with no party. A record type whose
--                 table names no party, a record this session cannot see, or a column it cannot read is left to the API
--                 (platform/files withRecordParty), as every guard skips what the session cannot see.
--
-- A record whose party changes later (a prospect's request matched to its customer) keeps the files shared before (none can
-- be shared while it has none); the record's own guards say when a party may change. Files written before this rule are left
-- as they are: a NOTICE counts any that name another party than their record's (none in the seed).
--
-- As every guard: a refusal is a check_violation (SQLSTATE 23514) in words, which name no party (an office message, neutral
-- toward customers); the check is an AFTER trigger (the policies speak first). No earlier function is redefined.

-- The party a record belongs to, as its table says: known = the record's table names a party and this session reads the row.
CREATE FUNCTION "factory_file_record_party"(tenant uuid, record_type text, record uuid, OUT known boolean, OUT party uuid)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  party_column text := CASE record_type
    WHEN 'Party' THEN 'id'
    WHEN 'Style' THEN 'brandPartyId'
    WHEN 'Invoice' THEN 'buyerPartyId'
    WHEN 'Certificate' THEN 'holderPartyId'
    WHEN 'Lot' THEN 'supplierId'
    WHEN 'GoodsReceipt' THEN 'supplierId'
    WHEN 'Capa' THEN 'customerId'
    ELSE 'partyId'
  END;
  record_table regclass;
  seen integer;
BEGIN
  known := false;
  party := NULL;
  IF record_type IS NULL OR record_type !~ '^[A-Z][A-Za-z0-9]{0,62}$' OR record IS NULL THEN
    RETURN;
  END IF;
  record_table := to_regclass(quote_ident(record_type));
  IF record_table IS NULL THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = record_table AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN (party_column, 'tenantId', 'id')) <> (CASE WHEN party_column = 'id' THEN 2 ELSE 3 END) THEN
    RETURN;
  END IF;
  IF NOT has_column_privilege(record_table, party_column, 'SELECT') OR NOT has_column_privilege(record_table, 'tenantId', 'SELECT')
     OR NOT has_column_privilege(record_table, 'id', 'SELECT') THEN
    RETURN;
  END IF;
  EXECUTE format('SELECT %I FROM %s WHERE "tenantId" = $1 AND "id" = $2', party_column, record_table) INTO party USING tenant, record;
  GET DIAGNOSTICS seen = ROW_COUNT;
  known := seen > 0;
END
$$;

-- StoredFile: a party named is its record's own.
CREATE FUNCTION "factory_stored_file_record_party_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  record_known boolean;
  record_party uuid;
BEGIN
  SELECT r.known, r.party INTO record_known, record_party FROM "factory_file_record_party"(NEW."tenantId", NEW."recordType", NEW."recordId") r;
  IF record_known AND record_party IS NULL THEN
    RAISE EXCEPTION 'files: file % belongs to a % that is no party''s; it is shared with no portal or link', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  IF record_known AND record_party IS DISTINCT FROM NEW."partyId" THEN
    RAISE EXCEPTION 'files: file % is shared only with the party its % belongs to, never with another', NEW."id", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "StoredFile_record_party" AFTER INSERT ON "StoredFile"
  FOR EACH ROW WHEN (NEW."partyId" IS NOT NULL)
  EXECUTE FUNCTION "factory_stored_file_record_party_check"();
CREATE TRIGGER "StoredFile_record_party_change" AFTER UPDATE OF "partyId" ON "StoredFile"
  FOR EACH ROW WHEN (NEW."partyId" IS NOT NULL AND NEW."partyId" IS DISTINCT FROM OLD."partyId")
  EXECUTE FUNCTION "factory_stored_file_record_party_check"();

-- The files written before this rule: counted, never changed.
DO $$
DECLARE
  mismatched integer;
BEGIN
  SELECT count(*) INTO mismatched
    FROM "StoredFile" f, LATERAL "factory_file_record_party"(f."tenantId", f."recordType", f."recordId") r
   WHERE f."partyId" IS NOT NULL AND r.known AND r.party IS DISTINCT FROM f."partyId";
  IF mismatched > 0 THEN
    RAISE NOTICE 'files: % file(s) written before this rule name a party other than their record''s; left as they are for the office to review', mismatched;
  END IF;
END
$$;
