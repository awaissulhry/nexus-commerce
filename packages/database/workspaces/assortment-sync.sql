-- AE.4 — live product sync: the database notes a change to a followed product, in the same
-- transaction as the change, and the follower's worker applies it.
-- Plan: docs/2026-09-19-shared-stock-plan.md step 6; contract docs/2026-09-19-shared-stock-build.md §6.
--
-- Shared by the generator (scripts/workspace-policies.mjs, which the disposable test database
-- applies) and the migration policy-migrations.json names for it (first 20260919d), which ENDS WITH these exact bytes
-- (check-policy-migration-parity.mjs). Change it only through a NEW migration ending with its new bytes.
--
-- The rules the database keeps, whatever the application does:
--   1. Every save of a followed product is noted, whoever saves it (research F2: most code paths send
--      no signal). A save that changes no followed field — a stock count, a sync stamp — costs nothing.
--   2. Only an ACTIVE share is followed, and only in the field groups it offers (a product's delete and
--      its variations always count: they decide whether the link still stands).
--   3. No loops and no chains: a write made by the sync (transaction flag nexus.assortment_sync) is not
--      noted, and a product that itself follows another business's product passes nothing on.
--   4. One pending note per link: a second change before the worker runs folds into it.
--   5. The follower reads its own notes only; which of the owner's products its worker may read is
--      decided here, never by the caller.

-- ── Helpers (INTERNAL: the runtime role gets no EXECUTE) ────────────────────────────────────
-- A cuid-shaped id for rows written here: 'c' + 24 lowercase hex characters (the cuid alphabet).
CREATE OR REPLACE FUNCTION nexus_assortment_id() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || txid_current()::text), 1, 24)
$$;
REVOKE ALL ON FUNCTION nexus_assortment_id() FROM PUBLIC;

