-- Written by hand (Prisma does not model triggers), after the generated 202611011802_mtm_office_w2b_schema and before
-- the policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The made-to-measure office, W2b-5 schema wave 44/44 (B-W2b-297; SAL-054, SAL-291, SAL-292, SAL-297, SAL-303, PRD-017).
-- Built switched OFF (GATE-MTM, Owner answer Q1 of 11-10): no style is made to measure until a person flags it, and no
-- template's rules run until a person switches them on. apps/factory-api's modules/sales/mtm (B-W2b-358) and
-- modules/sales/fittings (B-W2b-360) check all of this first and answer in words; these rules are the last word, for every
-- login, the owner included.
--
--   MeasurementProfile   REDEFINED `factory_measurement_profile_portal_guard` (…_portal_sales_w2b_guards, word for word) with
--                        the factory review among the columns that move. Its own trigger MeasurementProfile_review_check:
--                        a revision starts WAITING, unreviewed (also one a rider sends by link); WAITING → CONFIRMED |
--                        NEED_MORE, NEED_MORE → NEED_MORE (asked again) | CONFIRMED; CONFIRMED is final and never goes back
--                        (a change is a new revision); reviewed exactly with who and when, not in the future, not before the
--                        rider was measured nor before a link send; the words (1 to 2000) only once reviewed, required to ask
--                        for more; nobody confirms measures they took themselves (Owner answer Q3); who measured is an office
--                        person (never on a link send) and where 1 to 200 characters of one line, both given at insert and
--                        never changed (the portal guard).
--   Appointment          inserted BOOKED; BOOKED → DONE | MISSED | CANCELLED, which are final but for the notes and, once,
--                        the profile revision a DONE one led to; the company, customer, kind and creation never change; it
--                        ends after it starts and at most 24 hours later; where (1 to 200, one line), the rider's name and an
--                        outside person's name (1 to 200, one line), the notes (1 to 4000), why it was cancelled (1 to 500,
--                        exactly when CANCELLED); closed exactly when it leaves BOOKED (who optional: the system), DONE or
--                        MISSED only once it started; a DONE one says who was there; a FITTING names its profile revision;
--                        the person of ours an office person; the rider's contact the profile's when both name one; the
--                        closing, the invite and the reminder not in the future. Never deleted.
--   FittingResult        of a FITTING appointment (not cancelled or missed), of a MADE_TO_MEASURE order line (made to the
--                        result's profile revision) or both, of their company; fitted not in the future, not before the
--                        profile was measured; the point changes (points of the profile's measurements, in their unit, a
--                        signed decimal not zero, a note of one line, at most 60); OK with none and nothing opened, ALTER with
--                        a point or the words, REMAKE with the words (1 to 4000); the alteration's days (1 to 365) and the
--                        alteration (a RepairOrder of kind ALTERATION of the result's company; one result per alteration)
--                        only for ALTER, the new revision (the same rider and garment type, a later revision) for ALTER or
--                        REMAKE, each named once; everything else written once. Never deleted.
--   QuoteLine,           (own triggers; the line guards untouched) PRD-017 in the database (B-W2b-248): a MADE_TO_MEASURE
--   SalesOrderLine       line names a style flagged made-to-measure (Style.mtmAllowed), checked when the line is written or
--                        its kind or style changes (a style switched off later leaves its old lines alone).
--   GeneratedDocument    REDEFINED `factory_generated_document_check` (…_sales_orders_depth_w2b_guards' body, word for word)
--                        with one more kind: MTM_WORKSHEET of a MeasurementProfile, of any company of the tenant (a profile
--                        has none), no site.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks of the new tables are AFTER
-- triggers (the policies speak first), the refused deletes BEFORE (the office has no DELETE grant on these tables anyway, so
-- they speak to the owner); the redefined functions keep their triggers. The tenant of a row is left to the policies and the
-- references, never compared here: a rule that reads another row skips a row this session cannot see. An UPDATE that changes
-- nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a BOOKED fitting, an OK
-- fitting result that opened nothing; the first MeasurementProfile row, a link send, stays WAITING).
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok" and "factory_recall_not_future" (…_recall_claims_w2b_guards).

CREATE FUNCTION "factory_mtm_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_mtm_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sales: % % is kept, never deleted (cancel an appointment; a fitting result stays)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['Appointment', 'FittingResult'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "factory_mtm_refuse_truncate"()', name || '_no_truncate', name);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "factory_mtm_never_deleted"()', name || '_never_deleted', name);
  END LOOP;
END
$$;

-- What is wrong with a fitting's point changes, or NULL: an object of point codes, each { "change", "unit", "note"? }: the
-- change a signed decimal string (up to 4 digits and 2 decimals, not zero), the unit cm or mm, the note 1 to 500 characters of
-- one line; at most 60 points. With the profile's measurements (`measured`, { "<code>": { "value", "unit" } }), each point is
-- one of them and keeps its unit.
CREATE FUNCTION "factory_mtm_point_changes_problem"(changes jsonb, measured jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  points integer := 0;
  change text;
  unit text;
BEGIN
  IF changes IS NULL OR jsonb_typeof(changes) <> 'object' THEN
    RETURN 'the point changes are an object keyed by point code';
  END IF;
  FOR entry IN SELECT key, value FROM jsonb_each(changes) LOOP
    points := points + 1;
    IF entry.key !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$' THEN
      RETURN format('"%s" is not a point code', left(entry.key, 60));
    END IF;
    IF jsonb_typeof(entry.value) <> 'object' OR (entry.value - ARRAY['change', 'unit', 'note']) <> '{}'::jsonb
       OR jsonb_typeof(entry.value -> 'change') IS DISTINCT FROM 'string' OR jsonb_typeof(entry.value -> 'unit') IS DISTINCT FROM 'string'
       OR (entry.value ? 'note' AND jsonb_typeof(entry.value -> 'note') <> 'string') THEN
      RETURN format('point %s has its change and its unit as text, and a note when given: nothing else', entry.key);
    END IF;
    change := entry.value ->> 'change';
    unit := entry.value ->> 'unit';
    IF (CASE WHEN change ~ '^[+-]?[0-9]{1,4}(\.[0-9]{1,2})?$' THEN change::numeric = 0 ELSE true END) THEN
      RETURN format('the change of point %s is a signed decimal, not zero, of up to 4 digits and 2 decimals ("+2.0", "-1.5")', entry.key);
    END IF;
    IF unit NOT IN ('cm', 'mm') THEN
      RETURN format('the change of point %s is in cm or mm', entry.key);
    END IF;
    IF NOT "factory_recall_words_ok"(entry.value ->> 'note', 500, false) THEN
      RETURN format('the note of point %s is 1 to 500 characters of one line', entry.key);
    END IF;
    IF measured IS NOT NULL AND NOT (measured ? entry.key) THEN
      RETURN format('point %s is not one of the profile''s measures', entry.key);
    END IF;
    IF measured IS NOT NULL AND lower(coalesce(measured -> entry.key ->> 'unit', unit)) <> unit THEN
      RETURN format('the change of point %s is in the unit it was measured in (%s)', entry.key, measured -> entry.key ->> 'unit');
    END IF;
  END LOOP;
  IF points > 60 THEN
    RETURN 'a fitting asks changes to at most 60 points';
  END IF;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- MeasurementProfile (parties.prisma), 1 of 2: (W2b wave 21/22, 202610319303_portal_sales_w2b_guards, whole) + W2b-5: the
-- factory review's four columns move too (the review check below holds how).
CREATE OR REPLACE FUNCTION "factory_measurement_profile_portal_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  partner CONSTANT boolean := current_user = 'factory_partner_runtime';
  kept CONSTANT text[] := ARRAY['tenantId'];
  moves CONSTANT text[] := ARRAY['photosDeleteAfter', 'reviewStatus', 'reviewedById', 'reviewedAt', 'reviewNote'];
  photos uuid[];
  link_purpose text;
  link_company uuid;
  link_made timestamptz;
  link_expires timestamptz;
  link_revoked timestamptz;
  notice_kind text;
  notice_company uuid;
  notice_published timestamptz;
  notice_superseded timestamptz;
  bad_photos int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - (kept || moves)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || moves)) THEN
      RAISE EXCEPTION 'parties: measurement profile % is never edited in place (a change is a new revision); only when its photos are deleted and its factory review move', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."photosDeleteAfter" IS NOT NULL AND NEW."photosDeleteAfter" IS NULL THEN
      RAISE EXCEPTION 'parties: when the photos of measurement profile % are deleted is set; it is moved, never cleared', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."submittedViaLinkId" IS NULL) <> (NEW."submittedAt" IS NULL)
     OR (NEW."submittedViaLinkId" IS NOT NULL AND NEW."noticeVersionId" IS NULL)
     OR NEW."privacyNoticeAt" > NEW."submittedAt" THEN
    RAISE EXCEPTION 'parties: measurement profile % sent by link names the link, when it was sent and the notice shown (no later than the send)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  photos := array_remove(ARRAY[NEW."photoFrontFileId", NEW."photoSideFileId", NEW."photoBackFileId"], NULL);
  IF cardinality(photos) <> (SELECT count(DISTINCT photo) FROM unnest(photos) AS photo) THEN
    RAISE EXCEPTION 'parties: the front, side and back photos of measurement profile % are three different files', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."photosDeleteAfter" IS NOT NULL AND (cardinality(photos) = 0 OR NEW."photosDeleteAfter" < NEW."createdAt") THEN
    RAISE EXCEPTION 'parties: measurement profile % has a photo deletion date only with a photo, after it was written', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF partner AND (NEW."submittedViaLinkId" IS NULL OR NEW."photosDeleteAfter" IS NOT NULL) THEN
      RAISE EXCEPTION 'parties: a link session adds only the revision the rider sent through its MEASUREMENTS link, without a photo deletion date (the office sets it)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."submittedViaLinkId" IS NOT NULL THEN
      SELECT l."purpose"::text, l."companyId", l."createdAt", l."expiresAt", l."revokedAt"
        INTO link_purpose, link_company, link_made, link_expires, link_revoked
        FROM "OneOffLink" l WHERE l."tenantId" = NEW."tenantId" AND l."partyId" = NEW."partyId" AND l."id" = NEW."submittedViaLinkId";
      IF FOUND AND (link_purpose <> 'MEASUREMENTS' OR NEW."submittedAt" < link_made OR NEW."submittedAt" > link_expires OR link_revoked <= NEW."submittedAt") THEN
        RAISE EXCEPTION 'parties: measurement profile % is sent through a MEASUREMENTS link of its party, while the link opened', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND partner AND (link_revoked IS NOT NULL OR now() >= link_expires) THEN
        RAISE EXCEPTION 'parties: the MEASUREMENTS link of measurement profile % no longer opens', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."noticeVersionId" IS NOT NULL AND has_table_privilege('"PrivacyNotice"', 'SELECT') THEN
      SELECT n."kind"::text, n."companyId", n."publishedAt", n."supersededAt" INTO notice_kind, notice_company, notice_published, notice_superseded
        FROM "PrivacyNotice" n WHERE n."tenantId" = NEW."tenantId" AND n."id" = NEW."noticeVersionId";
      IF FOUND AND (notice_kind NOT IN ('PRIVACY_PUBLIC', 'PORTAL_TERMS') OR notice_published IS NULL OR notice_published > NEW."privacyNoticeAt"
                    OR notice_superseded <= NEW."privacyNoticeAt" OR notice_company <> link_company) THEN
        RAISE EXCEPTION 'parties: the notice shown for measurement profile % is a notice for people outside the company (PRIVACY_PUBLIC or PORTAL_TERMS) of the link''s company, in force when it was shown', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF cardinality(photos) > 0 THEN
      SELECT count(*) INTO bad_photos FROM "StoredFile" f
       WHERE f."tenantId" = NEW."tenantId" AND f."id" = ANY (photos)
         AND (f."kind" <> 'PHOTO' OR f."category" IS DISTINCT FROM 'BODY_PHOTO' OR f."status" <> 'AVAILABLE' OR f."partyId" <> NEW."partyId");
      IF bad_photos > 0 THEN
        RAISE EXCEPTION 'parties: the photos of measurement profile % are AVAILABLE PHOTO files of category BODY_PHOTO, not another party''s', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- MeasurementProfile, 2 of 2: the factory review (SAL-292) and who measured and where (SAL-291), a trigger of its own.
