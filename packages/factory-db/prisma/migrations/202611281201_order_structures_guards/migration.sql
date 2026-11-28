-- Written by hand (Prisma does not model triggers), after the generated 202611281200_order_structures_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The S3 schema wave "structures + units" (order workflow build, lane owb-, S3 PR owb-ssw; design order-workflow-build-2026-11-27
-- plan.md § 5 (the Owner's yes of 2026-11-28 07:22), plan/PL-schema.md § 5B item 2 as the S3 lead settled it in
-- build/briefs/_owb-ss-common.md L9 and L10: own tables, all additive, no column on SalesOrder or SalesOrderLine, no LineLoan
-- change). apps/factory-api checks all of this first and answers in words (S3's ss5 units and ss6 structures); these rules are
-- the last word, for every login, the owner included. The refusals are check_violation (SQLSTATE 23514), plain sentences that
-- reach the screen as 409s; they name no customer (the brand wall: "One brand must not be able to see anything related to any
-- other brand") and no office person. The checks are AFTER triggers (the policies speak first); the append-only triggers are
-- BEFORE, as their neighbours'. A rule that reads another row reads only what the role that fires it may read and skips a row
-- this session cannot see — except the design file a scan code is placed on: one this session cannot open is refused, never
-- skipped. Two keys are partial unique indexes (a duplicate is a unique_violation that names the index; the API says it in
-- words first): OrderStructureRule_open_same_orders(_any_kind) and OrderStructureOverride_one_open.
--
-- NEW here:
--   factory_team_unit_check                       + trigger Team_unit_check (AFTER INSERT OR UPDATE OF the unit columns and
--                                                 "status" ON "Team"): the owner's word 1 to 40 trimmed; what it does 1 to
--                                                 500; the most baskets 1 or more; the stand-in's last day only beside the
--                                                 stand-in; the customers it works for each once, customers of its company;
--                                                 never under itself nor merged into itself; a merged unit is archived; the
--                                                 unit above and the unit merged into open when set; no cycle (the walk up,
--                                                 under a transaction lock per tenant), at most 50 deep. The same company is
--                                                 the foreign keys' (parent, merged into, stand-in: tenantId + companyId).
--   factory_order_structure_guard                 + triggers OrderStructure_guard, OrderStructure_no_truncate: born open at
--                                                 version 1; the company and creation never change; the version goes up by
--                                                 one; a name of 1 to 80 trimmed; a note of 1 to 500; closed with when and
--                                                 who, both or neither; each team and person once; teams of its company,
--                                                 open when named; people active office people when named; no DELETE.
--   factory_order_structure_rule_guard            + triggers OrderStructureRule_guard, OrderStructureRule_no_truncate; indexes
--                                                 OrderStructureRule_open_same_orders (a kind named) and
--                                                 OrderStructureRule_open_same_orders_any_kind (any kind): two OPEN rules of
--                                                 a company never fit exactly the same orders (the same customer or any, the
--                                                 same kind or any). Born open at version 1; the company and creation never
--                                                 change; the version goes up by one; its place 1 or more; a note of 1 to
--                                                 500; closed with when and who, both or neither; a customer of its company;
--                                                 an open rule gives an open structure (checked when the rule is made,
--                                                 reopened or given another structure: a structure closed later is flagged
--                                                 by the API, not refused); no DELETE.
--   factory_order_structure_override_guard        + triggers OrderStructureOverride_guard, OrderStructureOverride_no_truncate;
--                                                 index OrderStructureOverride_one_open: one open row per order; born open,
--                                                 with an open structure; only ended (when and who, both, once), then never
--                                                 changed; normalWay exactly when no structure; why 3 to 500 trimmed; no
--                                                 DELETE.
--   OrderLineStructureKept                        append-only: triggers OrderLineStructureKept_append_only,
--                                                 OrderLineStructureKept_no_truncate (factory_refuse_production_ledger_change,
--                                                 as BundleReprint's and OrderPrint's), and
--   factory_order_line_structure_kept_check       + trigger OrderLineStructureKept_check: a line of its own order; RULE names
--                                                 the rule and the structure that rule gives, ORDER names no rule, NORMAL
--                                                 neither; the snapshot one object.
--   factory_scan_code_placement_guard             + triggers ScanCodePlacement_guard, ScanCodePlacement_no_truncate: at
--                                                 version 1, moved only on its own page (order, line, file, page never
--                                                 change), the version up by one; page 1 or more, x and y 0 or more, the
--                                                 side 20 mm or more; a line of its own order; the design file one this
--                                                 person can open, an image or a PDF (never a design source, a fiscal
--                                                 archive, a voice note, body data or a priced file, nor one deleted or
--                                                 quarantined), of the order's company and customer or of the whole factory,
--                                                 never another customer's. No DELETE trigger: the line or the file going
--                                                 takes its places with them (Cascade); no runtime role may delete one.
--
-- No earlier function is REDEFINED. Team_guard (…_people_w2b_guards, BEFORE) is untouched and still speaks first on Team.
-- USED FROM EARLIER WAVES, as they are: "factory_refuse_production_ledger_change" (…_production_guards),
-- "factory_order_workflow_refuse_truncate" (…_order_workflow_guards), "factory_file_record_party"
-- (…_files_record_party_th_guards), "factory_files_type_of" and "factory_files_is_design_type" (…_files_measurements_th_guards).

-- =====================================================================================================================
-- Team (people.prisma; owb-ssw w.1, w.4): the team as a unit of the factory's structure.
--   every row  the owner's word for it 1 to 40 characters, trimmed; what it does 1 to 500, not blank; the most baskets at once
--              1 or more; the stand-in's last day only beside the stand-in; the customers it works for each once, customers
--              of the tenant of no other company (when the list changes).
--   the tree   never under itself nor merged into itself; a merged unit is ARCHIVED; the unit above and the unit it is merged
--              into are open (ACTIVE) when set or changed; no cycle: the walk up from the new unit above never meets this
--              unit, and stops at 50 units (read under a transaction lock per tenant, so two moves at once wait for each
--              other). The same company is the foreign keys' (tenantId, companyId, …).
-- Closing a unit is today's archive (Team_guard: only with nobody in it); the API refuses it while units sit under it or
-- orders are open on it.
CREATE FUNCTION "factory_team_unit_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  set_parent boolean;
  set_merged boolean;
  set_parties boolean;
  target_status text;
  walker uuid;
  depth integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    set_parent := NEW."parentTeamId" IS NOT NULL;
    set_merged := NEW."mergedIntoId" IS NOT NULL;
    set_parties := true;
  ELSE
    IF (NEW."parentTeamId", NEW."kindWord", NEW."about", NEW."maxBaskets", NEW."standInEmployeeId", NEW."standInUntil", NEW."worksForPartyIds", NEW."mergedIntoId", NEW."status")
       IS NOT DISTINCT FROM (OLD."parentTeamId", OLD."kindWord", OLD."about", OLD."maxBaskets", OLD."standInEmployeeId", OLD."standInUntil", OLD."worksForPartyIds", OLD."mergedIntoId", OLD."status") THEN
      RETURN NULL;
    END IF;
    set_parent := NEW."parentTeamId" IS NOT NULL AND NEW."parentTeamId" IS DISTINCT FROM OLD."parentTeamId";
    set_merged := NEW."mergedIntoId" IS NOT NULL AND NEW."mergedIntoId" IS DISTINCT FROM OLD."mergedIntoId";
    set_parties := NEW."worksForPartyIds" IS DISTINCT FROM OLD."worksForPartyIds";
  END IF;
  IF NEW."kindWord" IS NOT NULL AND (btrim(NEW."kindWord") <> NEW."kindWord" OR NEW."kindWord" = '' OR length(NEW."kindWord") > 40) THEN
    RAISE EXCEPTION 'people: the word for unit % is 1 to 40 characters, with no space at either end', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."about" IS NOT NULL AND (btrim(NEW."about") = '' OR length(NEW."about") > 500) THEN
    RAISE EXCEPTION 'people: what unit % does is said in 1 to 500 characters', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."maxBaskets" IS NOT NULL AND NEW."maxBaskets" < 1 THEN
    RAISE EXCEPTION 'people: unit % takes at least 1 basket at once, or has no limit', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."standInUntil" IS NOT NULL AND NEW."standInEmployeeId" IS NULL THEN
    RAISE EXCEPTION 'people: unit % names who stands in for its leader before the day they stand in until', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."worksForPartyIds" IS NULL
     OR cardinality(NEW."worksForPartyIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."worksForPartyIds") AS x) THEN
    RAISE EXCEPTION 'people: unit % names each customer it works for once', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF set_parties AND cardinality(NEW."worksForPartyIds") > 0
     AND EXISTS (SELECT 1 FROM unnest(NEW."worksForPartyIds") AS x(id)
                  WHERE NOT EXISTS (SELECT 1 FROM "Party" p
                                     WHERE p."tenantId" = NEW."tenantId" AND p."id" = x.id AND (p."companyId" IS NULL OR p."companyId" = NEW."companyId"))) THEN
    RAISE EXCEPTION 'people: the customers unit % works for are customers of its own company', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."parentTeamId" = NEW."id" OR NEW."mergedIntoId" = NEW."id" THEN
    RAISE EXCEPTION 'people: unit % never sits under itself nor is merged into itself', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mergedIntoId" IS NOT NULL AND NEW."status"::text <> 'ARCHIVED' THEN
    RAISE EXCEPTION 'people: unit % was merged into another unit; a merged unit is closed (archived)', NEW."code"
      USING ERRCODE = 'check_violation';
  END IF;
  IF set_merged THEN
    SELECT t."status"::text INTO target_status FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."mergedIntoId";
    IF FOUND AND target_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'people: unit % is merged into an open unit; that one is closed', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF set_parent THEN
    SELECT t."status"::text INTO target_status FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."parentTeamId";
    IF FOUND AND target_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'people: unit % sits under an open unit; that one is closed', NEW."code"
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.team-units', NEW."tenantId"), 0));
    walker := NEW."parentTeamId";
    WHILE walker IS NOT NULL LOOP
      IF walker = NEW."id" THEN
        RAISE EXCEPTION 'people: unit % cannot sit under a unit that sits under it; move that unit first', NEW."code"
          USING ERRCODE = 'check_violation';
      END IF;
      depth := depth + 1;
      IF depth >= 50 THEN
        RAISE EXCEPTION 'people: unit % would sit 50 or more units deep; the structure is kept under 50 levels', NEW."code"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT t."parentTeamId" INTO walker FROM "Team" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = walker;
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Team_unit_check" AFTER INSERT OR UPDATE OF "parentTeamId", "kindWord", "about", "maxBaskets", "standInEmployeeId", "standInUntil", "worksForPartyIds", "mergedIntoId", "status" ON "Team"
  FOR EACH ROW EXECUTE FUNCTION "factory_team_unit_check"();

-- =====================================================================================================================
-- OrderStructure (structures.prisma; owb-ssw w.2, w.4): one order structure of a company.
--   INSERT     open (not closed), at version 1.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change; the version goes up by one.
--   every row  a name of 1 to 80 characters, trimmed; a note of 1 to 500, not blank; closed with when and who, both or
--              neither (reopened: both cleared); each team and each person once; when the list changes, the teams are teams
--              of its company — a team newly named is open (ACTIVE), one already named may since have closed — and the people
--              office people (audience OFFICE) — one newly named is ACTIVE.
--   DELETE     refused (closed instead: its rules and kept lines name it). TRUNCATE refused.
CREATE FUNCTION "factory_order_structure_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_teams uuid[] := '{}';
  old_people uuid[] := '{}';
  set_teams boolean := true;
  set_people boolean := true;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: an order structure is closed, never deleted (its rules and the orders that kept it name it)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new order structure is open, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company and the creation of order structure "%" never change', OLD."name"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'production: the version of order structure "%" goes up by one', OLD."name"
        USING ERRCODE = 'check_violation';
    END IF;
    old_teams := coalesce(OLD."teamIds", '{}');
    old_people := coalesce(OLD."peopleUserIds", '{}');
    set_teams := NEW."teamIds" IS DISTINCT FROM OLD."teamIds";
    set_people := NEW."peopleUserIds" IS DISTINCT FROM OLD."peopleUserIds";
  END IF;
  IF NEW."name" IS NULL OR btrim(NEW."name") <> NEW."name" OR NEW."name" = '' OR length(NEW."name") > 80 THEN
    RAISE EXCEPTION 'production: an order structure has a name of 1 to 80 characters, with no space at either end'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 500) THEN
    RAISE EXCEPTION 'production: the note of order structure "%" is 1 to 500 characters', NEW."name"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedAt" IS NULL) <> (NEW."closedById" IS NULL) THEN
    RAISE EXCEPTION 'production: order structure "%" is closed with when and who, both or neither', NEW."name"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."teamIds" IS NULL OR NEW."peopleUserIds" IS NULL
     OR cardinality(NEW."teamIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."teamIds") AS x)
     OR cardinality(NEW."peopleUserIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."peopleUserIds") AS x) THEN
    RAISE EXCEPTION 'production: order structure "%" names each team and each person once', NEW."name"
      USING ERRCODE = 'check_violation';
  END IF;
  IF set_teams AND EXISTS (SELECT 1 FROM unnest(NEW."teamIds") AS x(id)
                            WHERE NOT EXISTS (SELECT 1 FROM "Team" t
                                               WHERE t."tenantId" = NEW."tenantId" AND t."id" = x.id AND t."companyId" = NEW."companyId"
                                                 AND (t."status"::text = 'ACTIVE' OR x.id = ANY (old_teams)))) THEN
    RAISE EXCEPTION 'production: the teams of order structure "%" are open teams of its own company', NEW."name"
      USING ERRCODE = 'check_violation';
  END IF;
  IF set_people AND EXISTS (SELECT 1 FROM unnest(NEW."peopleUserIds") AS x(id)
                             WHERE NOT EXISTS (SELECT 1 FROM "User" u
                                                WHERE u."tenantId" = NEW."tenantId" AND u."id" = x.id AND u."audience"::text = 'OFFICE'
                                                  AND (u."status"::text = 'ACTIVE' OR x.id = ANY (old_people)))) THEN
    RAISE EXCEPTION 'production: the people of order structure "%" are active office people', NEW."name"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderStructure_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderStructure"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_structure_guard"();
CREATE TRIGGER "OrderStructure_no_truncate" BEFORE TRUNCATE ON "OrderStructure"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- =====================================================================================================================
-- OrderStructureRule (structures.prisma; owb-ssw w.2, w.4): one rule of a company's list.
--   INSERT     open (not closed), at version 1.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change; the version goes up by one.
--   every row  its place 1 or more; a note of 1 to 500, not blank; closed with when and who, both or neither; the customer
--              (when named or changed) a party of the tenant of no other company than the rule's; an open rule gives an open
--              structure, checked when the rule is made, reopened or given another structure (a structure closed later is
--              flagged on the list by the API, never refused here).
--   DELETE     refused (closed instead: the orders that kept it name it). TRUNCATE refused.
-- Partial uniques: two OPEN rules of a company never fit exactly the same orders — the same customer (or both any customer)
-- and the same kind of product (OrderStructureRule_open_same_orders) or both any kind
-- (OrderStructureRule_open_same_orders_any_kind). Two indexes, not one over coalesce(category): a cast of an enum to text is
-- not immutable, and NULLS NOT DISTINCT is used nowhere else in this schema.
CREATE FUNCTION "factory_order_structure_rule_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  set_party boolean := true;
  check_structure boolean := true;
  party_company uuid;
  structure_closed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: a structure rule is closed, never deleted (rule %)', OLD."sortOrder"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."closedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new structure rule is open, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: the company and the creation of structure rule % never change', OLD."sortOrder"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'production: the version of structure rule % goes up by one', OLD."sortOrder"
        USING ERRCODE = 'check_violation';
    END IF;
    set_party := NEW."partyId" IS DISTINCT FROM OLD."partyId";
    check_structure := OLD."closedAt" IS NOT NULL OR NEW."structureId" IS DISTINCT FROM OLD."structureId";
  END IF;
  IF NEW."sortOrder" < 1 THEN
    RAISE EXCEPTION 'production: a structure rule has its place on the list, 1 or more'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."note" IS NOT NULL AND (btrim(NEW."note") = '' OR length(NEW."note") > 500) THEN
    RAISE EXCEPTION 'production: the note of structure rule % is 1 to 500 characters', NEW."sortOrder"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."closedAt" IS NULL) <> (NEW."closedById" IS NULL) THEN
    RAISE EXCEPTION 'production: structure rule % is closed with when and who, both or neither', NEW."sortOrder"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."partyId" IS NOT NULL AND set_party THEN
    SELECT p."companyId" INTO party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF FOUND AND party_company IS NOT NULL AND party_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'production: structure rule % names a customer of its own company', NEW."sortOrder"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."closedAt" IS NULL AND check_structure THEN
    SELECT s."closedAt" INTO structure_closed FROM "OrderStructure" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."structureId";
    IF structure_closed IS NOT NULL THEN
      RAISE EXCEPTION 'production: structure rule % gives a closed structure; an open rule gives an open structure (reopen it, or pick another)', NEW."sortOrder"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderStructureRule_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderStructureRule"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_structure_rule_guard"();
CREATE TRIGGER "OrderStructureRule_no_truncate" BEFORE TRUNCATE ON "OrderStructureRule"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();
CREATE UNIQUE INDEX "OrderStructureRule_open_same_orders" ON "OrderStructureRule"
  ("tenantId", "companyId", (coalesce("partyId", '00000000-0000-0000-0000-000000000000'::uuid)), "category")
  WHERE "closedAt" IS NULL AND "category" IS NOT NULL;
CREATE UNIQUE INDEX "OrderStructureRule_open_same_orders_any_kind" ON "OrderStructureRule"
  ("tenantId", "companyId", (coalesce("partyId", '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE "closedAt" IS NULL AND "category" IS NULL;

-- =====================================================================================================================
-- OrderStructureOverride (structures.prisma; owb-ssw w.2, w.4): one order's structure by hand.
--   INSERT     open (not ended); a structure, when named, open (not closed).
--   UPDATE     an UPDATE that changes nothing passes; an ended row never changes again; otherwise only the end changes
--              (when and who).
--   every row  ended with when and who, both or neither; normalWay exactly when it names no structure; why 3 to 500
--              characters, trimmed.
--   DELETE     refused (ended instead: the order's history keeps it). TRUNCATE refused.
-- Partial unique: one open row per order (OrderStructureOverride_one_open). "Only before the order's first print" is the
-- API's (ss6), as the rights are.
CREATE FUNCTION "factory_order_structure_override_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  structure_closed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production: an order''s structure by hand is ended, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."endedAt" IS NOT NULL OR NEW."endedById" IS NOT NULL THEN
      RAISE EXCEPTION 'production: a new structure by hand is open (not ended)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."structureId" IS NOT NULL THEN
      SELECT s."closedAt" INTO structure_closed FROM "OrderStructure" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."structureId";
      IF structure_closed IS NOT NULL THEN
        RAISE EXCEPTION 'production: an order takes an open structure by hand; this structure is closed'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF OLD."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'production: this structure by hand was ended; it never changes again'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."structureId", NEW."normalWay", NEW."why", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."structureId", OLD."normalWay", OLD."why", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'production: a structure by hand is only ended (when and who); nothing else of it changes — give a new one instead'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW."endedAt" IS NULL) <> (NEW."endedById" IS NULL) THEN
    RAISE EXCEPTION 'production: a structure by hand is ended with when and who, both or neither'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."normalWay" <> (NEW."structureId" IS NULL) THEN
    RAISE EXCEPTION 'production: a structure by hand names a structure or is the normal way, exactly one of the two'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."why" IS NULL OR btrim(NEW."why") <> NEW."why" OR length(NEW."why") < 3 OR length(NEW."why") > 500 THEN
    RAISE EXCEPTION 'production: why the order takes a structure by hand is said in 3 to 500 characters, with no space at either end'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderStructureOverride_guard" AFTER INSERT OR UPDATE OR DELETE ON "OrderStructureOverride"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_structure_override_guard"();
CREATE TRIGGER "OrderStructureOverride_no_truncate" BEFORE TRUNCATE ON "OrderStructureOverride"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();
CREATE UNIQUE INDEX "OrderStructureOverride_one_open" ON "OrderStructureOverride" ("tenantId", "salesOrderId") WHERE "endedAt" IS NULL;

-- =====================================================================================================================
-- OrderLineStructureKept (structures.prisma; owb-ssw w.2, w.4): append-only (scripts/factory/check-append-only.mjs) and its
-- INSERT rules.
CREATE TRIGGER "OrderLineStructureKept_append_only" BEFORE UPDATE OR DELETE ON "OrderLineStructureKept"
  FOR EACH ROW EXECUTE FUNCTION "factory_refuse_production_ledger_change"();
CREATE TRIGGER "OrderLineStructureKept_no_truncate" BEFORE TRUNCATE ON "OrderLineStructureKept"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_refuse_production_ledger_change"();

--   INSERT    a line of its own order; RULE names the rule and the structure that rule gives, ORDER (by hand on the order)
--             names no rule, NORMAL (the normal way) names neither; the snapshot is one object { steps, teams, people }.
CREATE FUNCTION "factory_order_line_structure_kept_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_order uuid;
  rule_structure uuid;
BEGIN
  SELECT l."orderId" INTO line_order FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND AND line_order <> NEW."salesOrderId" THEN
    RAISE EXCEPTION 'production: a line keeps its structure on its own order'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."keptFrom"::text = 'RULE' AND (NEW."ruleId" IS NULL OR NEW."structureId" IS NULL))
     OR (NEW."keptFrom"::text = 'ORDER' AND NEW."ruleId" IS NOT NULL)
     OR (NEW."keptFrom"::text = 'NORMAL' AND (NEW."ruleId" IS NOT NULL OR NEW."structureId" IS NOT NULL)) THEN
    RAISE EXCEPTION 'production: a structure kept from a RULE names the rule and its structure, one by hand on the ORDER names no rule, and the NORMAL way names neither'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ruleId" IS NOT NULL THEN
    SELECT r."structureId" INTO rule_structure FROM "OrderStructureRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ruleId";
    IF FOUND AND rule_structure IS DISTINCT FROM NEW."structureId" THEN
      RAISE EXCEPTION 'production: a structure kept from a rule is the structure that rule gives'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."snapshot" IS NULL OR jsonb_typeof(NEW."snapshot") <> 'object' THEN
    RAISE EXCEPTION 'production: a kept structure keeps what it was as one object { steps, teams, people }'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "OrderLineStructureKept_check" AFTER INSERT ON "OrderLineStructureKept"
  FOR EACH ROW EXECUTE FUNCTION "factory_order_line_structure_kept_check"();

-- =====================================================================================================================
-- ScanCodePlacement (production.prisma; owb-ssw w.3, w.4): where the scan code sits on a page of a line's design file.
--   INSERT     at version 1; a line of its own order; the design file one this person can open — an image (not a design
--              source: EPS, AI, PSD, a zip) or a PDF, never a fiscal archive, a voice note, body data (measurements, a body,
--              made-to-measure or fitting photo) or a priced file (the page goes to the floor), nor one deleted or
--              quarantined — of the order's company and customer or of the whole factory, never another customer's (by
--              the file's own party and by the record it is filed under).
--   UPDATE     an UPDATE that changes nothing passes; the order, line, file and page never change (another page is a new
--              place); the version goes up by one.
--   every row  page 1 or more; x and y 0 mm or more; the side 20 mm or more.
--   DELETE     no trigger: the line or the file going takes its places with them (Cascade); no runtime role may delete one
--              (the grants). TRUNCATE refused.
CREATE FUNCTION "factory_scan_code_placement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  line_order uuid;
  design record;
  design_type text;
  record_known boolean;
  record_party uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'production: a new place of a scan code is at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."salesOrderLineId", NEW."fileId", NEW."page")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."salesOrderLineId", OLD."fileId", OLD."page") THEN
      RAISE EXCEPTION 'production: a scan code moves on its own page; its order, line, file and page never change (another page is a new place)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'production: the version of a scan code''s place goes up by one'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."page" < 1 OR NEW."xMm" < 0 OR NEW."yMm" < 0 OR NEW."sizeMm" < 20 THEN
    RAISE EXCEPTION 'production: a scan code sits on page 1 or later, 0 mm or more from the top and left edges, and is at least 20 mm wide so the floor can read it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NULL;
  END IF;
  SELECT l."orderId" INTO line_order FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF FOUND AND line_order <> NEW."salesOrderId" THEN
    RAISE EXCEPTION 'production: a scan code is placed for a line of its own order'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT f."companyId" AS company, f."partyId" AS party, f."recordType" AS record_type, f."recordId" AS record, f."kind"::text AS kind,
         f."category"::text AS category, f."contentType" AS content_type, f."status"::text AS status, f."priced" AS priced
    INTO design
    FROM "StoredFile" f WHERE f."tenantId" = NEW."tenantId" AND f."id" = NEW."fileId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'production: the design page of a scan code is a file this person can open'
      USING ERRCODE = 'check_violation';
  END IF;
  design_type := "factory_files_type_of"(design.content_type);
  IF NOT ((design_type LIKE 'image/%' AND NOT "factory_files_is_design_type"(design_type)) OR design_type = 'application/pdf')
     OR design.kind IN ('FISCAL_ARCHIVE', 'AUDIO')
     OR coalesce(design.category IN ('MEASUREMENTS', 'BODY_PHOTO', 'MTM_PHOTO', 'FITTING_PHOTO'), false)
     OR design.status IN ('DELETED', 'QUARANTINED')
     OR design.priced THEN
    RAISE EXCEPTION 'production: a scan code is placed on an image or a PDF page the floor may see: never a design source, a fiscal archive, a voice note, body data or a priced file, nor one deleted or quarantined'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.known, r.party INTO record_known, record_party FROM "factory_file_record_party"(NEW."tenantId", design.record_type, design.record) r;
  IF (design.company IS NOT NULL AND design.company <> NEW."companyId")
     OR (design.party IS NOT NULL AND design.party <> NEW."partyId")
     OR (record_known AND record_party IS NOT NULL AND record_party <> NEW."partyId") THEN
    RAISE EXCEPTION 'production: a scan code is placed on a file of its own order''s company and customer, or of the whole factory; never another customer''s'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "ScanCodePlacement_guard" AFTER INSERT OR UPDATE ON "ScanCodePlacement"
  FOR EACH ROW EXECUTE FUNCTION "factory_scan_code_placement_guard"();
CREATE TRIGGER "ScanCodePlacement_no_truncate" BEFORE TRUNCATE ON "ScanCodePlacement"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();
