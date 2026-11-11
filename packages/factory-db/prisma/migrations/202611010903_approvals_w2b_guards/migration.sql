-- Written by hand (Prisma does not model triggers), after the generated 202611010902_approvals_w2b_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- Approvals and workflow, W2b-5 schema wave 35/44 (B-W2b-276; PLT-042, PLT-086, PLT-091, PLT-093, PLT-104, PLT-105).
-- apps/factory-api's platform/approvals (B-W2b-282) checks all of this first and answers in words; these rules are the last
-- word, for every login, the owner included.
--
--   ApprovalRule   a name of one line (1 to 120); the RuleBuilder's condition ({ "combinator": "and" | "or", "rows": [...] },
--                  at most 50 rows, each a fact, a way to compare and the value that way needs); exactly one approver: an
--                  OFFICE role, or one OFFICE person who has not left; the order 1 to 9999; the hours to decide 1 to 2160
--                  or none; its kind, company and creation never change; the version moves by one at most. Switched off,
--                  never deleted (the tasks name the rules that asked).
--   ApprovalTask   asked PENDING with no decision, version 1; what was asked never changes after it (the kind, the subject,
--                  the company and site, the rules, the words, the preview and its fingerprint, who asked and when, the
--                  approver, the meaning, the step-up, the due time); PENDING → APPROVED | REJECTED | WITHDRAWN | STALE,
--                  once, then frozen; APPROVED and REJECTED exactly with when and by whom; a comment only on a yes; a no
--                  exactly with a reason code (`^[A-Z][A-Z0-9_]{1,39}$`, the APPROVAL_REJECT list's shape) and words; the
--                  step-up time only on a yes, required where the request asks one, within the 15 minutes before the yes;
--                  WITHDRAWN exactly with when (by whom, when a person), STALE exactly with when; every time not before the
--                  request and not in the future. Exactly one requester (an office user, or a floor worker of the task's
--                  site) and exactly one approver (an OFFICE role, or one OFFICE person who has not left). NOBODY DECIDES
--                  THEIR OWN REQUEST (Owner answer 11-10, Q3 = A; PLT-042), the Owner included, whatever the path: the
--                  decider is never the person who asked, never the person who wrote the request, never the office account
--                  of the worker who asked; a named approver is never one of them either, and is the only one who decides
--                  (a role's holders are the API's: B-W2b-282 checks the live roles). The rules that asked (at insert) are
--                  the tenant's rules of the task's kind, of its company or tenant-wide, each once, at most 20 (none: a
--                  domain switch asked). A subject named by record type + id (a model name). Never deleted.
--   ApprovalEvent  append-only (UPDATE, DELETE, TRUNCATE refused, for every login); who: an office user or a floor worker
--                  (at most one), nobody only for the system's WITHDRAWN and STALE; words required for COMMENTED and
--                  REJECTED (1 to 4000, line breaks allowed); a reason code only on REJECTED; the meaning required on SIGNED,
--                  possible on APPROVED, never elsewhere; not in the future. A task's line agrees with its task: its record
--                  is the task's subject; REQUESTED by the task's requester; APPROVED, SIGNED and REJECTED only once the task
--                  is so decided, by its decider, with its meaning or its reason code; WITHDRAWN and STALE only once the task
--                  is so. A domain approval's line (no task): an APPROVED, SIGNED or REJECTED line is never by the person (or
--                  the office account of the worker) of the record's last REQUESTED line.
--
-- As every W2b guard: every refusal is a check_violation (SQLSTATE 23514) in words; the checks are AFTER triggers (the
-- policies speak first), but the refused deletes and the append-only refusal (BEFORE: the runtime roles have no DELETE grant
-- here anyway, so these speak to the owner). The tenant of a row is left to the policies and the references, never compared
-- here: a rule that reads another row skips a row this session cannot see. An UPDATE that changes nothing passes.
--
-- The generated isolation tests copy the first seeded row of each table (a new id, unique text suffixed, unique numbers and
-- dates moved) and insert the copy: so the first rows the seed gives are ones a copy may repeat (a rule switched off, a PENDING
-- request, the REQUESTED line of that request). One PENDING request per kind and subject is the engine's (under the subject's
-- row lock), not a partial unique index here: the copy of the first request would break it.
--
-- USED FROM EARLIER WAVES, as they are: "factory_recall_words_ok", "factory_recall_not_future" and
-- "factory_recall_model_name_ok" (…_recall_claims_w2b_guards).

