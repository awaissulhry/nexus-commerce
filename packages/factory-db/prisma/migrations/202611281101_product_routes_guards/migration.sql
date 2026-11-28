-- Written by hand (Prisma does not model triggers), after the generated 202611281100_product_routes_schema and before the
-- policy migration. When the migrations are renumbered, keep this file as it is under its new timestamp.

-- The S4 schema wave "routes" with "cost Keep" (order workflow build, lane owb-, S4 PR owb-pd2w; design
-- order-workflow-build-2026-11-27 plan.md § 5 (the Owner's yes of 2026-11-28 07:22: § 5 I, R59 "Keep"), plan/PL-schema.md § 5B
-- items 3 and 6 as the S4 lead settled them in build/briefs/_owb-pd-common.md (settles 1, 2, 3, 5, 8, 9) and
-- build/briefs/owb-pd-server.md steps 2.1, 3.2, 3.3). apps/factory-api checks all of this first and answers in words (S4's pd2
-- and pd3 server steps); these rules are the last word, for every login, the owner included. The refusals are
-- check_violation (SQLSTATE 23514), plain sentences that reach the screen as 409s; they name no customer and no route name (a
-- route's name is the factory's words and may hold a customer's: the brand wall), and no office person. The new checks are
-- AFTER triggers (the policies speak first); the revision's part rule reused for the style routes is BEFORE, as on its other
-- tables. A rule that reads another row reads only what the role that fires it may read and skips a row this session cannot
-- see — except the departments of "Only this order", which have no foreign key: one this session cannot see is refused.
--
-- NEW here:
--   StyleRoute, StyleRouteStep                    parts of the style revision: triggers StyleRoute_revision_guard,
--                                                 StyleRoute_no_truncate, StyleRouteStep_revision_guard,
--                                                 StyleRouteStep_no_truncate use the …_product_guards part rule
--                                                 (factory_style_revision_part_guard) AS IT IS: inserted, changed and
--                                                 deleted only while the revision is DRAFT, never moved to another
--                                                 revision, frozen once released (BEFORE, the revision FOR SHARE).
--   factory_style_route_check                     + trigger StyleRoute_check (AFTER INSERT OR UPDATE): born at version 1;
--                                                 the product, company and creation never change; the version goes up by
--                                                 one; a name of 1 to 80 trimmed (unique per revision: the generated key);
--                                                 its place 1 or more; a CUSTOMER route names its customer; the company the
--                                                 style's; the customer a party of the route's company or the whole factory,
--                                                 and the brand itself on a brand's own product.
--   factory_style_route_step_check                + trigger StyleRouteStep_check (AFTER INSERT OR UPDATE): never moved to
--                                                 another route; its place 1 or more; 0 to 10000 minutes or none; a
--                                                 department of the route's company or the whole factory; an operation of
--                                                 that department. A CLOSED department is not refused here: the API refuses
--                                                 one ADDED new (DEPARTMENT_CLOSED) and keeps a step that had it, and a
--                                                 revision copied into its next draft copies its steps as they are.
--   factory_route_template_guard                  + triggers RouteTemplate_guard, RouteTemplate_no_truncate; indexes
--                                                 RouteTemplate_open_name (a company's) and RouteTemplate_open_name_factory
--                                                 (the whole factory's): born OPEN at version 1; the company and creation
--                                                 never change; the version goes up by one; a name of 1 to 80 trimmed, once
--                                                 among the OPEN ones whatever its letter case; closed, never deleted.
--   factory_route_template_step_check             + triggers RouteTemplateStep_check, RouteTemplateStep_no_truncate: never
--                                                 moved to another ready-made route; its place 1 or more; 0 to 10000
--                                                 minutes or none; a department of the route's company or the whole
--                                                 factory (closed: as above).
--   factory_product_routes_step_ok(jsonb)         one step of "Only this order": { departmentId: a uuid, minutes: none or
--                                                 0 to 10000 }, no other key (IMMUTABLE; one test after the other).
--   factory_sales_order_line_route_guard          + triggers SalesOrderLineRoute_guard, SalesOrderLineRoute_no_truncate:
--                                                 nothing changes, is added or removed once the order has an OrderPrint of
--                                                 kind FIRST (the order row FOR SHARE, so a print and a route change wait
--                                                 for each other where the print locks the order) — the line going (its
--                                                 Cascade) takes its row along; born at version 1; the order, line and
--                                                 creation never change; the version goes up by one; a line of its own
--                                                 order; a picked route with when (by whom only beside it); the picked route
--                                                 of the line's product and revision (the RELEASED one when the line names
--                                                 none) and never another customer's (a MODEL route of any customer or of
--                                                 the order's, a CUSTOMER route of the order's); "Only this order" with its
--                                                 steps, why (1 to 500) and when, all or none, by whom only beside them;
--                                                 1 to 50 steps { departmentId, minutes }, each a department of the tenant of
--                                                 the order's company or the whole factory, minutes 0 to 10000 or none.
--   LabourRate (costing.prisma)                   index LabourRate_one_company_rate_per_kind_and_day and
--                                                 LabourRate_one_tenant_rate_per_department_and_day, and
--   factory_labour_rate_department_check          + trigger LabourRate_department_check (AFTER INSERT OR UPDATE OF
--                                                 "departmentId", "workCentreKind", "companyId"): the department never
--                                                 changes; it is of the rate's kind of work centre and of the rate's company
--                                                 (a rate of the whole factory: a department of the whole factory).
--   index BomLine_one_main                        at most one main material line per revision (BomLine.isMain).
--   factory_costing_settings_one_keeper_check     + trigger CostingSettings_one_keeper_check (AFTER INSERT OR UPDATE OF
--                                                 "oneKeeperAllowed", "companyId"): "one person may keep a cost" is switched
--                                                 on only on a company's own row.
--
-- NOT ADDITIVE (marked owb-pd2w where they are):
--   index LabourRate_one_tenant_rate_per_kind_and_day (…_costing_guards) is DROPPED and made again, the same name and columns,
--     with "departmentId" IS NULL added to its WHERE: a department's own rate of the whole factory has its own index. The
--     schema folder before this one replaced the generated key LabourRate_tenantId_companyId_workCentreKind_validFrom_key with
--     one that holds the department too, so a company's kind rate per day is the new partial unique above.
--   factory_cost_sheet_guard (…_cost_sheets_w2b_guards, W2b-6 wave 55/57: its newest; no later migration redefines it — grep
--     of every CREATE OR REPLACE FUNCTION "factory_cost_sheet_guard" up to 202611281002 finds none) is REDEFINED from that
--     body, word for word but for the lines marked owb-pd2w: (a) a sheet approved by the person who made it is allowed ONLY
--     when the company's own CostingSettings.oneKeeperAllowed is true (read FOR SHARE: a switch turned off waits) AND
--     keptAloneReason is not blank (was: never; the four-eyes words stay the start of the refusal); (b) keptAloneReason, when
--     given, is 1 to 500 characters, not blank; (c) an APPROVED sheet's keptAloneReason never changes (it joins the frozen
--     columns). Its trigger CostSheet_guard stays as it is.
--
-- VERIFIED, NOT REDEFINED:
--   factory_style_revision_part_guard (…_product_guards) is defined once and never redefined; it reads only "revisionId" and
--   the revision's status, so it fits StyleRoute and StyleRouteStep (which carries its route's revision for it).
--   factory_labour_rate_guard (…_costing_guards) freezes the company, kind and creation and checks the figures; it compares
--   the whole row first, so the new column passes it; the department's own rule is the new trigger beside it.
--   factory_costing_settings_guard (…_costing_guards), factory_costing_settings_method_guard (…_money_w2a_guards),
--   CostingSettings_overhead_source (…_followups_quality_money_w2b_guards) and factory_costing_settings_piece_rate_check
--   (…_cost_sheets_w2b_guards) do not read oneKeeperAllowed and do not refuse a change of it.
--   factory_style_revision_part_guard on BomLine freezes isMain with the revision like every other column.
--   No guard of SalesOrderLine is touched (S4 settle 2: a line's route lives in its own table).
-- USED FROM EARLIER WAVES, as they are: "factory_style_revision_part_guard" (…_product_guards), "factory_recall_words_ok"
-- (…_recall_claims_w2b_guards), "factory_recall_not_future" and "factory_cost_sheets_*" helpers (…_recall_claims_w2b_guards,
-- …_cost_sheets_w2b_guards, in the redefined cost-sheet guard as before), "factory_styles_decimal_ok"
-- (…_styles_libraries_w2b_guards, in the redefined cost-sheet guard's helpers as before), "factory_order_workflow_refuse_truncate"
-- (…_order_workflow_guards).

-- =====================================================================================================================
-- StyleRoute and StyleRouteStep (product.prisma; owb-pd2w 2.1): parts of the style revision, under the …_product_guards part
-- rule as it is (insert, update, delete only while the revision is DRAFT; never moved to another revision; TRUNCATE refused).
CREATE TRIGGER "StyleRoute_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StyleRoute"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "StyleRoute_no_truncate" BEFORE TRUNCATE ON "StyleRoute"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "StyleRouteStep_revision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "StyleRouteStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_revision_part_guard"();
CREATE TRIGGER "StyleRouteStep_no_truncate" BEFORE TRUNCATE ON "StyleRouteStep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_style_revision_part_guard"();

-- StyleRoute (owb-pd2w 2.1): a model or customer route of one style revision.
--   INSERT     at version 1.
--   UPDATE     an UPDATE that changes nothing passes; the product, company and creation never change (the revision: the part
--              rule); the version goes up by one.
--   every row  a name of 1 to 80 characters with no space at either end (unique per revision: the generated key); its place
--              1 or more; a CUSTOMER route names its customer (a MODEL route may: "Only for ⟨customer⟩").
--   references (made, or the customer changed) the company is the style's (none for a product of the whole factory); the
--              customer is a party of the tenant of no other company than the route's, and on a brand's own product
--              (Style.brandPartyId) that brand.
--   DELETE     the part rule (only while DRAFT; its steps go with it).
CREATE FUNCTION "factory_style_route_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  set_party boolean := true;
  style_seen boolean;
  style_company uuid;
  style_brand uuid;
  party_seen boolean;
  party_company uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'product: a new route of a product is at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."styleId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."styleId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the product, company and creation of a route of a product never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'product: the version of a route of a product goes up by one'
        USING ERRCODE = 'check_violation';
    END IF;
    set_party := NEW."partyId" IS DISTINCT FROM OLD."partyId";
  END IF;
  IF NEW."name" IS NULL OR btrim(NEW."name") <> NEW."name" OR NEW."name" = '' OR length(NEW."name") > 80 THEN
    RAISE EXCEPTION 'product: a route of a product has a name of 1 to 80 characters, with no space at either end'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'product: a route of a product has its place among the product''s routes, 1 or more'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."kind"::text = 'CUSTOMER' AND NEW."partyId" IS NULL THEN
    RAISE EXCEPTION 'product: a customer route names its customer (a model route may name one: "Only for")'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT true, s."companyId", s."brandPartyId" INTO style_seen, style_company, style_brand
    FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
  IF TG_OP = 'INSERT' AND style_seen AND style_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'product: a route of a product is of the product''s company (none for a product of the whole factory)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF set_party AND NEW."partyId" IS NOT NULL THEN
    SELECT true, p."companyId" INTO party_seen, party_company FROM "Party" p WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."partyId";
    IF party_seen AND party_company IS NOT NULL AND NEW."companyId" IS NOT NULL AND party_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'product: a route of a product names a customer of its own company'
        USING ERRCODE = 'check_violation';
    END IF;
    IF style_seen AND style_brand IS NOT NULL AND style_brand <> NEW."partyId" THEN
      RAISE EXCEPTION 'product: a route of a brand''s own product names that brand only (never another customer)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleRoute_check" AFTER INSERT OR UPDATE ON "StyleRoute"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_route_check"();

-- StyleRouteStep (owb-pd2w 2.1): one step of a style route.
--   UPDATE     an UPDATE that changes nothing passes; the route and the creation never change (the revision: the part rule).
--   every row  its place 1 or more (unique per route: the generated key); 0 to 10000 minutes a piece, or none typed.
--   references (made, or the department or operation changed) the department is of the route's company or the whole factory;
--              the operation is one of that department (Operation.departmentId: the department's default, or another of
--              its own). A CLOSED department is the API's (DEPARTMENT_CLOSED: refused when ADDED new, kept on a step that
--              had it; a revision's copy copies its steps as they are).
CREATE FUNCTION "factory_style_route_step_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  route_seen boolean;
  route_company uuid;
  department_seen boolean;
  department_company uuid;
  department_number integer;
  operation_seen boolean;
  operation_department uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."routeId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."routeId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: a step of a route never moves to another route; its creation never changes'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'product: a step of a route has its place, 1 or more'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minutes" IS NOT NULL AND (NEW."minutes" < 0 OR NEW."minutes" > 10000) THEN
    RAISE EXCEPTION 'product: a step of a route takes 0 to 10000 minutes a piece, or none typed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."departmentId", NEW."operationId") IS DISTINCT FROM (OLD."departmentId", OLD."operationId") THEN
    SELECT true, r."companyId" INTO route_seen, route_company FROM "StyleRoute" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."routeId";
    SELECT true, d."companyId", d."number" INTO department_seen, department_company, department_number
      FROM "Department" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."departmentId";
    IF route_seen AND department_seen AND department_company IS NOT NULL AND route_company IS NOT NULL AND department_company <> route_company THEN
      RAISE EXCEPTION 'product: a step of a route names department %, of another company; it names a department of its own company or of the whole factory', department_number
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT true, o."departmentId" INTO operation_seen, operation_department FROM "Operation" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."operationId";
    IF operation_seen AND operation_department IS DISTINCT FROM NEW."departmentId" THEN
      RAISE EXCEPTION 'product: a step of a route runs an operation of its own department (the department''s default operation, or another of that department)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "StyleRouteStep_check" AFTER INSERT OR UPDATE ON "StyleRouteStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_style_route_step_check"();

-- =====================================================================================================================
-- RouteTemplate (product.prisma; owb-pd2w 2.1, S4 settle 8): a ready-made route of the factory.
--   INSERT     OPEN, at version 1.
--   UPDATE     an UPDATE that changes nothing passes; the company and the creation never change; the version goes up by one;
--              OPEN ↔ CLOSED freely (a copy is independent of it: closing changes no product).
--   every row  a name of 1 to 80 characters with no space at either end; once among the OPEN ready-made routes of its company
--              (or of the whole factory), whatever its letter case (the partial uniques below).
--   DELETE     refused (CLOSED instead). TRUNCATE refused.
-- Two partial uniques, not one over coalesce(companyId): as OrderStructureRule's, NULLS NOT DISTINCT is used nowhere else in
-- this schema.
CREATE FUNCTION "factory_route_template_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product: a ready-made route is closed, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'OPEN' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'product: a new ready-made route is OPEN, at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."companyId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: the company and the creation of a ready-made route never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'product: the version of a ready-made route goes up by one'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."name" IS NULL OR btrim(NEW."name") <> NEW."name" OR NEW."name" = '' OR length(NEW."name") > 80 THEN
    RAISE EXCEPTION 'product: a ready-made route has a name of 1 to 80 characters, with no space at either end'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RouteTemplate_guard" AFTER INSERT OR UPDATE OR DELETE ON "RouteTemplate"
  FOR EACH ROW EXECUTE FUNCTION "factory_route_template_guard"();
CREATE TRIGGER "RouteTemplate_no_truncate" BEFORE TRUNCATE ON "RouteTemplate"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

CREATE UNIQUE INDEX "RouteTemplate_open_name" ON "RouteTemplate" ("tenantId", "companyId", lower(btrim("name"))) WHERE "status" = 'OPEN' AND "companyId" IS NOT NULL;
CREATE UNIQUE INDEX "RouteTemplate_open_name_factory" ON "RouteTemplate" ("tenantId", lower(btrim("name"))) WHERE "status" = 'OPEN' AND "companyId" IS NULL;

-- RouteTemplateStep (owb-pd2w 2.1): one step of a ready-made route.
--   UPDATE     an UPDATE that changes nothing passes; the ready-made route and the creation never change.
--   every row  its place 1 or more (unique per route: the generated key); 0 to 10000 minutes a piece, or none typed.
--   references (made, or the department changed) a department of the route's company or the whole factory (a CLOSED one is
--              the API's, as on a style route's step).
--   DELETE     free (a save replaces the steps); TRUNCATE refused.
CREATE FUNCTION "factory_route_template_step_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_seen boolean;
  template_company uuid;
  department_seen boolean;
  department_company uuid;
  department_number integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."id", NEW."templateId", NEW."createdAt", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."templateId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'product: a step of a ready-made route never moves to another one; its creation never changes'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."seq" < 1 THEN
    RAISE EXCEPTION 'product: a step of a ready-made route has its place, 1 or more'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."minutes" IS NOT NULL AND (NEW."minutes" < 0 OR NEW."minutes" > 10000) THEN
    RAISE EXCEPTION 'product: a step of a ready-made route takes 0 to 10000 minutes a piece, or none typed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."departmentId" IS DISTINCT FROM OLD."departmentId" THEN
    SELECT true, t."companyId" INTO template_seen, template_company FROM "RouteTemplate" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."templateId";
    SELECT true, d."companyId", d."number" INTO department_seen, department_company, department_number
      FROM "Department" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."departmentId";
    IF template_seen AND department_seen AND department_company IS NOT NULL AND department_company IS DISTINCT FROM template_company THEN
      RAISE EXCEPTION 'product: a step of a ready-made route names department %, of another company; it names a department of its own company or of the whole factory', department_number
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "RouteTemplateStep_check" AFTER INSERT OR UPDATE ON "RouteTemplateStep"
  FOR EACH ROW EXECUTE FUNCTION "factory_route_template_step_check"();
CREATE TRIGGER "RouteTemplateStep_no_truncate" BEFORE TRUNCATE ON "RouteTemplateStep"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- =====================================================================================================================
-- SalesOrderLineRoute (product.prisma; owb-pd2w 2.1; S4 settle 2; design § 5v "a route of a line is fixed when the basket cards
-- are printed"): one order line's route choice.
--   printed    once the order has an OrderPrint of kind FIRST nothing of it is added, changed or removed (the order row is
--              read FOR SHARE first: a print that locks the order waits for the change, and a change after it sees it). The
--              line going takes its row along (the Cascade: the line is gone when the row's delete is checked).
--   INSERT     at version 1; a line of its own order.
--   UPDATE     an UPDATE that changes nothing passes; the company, customer, order, line and creation never change; the
--              version goes up by one.
--   every row  a picked route exactly with when it was picked, by whom only beside it; "Only this order" exactly with its
--              steps, why and when, by whom only beside them; why 1 to 500 characters, not blank.
--   picked     (named or changed) a route of the line's product, of the line's revision (the product's RELEASED revision
--              when the line names none), never another customer's: a MODEL route of any customer or of the order's, a
--              CUSTOMER route of the order's. Sales picks MODEL routes only: the API.
--   steps      (given or changed) a list of 1 to 50 objects { "departmentId": a uuid, "minutes": null or a decimal 0 to
--              10000 with up to 3 places (a string or a number) }, no other key; each department one of the tenant (no
--              foreign key: one this session cannot see is refused) of the order's company or the whole factory.
--   DELETE     no runtime role deletes one (no grant; the API clears a pick or an exception with an update); refused once
--              printed unless the line is gone. TRUNCATE refused.
-- One step of "Only this order": an object of exactly the keys departmentId (a uuid in its usual form) and minutes (absent, null,
-- or a decimal 0 to 10000 with up to 3 places, as a string or a number). Each test after the other: no list function on a scalar.
CREATE FUNCTION "factory_product_routes_step_ok"(step jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  minutes text;
BEGIN
  IF step IS NULL OR jsonb_typeof(step) <> 'object' THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(step) AS k(name) WHERE k.name NOT IN ('departmentId', 'minutes')) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(step -> 'departmentId') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  IF (step ->> 'departmentId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  IF coalesce(jsonb_typeof(step -> 'minutes'), 'null') = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(step -> 'minutes') NOT IN ('string', 'number') THEN
    RETURN false;
  END IF;
  minutes := step ->> 'minutes';
  IF minutes !~ '^[0-9]{1,5}(\.[0-9]{1,3})?$' THEN
    RETURN false;
  END IF;
  RETURN minutes::numeric <= 10000;
END
$$;

CREATE FUNCTION "factory_sales_order_line_route_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  set_route boolean := true;
  set_steps boolean := true;
  line_seen boolean;
  line_order uuid;
  line_style uuid;
  line_revision uuid;
  route_seen boolean;
  route_style uuid;
  route_revision uuid;
  route_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "SalesOrderLine" l WHERE l."tenantId" = OLD."tenantId" AND l."id" = OLD."salesOrderLineId") THEN
      RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM "OrderPrint" p WHERE p."tenantId" = OLD."tenantId" AND p."salesOrderId" = OLD."salesOrderId" AND p."kind" = 'FIRST') THEN
      RAISE EXCEPTION 'sales: the route of an order line is fixed once the order''s work papers are printed (Print and start the work)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM 1 FROM "SalesOrder" o WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."salesOrderId" FOR SHARE;
  IF EXISTS (SELECT 1 FROM "OrderPrint" p WHERE p."tenantId" = NEW."tenantId" AND p."salesOrderId" = NEW."salesOrderId" AND p."kind" = 'FIRST') THEN
    RAISE EXCEPTION 'sales: the route of an order line is fixed once the order''s work papers are printed (Print and start the work)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'sales: a new route of an order line is at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW."id", NEW."companyId", NEW."partyId", NEW."salesOrderId", NEW."salesOrderLineId", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."partyId", OLD."salesOrderId", OLD."salesOrderLineId", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'sales: the order, line and creation of an order line''s route never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" < OLD."version" OR NEW."version" > OLD."version" + 1 THEN
      RAISE EXCEPTION 'sales: the version of an order line''s route goes up by one'
        USING ERRCODE = 'check_violation';
    END IF;
    set_route := NEW."styleRouteId" IS DISTINCT FROM OLD."styleRouteId";
    set_steps := NEW."exceptionSteps"::jsonb IS DISTINCT FROM OLD."exceptionSteps"::jsonb;
  END IF;

  SELECT true, l."orderId", l."styleId", l."styleRevisionId" INTO line_seen, line_order, line_style, line_revision
    FROM "SalesOrderLine" l WHERE l."tenantId" = NEW."tenantId" AND l."id" = NEW."salesOrderLineId";
  IF TG_OP = 'INSERT' AND line_seen AND line_order <> NEW."salesOrderId" THEN
    RAISE EXCEPTION 'sales: a route is kept for a line of its own order'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."styleRouteId" IS NULL) <> (NEW."pickedAt" IS NULL) OR (NEW."pickedById" IS NOT NULL AND NEW."pickedAt" IS NULL) THEN
    RAISE EXCEPTION 'sales: a route picked on an order line carries when it was picked (and by whom), and only a picked one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."exceptionSteps" IS NULL) <> (NEW."exceptionReason" IS NULL) OR (NEW."exceptionSteps" IS NULL) <> (NEW."exceptionAt" IS NULL)
     OR (NEW."exceptionById" IS NOT NULL AND NEW."exceptionSteps" IS NULL) THEN
    RAISE EXCEPTION 'sales: "Only this order" comes with its steps, why and when (and by whom), all together or none'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."exceptionReason", 500, true) THEN
    RAISE EXCEPTION 'sales: why an order line takes its own route is said in 1 to 500 characters, not blank'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."exceptionSteps" IS NOT NULL AND set_steps THEN
    -- One test after the other (a list first, then each step by the helper): SQL does not promise the order of an OR, and a
    -- list function on a scalar raises.
    IF jsonb_typeof(NEW."exceptionSteps"::jsonb) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'sales: the steps of "Only this order" are a list of 1 to 50 steps, each { departmentId, minutes } with 0 to 10000 minutes or none'
        USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(NEW."exceptionSteps"::jsonb) NOT BETWEEN 1 AND 50
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."exceptionSteps"::jsonb) AS e(step) WHERE NOT "factory_product_routes_step_ok"(e.step)) THEN
      RAISE EXCEPTION 'sales: the steps of "Only this order" are a list of 1 to 50 steps, each { departmentId, minutes } with 0 to 10000 minutes or none'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."exceptionSteps"::jsonb) AS e(step)
                 LEFT JOIN "Department" d ON d."tenantId" = NEW."tenantId" AND d."id" = (e.step ->> 'departmentId')::uuid
                WHERE d."id" IS NULL OR (d."companyId" IS NOT NULL AND d."companyId" <> NEW."companyId")) THEN
      RAISE EXCEPTION 'sales: the steps of "Only this order" are departments of the order''s company or of the whole factory'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."styleRouteId" IS NOT NULL AND set_route THEN
    SELECT true, r."styleId", r."revisionId", r."partyId" INTO route_seen, route_style, route_revision, route_party
      FROM "StyleRoute" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."styleRouteId";
    IF route_seen AND line_seen THEN
      IF route_style <> line_style
         OR (line_revision IS NOT NULL AND route_revision <> line_revision)
         OR (line_revision IS NULL AND NOT EXISTS (SELECT 1 FROM "StyleRevision" v
                                                    WHERE v."tenantId" = NEW."tenantId" AND v."id" = route_revision AND v."status" = 'RELEASED')) THEN
        RAISE EXCEPTION 'sales: an order line picks a route of its own product and revision (the released revision when the line names none)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF route_party IS NOT NULL AND route_party <> NEW."partyId" THEN
        RAISE EXCEPTION 'sales: an order line picks a model route or a route of its own customer, never another customer''s'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "SalesOrderLineRoute_guard" AFTER INSERT OR UPDATE OR DELETE ON "SalesOrderLineRoute"
  FOR EACH ROW EXECUTE FUNCTION "factory_sales_order_line_route_guard"();