CREATE FUNCTION "factory_measurement_profile_review_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  measurer_audience text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."reviewStatus" <> 'WAITING' OR NEW."reviewedAt" IS NOT NULL OR NEW."reviewedById" IS NOT NULL OR NEW."reviewNote" IS NOT NULL THEN
      RAISE EXCEPTION 'parties: measurement profile % starts WAITING for the factory review, not reviewed', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."measuredByUserId" IS NOT NULL THEN
      IF NEW."submittedViaLinkId" IS NOT NULL THEN
        RAISE EXCEPTION 'parties: measurement profile % was sent by link: no office person of ours measured it (the rider''s helper is in takenBy)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT u."audience"::text INTO measurer_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."measuredByUserId";
      IF FOUND AND measurer_audience <> 'OFFICE' THEN
        RAISE EXCEPTION 'parties: who measured profile % is an office person of ours (a partner''s fitter is named in takenBy)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."reviewStatus", NEW."reviewedById", NEW."reviewedAt", NEW."reviewNote")
       IS DISTINCT FROM (OLD."reviewStatus", OLD."reviewedById", OLD."reviewedAt", OLD."reviewNote") THEN
      IF OLD."reviewStatus" = 'CONFIRMED' THEN
        RAISE EXCEPTION 'parties: measurement profile % is CONFIRMED: its review never changes (a change is a new revision)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."reviewStatus" = 'WAITING' AND OLD."reviewStatus" <> 'WAITING' THEN
        RAISE EXCEPTION 'parties: the review of measurement profile % never goes back to WAITING (the rider''s answer is a new revision)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD."reviewedAt" IS NOT NULL AND NEW."reviewedAt" < OLD."reviewedAt" THEN
        RAISE EXCEPTION 'parties: measurement profile % is reviewed again no earlier than its last review', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF (NEW."reviewStatus" = 'WAITING') <> (NEW."reviewedAt" IS NULL) OR (NEW."reviewedAt" IS NULL) <> (NEW."reviewedById" IS NULL) THEN
    RAISE EXCEPTION 'parties: measurement profile % is reviewed (CONFIRMED or NEED_MORE) exactly with who reviewed it and when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."reviewNote", 2000, true)
     OR (NEW."reviewStatus" = 'WAITING' AND NEW."reviewNote" IS NOT NULL)
     OR (NEW."reviewStatus" = 'NEED_MORE' AND NEW."reviewNote" IS NULL) THEN
    RAISE EXCEPTION 'parties: the review words of measurement profile % (1 to 2000 characters) come with the review, and say what more is needed to ask for more', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."reviewedAt") OR NEW."reviewedAt" < NEW."takenAt" OR NEW."reviewedAt" < NEW."submittedAt" THEN
    RAISE EXCEPTION 'parties: measurement profile % is reviewed at a time not in the future, after the rider was measured and the revision sent', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reviewStatus" = 'CONFIRMED' AND NEW."reviewedById" = NEW."measuredByUserId" THEN
    RAISE EXCEPTION 'parties: measurement profile % was measured by the person confirming it: someone else confirms it (nobody confirms their own measures)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."measuredPlace", 200, false) THEN
    RAISE EXCEPTION 'parties: where measurement profile % was measured is 1 to 200 characters of one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "MeasurementProfile_review_check" AFTER INSERT OR UPDATE ON "MeasurementProfile"
  FOR EACH ROW EXECUTE FUNCTION "factory_measurement_profile_review_check"();

