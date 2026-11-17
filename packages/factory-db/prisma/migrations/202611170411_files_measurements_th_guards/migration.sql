-- Written by hand (Prisma does not model triggers), after the generated 202611170410_files_measurements_th_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Measurement sheets and design files, TH-7 (threads plan, schema wave 6/9, B-TH-082; gaps N11, G12; open point 3 of the tree,
-- decided by the lead: AI, EPS, PSD and ZIP download-only, never SVG). apps/factory-api's platform/files checks all of this
-- first and answers in words (B-TH-083 the sheet's tick and its permission sales.measurements.view, each opening recorded;
-- B-TH-084 the accepted types); these rules are the last word, for every login, the owner included. The data change only:
-- customer uploads stay closed on staging and production until the virus scanner runs (B-TH-086, the Owner's spend).
--
--   StoredFile    a MEASUREMENTS file (a customer's measurement sheet: body data) is a document, an attachment or a photo of
--                 one, never shared with a floor (the floor holds no sales.measurements.view); shared with a portal or a link
--                 only with its record's own party, as every file (…_files_record_party_th_guards, WALL-G02), so a customer
--                 never reads another customer's sheet (W01, W25). A design file (Illustrator, EPS or PostScript, Photoshop,
--                 ZIP) is download-only: an attachment or a document, never a PHOTO, and never given a thumbnail (nothing of
--                 it is previewed). No file is of a type a browser runs or renders as a page (HTML, XHTML, SVG, JavaScript):
--                 the files platform has never accepted one (rules.ts), and the database now refuses it for every path. The
--                 type is compared as the files platform does: lower case, without its parameters.
--
-- Who may open a measurement sheet (sales.measurements.view: the production manager holds it on purpose, research §7.4), and
-- that a sheet's tag is taken off only by such a person, are the API's (B-TH-083): a permission is no database role.
--
-- As every TH guard: a refusal is a check_violation (SQLSTATE 23514) in words, which name no party (neutral toward customers);
-- the check is an AFTER trigger (the policies speak first). Files stored before this rule are left as they are: a NOTICE counts
-- any that would break it (none in the seed). No earlier function is redefined.

-- The type as the files platform compares it: lower case, without parameters (`Image/PNG; x=y` → `image/png`).
CREATE FUNCTION "factory_files_type_of"(content_type text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(split_part(coalesce(content_type, ''), ';', 1)))
$$;

-- A design file's types: Illustrator, EPS and PostScript, Photoshop, ZIP (with the aliases browsers and tools announce).
CREATE FUNCTION "factory_files_is_design_type"(content_type text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT "factory_files_type_of"(content_type) IN (
    'application/postscript', 'application/eps', 'application/x-eps', 'image/eps', 'image/x-eps',
    'application/illustrator', 'application/vnd.adobe.illustrator',
    'image/vnd.adobe.photoshop', 'application/vnd.adobe.photoshop', 'application/photoshop', 'application/x-photoshop',
    'image/photoshop', 'image/x-photoshop', 'image/psd',
    'application/zip', 'application/x-zip-compressed', 'application/x-zip')
$$;

-- A type a browser runs or renders as a page.
CREATE FUNCTION "factory_files_is_page_type"(content_type text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT "factory_files_type_of"(content_type) IN (
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'text/javascript',
    'application/x-javascript', 'application/ecmascript', 'text/ecmascript')
$$;

-- What a file breaks of this wave's rules, in words, or NULL.
CREATE FUNCTION "factory_stored_file_th_kinds_problem"(kind text, content_type text, category text, visibility text[], thumbnail text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN "factory_files_is_page_type"(content_type)
      THEN 'is of a type a browser runs or renders as a page (HTML, SVG, scripts): never stored'
    WHEN "factory_files_is_design_type"(content_type) AND kind NOT IN ('ATTACHMENT', 'DOCUMENT')
      THEN 'is a design file (Illustrator, EPS, Photoshop, ZIP): download-only, an attachment or a document, never a ' || kind
    WHEN "factory_files_is_design_type"(content_type) AND thumbnail IS NOT NULL
      THEN 'is a design file (Illustrator, EPS, Photoshop, ZIP): download-only, never previewed (no thumbnail)'
    WHEN category = 'MEASUREMENTS' AND kind NOT IN ('ATTACHMENT', 'DOCUMENT', 'PHOTO')
      THEN 'is a measurement sheet: a document, an attachment or a photo of one, not a ' || kind
    WHEN category = 'MEASUREMENTS' AND 'FLOOR' = ANY (visibility)
      THEN 'is a measurement sheet (body data): never shared with a floor'
  END
$$;

CREATE FUNCTION "factory_stored_file_th_kinds_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem text := "factory_stored_file_th_kinds_problem"(NEW."kind"::text, NEW."contentType", NEW."category"::text, NEW."visibility"::text[], NEW."thumbnailKey");
BEGIN
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'files: file % %', NEW."id", problem
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER "StoredFile_th_kinds_check" AFTER INSERT ON "StoredFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_stored_file_th_kinds_check"();
CREATE TRIGGER "StoredFile_th_kinds_change" AFTER UPDATE OF "category", "visibility", "thumbnailKey", "kind", "contentType" ON "StoredFile"
  FOR EACH ROW EXECUTE FUNCTION "factory_stored_file_th_kinds_check"();

-- The files stored before this rule: counted, never changed.
DO $$
DECLARE
  breaking integer;
BEGIN
  SELECT count(*) INTO breaking FROM "StoredFile" f
   WHERE "factory_stored_file_th_kinds_problem"(f."kind"::text, f."contentType", f."category"::text, f."visibility"::text[], f."thumbnailKey") IS NOT NULL;
  IF breaking > 0 THEN
    RAISE NOTICE 'files: % file(s) stored before this rule are a page type, a previewed design file or a floor-shared measurement sheet; left as they are for the office to review', breaking;
  END IF;
END
$$;
