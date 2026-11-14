-- Written by hand (Prisma does not model triggers), after the generated …_insights_depth_w2b_schema and before the policy
-- migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The metric layer (W2b-6, schema wave 57/57, B-W2b-381; insights-depth.prisma; ANA-002, ANA-012, ANA-032, ANA-041,
-- ANA-069, ANA-070). These rules hold for every login, the owner included; apps/factory-api's commands (B-W2b-428, B-W2b-434,
-- B-W2b-435) check them first in words. Every refusal is a check_violation (SQLSTATE 23514) in words. The row guards are AFTER
-- triggers (the policies speak first); the refused deletes are BEFORE triggers. An UPDATE that changes nothing passes.
--
-- Reused as they are: recall's `factory_recall_words_ok`, `factory_recall_not_future`; styles' `factory_styles_distinct`; the
-- privacy wave's `factory_privacy_ops_table_ok` (a model name that is a table) and `factory_privacy_ops_code_ok` (a code).
-- No earlier function is redefined, and no trigger is added to a table of another wave.
--
-- The Owner's rule of 11-13: the morning e-mail sits behind a per-company switch, OFF by default (InsightsSettings): a
-- person's digest is marked sent (DigestSetting.lastSentAt) only while it is on and its company's switch is on.
-- No per-person figure (Statuto dei Lavoratori art. 4; Owner answer W1): the facts have no person column (company, site and
-- line only), and a KPI's grain is PRICE, COST or MARGIN, never wages or pay.

CREATE FUNCTION "factory_insights_depth_refuse_truncate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'insights: TRUNCATE on "%" is refused', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- A key made of a fixed beginning: the beginning itself, or the beginning and a dash with more after it (the generated
-- isolation tests copy a row with its unique texts suffixed).
CREATE FUNCTION "factory_insights_depth_key_ok"(key text, beginning text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT key IS NOT NULL AND beginning IS NOT NULL AND char_length(key) <= 400 AND (key = beginning OR starts_with(key, beginning || '-'))
$$;

-- A dotted key of a registry (a measure `orders.lines_shipped`, a KPI `delivery.otif`): lower-case words of letters, digits
-- and _, at least two, joined by dots; 3 to 100 characters.
CREATE FUNCTION "factory_insights_depth_dotted_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND char_length(code) <= 100 AND code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
$$;

-- A KPI's key: a dotted key (above), or one with a dash and more after it (the isolation tests' copy of a version).
CREATE FUNCTION "factory_insights_depth_kpi_key_ok"(code text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT code IS NOT NULL AND char_length(code) <= 120 AND code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+(-[a-z0-9-]+)?$'
$$;

-- A time zone of the IANA database PostgreSQL knows (`Europe/Rome`).
CREATE FUNCTION "factory_insights_depth_zone_ok"(zone text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT zone IS NOT NULL AND zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$' AND EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n."name" = zone)
$$;

-- A dashboard's panels in order: 1 to 40 objects, each exactly { "id": <a code of 1 to 120: lower-case letters and digits,
-- joined by . : _ ->, "hidden": <true | false>, "width": "HALF" | "TWO_THIRDS" | "FULL" }, each id once.
CREATE FUNCTION "factory_insights_depth_panels_ok"(panels jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT panels IS NOT NULL AND jsonb_typeof(panels) = 'array' AND jsonb_array_length(panels) BETWEEN 1 AND 40
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(panels) e
        WHERE jsonb_typeof(e.value) <> 'object'
           OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e.value) k) IS DISTINCT FROM ARRAY['hidden', 'id', 'width']
           OR jsonb_typeof(e.value -> 'id') <> 'string'
           OR char_length(e.value ->> 'id') > 120
           OR (e.value ->> 'id') !~ '^[a-z0-9]+([.:_-][a-z0-9]+)*$'
           OR jsonb_typeof(e.value -> 'hidden') <> 'boolean'
           OR jsonb_typeof(e.value -> 'width') <> 'string'
           OR (e.value ->> 'width') NOT IN ('HALF', 'TWO_THIRDS', 'FULL'))
     AND (SELECT count(DISTINCT e.value ->> 'id') FROM jsonb_array_elements(panels) e) = jsonb_array_length(panels)
$$;