CREATE FUNCTION "factory_approval_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approvals: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_approval_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approvals: % % is kept, never deleted (switch a rule off; withdraw a request)', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION "factory_approval_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approvals: the approval history is never changed or removed (% of ApprovalEvent %); add a new line', TG_OP, OLD."id"
    USING ERRCODE = 'check_violation';
END
$$;

-- A reject reason code: the shape of every reason code (factory-domain REASON_CODE), here of the APPROVAL_REJECT list.
CREATE FUNCTION "factory_approval_code_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND code ~ '^[A-Z][A-Z0-9_]{1,39}$'
$$;

-- The RuleBuilder's condition (packages/ui RuleBuilder; B-W2b-207): exactly { "combinator": "and" | "or", "rows": [...] }, at
-- most 50 rows (none: every request of the kind), each { "field", "operator", "value", "id"? }: a fact of the kind
-- (`^[a-z][A-Za-z0-9_.]{0,79}$`), one of the eleven ways to compare, and the value that way needs (none for isTrue and isFalse,
-- one to 100 texts for in and notIn, one text otherwise; each text 1 to 500 characters of one line). The API checks the facts
-- each kind exposes.
CREATE FUNCTION "factory_approval_condition_ok"(cond jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
  op text;
  val jsonb;
BEGIN
  IF cond IS NULL OR jsonb_typeof(cond) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(cond) AS k(name) WHERE k.name NOT IN ('combinator', 'rows'))
     OR jsonb_typeof(cond -> 'combinator') IS DISTINCT FROM 'string' OR (cond ->> 'combinator') NOT IN ('and', 'or')
     OR jsonb_typeof(cond -> 'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(cond -> 'rows') > 50 THEN
    RETURN false;
  END IF;
  FOR entry IN SELECT e.value FROM jsonb_array_elements(cond -> 'rows') AS e LOOP
    IF jsonb_typeof(entry) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(entry) AS k(name) WHERE k.name NOT IN ('id', 'field', 'operator', 'value'))
       OR (entry ? 'id' AND (jsonb_typeof(entry -> 'id') <> 'string' OR NOT "factory_recall_words_ok"(entry ->> 'id', 80, false)))
       OR jsonb_typeof(entry -> 'field') IS DISTINCT FROM 'string' OR (entry ->> 'field') !~ '^[a-z][A-Za-z0-9_.]{0,79}$'
       OR jsonb_typeof(entry -> 'operator') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    op := entry ->> 'operator';
    val := entry -> 'value';
    IF op IN ('isTrue', 'isFalse') THEN
      IF val IS NOT NULL AND jsonb_typeof(val) <> 'null' THEN
        RETURN false;
      END IF;
    ELSIF op IN ('in', 'notIn') THEN
      IF val IS NULL OR jsonb_typeof(val) <> 'array' OR jsonb_array_length(val) NOT BETWEEN 1 AND 100
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(val) AS v(item)
                     WHERE jsonb_typeof(v.item) <> 'string' OR NOT "factory_recall_words_ok"(v.item #>> '{}', 500, false)) THEN
        RETURN false;
      END IF;
    ELSIF op IN ('eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains') THEN
      IF val IS NULL OR jsonb_typeof(val) <> 'string' OR NOT "factory_recall_words_ok"(val #>> '{}', 500, false) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$$;

-- A request's preview: an object of at most 256 KiB with "changes" (a list) and, optionally, "facts" (a list); each entry an
-- object with a "field" (1 to 120 characters of one line) and, optionally, the "grain" of its money (price, cost, margin, wages,
-- pay; null: not money), which the API needs to drop a figure for a reader without that grain.
CREATE FUNCTION "factory_approval_preview_ok"(preview jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  list text;
  entry jsonb;
BEGIN
  IF preview IS NULL OR jsonb_typeof(preview) <> 'object' OR octet_length(preview::text) > 262144
     OR jsonb_typeof(preview -> 'changes') IS DISTINCT FROM 'array'
     OR (preview ? 'facts' AND jsonb_typeof(preview -> 'facts') <> 'array') THEN
    RETURN false;
  END IF;
  FOREACH list IN ARRAY ARRAY['changes', 'facts'] LOOP
    FOR entry IN SELECT e.value FROM jsonb_array_elements(coalesce(preview -> list, '[]'::jsonb)) AS e LOOP
      IF jsonb_typeof(entry) <> 'object'
         OR jsonb_typeof(entry -> 'field') IS DISTINCT FROM 'string' OR NOT "factory_recall_words_ok"(entry ->> 'field', 120, false)
         OR (entry ? 'grain' AND jsonb_typeof(entry -> 'grain') <> 'null'
             AND (jsonb_typeof(entry -> 'grain') <> 'string' OR (entry ->> 'grain') NOT IN ('price', 'cost', 'margin', 'wages', 'pay'))) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END
$$;

-- An approver: an OFFICE role, or an OFFICE person who has not left (a row this session cannot see is skipped). `what` names
-- the row in the words.
CREATE FUNCTION "factory_approval_approver_check"(tenant uuid, role_id uuid, user_id uuid, what text) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE
  audience text;
  user_status text;
BEGIN
  IF (role_id IS NULL) = (user_id IS NULL) THEN
    RAISE EXCEPTION 'approvals: % names exactly one approver: an office role, or one person', what
      USING ERRCODE = 'check_violation';
  END IF;
  IF role_id IS NOT NULL THEN
    SELECT r."audience"::text INTO audience FROM "Role" r WHERE r."tenantId" = tenant AND r."id" = role_id;
    IF FOUND AND audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'approvals: % names role %, which is not an office role (a floor or partner role approves nothing here)', what, role_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT u."audience"::text, u."status"::text INTO audience, user_status FROM "User" u WHERE u."tenantId" = tenant AND u."id" = user_id;
    IF FOUND AND (audience <> 'OFFICE' OR user_status = 'DEACTIVATED') THEN
      RAISE EXCEPTION 'approvals: % names person %, who is not an office user of the tenant (or has left)', what, user_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END
$$;

-- =====================================================================================================================
-- ApprovalRule (PLT-086)
CREATE FUNCTION "factory_approval_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."kind", NEW."companyId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."kind", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'approvals: approval rule % keeps its kind, company and creation (make a new rule and switch this one off)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" NOT IN (OLD."version", OLD."version" + 1) THEN
      RAISE EXCEPTION 'approvals: approval rule % moves its version by one at most (% → %)', OLD."id", OLD."version", NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."version" <> 1 THEN
    RAISE EXCEPTION 'approvals: approval rule % starts at version 1', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."name" IS NULL OR NOT "factory_recall_words_ok"(NEW."name", 120, false) THEN
    RAISE EXCEPTION 'approvals: approval rule % has a name of one line, 1 to 120 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_approval_condition_ok"(NEW."condition") THEN
    RAISE EXCEPTION 'approvals: approval rule % keeps its condition as the RuleBuilder does: { "combinator": "and" | "or", "rows": [{ "field", "operator", "value" }] }, at most 50 rows, each value as its way to compare needs', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sequence" NOT BETWEEN 1 AND 9999 THEN
    RAISE EXCEPTION 'approvals: approval rule % has its place in the kind''s order between 1 and 9999 (not %)', NEW."id", NEW."sequence"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueHours" IS NOT NULL AND NEW."dueHours" NOT BETWEEN 1 AND 2160 THEN
    RAISE EXCEPTION 'approvals: approval rule % gives 1 to 2160 hours to decide, or none (not %)', NEW."id", NEW."dueHours"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approverRoleId" IS NULL) = (NEW."approverUserId" IS NULL) THEN
    RAISE EXCEPTION 'approvals: approval rule % names exactly one approver: an office role, or one person', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."approverRoleId" IS DISTINCT FROM OLD."approverRoleId" OR NEW."approverUserId" IS DISTINCT FROM OLD."approverUserId" THEN
    PERFORM "factory_approval_approver_check"(NEW."tenantId", NEW."approverRoleId", NEW."approverUserId", format('approval rule %s', NEW."id"));
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ApprovalRule_guard" AFTER INSERT OR UPDATE ON "ApprovalRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_rule_guard"();
CREATE TRIGGER "ApprovalRule_never_deleted" BEFORE DELETE ON "ApprovalRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_never_deleted"();
CREATE TRIGGER "ApprovalRule_no_truncate" BEFORE TRUNCATE ON "ApprovalRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_approval_refuse_truncate"();

-- =====================================================================================================================
-- ApprovalTask (PLT-042, PLT-091, PLT-093, PLT-105)
CREATE FUNCTION "factory_approval_task_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  asked constant text[] := ARRAY['id', 'kind', 'recordType', 'recordId', 'companyId', 'siteId', 'ruleIds', 'summary', 'preview',
                                 'fingerprint', 'requestedById', 'requestedByWorkerId', 'requestedAt', 'approverRoleId',
                                 'approverUserId', 'signatureMeaning', 'requireStepUp', 'dueAt', 'createdAt', 'createdById'];
  worker_user uuid;
  decider_audience text;
  rules_found integer;
  rule_row record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF to_jsonb(NEW) = to_jsonb(OLD) THEN
      RETURN NULL;
    END IF;
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'approvals: request % is % already: it never changes again (ask a new request)', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT jsonb_object_agg(k.name, to_jsonb(NEW) -> k.name) FROM unnest(asked) AS k(name))
       IS DISTINCT FROM (SELECT jsonb_object_agg(k.name, to_jsonb(OLD) -> k.name) FROM unnest(asked) AS k(name)) THEN
      RAISE EXCEPTION 'approvals: request % keeps what was asked (its subject, rules, words, preview and fingerprint, who asked and when, the approver, the meaning, the step-up and the due time): ask a new request', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" NOT IN (OLD."version", OLD."version" + 1) THEN
      RAISE EXCEPTION 'approvals: request % moves its version by one at most (% → %)', OLD."id", OLD."version", NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" <> 'PENDING' OR NEW."version" <> 1
        OR num_nonnulls(NEW."decidedAt", NEW."decidedById", NEW."comment", NEW."rejectReasonCode", NEW."rejectReason", NEW."stepUpAt",
                        NEW."withdrawnAt", NEW."withdrawnById", NEW."staleAt") > 0 THEN
    RAISE EXCEPTION 'approvals: request % is asked PENDING at version 1, with no decision, withdrawal or staleness yet', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- What was asked (every row; it never changes after the insert).
  IF NOT "factory_recall_model_name_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'approvals: request % names its subject by its model name ("PurchaseOrder", "SalesOrder") and id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."summary" IS NULL OR NOT "factory_recall_words_ok"(NEW."summary", 500, false) THEN
    RAISE EXCEPTION 'approvals: request % says what it asks in one line of 1 to 500 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_approval_preview_ok"(NEW."preview") THEN
    RAISE EXCEPTION 'approvals: request % shows its change as { "changes": [{ "field", "from", "to", "grain"? }], "facts"?: [...] }: an object of at most 256 KiB, each entry with a field and the grain of its money (price, cost, margin, wages, pay) or none', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fingerprint" IS NULL OR NEW."fingerprint" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'approvals: request % carries the SHA-256 fingerprint of its change (64 lower-case hex digits)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."requestedById" IS NULL) = (NEW."requestedByWorkerId" IS NULL) THEN
    RAISE EXCEPTION 'approvals: request % names exactly one person who asked: an office user, or a floor worker', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."requestedByWorkerId" IS NOT NULL AND NEW."siteId" IS NULL THEN
    RAISE EXCEPTION 'approvals: request % asked on the floor names the site of the worker who asked', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."approverRoleId" IS NULL) = (NEW."approverUserId" IS NULL) THEN
    RAISE EXCEPTION 'approvals: request % names exactly one approver: an office role, or one person', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ruleIds" IS NULL OR cardinality(NEW."ruleIds") > 20 OR array_position(NEW."ruleIds", NULL) IS NOT NULL
     OR (SELECT count(DISTINCT r.id) FROM unnest(NEW."ruleIds") AS r(id)) <> cardinality(NEW."ruleIds") THEN
    RAISE EXCEPTION 'approvals: request % names the rules that asked each once, at most 20 (none: a domain switch asked)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."requestedAt") THEN
    RAISE EXCEPTION 'approvals: request % is not asked in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dueAt" IS NOT NULL AND NEW."dueAt" <= NEW."requestedAt" THEN
    RAISE EXCEPTION 'approvals: request % is due after it was asked', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Its one decision, withdrawal or staleness.
  IF (NEW."status" IN ('APPROVED', 'REJECTED')) <> (NEW."decidedAt" IS NOT NULL) OR (NEW."decidedAt" IS NULL) <> (NEW."decidedById" IS NULL) THEN
    RAISE EXCEPTION 'approvals: request % is APPROVED or REJECTED exactly with when and by whom it was decided', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."comment" IS NOT NULL AND (NEW."status" <> 'APPROVED' OR NOT "factory_recall_words_ok"(NEW."comment", 2000, true)) THEN
    RAISE EXCEPTION 'approvals: request % carries a comment only with a yes (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'REJECTED') <> (NEW."rejectReasonCode" IS NOT NULL) OR (NEW."rejectReasonCode" IS NULL) <> (NEW."rejectReason" IS NULL)
     OR (NEW."rejectReasonCode" IS NOT NULL AND NOT "factory_approval_code_ok"(NEW."rejectReasonCode"))
     OR NOT "factory_recall_words_ok"(NEW."rejectReason", 2000, true) THEN
    RAISE EXCEPTION 'approvals: request % is REJECTED exactly with a reason code of the APPROVAL_REJECT list (2 to 40 upper-case letters, digits and underscores) and the words why (1 to 2000 characters)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stepUpAt" IS NOT NULL AND NEW."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'approvals: request % records a step-up only with its yes', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND NEW."requireStepUp" AND NEW."stepUpAt" IS NULL THEN
    RAISE EXCEPTION 'approvals: request % asks a fresh step-up with its yes (an authenticator code within the 15 minutes before it)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."stepUpAt" IS NOT NULL AND (NEW."stepUpAt" < NEW."decidedAt" - interval '15 minutes' OR NEW."stepUpAt" > NEW."decidedAt" + interval '1 minute') THEN
    RAISE EXCEPTION 'approvals: request % was approved with a step-up of at most 15 minutes before the yes (step-up %, yes %)', NEW."id", NEW."stepUpAt", NEW."decidedAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'WITHDRAWN') <> (NEW."withdrawnAt" IS NOT NULL) OR (NEW."withdrawnById" IS NOT NULL AND NEW."withdrawnAt" IS NULL) THEN
    RAISE EXCEPTION 'approvals: request % is WITHDRAWN exactly with when (and by whom, when a person took it back)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."status" = 'STALE') <> (NEW."staleAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'approvals: request % is STALE exactly with when its subject was found changed', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(NEW."decidedAt", NEW."withdrawnAt", NEW."staleAt") < NEW."requestedAt"
     OR NOT "factory_recall_not_future"(coalesce(NEW."decidedAt", NEW."withdrawnAt", NEW."staleAt")) THEN
    RAISE EXCEPTION 'approvals: request % is decided, withdrawn or found stale not before it was asked and not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Nobody decides their own request, the Owner included (Owner answer 11-10, Q3 = A; PLT-042), whatever the path.
  IF NEW."requestedByWorkerId" IS NOT NULL THEN
    SELECT w."userId" INTO worker_user FROM "Worker" w
     WHERE w."tenantId" = NEW."tenantId" AND w."siteId" = NEW."siteId" AND w."id" = NEW."requestedByWorkerId";
  END IF;
  IF NEW."approverUserId" IS NOT NULL AND NEW."approverUserId" IN (NEW."requestedById", NEW."createdById", worker_user) THEN
    RAISE EXCEPTION 'approvals: request % is addressed to the person who asked for it: nobody approves their own request, the Owner included (Owner answer Q3); name another approver', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decidedById" IS NOT NULL THEN
    IF NEW."decidedById" IN (NEW."requestedById", NEW."createdById", worker_user) THEN
      RAISE EXCEPTION 'approvals: request % is decided by another person than the one who asked for it: nobody approves their own request, the Owner included (Owner answer Q3)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approverUserId" IS NOT NULL AND NEW."decidedById" <> NEW."approverUserId" THEN
      RAISE EXCEPTION 'approvals: request % is addressed to one person (%): only they decide it', NEW."id", NEW."approverUserId"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT u."audience"::text INTO decider_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."decidedById";
    IF FOUND AND decider_audience <> 'OFFICE' THEN
      RAISE EXCEPTION 'approvals: request % is decided by an office user, never a partner user', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- At the insert: the approver, and the rules that asked (the tenant's rules of the task's kind, of its company or
  -- tenant-wide).
  IF TG_OP = 'INSERT' THEN
    PERFORM "factory_approval_approver_check"(NEW."tenantId", NEW."approverRoleId", NEW."approverUserId", format('request %s', NEW."id"));
    rules_found := 0;
    FOR rule_row IN SELECT r."id", r."kind"::text AS kind, r."companyId" FROM "ApprovalRule" r
                     WHERE r."tenantId" = NEW."tenantId" AND r."id" = ANY (NEW."ruleIds") LOOP
      rules_found := rules_found + 1;
      IF rule_row.kind <> NEW."kind"::text OR (rule_row."companyId" IS NOT NULL AND rule_row."companyId" <> NEW."companyId") THEN
        RAISE EXCEPTION 'approvals: request % (%) names rule %, which is not a % rule of its company or of every company', NEW."id", NEW."kind", rule_row."id", NEW."kind"
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF rules_found <> cardinality(NEW."ruleIds") THEN
      RAISE EXCEPTION 'approvals: request % names a rule that is not an approval rule of the tenant', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ApprovalTask_guard" AFTER INSERT OR UPDATE ON "ApprovalTask"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_task_guard"();