-- ── The change queue ────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentChange_state_check') THEN
    ALTER TABLE "AssortmentChange" ADD CONSTRAINT "AssortmentChange_state_check"
      CHECK (state IN ('pending', 'claimed', 'done', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssortmentChange_two_businesses_check') THEN
    ALTER TABLE "AssortmentChange" ADD CONSTRAINT "AssortmentChange_two_businesses_check" CHECK ("sourceWorkspaceId" <> "targetWorkspaceId");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AssortmentChange_one_pending_per_link" ON "AssortmentChange" ("linkId") WHERE state = 'pending';

ALTER TABLE "AssortmentChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssortmentChange" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "AssortmentChange" TO nexus_workspace_runtime;

-- The FOLLOWER owns the notes about its links. The owner never reads them: capture writes them as
-- definer, inside the owner's own transaction.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "AssortmentChange";
CREATE POLICY nexus_workspace_isolation ON "AssortmentChange" FOR ALL TO nexus_workspace_runtime
USING (("targetWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentChange"."targetWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("targetWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "AssortmentChange"."targetWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- A note the follower writes itself ("Follow again", a resync, the repair job) must name one of its
-- own links, with that link's share and businesses.
CREATE OR REPLACE FUNCTION nexus_assortment_change_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CatalogLink" l WHERE l.id = NEW."linkId" AND l."shareId" = NEW."shareId"
                 AND l."sourceWorkspaceId" = NEW."sourceWorkspaceId" AND l."targetWorkspaceId" = NEW."targetWorkspaceId") THEN
    RAISE EXCEPTION 'The change does not match its link' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW."linkId", NEW."shareId", NEW."sourceWorkspaceId", NEW."targetWorkspaceId", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD."linkId", OLD."shareId", OLD."sourceWorkspaceId", OLD."targetWorkspaceId", OLD."createdAt") THEN
    RAISE EXCEPTION 'A change''s link and businesses cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nexus_assortment_change_guard ON "AssortmentChange";
CREATE TRIGGER nexus_assortment_change_guard BEFORE INSERT OR UPDATE ON "AssortmentChange"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_change_guard();

-- ── The sync's own writes ────────────────────────────────────────────────────────────────────
-- The worker calls this first in each transaction that writes a follower product, so capture does not
-- note its writes (rule 3). Application SQL may not call set_config itself (packages/database/
-- workspace-sql.ts guards the business context); this sets nothing but this one flag, for this
-- transaction only.
CREATE OR REPLACE FUNCTION nexus_assortment_sync_write() RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM set_config('nexus.assortment_sync', 'on', true);
END $$;
REVOKE ALL ON FUNCTION nexus_assortment_sync_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assortment_sync_write() TO nexus_workspace_runtime;

-- ── Capture ─────────────────────────────────────────────────────────────────────────────────
-- Notes a change to one product of the business in `source_workspace`, for every active link of an
-- active share that follows it in one of `groups`. 'lifecycle' (the product was deleted or restored)
-- always counts. INTERNAL: reached only through the triggers below.
CREATE OR REPLACE FUNCTION nexus_assortment_capture(product_id text, source_workspace text, groups text[], source_version integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  link record;
BEGIN
  IF product_id IS NULL OR source_workspace IS NULL OR COALESCE(current_setting('nexus.assortment_sync', true), '') = 'on' THEN
    RETURN;
  END IF;
  -- No chains: a product that follows another business's product passes nothing on.
  IF EXISTS (SELECT 1 FROM "CatalogLink" t WHERE t."targetWorkspaceId" = source_workspace AND t."targetProductId" = product_id AND t.status = 'active') THEN
    RETURN;
  END IF;
  FOR link IN
    SELECT l.id, l."shareId", l."targetWorkspaceId"
    FROM "CatalogLink" l JOIN "AssortmentShare" s ON s.id = l."shareId"
    WHERE l."sourceWorkspaceId" = source_workspace AND l."sourceProductId" = product_id
      AND l.status = 'active' AND s.status = 'active'
      AND (s."fieldGroups" && groups OR 'lifecycle' = ANY (groups))
  LOOP
    INSERT INTO "AssortmentChange" (id, "linkId", "shareId", "sourceWorkspaceId", "targetWorkspaceId", reasons, "sourceVersion", "updatedAt")
    VALUES (nexus_assortment_id(), link.id, link."shareId", source_workspace, link."targetWorkspaceId", groups, source_version, CURRENT_TIMESTAMP)
    -- A fresh change makes a note waiting on a retry delay ready now: the new state may apply.
    ON CONFLICT ("linkId") WHERE state = 'pending' DO UPDATE SET
      reasons = ARRAY(SELECT DISTINCT r FROM unnest("AssortmentChange".reasons || EXCLUDED.reasons) AS r ORDER BY r),
      "sourceVersion" = GREATEST("AssortmentChange"."sourceVersion", EXCLUDED."sourceVersion"),
      "availableAt" = LEAST("AssortmentChange"."availableAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP;
    PERFORM pg_notify('nexus_assortment_sync', link."targetWorkspaceId");
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION nexus_assortment_capture(text, text, text[], integer) FROM PUBLIC;

-- Product: which followed groups a save changed. The column lists are the groups of
-- apps/api/src/services/assortment/field-groups.ts (field-groups.vitest.test.ts keeps them equal).
-- followed-columns:begin
CREATE OR REPLACE FUNCTION nexus_assortment_capture_product() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  groups text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new variation under a followed parent.
    IF NEW."parentId" IS NOT NULL AND NEW."deletedAt" IS NULL THEN
      PERFORM nexus_assortment_capture(NEW."parentId", NEW."workspaceId", ARRAY['structure'], NULL);
    END IF;
    RETURN NULL;
  END IF;
  IF (OLD.sku, OLD.upc, OLD.ean, OLD.gtin, OLD.brand, OLD.manufacturer)
     IS DISTINCT FROM (NEW.sku, NEW.upc, NEW.ean, NEW.gtin, NEW.brand, NEW.manufacturer) THEN groups := array_append(groups, 'identity'); END IF;
  IF (OLD.name, OLD.description, OLD."bulletPoints", OLD.keywords, OLD."aPlusContent", OLD."localizedContent")
     IS DISTINCT FROM (NEW.name, NEW.description, NEW."bulletPoints", NEW.keywords, NEW."aPlusContent", NEW."localizedContent") THEN groups := array_append(groups, 'content'); END IF;
  IF (OLD."productType", OLD."variationTheme", OLD."variationAxes", OLD."categoryAttributes", OLD."variantAttributes")
     IS DISTINCT FROM (NEW."productType", NEW."variationTheme", NEW."variationAxes", NEW."categoryAttributes", NEW."variantAttributes") THEN groups := array_append(groups, 'attributes'); END IF;
  IF OLD."imageAxisPreference" IS DISTINCT FROM NEW."imageAxisPreference" THEN groups := array_append(groups, 'media'); END IF;
  IF (OLD."weightValue", OLD."weightUnit", OLD."dimLength", OLD."dimWidth", OLD."dimHeight", OLD."dimUnit")
     IS DISTINCT FROM (NEW."weightValue", NEW."weightUnit", NEW."dimLength", NEW."dimWidth", NEW."dimHeight", NEW."dimUnit") THEN groups := array_append(groups, 'physical'); END IF;
  IF (OLD."hsCode", OLD."countryOfOrigin", OLD."ppeCategory", OLD."hazmatClass", OLD."hazmatUnNumber", OLD."garmentClass",
      OLD."notifiedBodyNumber", OLD."notifiedBodyName", OLD."declarationOfConformityUrl", OLD."impactProtectors")
     IS DISTINCT FROM (NEW."hsCode", NEW."countryOfOrigin", NEW."ppeCategory", NEW."hazmatClass", NEW."hazmatUnNumber", NEW."garmentClass",
      NEW."notifiedBodyNumber", NEW."notifiedBodyName", NEW."declarationOfConformityUrl", NEW."impactProtectors") THEN groups := array_append(groups, 'compliance'); END IF;
  IF (OLD."parentId", OLD."isParent", OLD."familyId")
     IS DISTINCT FROM (NEW."parentId", NEW."isParent", NEW."familyId") THEN groups := array_append(groups, 'structure'); END IF;
  IF (OLD."basePrice", OLD."minPrice", OLD."maxPrice", OLD."b2bPrice", OLD."b2bMinQty")
     IS DISTINCT FROM (NEW."basePrice", NEW."minPrice", NEW."maxPrice", NEW."b2bPrice", NEW."b2bMinQty") THEN groups := array_append(groups, 'price'); END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN groups := array_append(groups, 'status'); END IF;
  IF OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt" THEN groups := array_append(groups, 'lifecycle'); END IF;

  IF cardinality(groups) > 0 THEN
    PERFORM nexus_assortment_capture(NEW.id, NEW."workspaceId", groups, NEW.version);
  END IF;
  -- A variation that arrived, left, was deleted or restored changes its parents' variations.
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt" THEN
    PERFORM nexus_assortment_capture(OLD."parentId", OLD."workspaceId", ARRAY['structure'], NULL);
    IF NEW."parentId" IS DISTINCT FROM OLD."parentId" THEN
      PERFORM nexus_assortment_capture(NEW."parentId", NEW."workspaceId", ARRAY['structure'], NULL);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_assortment_capture_product ON "Product";
DROP TRIGGER IF EXISTS nexus_assortment_capture_product_insert ON "Product";
CREATE TRIGGER nexus_assortment_capture_product_insert AFTER INSERT ON "Product"
  FOR EACH ROW WHEN (NEW."parentId" IS NOT NULL)
  EXECUTE FUNCTION nexus_assortment_capture_product();
-- The WHEN keeps every other save (stock counts, sync stamps, readiness) from calling the function at all.
DROP TRIGGER IF EXISTS nexus_assortment_capture_product_update ON "Product";
CREATE TRIGGER nexus_assortment_capture_product_update AFTER UPDATE ON "Product"
  FOR EACH ROW WHEN ((OLD.sku, OLD.upc, OLD.ean, OLD.gtin, OLD.brand, OLD.manufacturer,
      OLD.name, OLD.description, OLD."bulletPoints", OLD.keywords, OLD."aPlusContent", OLD."localizedContent",
      OLD."productType", OLD."variationTheme", OLD."variationAxes", OLD."categoryAttributes", OLD."variantAttributes",
      OLD."imageAxisPreference",
      OLD."weightValue", OLD."weightUnit", OLD."dimLength", OLD."dimWidth", OLD."dimHeight", OLD."dimUnit",
      OLD."hsCode", OLD."countryOfOrigin", OLD."ppeCategory", OLD."hazmatClass", OLD."hazmatUnNumber", OLD."garmentClass",
      OLD."notifiedBodyNumber", OLD."notifiedBodyName", OLD."declarationOfConformityUrl", OLD."impactProtectors",
      OLD."parentId", OLD."isParent", OLD."familyId",
      OLD."basePrice", OLD."minPrice", OLD."maxPrice", OLD."b2bPrice", OLD."b2bMinQty",
      OLD.status, OLD."deletedAt")
    IS DISTINCT FROM (NEW.sku, NEW.upc, NEW.ean, NEW.gtin, NEW.brand, NEW.manufacturer,
      NEW.name, NEW.description, NEW."bulletPoints", NEW.keywords, NEW."aPlusContent", NEW."localizedContent",
      NEW."productType", NEW."variationTheme", NEW."variationAxes", NEW."categoryAttributes", NEW."variantAttributes",
      NEW."imageAxisPreference",
      NEW."weightValue", NEW."weightUnit", NEW."dimLength", NEW."dimWidth", NEW."dimHeight", NEW."dimUnit",
      NEW."hsCode", NEW."countryOfOrigin", NEW."ppeCategory", NEW."hazmatClass", NEW."hazmatUnNumber", NEW."garmentClass",
      NEW."notifiedBodyNumber", NEW."notifiedBodyName", NEW."declarationOfConformityUrl", NEW."impactProtectors",
      NEW."parentId", NEW."isParent", NEW."familyId",
      NEW."basePrice", NEW."minPrice", NEW."maxPrice", NEW."b2bPrice", NEW."b2bMinQty",
      NEW.status, NEW."deletedAt"))
  EXECUTE FUNCTION nexus_assortment_capture_product();
-- followed-columns:end

-- Translations, images and categories: the product they belong to.
CREATE OR REPLACE FUNCTION nexus_assortment_capture_child_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  row_product text;
  row_workspace text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_product := OLD."productId"; row_workspace := OLD."workspaceId";
  ELSE
    row_product := NEW."productId"; row_workspace := NEW."workspaceId";
  END IF;
  PERFORM nexus_assortment_capture(row_product, row_workspace, ARRAY[TG_ARGV[0]], NULL);
  -- A row moved to another product changes both.
  IF TG_OP = 'UPDATE' AND OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    PERFORM nexus_assortment_capture(OLD."productId", OLD."workspaceId", ARRAY[TG_ARGV[0]], NULL);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_assortment_capture_translation ON "ProductTranslation";
CREATE TRIGGER nexus_assortment_capture_translation AFTER INSERT OR UPDATE OR DELETE ON "ProductTranslation"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_capture_child_row('translations');
DROP TRIGGER IF EXISTS nexus_assortment_capture_image ON "ProductImage";
CREATE TRIGGER nexus_assortment_capture_image AFTER INSERT OR UPDATE OR DELETE ON "ProductImage"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_capture_child_row('media');
DROP TRIGGER IF EXISTS nexus_assortment_capture_category ON "ProductCategory";
CREATE TRIGGER nexus_assortment_capture_category AFTER INSERT OR UPDATE OR DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_capture_child_row('attributes');

-- A resumed share catches up: every one of its links is noted.
CREATE OR REPLACE FUNCTION nexus_assortment_share_resume() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  link record;
BEGIN
  IF OLD.status = 'paused' AND NEW.status = 'active' THEN
    FOR link IN SELECT l.id, l."sourceWorkspaceId", l."targetWorkspaceId" FROM "CatalogLink" l WHERE l."shareId" = NEW.id AND l.status = 'active' LOOP
      INSERT INTO "AssortmentChange" (id, "linkId", "shareId", "sourceWorkspaceId", "targetWorkspaceId", reasons, "updatedAt")
      VALUES (nexus_assortment_id(), link.id, NEW.id, link."sourceWorkspaceId", link."targetWorkspaceId", ARRAY['resume'], CURRENT_TIMESTAMP)
      ON CONFLICT ("linkId") WHERE state = 'pending' DO UPDATE SET
        reasons = ARRAY(SELECT DISTINCT r FROM unnest("AssortmentChange".reasons || EXCLUDED.reasons) AS r ORDER BY r),
        "availableAt" = LEAST("AssortmentChange"."availableAt", CURRENT_TIMESTAMP),
        "updatedAt" = CURRENT_TIMESTAMP;
      PERFORM pg_notify('nexus_assortment_sync', link."targetWorkspaceId");
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS nexus_assortment_share_resume ON "AssortmentShare";
CREATE TRIGGER nexus_assortment_share_resume AFTER UPDATE ON "AssortmentShare"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_share_resume();

-- ── Does a share still cover one product? ───────────────────────────────────────────────────
-- The same answer as nexus_assortment_share_product_ids for ONE product, without listing the whole
-- assortment (an "all products" assortment covers every product of the owner). INTERNAL.
CREATE OR REPLACE FUNCTION nexus_assortment_share_covers(share_id text, product_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "AssortmentShare" s
    JOIN "Assortment" a ON a.id = s."assortmentId" AND a."workspaceId" = s."ownerWorkspaceId"
    JOIN "Product" p ON p.id = product_id AND p."workspaceId" = s."ownerWorkspaceId" AND p."deletedAt" IS NULL
    JOIN "Product" top ON top.id = COALESCE(p."parentId", p.id) AND top."workspaceId" = s."ownerWorkspaceId"
      AND top."parentId" IS NULL AND top."deletedAt" IS NULL
    WHERE s.id = share_id
      AND CASE WHEN a.selection = 'list'
        THEN EXISTS (SELECT 1 FROM "AssortmentMember" m WHERE m."assortmentId" = a.id AND m."productId" = top.id AND m.mode = 'include')
        ELSE NOT EXISTS (SELECT 1 FROM "AssortmentMember" m WHERE m."assortmentId" = a.id AND m."productId" = top.id AND m.mode = 'exclude')
      END)
$$;
REVOKE ALL ON FUNCTION nexus_assortment_share_covers(text, text) FROM PUBLIC;

-- ── The follower's worker asks what it may read ─────────────────────────────────────────────
-- For one link of the business in context. Returns jsonb: {linkId, shareId, ownerWorkspaceId,
-- fieldGroups, source: {id, sku, version, parentId, deleted}, variations: [{id, sku, version}]} — the
-- source product and, for a parent, its variations the assortment still covers — or {error, code}.
-- No person is needed: the follower's owner consented when the share was accepted and the link made.
CREATE OR REPLACE FUNCTION nexus_assortment_sync_source(link_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  follower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  link "CatalogLink"%ROWTYPE;
  share "AssortmentShare"%ROWTYPE;
  source "Product"%ROWTYPE;
BEGIN
  IF follower_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Choose a business profile.', 'code', 'workspace_required');
  END IF;
  SELECT * INTO link FROM "CatalogLink" WHERE id = link_id AND "targetWorkspaceId" = follower_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This link is unavailable in this business profile.', 'code', 'link_not_found');
  END IF;
  IF link.status <> 'active' THEN
    RETURN jsonb_build_object('error', 'This product no longer follows a shared product.', 'code', 'link_detached');
  END IF;
  SELECT * INTO share FROM "AssortmentShare" WHERE id = link."shareId";
  IF share.status <> 'active' THEN
    RETURN jsonb_build_object('error', format('The share is %s.', share.status), 'code', 'share_not_active', 'shareStatus', share.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = share."ownerWorkspaceId" AND w.status = 'active')
     OR NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = follower_id AND w.status = 'active') THEN
    RETURN jsonb_build_object('error', 'A business of this share is unavailable.', 'code', 'business_unavailable');
  END IF;
  SELECT * INTO source FROM "Product" WHERE id = link."sourceProductId" AND "workspaceId" = link."sourceWorkspaceId";
  RETURN jsonb_build_object(
    'linkId', link.id, 'shareId', share.id, 'ownerWorkspaceId', share."ownerWorkspaceId", 'fieldGroups', to_jsonb(share."fieldGroups"),
    'source', CASE WHEN source.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', source.id, 'sku', source.sku, 'version', source.version, 'parentId', source."parentId",
      -- Deleted, or no longer in the assortment: either way the link cannot stand.
      'deleted', NOT nexus_assortment_share_covers(share.id, source.id)) END,
    -- A covered parent covers its variations that are not deleted.
    'variations', CASE WHEN source.id IS NULL OR NOT nexus_assortment_share_covers(share.id, source.id) THEN '[]'::jsonb ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'version', p.version) ORDER BY p.sku)
      FROM "Product" p
      WHERE p."parentId" = source.id AND p."workspaceId" = source."workspaceId" AND p."deletedAt" IS NULL
    ), '[]'::jsonb) END);