-- ISO weekdays: 1 (Monday) to 7 (Sunday), ascending, each once, at least one.
CREATE FUNCTION "factory_insights_depth_weekdays_ok"(days integer[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT days IS NOT NULL AND cardinality(days) BETWEEN 1 AND 7
     AND NOT EXISTS (SELECT 1 FROM unnest(days) d WHERE d IS NULL OR d < 1 OR d > 7)
     AND days = (SELECT array_agg(DISTINCT d ORDER BY d) FROM unnest(days) d)
$$;

-- The clock of a fact's place: its site's time zone, else its company's.
CREATE FUNCTION "factory_insights_depth_zone_of"(tenant uuid, company uuid, site uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s."timezone" FROM "Site" s WHERE s."tenantId" = tenant AND s."id" = site),
                  (SELECT c."timezone" FROM "Company" c WHERE c."tenantId" = tenant AND c."id" = company))
$$;

-- =====================================================================================================================
-- KpiDefinition (ANA-012, ANA-070): one version of one KPI
--   INSERT     born DRAFT; made from a version (basedOnId) of the same key with a lower number, or from nothing.
--   every row  the key (a dotted key); the number 1 or more; what changed (1 to 2000 characters) exactly with basedOn; the
--              names one line of 1 to 120, the definitions 1 to 2000 and the formulas 1 to 1000 characters, Italian and
--              English; 1 to 20 source records, each a table, each once; up to 30 measure keys, each once; the owner an
--              office role that is not archived (when named or changed); a MONEY unit with its grain; activated (when, by
--              whom) exactly from ACTIVE on, ended exactly when SUPERSEDED or RETIRED, not before it was activated, neither in
--              the future.
--   UPDATE     an UPDATE that changes nothing passes; the key, the number, basedOn and the creation never change; DRAFT →
--              ACTIVE → SUPERSEDED | RETIRED, nothing back, nothing skipped; an ACTIVE version changes only by its end; a
--              SUPERSEDED or RETIRED one changes no more. One ACTIVE per key: the partial unique index below (the API
--              supersedes the version in force first, in the same command).
--   DELETE     only a DRAFT (a version in force or past explains old numbers). TRUNCATE refused.
CREATE FUNCTION "factory_kpi_definition_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  based_key text;
  based_number integer;
  role_audience text;
  role_archived timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD."state" IN ('SUPERSEDED', 'RETIRED') THEN
      RAISE EXCEPTION 'kpis: version % of KPI % is no longer in force (%): it changes no more', OLD."kpiVersion", OLD."kpiKey", OLD."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."kpiKey", NEW."kpiVersion", NEW."basedOnId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."kpiKey", OLD."kpiVersion", OLD."basedOnId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'kpis: the key, the number, the version it was made from and the creation of version % of KPI % never change', OLD."kpiVersion", OLD."kpiKey"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."state" IS DISTINCT FROM OLD."state"
       AND NOT ((OLD."state" = 'DRAFT' AND NEW."state" = 'ACTIVE') OR (OLD."state" = 'ACTIVE' AND NEW."state" IN ('SUPERSEDED', 'RETIRED'))) THEN
      RAISE EXCEPTION 'kpis: version % of KPI % moves DRAFT → ACTIVE → SUPERSEDED or RETIRED (not % → %)', OLD."kpiVersion", OLD."kpiKey", OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'ACTIVE'
       AND (NEW."state" = 'ACTIVE'
            OR (NEW."changeNote", NEW."nameIt", NEW."nameEn", NEW."definitionIt", NEW."definitionEn", NEW."formulaIt", NEW."formulaEn", NEW."sourceRecords", NEW."measureKeys", NEW."ownerRoleId", NEW."unit", NEW."grain", NEW."activatedAt", NEW."activatedById")
               IS DISTINCT FROM (OLD."changeNote", OLD."nameIt", OLD."nameEn", OLD."definitionIt", OLD."definitionEn", OLD."formulaIt", OLD."formulaEn", OLD."sourceRecords", OLD."measureKeys", OLD."ownerRoleId", OLD."unit", OLD."grain", OLD."activatedAt", OLD."activatedById")) THEN
      RAISE EXCEPTION 'kpis: version % of KPI % is in force: it is never edited (a change is a new version); it only ends, SUPERSEDED or RETIRED', OLD."kpiVersion", OLD."kpiKey"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."state" <> 'DRAFT' THEN
      RAISE EXCEPTION 'kpis: version % of KPI % is written as a DRAFT, then activated', NEW."kpiVersion", NEW."kpiKey"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."basedOnId" IS NOT NULL THEN
      SELECT d."kpiKey", d."kpiVersion" INTO based_key, based_number
        FROM "KpiDefinition" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."basedOnId";
      IF based_key IS DISTINCT FROM NEW."kpiKey" OR based_number >= NEW."kpiVersion" THEN
        RAISE EXCEPTION 'kpis: version % of KPI % is made from a version of the same KPI with a lower number', NEW."kpiVersion", NEW."kpiKey"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NOT "factory_insights_depth_kpi_key_ok"(NEW."kpiKey") THEN
    RAISE EXCEPTION 'kpis: a KPI''s key is a dotted key of lower-case words (delivery.otif), up to 100 characters (not %)', NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kpiVersion" < 1 THEN
    RAISE EXCEPTION 'kpis: the versions of KPI % are numbered from 1', NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."basedOnId" IS NULL) <> (NEW."changeNote" IS NULL) OR NOT "factory_recall_words_ok"(NEW."changeNote", 2000, true) THEN
    RAISE EXCEPTION 'kpis: version % of KPI % says what changed (1 to 2000 characters) exactly when it is made from an earlier version', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."nameIt" IS NULL OR NEW."nameEn" IS NULL
     OR NOT "factory_recall_words_ok"(NEW."nameIt", 120, false) OR NOT "factory_recall_words_ok"(NEW."nameEn", 120, false) THEN
    RAISE EXCEPTION 'kpis: version % of KPI % has its name in Italian and in English, 1 to 120 characters on one line each', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."definitionIt" IS NULL OR NEW."definitionEn" IS NULL
     OR NOT "factory_recall_words_ok"(NEW."definitionIt", 2000, true) OR NOT "factory_recall_words_ok"(NEW."definitionEn", 2000, true) THEN
    RAISE EXCEPTION 'kpis: version % of KPI % says what it means in plain words, in Italian and in English, 1 to 2000 characters each', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."formulaIt" IS NULL OR NEW."formulaEn" IS NULL
     OR NOT "factory_recall_words_ok"(NEW."formulaIt", 1000, true) OR NOT "factory_recall_words_ok"(NEW."formulaEn", 1000, true) THEN
    RAISE EXCEPTION 'kpis: version % of KPI % gives its formula in words, in Italian and in English, 1 to 1000 characters each', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceRecords" IS NULL OR cardinality(NEW."sourceRecords") NOT BETWEEN 1 AND 20 OR NOT "factory_styles_distinct"(NEW."sourceRecords")
     OR EXISTS (SELECT 1 FROM unnest(NEW."sourceRecords") r WHERE NOT "factory_privacy_ops_table_ok"(r)) THEN
    RAISE EXCEPTION 'kpis: version % of KPI % names 1 to 20 records it is computed from, each a table of the database (SalesOrderLine), each once', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."measureKeys" IS NULL OR cardinality(NEW."measureKeys") > 30 OR NOT "factory_styles_distinct"(NEW."measureKeys")
     OR EXISTS (SELECT 1 FROM unnest(NEW."measureKeys") m WHERE NOT "factory_insights_depth_dotted_ok"(m)) THEN
    RAISE EXCEPTION 'kpis: version % of KPI % names up to 30 facts it reads, each a measure key (orders.lines_shipped), each once', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."ownerRoleId" IS DISTINCT FROM OLD."ownerRoleId" THEN
    SELECT r."audience"::text, r."archivedAt" INTO role_audience, role_archived FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ownerRoleId";
    IF role_audience IS DISTINCT FROM 'OFFICE' OR role_archived IS NOT NULL THEN
      RAISE EXCEPTION 'kpis: KPI % is owned by an office role that is not archived', NEW."kpiKey"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."unit" = 'MONEY' AND NEW."grain" IS NULL THEN
    RAISE EXCEPTION 'kpis: KPI % counts money: it names the grain its value needs (PRICE, COST or MARGIN)', NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" IN ('ACTIVE', 'SUPERSEDED', 'RETIRED')) <> (NEW."activatedAt" IS NOT NULL)
     OR (NEW."activatedAt" IS NULL) <> (NEW."activatedById" IS NULL) OR NOT "factory_recall_not_future"(NEW."activatedAt") THEN
    RAISE EXCEPTION 'kpis: version % of KPI % names when and by whom it was activated exactly from ACTIVE on, not in the future', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" IN ('SUPERSEDED', 'RETIRED')) <> (NEW."endedAt" IS NOT NULL)
     OR (NEW."endedAt" IS NULL) <> (NEW."endedById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."endedAt") OR NEW."endedAt" < NEW."activatedAt" THEN
    RAISE EXCEPTION 'kpis: version % of KPI % names when and by whom it ended exactly when SUPERSEDED or RETIRED, not before it was activated nor in the future', NEW."kpiVersion", NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_kpi_definition_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' THEN
    RAISE EXCEPTION 'kpis: version % of KPI % was in force (%): it explains old numbers and is never deleted; only a DRAFT is', OLD."kpiVersion", OLD."kpiKey", OLD."state"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "KpiDefinition_guard" AFTER INSERT OR UPDATE ON "KpiDefinition"
  FOR EACH ROW EXECUTE FUNCTION "factory_kpi_definition_guard"();
CREATE TRIGGER "KpiDefinition_delete_guard" BEFORE DELETE ON "KpiDefinition"
  FOR EACH ROW EXECUTE FUNCTION "factory_kpi_definition_delete_guard"();
CREATE TRIGGER "KpiDefinition_no_truncate" BEFORE TRUNCATE ON "KpiDefinition"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_insights_depth_refuse_truncate"();

-- One version in force per KPI.
CREATE UNIQUE INDEX "KpiDefinition_one_active" ON "KpiDefinition" ("tenantId", "kpiKey") WHERE "state" = 'ACTIVE';

-- =====================================================================================================================
-- KpiUse (ANA-070): where a KPI is read
--   INSERT     of a KPI that has a version in force (ACTIVE); the reader's key a code of 1 to 100; the key
--              `kpiuse:<kpiKey>:<usedIn>:<useKey>`.
--   UPDATE     refused unless it changes nothing: a use is added or removed, never changed. DELETE free.
CREATE FUNCTION "factory_kpi_use_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'kpis: use % of KPI % is added or removed, never changed', OLD."id", OLD."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_kpi_key_ok"(NEW."kpiKey")
     OR NOT EXISTS (SELECT 1 FROM "KpiDefinition" d WHERE d."tenantId" = NEW."tenantId" AND d."kpiKey" = NEW."kpiKey" AND d."state" = 'ACTIVE') THEN
    RAISE EXCEPTION 'kpis: a reader reads a KPI that is in force (an ACTIVE version of %)', NEW."kpiKey"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_privacy_ops_code_ok"(NEW."useKey", 100) THEN
    RAISE EXCEPTION 'kpis: use % names its reader by its key (a dashboard, a report, an alert rule kind, a portal page), 1 to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'kpiuse:' || NEW."kpiKey" || ':' || NEW."usedIn"::text || ':' || NEW."useKey") THEN
    RAISE EXCEPTION 'kpis: the key of use % is kpiuse:<kpiKey>:<usedIn>:<useKey> (each reader once per KPI)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "KpiUse_guard" AFTER INSERT OR UPDATE ON "KpiUse"
  FOR EACH ROW EXECUTE FUNCTION "factory_kpi_use_guard"();

-- =====================================================================================================================
-- DashboardLayout (ANA-002): one person's arrangement of one dashboard
--   INSERT     of an office user.
--   every row  the dashboard's key (lower-case words joined by dashes, 1 to 60); the key `dashboard:<userId>:<dashboardKey>`;
--              the panels (factory_insights_depth_panels_ok).
--   UPDATE     an UPDATE that changes nothing passes; the person, the dashboard, the key and the creation never change.
--   DELETE     free (back to the dashboard's own order).
CREATE FUNCTION "factory_dashboard_layout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."userId", NEW."dashboardKey", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."userId", OLD."dashboardKey", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'dashboards: the person, the dashboard and the key of layout % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT u."audience"::text INTO user_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF user_audience IS DISTINCT FROM 'OFFICE' THEN
      RAISE EXCEPTION 'dashboards: layout % is an office person''s arrangement', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."dashboardKey" IS NULL OR char_length(NEW."dashboardKey") > 60 OR NEW."dashboardKey" !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'dashboards: layout % names its dashboard by its key (owner-group), lower-case words joined by dashes, up to 60 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'dashboard:' || NEW."userId"::text || ':' || NEW."dashboardKey") THEN
    RAISE EXCEPTION 'dashboards: the key of layout % is dashboard:<userId>:<dashboardKey> (one per person and dashboard)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_panels_ok"(NEW."panels") THEN
    RAISE EXCEPTION 'dashboards: layout % lists 1 to 40 panels in order, each { id, hidden, width: HALF | TWO_THIRDS | FULL }, each id once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DashboardLayout_guard" AFTER INSERT OR UPDATE ON "DashboardLayout"
  FOR EACH ROW EXECUTE FUNCTION "factory_dashboard_layout_guard"();

-- =====================================================================================================================
-- InsightsSettings (ANA-032; the Owner's rule of 11-13): a company's switch for the morning e-mail, OFF by default
--   every row  the key `insights:<companyId>`; on exactly with when and by whom, not in the future.
--   UPDATE     an UPDATE that changes nothing passes; the company, the key and the creation never change; while on, when
--              and by whom it was switched on never change. Switching off is always allowed.
--   DELETE     refused (the record of who switched the e-mail on). TRUNCATE refused.
CREATE FUNCTION "factory_insights_settings_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'insights: the company and the key of settings % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."digestMailOn" AND NEW."digestMailOn"
       AND (NEW."digestMailOnAt", NEW."digestMailOnById") IS DISTINCT FROM (OLD."digestMailOnAt", OLD."digestMailOnById") THEN
      RAISE EXCEPTION 'insights: while the morning e-mail of company % is on, when and by whom it was switched on never change', OLD."companyId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'insights:' || NEW."companyId"::text) THEN
    RAISE EXCEPTION 'insights: the key of settings % is insights:<companyId> (one per company)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."digestMailOn" <> (NEW."digestMailOnAt" IS NOT NULL) OR (NEW."digestMailOnAt" IS NULL) <> (NEW."digestMailOnById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."digestMailOnAt") THEN
    RAISE EXCEPTION 'insights: the morning e-mail of company % is switched on with when and by whom, set exactly while on, not in the future', NEW."companyId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_insights_settings_never_deleted"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'insights: the settings of company % are switched off, never deleted', OLD."companyId"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER "InsightsSettings_guard" AFTER INSERT OR UPDATE ON "InsightsSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_insights_settings_guard"();
CREATE TRIGGER "InsightsSettings_never_deleted" BEFORE DELETE ON "InsightsSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_insights_settings_never_deleted"();
CREATE TRIGGER "InsightsSettings_no_truncate" BEFORE TRUNCATE ON "InsightsSettings"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_insights_depth_refuse_truncate"();

-- =====================================================================================================================
-- DigestSetting (ANA-032): one person's morning e-mail
--   INSERT     of an office user; never sent yet (lastSentAt empty).
--   every row  the key `digest:<userId>`; on exactly with when and by whom, not in the future; the time HH:MM, a known time
--              zone, ISO weekdays (factory_insights_depth_weekdays_ok), the language `it` or `en`, at least one section, each
--              once; the last time it went out not in the future.
--   UPDATE     an UPDATE that changes nothing passes; the person, the key and the creation never change; while on, when and
--              by whom it was turned on never change; the last time it went out only moves forward, and only while it is on
--              and its company's switch is on (InsightsSettings.digestMailOn, read FOR SHARE: a switch-off and a send take
--              turns; a group digest needs at least one company of the tenant switched on).
--   DELETE     free.
CREATE FUNCTION "factory_digest_setting_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  user_audience text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."userId", NEW."key", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."userId", OLD."key", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'digest: the person and the key of digest % never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."enabled" AND NEW."enabled" AND (NEW."enabledAt", NEW."enabledById") IS DISTINCT FROM (OLD."enabledAt", OLD."enabledById") THEN
      RAISE EXCEPTION 'digest: while digest % is on, when and by whom it was turned on never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."lastSentAt" IS NOT NULL AND (NEW."lastSentAt" IS NULL OR NEW."lastSentAt" < OLD."lastSentAt") THEN
      RAISE EXCEPTION 'digest: the last time digest % went out only moves forward', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lastSentAt" IS DISTINCT FROM OLD."lastSentAt" THEN
      IF NOT NEW."enabled" THEN
        RAISE EXCEPTION 'digest: digest % goes out only while it is on', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
      PERFORM 1 FROM "InsightsSettings" s
        WHERE s."tenantId" = NEW."tenantId" AND s."digestMailOn" AND (NEW."companyId" IS NULL OR s."companyId" = NEW."companyId")
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'digest: digest % goes out only while its company''s morning e-mail is switched on (OFF by default: the Owner''s rule)', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    SELECT u."audience"::text INTO user_audience FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF user_audience IS DISTINCT FROM 'OFFICE' THEN
      RAISE EXCEPTION 'digest: digest % is an office person''s morning e-mail', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."lastSentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'digest: digest % is set before it first goes out (no last time yet)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'digest:' || NEW."userId"::text) THEN
    RAISE EXCEPTION 'digest: the key of digest % is digest:<userId> (one per person)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."enabled" <> (NEW."enabledAt" IS NOT NULL) OR (NEW."enabledAt" IS NULL) <> (NEW."enabledById" IS NULL)
     OR NOT "factory_recall_not_future"(NEW."enabledAt") THEN
    RAISE EXCEPTION 'digest: digest % is turned on with when and by whom, set exactly while on, not in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sendTime" IS NULL OR NEW."sendTime" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'digest: digest % goes out at a time of day HH:MM (07:30)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_zone_ok"(NEW."timeZone") THEN
    RAISE EXCEPTION 'digest: digest % keeps the clock of a known time zone (Europe/Rome), not %', NEW."id", NEW."timeZone"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_weekdays_ok"(NEW."weekdays") THEN
    RAISE EXCEPTION 'digest: digest % goes out on ISO weekdays 1 (Monday) to 7 (Sunday), ascending, each once, at least one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."locale" IS NULL OR NEW."locale" NOT IN ('it', 'en') THEN
    RAISE EXCEPTION 'digest: digest % is written in Italian (it) or English (en)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sections" IS NULL OR cardinality(NEW."sections") < 1 OR NOT "factory_styles_distinct"(NEW."sections") THEN
    RAISE EXCEPTION 'digest: digest % lists at least one section, each once', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."lastSentAt") THEN
    RAISE EXCEPTION 'digest: digest % did not go out in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "DigestSetting_guard" AFTER INSERT OR UPDATE ON "DigestSetting"
  FOR EACH ROW EXECUTE FUNCTION "factory_digest_setting_guard"();

-- =====================================================================================================================
-- AlertRoute (ANA-041): who an alert rule tells at one place
--   INSERT     exactly one of an office role that is not archived and an office person who is invited or active; the place
--              exists: a company, a site, a line, or a customer (a party with the CUSTOMER or BRAND role); it never widens
--              its rule's place (a company's rule routes inside that company; a site's rule routes the site, its lines or a
--              customer, never a whole company); the key `route:<ruleId>:<scope>:<scopeId>:role:<roleId>` or
--              `…:user:<userId>`.
--   UPDATE     refused unless it changes nothing: a route is added or removed, never changed. DELETE free.
CREATE FUNCTION "factory_alert_route_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rule_company uuid;
  rule_site uuid;
  place_company uuid;
  place_site uuid;
  found_place boolean;
  role_audience text;
  role_archived timestamptz;
  user_audience text;
  user_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'alerts: route % is added or removed, never changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."roleId" IS NULL) = (NEW."userId" IS NULL) THEN
    RAISE EXCEPTION 'alerts: route % tells the holders of one office role or one office person, exactly one', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'route:' || NEW."ruleId"::text || ':' || NEW."scope"::text || ':' || NEW."scopeId"::text
       || CASE WHEN NEW."roleId" IS NOT NULL THEN ':role:' || NEW."roleId"::text ELSE ':user:' || NEW."userId"::text END) THEN
    RAISE EXCEPTION 'alerts: the key of route % is route:<ruleId>:<scope>:<scopeId>:role:<roleId> or …:user:<userId> (each recipient once per rule and place)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."roleId" IS NOT NULL THEN
    SELECT r."audience"::text, r."archivedAt" INTO role_audience, role_archived FROM "Role" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."roleId";
    IF role_audience IS DISTINCT FROM 'OFFICE' OR role_archived IS NOT NULL THEN
      RAISE EXCEPTION 'alerts: route % tells the holders of an office role that is not archived', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT u."audience"::text, u."status"::text INTO user_audience, user_status FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = NEW."userId";
    IF user_audience IS DISTINCT FROM 'OFFICE' OR user_status NOT IN ('INVITED', 'ACTIVE') THEN
      RAISE EXCEPTION 'alerts: route % tells an office person who is invited or active', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT r."companyId", r."siteId" INTO rule_company, rule_site FROM "AlertRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ruleId";
  IF NEW."scope" = 'COMPANY' THEN
    SELECT c."id", NULL::uuid INTO place_company, place_site FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."scopeId";
    found_place := FOUND;
  ELSIF NEW."scope" = 'SITE' THEN
    SELECT s."companyId", s."id" INTO place_company, place_site FROM "Site" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."scopeId";
    found_place := FOUND;
  ELSIF NEW."scope" = 'LINE' THEN
    SELECT l."companyId", l."siteId" INTO place_company, place_site FROM "Line" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."scopeId";
    found_place := FOUND;
  ELSE
    SELECT p."companyId", NULL::uuid INTO place_company, place_site FROM "Party" p
     WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."scopeId" AND p."roles" && ARRAY['CUSTOMER', 'BRAND']::"PartyRole"[];
    found_place := FOUND;
  END IF;
  IF NOT found_place THEN
    RAISE EXCEPTION 'alerts: route % names a % that does not exist (a customer: a party we sell to, or a brand)', NEW."id", lower(NEW."scope"::text)
      USING ERRCODE = 'check_violation';
  END IF;
  IF rule_company IS NOT NULL AND place_company IS DISTINCT FROM rule_company AND NOT (NEW."scope" = 'CUSTOMER' AND place_company IS NULL) THEN
    RAISE EXCEPTION 'alerts: route % never widens its rule''s place: the rule looks at company %, the % is of another', NEW."id", rule_company, lower(NEW."scope"::text)
      USING ERRCODE = 'check_violation';
  END IF;
  IF rule_site IS NOT NULL AND (NEW."scope" = 'COMPANY' OR (NEW."scope" IN ('SITE', 'LINE') AND place_site IS DISTINCT FROM rule_site)) THEN
    RAISE EXCEPTION 'alerts: route % never widens its rule''s place: the rule looks at site %, the route at a whole company or another site', NEW."id", rule_site
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "AlertRoute_guard" AFTER INSERT OR UPDATE ON "AlertRoute"
  FOR EACH ROW EXECUTE FUNCTION "factory_alert_route_guard"();