CREATE TRIGGER "ApprovalTask_never_deleted" BEFORE DELETE ON "ApprovalTask"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_never_deleted"();
CREATE TRIGGER "ApprovalTask_no_truncate" BEFORE TRUNCATE ON "ApprovalTask"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_approval_refuse_truncate"();

-- =====================================================================================================================
-- ApprovalEvent (PLT-104): append-only; a task's line agrees with its task; a decision never by the person who asked.
CREATE FUNCTION "factory_approval_event_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task record;
  asked record;
  worker_user uuid;
  asked_worker_user uuid;
BEGIN
  IF NOT "factory_recall_model_name_ok"(NEW."recordType") THEN
    RAISE EXCEPTION 'approvals: history line % names its record by its model name ("ChangeOrder", "PurchaseOrder") and id', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."byId" IS NOT NULL AND NEW."byWorkerId" IS NOT NULL THEN
    RAISE EXCEPTION 'approvals: history line % names one person: an office user or a floor worker', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."byId" IS NULL AND NEW."byWorkerId" IS NULL AND NEW."action" NOT IN ('WITHDRAWN', 'STALE') THEN
    RAISE EXCEPTION 'approvals: history line % (%) names the person who did it (only the system''s WITHDRAWN and STALE name nobody)', NEW."id", NEW."action"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."at") THEN
    RAISE EXCEPTION 'approvals: history line % is not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."words", 4000, true) OR (NEW."action" IN ('COMMENTED', 'REJECTED') AND NEW."words" IS NULL) THEN
    RAISE EXCEPTION 'approvals: history line % has words of 1 to 4000 characters (required for COMMENTED and REJECTED)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reasonCode" IS NOT NULL AND (NEW."action" <> 'REJECTED' OR NOT "factory_approval_code_ok"(NEW."reasonCode")) THEN
    RAISE EXCEPTION 'approvals: history line % carries a reason code (of the APPROVAL_REJECT list) only on REJECTED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."action" = 'SIGNED' AND NEW."meaning" IS NULL) OR (NEW."meaning" IS NOT NULL AND NEW."action" NOT IN ('SIGNED', 'APPROVED')) THEN
    RAISE EXCEPTION 'approvals: history line % carries a meaning only on SIGNED (required) or APPROVED', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."taskId" IS NOT NULL THEN
    -- A task's line agrees with its task (a task this session cannot see is skipped; the key pins the company).
    SELECT t."recordType", t."recordId", t."status"::text AS status, t."requestedById", t."requestedByWorkerId", t."decidedById",
           t."signatureMeaning"::text AS meaning, t."rejectReasonCode", t."withdrawnById"
      INTO task FROM "ApprovalTask" t WHERE t."tenantId" = NEW."tenantId" AND t."companyId" = NEW."companyId" AND t."id" = NEW."taskId";
    IF FOUND THEN
      IF (NEW."recordType", NEW."recordId") IS DISTINCT FROM (task."recordType", task."recordId") THEN
        RAISE EXCEPTION 'approvals: history line % of request % names the request''s subject (% %)', NEW."id", NEW."taskId", task."recordType", task."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."action" = 'REQUESTED' AND (NEW."byId", NEW."byWorkerId") IS DISTINCT FROM (task."requestedById", task."requestedByWorkerId") THEN
        RAISE EXCEPTION 'approvals: history line % says request % was asked by the person who asked it', NEW."id", NEW."taskId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."action" IN ('APPROVED', 'SIGNED')
         AND (task.status <> 'APPROVED' OR NEW."byId" IS DISTINCT FROM task."decidedById" OR NEW."byWorkerId" IS NOT NULL
              OR (NEW."action" = 'SIGNED' AND NEW."meaning"::text IS DISTINCT FROM task.meaning)
              OR (NEW."action" = 'APPROVED' AND NEW."meaning" IS NOT NULL AND NEW."meaning"::text IS DISTINCT FROM task.meaning)) THEN
        RAISE EXCEPTION 'approvals: history line % (%) follows request %''s yes: by its approver, with the meaning it asked', NEW."id", NEW."action", NEW."taskId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."action" = 'REJECTED'
         AND (task.status <> 'REJECTED' OR NEW."byId" IS DISTINCT FROM task."decidedById" OR NEW."byWorkerId" IS NOT NULL
              OR NEW."reasonCode" IS DISTINCT FROM task."rejectReasonCode") THEN
        RAISE EXCEPTION 'approvals: history line % follows request %''s no: by its approver, with its reason code', NEW."id", NEW."taskId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."action" = 'WITHDRAWN' AND (task.status <> 'WITHDRAWN' OR NEW."byId" IS DISTINCT FROM task."withdrawnById" OR NEW."byWorkerId" IS NOT NULL) THEN
        RAISE EXCEPTION 'approvals: history line % follows request %''s withdrawal, by whoever took it back', NEW."id", NEW."taskId"
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."action" = 'STALE' AND task.status <> 'STALE' THEN
        RAISE EXCEPTION 'approvals: history line % follows request % found stale', NEW."id", NEW."taskId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF NEW."action" IN ('APPROVED', 'SIGNED', 'REJECTED') THEN
    -- A domain approval's decision: never by the person (or the office account of the worker) of the record's last
    -- REQUESTED line (Owner answer Q3).
    SELECT e."byId", e."byWorkerId" INTO asked FROM "ApprovalEvent" e
     WHERE e."tenantId" = NEW."tenantId" AND e."recordType" = NEW."recordType" AND e."recordId" = NEW."recordId"
       AND e."taskId" IS NULL AND e."action" = 'REQUESTED' AND e."id" <> NEW."id"
     ORDER BY e."at" DESC, e."createdAt" DESC, e."id" DESC
     LIMIT 1;
    IF FOUND THEN
      IF NEW."byWorkerId" IS NOT NULL THEN
        SELECT w."userId" INTO worker_user FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = NEW."byWorkerId";
      END IF;
      IF asked."byWorkerId" IS NOT NULL THEN
        SELECT w."userId" INTO asked_worker_user FROM "Worker" w WHERE w."tenantId" = NEW."tenantId" AND w."id" = asked."byWorkerId";
      END IF;
      IF (NEW."byId" IS NOT NULL AND NEW."byId" IN (asked."byId", asked_worker_user))
         OR (NEW."byWorkerId" IS NOT NULL AND NEW."byWorkerId" = asked."byWorkerId")
         OR (worker_user IS NOT NULL AND worker_user = asked."byId") THEN
        RAISE EXCEPTION 'approvals: history line % decides % % for the person who asked for it: nobody approves their own request, the Owner included (Owner answer Q3)', NEW."id", NEW."recordType", NEW."recordId"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ApprovalEvent_check" AFTER INSERT ON "ApprovalEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_event_check"();
CREATE TRIGGER "ApprovalEvent_append_only" BEFORE UPDATE OR DELETE ON "ApprovalEvent"
  FOR EACH ROW EXECUTE FUNCTION "factory_approval_event_append_only"();
CREATE TRIGGER "ApprovalEvent_no_truncate" BEFORE TRUNCATE ON "ApprovalEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_approval_refuse_truncate"();