CREATE TRIGGER "SalesOrderLineRoute_no_truncate" BEFORE TRUNCATE ON "SalesOrderLineRoute"
  FOR EACH STATEMENT EXECUTE FUNCTION "factory_order_workflow_refuse_truncate"();

-- =====================================================================================================================
-- LabourRate (costing.prisma; owb-pd2w 2.1, 2.5): a department's own rate, which wins over its kind's.
-- One rate per day for each company (or the whole factory), kind and department:
--   a company's department rate     the generated key (tenantId, companyId, workCentreKind, departmentId, validFrom)
--   a company's kind rate           LabourRate_one_company_rate_per_kind_and_day (NEW: the key above no longer counts a
--                                   NULL department)
--   the whole factory's kind rate   LabourRate_one_tenant_rate_per_kind_and_day (…_costing_guards; owb-pd2w: made again with
--                                   "departmentId" IS NULL in its WHERE, the same name and columns)
--   the whole factory's department  LabourRate_one_tenant_rate_per_department_and_day (NEW)
-- owb-pd2w: NOT ADDITIVE — the …_costing_guards index is dropped and made again (narrower: it no longer counts a department's
-- rate, which has its own index).
DROP INDEX "LabourRate_one_tenant_rate_per_kind_and_day";
CREATE UNIQUE INDEX "LabourRate_one_tenant_rate_per_kind_and_day" ON "LabourRate" ("tenantId", "workCentreKind", "validFrom") WHERE "companyId" IS NULL AND "departmentId" IS NULL;
CREATE UNIQUE INDEX "LabourRate_one_company_rate_per_kind_and_day" ON "LabourRate" ("tenantId", "companyId", "workCentreKind", "validFrom") WHERE "companyId" IS NOT NULL AND "departmentId" IS NULL;
CREATE UNIQUE INDEX "LabourRate_one_tenant_rate_per_department_and_day" ON "LabourRate" ("tenantId", "departmentId", "validFrom") WHERE "companyId" IS NULL AND "departmentId" IS NOT NULL;