-- =====================================================================================================================
-- FactDaily, FactHourly (ANA-069): facts rebuilt from the ledgers
--   every row  a line's fact names its site; the measure a dotted key; exactly one number (value, priceAmount, costAmount,
--              marginAmount); the currency exactly with an amount, the company's; rebuilt not in the future.
--              FactDaily: the key `fact:<companyId>:<siteId | all>:<lineId | all>:<YYYY-MM-DD>:<measureKey>`; the day today
--              at the latest on the site's clock (else the company's).
--              FactHourly: the start of the hour a whole hour on that clock and not in the future; its day the business day
--              of that hour on that clock; the key `facth:<companyId>:<siteId | all>:<lineId | all>:<hourStart in UTC as
--              YYYY-MM-DDTHH:MMZ>:<measureKey>`.
--   UPDATE     an UPDATE that changes nothing passes; the place, the day or hour, the measure, the key and the creation
--              never change (a rebuild writes the numbers); rebuiltAt never goes back.
--   DELETE     free (a rebuild deletes and writes again).
CREATE FUNCTION "factory_fact_numbers_check"(fact record, company_currency text) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF (fact."value" IS NOT NULL)::int + (fact."priceAmount" IS NOT NULL)::int + (fact."costAmount" IS NOT NULL)::int + (fact."marginAmount" IS NOT NULL)::int <> 1 THEN
    RAISE EXCEPTION 'facts: fact % holds exactly one number: a value, or an amount at price, at cost or of margin', fact."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (fact."value" IS NULL AND fact."currency" IS DISTINCT FROM company_currency) OR (fact."value" IS NOT NULL AND fact."currency" IS NOT NULL) THEN
    RAISE EXCEPTION 'facts: fact % names the company''s currency (%) exactly with an amount', fact."id", company_currency
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION "factory_fact_daily_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone text;
  company_currency text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."lineId", NEW."day", NEW."measureKey", NEW."key", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."lineId", OLD."day", OLD."measureKey", OLD."key", OLD."createdAt") THEN
      RAISE EXCEPTION 'facts: the place, the day and the measure of fact % never change (a rebuild writes its numbers)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."rebuiltAt" < OLD."rebuiltAt" THEN
      RAISE EXCEPTION 'facts: fact % is rebuilt forward in time (rebuiltAt never goes back)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lineId" IS NOT NULL AND NEW."siteId" IS NULL THEN
    RAISE EXCEPTION 'facts: the fact % of a line names the line''s site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_dotted_ok"(NEW."measureKey") THEN
    RAISE EXCEPTION 'facts: fact % names its measure by a dotted key (orders.lines_in), up to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'fact:' || NEW."companyId"::text || ':' || COALESCE(NEW."siteId"::text, 'all') || ':'
       || COALESCE(NEW."lineId"::text, 'all') || ':' || to_char(NEW."day", 'YYYY-MM-DD') || ':' || NEW."measureKey") THEN
    RAISE EXCEPTION 'facts: the key of fact % is fact:<companyId>:<siteId | all>:<lineId | all>:<YYYY-MM-DD>:<measureKey> (one per place, day and measure)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."currency" INTO company_currency FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."companyId";
  PERFORM "factory_fact_numbers_check"(NEW, company_currency);
  zone := "factory_insights_depth_zone_of"(NEW."tenantId", NEW."companyId", NEW."siteId");
  IF NEW."day" > (now() AT TIME ZONE zone)::date THEN
    RAISE EXCEPTION 'facts: fact % is of a day that has begun (today at the latest on the clock of %)', NEW."id", zone
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."rebuiltAt") THEN
    RAISE EXCEPTION 'facts: fact % was not rebuilt in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION "factory_fact_hourly_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone text;
  company_currency text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."siteId", NEW."lineId", NEW."hourStart", NEW."day", NEW."measureKey", NEW."key", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."siteId", OLD."lineId", OLD."hourStart", OLD."day", OLD."measureKey", OLD."key", OLD."createdAt") THEN
      RAISE EXCEPTION 'facts: the place, the hour and the measure of fact % never change (a rebuild writes its numbers)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."rebuiltAt" < OLD."rebuiltAt" THEN
      RAISE EXCEPTION 'facts: fact % is rebuilt forward in time (rebuiltAt never goes back)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."lineId" IS NOT NULL AND NEW."siteId" IS NULL THEN
    RAISE EXCEPTION 'facts: the fact % of a line names the line''s site', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_dotted_ok"(NEW."measureKey") THEN
    RAISE EXCEPTION 'facts: fact % names its measure by a dotted key (orders.lines_in), up to 100 characters', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_insights_depth_key_ok"(NEW."key", 'facth:' || NEW."companyId"::text || ':' || COALESCE(NEW."siteId"::text, 'all') || ':'
       || COALESCE(NEW."lineId"::text, 'all') || ':' || to_char(NEW."hourStart" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') || ':' || NEW."measureKey") THEN
    RAISE EXCEPTION 'facts: the key of fact % is facth:<companyId>:<siteId | all>:<lineId | all>:<YYYY-MM-DDTHH:MMZ>:<measureKey> (one per place, hour and measure)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c."currency" INTO company_currency FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."companyId";
  PERFORM "factory_fact_numbers_check"(NEW, company_currency);
  zone := "factory_insights_depth_zone_of"(NEW."tenantId", NEW."companyId", NEW."siteId");
  IF (NEW."hourStart" AT TIME ZONE zone) <> date_trunc('hour', NEW."hourStart" AT TIME ZONE zone) OR NEW."hourStart" > now() THEN
    RAISE EXCEPTION 'facts: fact % starts at a whole hour of the clock of % that has begun', NEW."id", zone
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."day" <> (NEW."hourStart" AT TIME ZONE zone)::date THEN
    RAISE EXCEPTION 'facts: fact % names the business day its hour belongs to on the clock of %', NEW."id", zone
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_not_future"(NEW."rebuiltAt") THEN
    RAISE EXCEPTION 'facts: fact % was not rebuilt in the future', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "FactDaily_guard" AFTER INSERT OR UPDATE ON "FactDaily"
  FOR EACH ROW EXECUTE FUNCTION "factory_fact_daily_guard"();
CREATE TRIGGER "FactHourly_guard" AFTER INSERT OR UPDATE ON "FactHourly"
  FOR EACH ROW EXECUTE FUNCTION "factory_fact_hourly_guard"();