-- =====================================================================================================================
-- Appointment (mtm-office.prisma; SAL-054)
CREATE FUNCTION "factory_appointment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  final_kept CONSTANT text[] := ARRAY['tenantId', 'notes', 'measurementProfileId', 'version', 'updatedAt', 'updatedById'];
  with_audience text;
  profile_contact uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'BOOKED' OR NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."cancelReason" IS NOT NULL THEN
      RAISE EXCEPTION 'sales: appointment % is booked first (BOOKED, not closed)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."partyId", NEW."kind", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."partyId", OLD."kind", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the company, customer, kind and creation of appointment % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" <> 'BOOKED' THEN
      IF (to_jsonb(NEW) - final_kept) IS DISTINCT FROM (to_jsonb(OLD) - final_kept) THEN
        RAISE EXCEPTION 'sales: appointment % is %: only its notes change (book a new one)', OLD."id", OLD."status"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."measurementProfileId" IS DISTINCT FROM OLD."measurementProfileId" AND (OLD."measurementProfileId" IS NOT NULL OR OLD."status" <> 'DONE') THEN
        RAISE EXCEPTION 'sales: appointment % is %: a DONE one names the profile revision it led to once, nothing else', OLD."id", OLD."status"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW."endsAt" <= NEW."startsAt" OR NEW."endsAt" > NEW."startsAt" + interval '24 hours' THEN
    RAISE EXCEPTION 'sales: appointment % ends after it starts, at most 24 hours later', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."place" IS NULL OR NOT "factory_recall_words_ok"(NEW."place", 200, false) OR NOT "factory_recall_words_ok"(NEW."riderName", 200, false)
     OR NOT "factory_recall_words_ok"(NEW."withName", 200, false) THEN
    RAISE EXCEPTION 'sales: where appointment % is, the rider''s name and the name of who it is with are 1 to 200 characters of one line', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."notes", 4000, true) OR NOT "factory_recall_words_ok"(NEW."cancelReason", 500, true)
     OR (NEW."status" = 'CANCELLED') <> (NEW."cancelReason" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: appointment % has notes of 1 to 4000 characters, and why it was cancelled (1 to 500) exactly when CANCELLED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" <> 'BOOKED') <> (NEW."closedAt" IS NOT NULL) OR (NEW."closedById" IS NOT NULL AND NEW."closedAt" IS NULL) THEN
    RAISE EXCEPTION 'sales: appointment % is closed (DONE, MISSED, CANCELLED) exactly with when', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IN ('DONE', 'MISSED') AND NEW."closedAt" < NEW."startsAt" THEN
    RAISE EXCEPTION 'sales: appointment % is % only once it started', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ("factory_recall_not_future"(NEW."closedAt") AND "factory_recall_not_future"(NEW."inviteSentAt") AND "factory_recall_not_future"(NEW."reminderSentAt")) THEN
    RAISE EXCEPTION 'sales: appointment % is closed and its invite and reminder sent at times not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'DONE' AND NEW."withUserId" IS NULL AND NEW."withName" IS NULL THEN
    RAISE EXCEPTION 'sales: appointment % is DONE: it says who was there (a person of ours or a name)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind" = 'FITTING' AND NEW."measurementProfileId" IS NULL THEN
    RAISE EXCEPTION 'sales: fitting % is of a rider''s measurement profile revision', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."withUserId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."withUserId" IS DISTINCT FROM OLD."withUserId") THEN
    SELECT u."audience"::text INTO with_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."withUserId";
    IF FOUND AND with_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'sales: the person of ours at appointment % is an office person (someone outside is named by withName)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."contactId" IS NOT NULL AND NEW."measurementProfileId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."contactId" IS DISTINCT FROM OLD."contactId" OR NEW."measurementProfileId" IS DISTINCT FROM OLD."measurementProfileId") THEN
    SELECT p."contactId" INTO profile_contact FROM "MeasurementProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."measurementProfileId";
    IF FOUND AND profile_contact IS NOT NULL AND profile_contact <> NEW."contactId" THEN
      RAISE EXCEPTION 'sales: appointment % is with the rider of its measurement profile (contact %)', NEW."id", profile_contact
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Appointment_guard" AFTER INSERT OR UPDATE ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION "factory_appointment_guard"();

-- =====================================================================================================================
-- FittingResult (mtm-office.prisma; SAL-297)
CREATE FUNCTION "factory_fitting_result_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'alterationRepairId', 'newProfileId', 'version', 'updatedAt'];
  problem text;
  fitted_taken timestamptz;
  fitted_measures jsonb;
  fitted_rider text;
  fitted_type text;
  fitted_revision int;
  appointment_kind text;
  appointment_status text;
  appointment_company uuid;
  line_kind text;
  line_company uuid;
  line_profile uuid;
  repair_kind text;
  repair_company uuid;
  newer_rider text;
  newer_type text;
  newer_revision int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (to_jsonb(NEW) - kept) IS DISTINCT FROM (to_jsonb(OLD) - kept) THEN
      RAISE EXCEPTION 'sales: fitting result % is written once; later only the alteration it opened and the new revision it led to are named', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (OLD."alterationRepairId" IS NOT NULL AND NEW."alterationRepairId" IS DISTINCT FROM OLD."alterationRepairId")
       OR (OLD."newProfileId" IS NOT NULL AND NEW."newProfileId" IS DISTINCT FROM OLD."newProfileId") THEN
      RAISE EXCEPTION 'sales: fitting result % names its alteration and its new revision once each, never another', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."appointmentId" IS NULL AND NEW."salesOrderLineId" IS NULL THEN
    RAISE EXCEPTION 'sales: fitting result % is of a fitting appointment, of a made-to-measure order line, or of both', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."notes", 4000, true) OR (NEW."verdict" = 'REMAKE' AND NEW."notes" IS NULL) THEN
    RAISE EXCEPTION 'sales: the words of fitting result % are 1 to 4000 characters, and a REMAKE says why the unit cannot be altered', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."verdict" = 'OK' AND (NEW."pointChanges" <> '{}'::jsonb OR NEW."alterationDays" IS NOT NULL OR NEW."alterationRepairId" IS NOT NULL OR NEW."newProfileId" IS NOT NULL) THEN
    RAISE EXCEPTION 'sales: fitting result % is OK: it asks no change and opens nothing', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."verdict" = 'ALTER' AND NEW."pointChanges" = '{}'::jsonb AND NEW."notes" IS NULL THEN
    RAISE EXCEPTION 'sales: fitting result % asks an alteration: it names the points to change or says what to change', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."verdict" <> 'ALTER' AND (NEW."alterationDays" IS NOT NULL OR NEW."alterationRepairId" IS NOT NULL))
     OR NEW."alterationDays" NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION 'sales: fitting result % has an alteration and its days (1 to 365) only when it asks an ALTER', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."fittedAt") THEN
    RAISE EXCEPTION 'sales: fitting result % is of a fitting that took place, not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT p."takenAt", p."measurements", p."riderName", p."garmentType", p."revision"
      INTO fitted_taken, fitted_measures, fitted_rider, fitted_type, fitted_revision
      FROM "MeasurementProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."measurementProfileId";
    IF FOUND AND NEW."fittedAt" < fitted_taken THEN
      RAISE EXCEPTION 'sales: fitting result % is of a fitting after the rider was measured (profile revision %)', NEW."id", fitted_revision
        USING ERRCODE = 'check_violation';
    END IF;
    problem := "factory_mtm_point_changes_problem"(NEW."pointChanges", fitted_measures);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION 'sales: fitting result %: %', NEW."id", problem
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."appointmentId" IS NOT NULL THEN
      SELECT a."kind"::text, a."status"::text, a."companyId" INTO appointment_kind, appointment_status, appointment_company
        FROM "Appointment" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."appointmentId";
      IF FOUND AND (appointment_kind <> 'FITTING' OR appointment_status IN ('MISSED', 'CANCELLED') OR appointment_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'sales: fitting result % is of a FITTING appointment of its company that was not missed or cancelled', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."salesOrderLineId" IS NOT NULL THEN
      SELECT l."kind"::text, l."companyId", l."measurementProfileId" INTO line_kind, line_company, line_profile
        FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
      IF FOUND AND (line_kind <> 'MADE_TO_MEASURE' OR line_company <> NEW."companyId" OR line_profile IS DISTINCT FROM NEW."measurementProfileId") THEN
        RAISE EXCEPTION 'sales: fitting result % is of a MADE_TO_MEASURE order line of its company, made to the profile revision it fitted', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT p."riderName", p."garmentType", p."revision" INTO fitted_rider, fitted_type, fitted_revision
      FROM "MeasurementProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."measurementProfileId";
  END IF;

  IF NEW."alterationRepairId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."alterationRepairId" IS NULL) THEN
    SELECT r."kind"::text, r."companyId" INTO repair_kind, repair_company
      FROM "RepairOrder" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."alterationRepairId";
    IF FOUND AND (repair_kind <> 'ALTERATION' OR repair_company <> NEW."companyId") THEN
      RAISE EXCEPTION 'sales: fitting result % opens an ALTERATION repair order of its company and customer', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."newProfileId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."newProfileId" IS NULL) THEN
    IF NEW."verdict" = 'OK' OR NEW."newProfileId" = NEW."measurementProfileId" THEN
      RAISE EXCEPTION 'sales: fitting result % leads to a new revision only for an ALTER or a REMAKE, never the revision it fitted', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."riderName", p."garmentType", p."revision" INTO newer_rider, newer_type, newer_revision
      FROM "MeasurementProfile" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."newProfileId";
    IF FOUND AND fitted_revision IS NOT NULL AND ((newer_rider, newer_type) IS DISTINCT FROM (fitted_rider, fitted_type) OR newer_revision <= fitted_revision) THEN
      RAISE EXCEPTION 'sales: the new revision of fitting result % is a later revision of the same rider and garment type (after %)', NEW."id", fitted_revision
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "FittingResult_guard" AFTER INSERT OR UPDATE ON "FittingResult"
  FOR EACH ROW EXECUTE FUNCTION "factory_fitting_result_guard"();

-- =====================================================================================================================
-- QuoteLine and SalesOrderLine (sales.prisma): PRD-017 in the database (B-W2b-248's check is the API's): a made-to-measure
-- unit is of a style flagged made-to-measure. Own triggers; the W1-W2b line guards are untouched. Checked when the line is
-- written and when its kind or style changes, so a style switched off later leaves its old lines (and their other changes)
-- alone. A style this session cannot see is skipped.
CREATE FUNCTION "factory_mtm_line_style_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
  style_code text;
BEGIN
  IF NEW."kind" <> 'MADE_TO_MEASURE'
     OR (TG_OP = 'UPDATE' AND NEW."kind" IS NOT DISTINCT FROM OLD."kind" AND NEW."styleId" IS NOT DISTINCT FROM OLD."styleId") THEN
    RETURN NULL;
  END IF;
  SELECT s."mtmAllowed", s."code" INTO allowed, style_code FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  IF FOUND AND NOT allowed THEN
    RAISE EXCEPTION 'sales: % % is a made-to-measure unit of style %, which is not made to measure (a person flags the style first, PRD-017)', TG_TABLE_NAME, NEW."id", style_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "QuoteLine_mtm_style" AFTER INSERT OR UPDATE OF "kind", "styleId" ON "QuoteLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_mtm_line_style_check"();
CREATE TRIGGER "SalesOrderLine_mtm_style" AFTER INSERT OR UPDATE OF "kind", "styleId" ON "SalesOrderLine"
  FOR EACH ROW EXECUTE FUNCTION "factory_mtm_line_style_check"();

-- =====================================================================================================================
-- GeneratedDocument (gendocs.prisma): (W2b-5 wave 39/44, 202611011303_sales_orders_depth_w2b_guards, whole) + W2b-5 wave
-- 44/44: MTM_WORKSHEET of a MeasurementProfile (SAL-303), of any company of the tenant, no site.
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
          OR (NEW."kind" = 'MTM_WORKSHEET' AND NEW."recordType" = 'MeasurementProfile')) THEN
    RAISE EXCEPTION 'documents: generated document % is a % of a %; a packing list is a Shipment''s, a claim letter a SupplierClaim''s, a job sheet a SubcontractOrder''s or a MaintenanceJob''s, an RMA sheet a ReturnAuthorisation''s, a certificate of conformity a Shipment''s, an inspection report an Inspection''s or an IncomingInspection''s, an NCR report a Nonconformance''s, an 8D a Capa''s, an answer letter a Complaint''s, a check report a MachineCheckResult''s, a frozen risk assessment a RiskAssessmentVersion''s, a PPE receipt a PpeIssue''s, a compliance pack a Shipment''s, an evidence pack an EvidencePack''s, a tech pack a StyleRevision''s, a user information leaflet a ComplianceDocument''s, an order confirmation a SalesOrder''s, a made-to-measure worksheet a MeasurementProfile''s', NEW."id", NEW."kind", NEW."recordType"
      USING ERRCODE = 'check_violation';
  END IF;
  CASE NEW."recordType"
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
