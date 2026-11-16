-- Written by hand (Prisma does not model triggers or functions), after the generated
-- 202611152310_protected_safety_fatal_w2b_schema and before the policy migration. When the migrations are renumbered, keep
-- this file as it is under its new timestamp.

-- B-W2b-GF2 (Owner G505 A): a fatal or presumed fatal accident is an INAIL filing of its own, InailFiling type FATAL (DPR
-- 1124/1965 art. 53: the report within 24 hours of the accident, by any means that proves it was sent). It runs from the
-- accident, not from a medical certificate:
--
--   FATAL      no certificate (its reference and time stay empty); DUE, FILED or NOT_NEEDED, never WAITING_CERTIFICATE;
--              the deadline always set, and exactly 24 hours after the incident happened (Incident."occurredAt") when the
--              filing is added and whenever its deadline moves (the incident's time corrected: the API moves the deadline
--              of a filing still open in the same command; a FILED one keeps the deadline it was filed against).
--   the others as before: the deadline exactly 48 hours after the certificate was received.
--
-- REDEFINED, from its whole latest body (202610318801_protected_safety_w2b_guards; every rule and word kept, the 48-hour rule
-- now for the types that have a certificate, the FATAL branch added; the trigger "InailFiling_guard" stays):
--   factory_inail_filing_guard.
-- USED FROM EARLIER WAVES, as they are: "factory_quality_plant_in_scope" (…_quality_plant_w2a_guards),
-- "factory_protected_words_ok" (…_protected_safety_w2b_guards).

CREATE OR REPLACE FUNCTION "factory_inail_filing_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept CONSTANT text[] := ARRAY['tenantId', 'siteId'];
  movable CONSTANT text[] := ARRAY['expectedAbsenceDays', 'actualAbsenceDays', 'certificateReference', 'certificateReceivedAt', 'dueAt', 'status', 'filedAt', 'filedById',
                                   'protocolNumber', 'notNeededAt', 'notNeededById', 'version', 'updatedAt'];
  person record;
  happened timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is filed or not needed, never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF "factory_quality_plant_in_scope"(NEW."tenantId", NEW."siteId") IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF position(('inail:' || NEW."incidentPersonId"::text || ':' || NEW."type"::text) IN NEW."key") <> 1 THEN
    RAISE EXCEPTION 'incidents: INAIL filing % has the key inail:<its person>:<its type> (one of each type per person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW."expectedAbsenceDays" NOT BETWEEN 0 AND 3650, false) OR coalesce(NEW."actualAbsenceDays" NOT BETWEEN 0 AND 3650, false)
     OR NOT "factory_protected_words_ok"(NEW."certificateReference", 100) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % counts the absence in days, 0 to 3650, and the certificate''s reference in at most 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."type"::text = 'FATAL' THEN
    -- B-W2b-GF2: a fatal accident's report runs from the accident (24 hours), with no certificate.
    IF NEW."certificateReceivedAt" IS NOT NULL OR NEW."certificateReference" IS NOT NULL OR NEW."dueAt" IS NULL OR NEW."status" = 'WAITING_CERTIFICATE' THEN
      RAISE EXCEPTION 'incidents: INAIL filing % reports a fatal accident: due 24 hours after the accident (DPR 1124/1965 art. 53), with no medical certificate, never waiting for one', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR NEW."dueAt" IS DISTINCT FROM OLD."dueAt" THEN
      SELECT i."occurredAt" INTO happened FROM "Incident" i WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."incidentId";
      IF FOUND AND NEW."dueAt" <> happened + interval '24 hours' THEN
        RAISE EXCEPTION 'incidents: INAIL filing % reports a fatal accident: its deadline is exactly 24 hours after the incident happened (DPR 1124/1965 art. 53)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF (NEW."certificateReceivedAt" IS NULL) <> (NEW."dueAt" IS NULL) OR NEW."dueAt" <> NEW."certificateReceivedAt" + interval '48 hours'
     OR (NEW."status" = 'WAITING_CERTIFICATE' AND NEW."certificateReceivedAt" IS NOT NULL)
     OR (NEW."status" IN ('DUE', 'FILED') AND NEW."certificateReceivedAt" IS NULL) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is due 48 hours after the medical certificate was received (D.Lgs. 81/2008 art. 18 c.1 r): the deadline exactly with the certificate''s time, which a filing DUE or FILED has and one WAITING_CERTIFICATE has not', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'FILED') <> (NEW."filedAt" IS NOT NULL) OR (NEW."status" = 'FILED') <> (NEW."filedById" IS NOT NULL)
     OR (NEW."status" = 'FILED') <> (NEW."protocolNumber" IS NOT NULL) OR NOT "factory_protected_words_ok"(NEW."protocolNumber", 100)
     OR coalesce(NEW."filedAt" < NEW."certificateReceivedAt", false) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is FILED exactly with when (not before the certificate), by whom and INAIL''s protocol number', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'NOT_NEEDED') <> (NEW."notNeededAt" IS NOT NULL) OR (NEW."status" = 'NOT_NEEDED') <> (NEW."notNeededById" IS NOT NULL) THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is NOT_NEEDED exactly with when and by whom it was decided', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'NOT_NEEDED' THEN
      RAISE EXCEPTION 'incidents: INAIL filing % starts WAITING_CERTIFICATE, DUE or FILED (a filing recorded after it was sent)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT p."involvement"::text AS involvement, p."employeeId" AS employee, i."kind"::text AS kind, i."status"::text AS status INTO person
      FROM "IncidentPerson" p JOIN "Incident" i ON i."tenantId" = p."tenantId" AND i."id" = p."incidentId"
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."incidentPersonId";
    IF FOUND THEN
      IF person.involvement <> 'INJURED' OR person.employee IS NULL OR person.kind <> 'INJURY' THEN
        RAISE EXCEPTION 'incidents: INAIL filing % is for an injured person of the company in an injury', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
      IF person.status <> 'OPEN' THEN
        RAISE EXCEPTION 'incidents: INAIL filing % is added while incident % is OPEN (it is %)', NEW."id", NEW."incidentId", person.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - (kept || movable)) IS DISTINCT FROM (to_jsonb(OLD) - (kept || movable)) THEN
    RAISE EXCEPTION 'incidents: the incident, person, type, key and creation of INAIL filing % never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'FILED' THEN
    RAISE EXCEPTION 'incidents: INAIL filing % is FILED; it no longer changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