--   UPDATE     the department never changes (beside …_costing_guards' rule: the company, kind and creation never change).
--   named      a department of the rate's kind of work centre and of the rate's company (a rate of the whole factory: a
--              department of the whole factory).
CREATE FUNCTION "factory_labour_rate_department_check"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  department_seen boolean;
  department_company uuid;
  department_kind text;
  department_number integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."departmentId" IS DISTINCT FROM OLD."departmentId" THEN
    RAISE EXCEPTION 'costing: the department of the labour rate % never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."departmentId" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT true, d."companyId", d."workCentreKind"::text, d."number" INTO department_seen, department_company, department_kind, department_number
    FROM "Department" d WHERE d."tenantId" = NEW."tenantId" AND d."id" = NEW."departmentId";
  IF department_seen AND department_kind <> NEW."workCentreKind"::text THEN
    RAISE EXCEPTION 'costing: the labour rate % is for department %, which works at % (the rate''s kind of work centre is %)', NEW."id", department_number, department_kind, NEW."workCentreKind"
      USING ERRCODE = 'check_violation';
  END IF;
  IF department_seen AND department_company IS NOT NULL AND department_company IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'costing: the labour rate % is for a department of its own company (a rate of the whole factory: a department of the whole factory)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "LabourRate_department_check" AFTER INSERT OR UPDATE OF "departmentId", "workCentreKind", "companyId" ON "LabourRate"
  FOR EACH ROW EXECUTE FUNCTION "factory_labour_rate_department_check"();

-- =====================================================================================================================
-- BomLine (product.prisma; owb-pd2w 3.3 decision, see the column): at most one main material line per revision.
CREATE UNIQUE INDEX "BomLine_one_main" ON "BomLine" ("tenantId", "revisionId") WHERE "isMain";

-- =====================================================================================================================
-- CostingSettings (costing.prisma; owb-pd2w 3.2, S4 settle 9): "one person may keep a cost" (beside W1's
-- "CostingSettings_guard" and the W2a/W2b checks, untouched).
--   on         only on a company's own row (companyId set): the cost-sheet guard reads the company's own row, so a value on
--              the row of the whole factory would say nothing. Off is always allowed.
CREATE FUNCTION "factory_costing_settings_one_keeper_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."oneKeeperAllowed" AND NEW."companyId" IS NULL THEN
    RAISE EXCEPTION 'costing: "one person may keep a cost" is switched on only on a company''s own costing settings, not on those of the whole factory'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "CostingSettings_one_keeper_check" AFTER INSERT OR UPDATE OF "oneKeeperAllowed", "companyId" ON "CostingSettings"
  FOR EACH ROW EXECUTE FUNCTION "factory_costing_settings_one_keeper_check"();

-- =====================================================================================================================
-- CostSheet (cost-sheets.prisma): REDEFINES factory_cost_sheet_guard (…_cost_sheets_w2b_guards, W2b-6 wave 55/57: its newest;
-- no later migration redefines it), word for word but for the lines marked owb-pd2w (S4 settle 9, plan § 5 I, R59 "Keep"):
--   (a) DRAFT → APPROVED by the person who made it: allowed ONLY when the company's own CostingSettings.oneKeeperAllowed is
--       true (read FOR SHARE) AND keptAloneReason is not blank (was: never). The refusal starts with the four-eyes words as
--       before.
--   (b) every row: keptAloneReason, when given, is 1 to 500 characters, not blank.
--   (c) an APPROVED sheet: keptAloneReason joins the columns that never change.
-- The rest of its header (…_cost_sheets_w2b_guards) stands. Its trigger CostSheet_guard stays as it is.
CREATE OR REPLACE FUNCTION "factory_cost_sheet_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  style_company uuid;
  style_sizes text[];
  style_scale uuid;
  company_currency text;
  season_status text;
  base_key text;
  base_version integer;
  curve_scale uuid;
  curve_company uuid;
  found boolean;
  task record;
  one_keeper boolean; -- owb-pd2w (a)
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NULL;
    END IF;
    IF (NEW."companyId", NEW."styleId", NEW."revisionId", NEW."seasonId", NEW."key", NEW."sheetVersion", NEW."basedOnId", NEW."currency", NEW."baseSize", NEW."createdAt", NEW."createdById")
       IS DISTINCT FROM (OLD."companyId", OLD."styleId", OLD."revisionId", OLD."seasonId", OLD."key", OLD."sheetVersion", OLD."basedOnId", OLD."currency", OLD."baseSize", OLD."createdAt", OLD."createdById") THEN
      RAISE EXCEPTION 'costing: the company, style, revision, season, version, currency and base size of cost sheet % never change (a change is a new version)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'FROZEN' THEN
      RAISE EXCEPTION 'costing: cost sheet % is frozen: it changes no more', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."state" = 'APPROVED' THEN
      -- owb-pd2w (c): keptAloneReason joins the columns an approved sheet never changes.
      IF NEW."state" <> 'FROZEN'
         OR (NEW."targetPrice", NEW."targetMarginPct", NEW."sizeCurveId", NEW."sizeWeights", NEW."inputs", NEW."note", NEW."approvalTaskId", NEW."approvedAt", NEW."approvedById", NEW."keptAloneReason")
            IS DISTINCT FROM (OLD."targetPrice", OLD."targetMarginPct", OLD."sizeCurveId", OLD."sizeWeights", OLD."inputs", OLD."note", OLD."approvalTaskId", OLD."approvedAt", OLD."approvedById", OLD."keptAloneReason") THEN
        RAISE EXCEPTION 'costing: cost sheet % is approved and locked: it is never edited, only frozen; a change is a new version', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'APPROVED') THEN
      RAISE EXCEPTION 'costing: cost sheet % moves DRAFT → APPROVED → FROZEN (not % → %); a draft nobody needs is deleted', OLD."id", OLD."state", NEW."state"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."state" <> 'DRAFT' THEN
      RAISE EXCEPTION 'costing: cost sheet % is made as a DRAFT, then approved', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT true, s."companyId", s."sizes" INTO found, style_company, style_sizes FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF found AND style_company IS NOT NULL AND style_company <> NEW."companyId" THEN
      RAISE EXCEPTION 'costing: cost sheet % costs a style of another company (a tenant-wide style is costed for any company)', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF found AND NOT (NEW."baseSize" = ANY (COALESCE(style_sizes, ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'costing: the base size % of cost sheet % is not in the style''s size range', NEW."baseSize", NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."seasonId" IS NOT NULL THEN
      SELECT z."status"::text INTO season_status FROM "Season" z WHERE z."tenantId" = NEW."tenantId" AND z."id" = NEW."seasonId";
      IF season_status IS DISTINCT FROM 'OPEN' THEN
        RAISE EXCEPTION 'costing: cost sheet % is for a season that is closed: a new sheet is for an open season (or none)', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT c."currency" INTO company_currency FROM "Company" c WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."companyId";
    IF company_currency IS NOT NULL AND company_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'costing: cost sheet % is in %, its company''s currency is %', NEW."id", NEW."currency", company_currency
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."basedOnId" IS NOT NULL THEN
      SELECT b."key", b."sheetVersion" INTO base_key, base_version FROM "CostSheet" b WHERE b."tenantId" = NEW."tenantId" AND b."id" = NEW."basedOnId";
      IF base_key IS DISTINCT FROM NEW."key" OR base_version >= NEW."sheetVersion" THEN
        RAISE EXCEPTION 'costing: cost sheet % is copied from a lower version of the same style, company and season', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NOT "factory_cost_sheets_key_ok"(NEW."key", 'costsheet:' || NEW."styleId" || ':' || NEW."companyId" || ':' || COALESCE(NEW."seasonId"::text, 'none')) THEN
    RAISE EXCEPTION 'costing: cost sheet %''s series is costsheet:<style>:<company>:<season | none>, not %', NEW."id", NEW."key"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sheetVersion" < 1 OR NOT "factory_cost_sheets_currency_ok"(NEW."currency") THEN
    RAISE EXCEPTION 'costing: cost sheet % has a version from 1 and an ISO 4217 currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."targetPrice" IS NOT NULL AND NEW."targetPrice" <= 0) OR (NEW."targetMarginPct" IS NOT NULL AND (NEW."targetMarginPct" >= 100 OR NEW."targetMarginPct" <= -1000)) THEN
    RAISE EXCEPTION 'costing: cost sheet % has a target price above 0 and a target margin below 100 %%', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT "factory_recall_words_ok"(NEW."note", 2000, true) OR NOT "factory_cost_sheets_object_ok"(NEW."inputs", 262144) THEN
    RAISE EXCEPTION 'costing: cost sheet % has a note of up to 2000 characters and its inputs as an object of at most 256 KiB', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- owb-pd2w (b): why its maker kept it alone, when given, is 1 to 500 characters, not blank.
  IF NOT "factory_recall_words_ok"(NEW."keptAloneReason", 500, true) THEN
    RAISE EXCEPTION 'costing: why one person kept cost sheet % is said in 1 to 500 characters, not blank', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."sizeWeights" IS DISTINCT FROM OLD."sizeWeights" OR NEW."sizeCurveId" IS DISTINCT FROM OLD."sizeCurveId" THEN
    SELECT s."sizes", s."sizeScaleId" INTO style_sizes, style_scale FROM "Style" s WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."styleId";
    IF NOT "factory_cost_sheets_weights_ok"(NEW."sizeWeights", style_sizes) THEN
      RAISE EXCEPTION 'costing: the size weights of cost sheet % are sizes of the style''s range, each a decimal above 0', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sizeCurveId" IS NOT NULL THEN
      SELECT true, k."sizeScaleId", k."companyId" INTO found, curve_scale, curve_company FROM "SizeCurve" k WHERE k."tenantId" = NEW."tenantId" AND k."id" = NEW."sizeCurveId";
      IF found IS NOT TRUE OR curve_scale IS DISTINCT FROM style_scale OR (curve_company IS NOT NULL AND curve_company <> NEW."companyId") THEN
        RAISE EXCEPTION 'costing: cost sheet % weights by a size curve of the style''s scale, of its company or every company', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."approvalTaskId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."approvalTaskId" IS DISTINCT FROM OLD."approvalTaskId" OR NEW."state" IS DISTINCT FROM OLD."state") THEN
    SELECT t."kind"::text AS kind, t."recordType", t."recordId", t."companyId", t."status"::text AS status, t."decidedById" INTO task
      FROM "ApprovalTask" t WHERE t."tenantId" = NEW."tenantId" AND t."id" = NEW."approvalTaskId" FOR SHARE;
    IF task IS NULL OR task.kind <> 'COST_SHEET' OR task."recordType" <> 'CostSheet' OR task."recordId" <> NEW."id" OR task."companyId" <> NEW."companyId" THEN
      RAISE EXCEPTION 'costing: cost sheet % names a request for a yes that is not a COST_SHEET request of this sheet', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."state" IN ('APPROVED', 'FROZEN')) <> (NEW."approvedAt" IS NOT NULL AND NEW."approvedById" IS NOT NULL)
     OR (NEW."approvedAt" IS NULL) <> (NEW."approvedById" IS NULL) THEN
    RAISE EXCEPTION 'costing: cost sheet % carries when and by whom it was approved exactly once it is approved', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."state" = 'FROZEN') <> (NEW."frozenAt" IS NOT NULL AND NEW."frozenReason" IS NOT NULL)
     OR (NEW."state" <> 'FROZEN' AND (NEW."frozenAt" IS NOT NULL OR NEW."frozenById" IS NOT NULL OR NEW."frozenReason" IS NOT NULL)) THEN
    RAISE EXCEPTION 'costing: cost sheet % carries when and why it was frozen exactly once it is frozen', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."state" = 'DRAFT' AND NEW."state" = 'APPROVED' THEN
    IF NOT "factory_recall_not_future"(NEW."approvedAt") THEN
      RAISE EXCEPTION 'costing: cost sheet % is approved now or before, not in the future', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."createdById" IS NOT NULL AND NEW."approvedById" = NEW."createdById" THEN
      -- owb-pd2w (a): its maker keeps it alone only with the company's own "one person may keep a cost" ON (its row FOR SHARE: a
      -- switch turned off waits for this approval, and an approval after it sees it off) and a reason that is not blank.
      SELECT s."oneKeeperAllowed" INTO one_keeper FROM "CostingSettings" s
        WHERE s."tenantId" = NEW."tenantId" AND s."companyId" = NEW."companyId" FOR SHARE;
      IF one_keeper IS NOT TRUE OR NEW."keptAloneReason" IS NULL OR btrim(NEW."keptAloneReason") = '' THEN
        RAISE EXCEPTION 'costing: cost sheet % is approved by someone other than the person who made it (nobody approves their own), unless the company lets one person keep a cost and the reason is given', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "CostSheetLine" l WHERE l."tenantId" = NEW."tenantId" AND l."costSheetId" = NEW."id") THEN
      RAISE EXCEPTION 'costing: cost sheet % has no line: there is nothing to approve', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approvalTaskId" IS NOT NULL THEN
      IF task.status <> 'APPROVED' OR task."decidedById" IS DISTINCT FROM NEW."approvedById" THEN
        RAISE EXCEPTION 'costing: cost sheet % is approved on its request''s yes, by the person who decided it', NEW."id"
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."state" = 'APPROVED' AND NEW."state" = 'FROZEN'
     AND (NEW."frozenAt" < NEW."approvedAt" OR NOT "factory_recall_not_future"(NEW."frozenAt")) THEN
    RAISE EXCEPTION 'costing: cost sheet % is frozen after its approval, now or before', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