END $$;
REVOKE ALL ON FUNCTION nexus_assortment_sync_source(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assortment_sync_source(text) TO nexus_workspace_runtime;

-- ── Who has work: the poller asks with NO business context (a system caller) ────────────────
-- "Due" at the column's precision: availableAt is TIMESTAMP(3), rounded — possibly up — when written, so it is compared
-- with CURRENT_TIMESTAMP(3), rounded the same way (sync-worker.ts claims with the same rule).
CREATE OR REPLACE FUNCTION nexus_assortment_pending_workspaces()
RETURNS TABLE (workspace_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT c."targetWorkspaceId"
  FROM "AssortmentChange" c
  WHERE NULLIF(current_setting('nexus.workspace_id', true), '') IS NULL
    AND ((c.state = 'pending' AND c."availableAt" <= CURRENT_TIMESTAMP(3))
      OR (c.state = 'claimed' AND c."claimedAt" < CURRENT_TIMESTAMP - interval '10 minutes'))
$$;
REVOKE ALL ON FUNCTION nexus_assortment_pending_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assortment_pending_workspaces() TO nexus_workspace_runtime;

-- ── Sharing studio step 5: the same product, live on the same channel in another business ──────
-- For the publish review's warning. Answers only for a product of the business in context, only through an active
-- link in either direction (this business follows it, or another business follows this one), and only the other
-- business's name, the market and how many listings are live there — no ids, no accounts, no values.
CREATE OR REPLACE FUNCTION nexus_shared_product_live_listings(product_id text, channel_name text)
RETURNS TABLE (business_name text, marketplace text, listings integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT p.id AS product, p."workspaceId" AS business
    FROM "Product" p
    WHERE p.id = product_id AND p."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
  ), counterparts AS (
    SELECT l."sourceWorkspaceId" AS business, l."sourceProductId" AS product
    FROM "CatalogLink" l JOIN me ON l."targetWorkspaceId" = me.business AND l."targetProductId" = me.product
    WHERE l.status = 'active'
    UNION
    SELECT l."targetWorkspaceId", l."targetProductId"
    FROM "CatalogLink" l JOIN me ON l."sourceWorkspaceId" = me.business AND l."sourceProductId" = me.product
    WHERE l.status = 'active'
  )
  SELECT w.name, cl.marketplace, count(*)::integer
  FROM counterparts c
  JOIN "Workspace" w ON w.id = c.business
  JOIN "ChannelListing" cl ON cl."workspaceId" = c.business AND cl."productId" = c.product
  WHERE cl.channel = channel_name AND cl."listingStatus" = 'ACTIVE' AND cl."isPublished" AND cl."externalListingId" IS NOT NULL
  GROUP BY w.name, cl.marketplace
$$;
REVOKE ALL ON FUNCTION nexus_shared_product_live_listings(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_shared_product_live_listings(text, text) TO nexus_workspace_runtime;

-- ── The repair job asks which of its links are behind ───────────────────────────────────────
-- Active links of the business in context, of active shares, whose source was saved after the last
-- sync (the product, a translation or an image), that never synced, or whose rename is held.
CREATE OR REPLACE FUNCTION nexus_assortment_stale_links(max_links integer)
RETURNS TABLE (link_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id
  FROM "CatalogLink" l
  JOIN "AssortmentShare" s ON s.id = l."shareId" AND s.status = 'active'
  JOIN "Product" p ON p.id = l."sourceProductId" AND p."workspaceId" = l."sourceWorkspaceId"
  WHERE l."targetWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND l.status = 'active'
    AND (l."lastSyncedAt" IS NULL OR l."heldSku" IS NOT NULL
      OR p."updatedAt" > l."lastSyncedAt"
      OR EXISTS (SELECT 1 FROM "ProductTranslation" t WHERE t."productId" = p.id AND t."updatedAt" > l."lastSyncedAt")
      OR EXISTS (SELECT 1 FROM "ProductImage" i WHERE i."productId" = p.id AND i."updatedAt" > l."lastSyncedAt")
      OR EXISTS (SELECT 1 FROM "Product" v WHERE v."parentId" = p.id AND v."updatedAt" > l."lastSyncedAt"))
  ORDER BY l."lastSyncedAt" NULLS FIRST, l.id
  LIMIT GREATEST(1, LEAST(max_links, 5000))
$$;
REVOKE ALL ON FUNCTION nexus_assortment_stale_links(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assortment_stale_links(integer) TO nexus_workspace_runtime;
