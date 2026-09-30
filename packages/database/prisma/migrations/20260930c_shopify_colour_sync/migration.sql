-- Durable Shopify colour work; additive only.
-- CreateTable
CREATE TABLE "ShopifyColourSync" (
    "workspaceId" TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "channelConnectionId" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'GLOBAL',
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyColourSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyColourSync_workspaceId_dueAt_idx" ON "ShopifyColourSync"("workspaceId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyColourSync_workspaceId_familyId_channelConnectionId__key" ON "ShopifyColourSync"("workspaceId", "familyId", "channelConnectionId", "marketplace", "aliasKey");

-- AddForeignKey
ALTER TABLE "ShopifyColourSync" ADD CONSTRAINT "ShopifyColourSync_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyColourSync" ADD CONSTRAINT "ShopifyColourSync_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopifyColourSync" TO nexus_workspace_runtime;
ALTER TABLE "ShopifyColourSync" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyColourSync" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ShopifyColourSync";
CREATE POLICY nexus_workspace_isolation ON "ShopifyColourSync" FOR ALL TO nexus_workspace_runtime USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyColourSync"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "ShopifyColourSync"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));
DROP TRIGGER IF EXISTS nexus_workspace_references ON "ShopifyColourSync";
CREATE TRIGGER nexus_workspace_references BEFORE INSERT OR UPDATE ON "ShopifyColourSync" FOR EACH ROW EXECUTE FUNCTION nexus_workspace_reference_guard('[{"model":"Product","from":"familyId","to":"id"},{"model":"ChannelConnection","from":"channelConnectionId","to":"id"}]');
-- Colour sync captures structural changes in the writer's transaction, including raw SQL and imports.
-- SECURITY INVOKER: ordinary workspace policies apply to every read and write. No cross-business door.
CREATE OR REPLACE FUNCTION nexus_queue_shopify_colour_sync(family_id text, scope_account text DEFAULT NULL, scope_market text DEFAULT NULL, scope_alias text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- The first Confirm has only proposals. Its existing lease must still be fenced by a concurrent edit.
  WITH scopes AS (
    SELECT c."workspaceId", c."familyId", c."channelConnectionId", c.marketplace, c."aliasKey"
    FROM "ShopifyColourProduct" c WHERE c."familyId" = family_id
      AND (c.state IN ('LINKED', 'DELETED') OR c.state = 'NOT_FOUND' AND c."shopifyProductId" IS NOT NULL)
    UNION
    SELECT w."workspaceId", w."familyId", w."channelConnectionId", w.marketplace, w."aliasKey"
    FROM "ShopifyColourSync" w WHERE w."familyId" = family_id AND w."leaseToken" IS NOT NULL
  )
  INSERT INTO "ShopifyColourSync" (id, "workspaceId", "familyId", "channelConnectionId", marketplace, "aliasKey", revision, "dueAt", "updatedAt")
  SELECT 'scs_' || md5(jsonb_build_array(c."workspaceId", c."familyId", c."channelConnectionId", c.marketplace, c."aliasKey")::text),
    c."workspaceId", c."familyId", c."channelConnectionId", c.marketplace, c."aliasKey", 1, CURRENT_TIMESTAMP + interval '2 seconds', CURRENT_TIMESTAMP
  FROM scopes c
  WHERE EXISTS (SELECT 1 FROM "Product" p WHERE p.id = family_id)
    AND (scope_account IS NULL OR (c."channelConnectionId" = scope_account AND c.marketplace = scope_market AND c."aliasKey" = scope_alias))
  GROUP BY c."workspaceId", c."familyId", c."channelConnectionId", c.marketplace, c."aliasKey"
  ORDER BY c."workspaceId", c."familyId", c."channelConnectionId", c.marketplace, c."aliasKey"
  ON CONFLICT ("workspaceId", "familyId", "channelConnectionId", marketplace, "aliasKey") DO UPDATE
    SET revision = "ShopifyColourSync".revision + 1, "dueAt" = EXCLUDED."dueAt", "updatedAt" = CURRENT_TIMESTAMP;
  UPDATE "ShopifyColourProduct" SET "linkVerifiedAt" = NULL
    WHERE "familyId" = family_id AND "linkVerifiedAt" IS NOT NULL
      AND (scope_account IS NULL OR ("channelConnectionId" = scope_account AND marketplace = scope_market AND "aliasKey" = scope_alias));
END;
$$;
REVOKE ALL ON FUNCTION nexus_queue_shopify_colour_sync(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_queue_shopify_colour_sync(text, text, text, text) TO nexus_workspace_runtime;

CREATE OR REPLACE FUNCTION nexus_capture_shopify_colour_structure() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE families text[];
DECLARE family_id text;
BEGIN
  IF TG_TABLE_NAME = 'Product' THEN
    IF TG_OP = 'UPDATE' AND
      (NEW."parentId", NEW."deletedAt", NEW.sku, NEW."variationAxes", NEW."variationAxisCodes", NEW."variationValueOrder", NEW."categoryAttributes"->'variations')
      IS NOT DISTINCT FROM
      (OLD."parentId", OLD."deletedAt", OLD.sku, OLD."variationAxes", OLD."variationAxisCodes", OLD."variationValueOrder", OLD."categoryAttributes"->'variations') THEN RETURN NEW; END IF;
    IF TG_OP <> 'INSERT' THEN families := ARRAY[COALESCE(OLD."parentId", OLD.id)]; END IF;
    IF TG_OP <> 'DELETE' THEN families := array_append(families, COALESCE(NEW."parentId", NEW.id)); END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW.state, NEW."shopifyProductId", NEW."colourName", NEW."splitAxis", NEW."valueKey")
      IS NOT DISTINCT FROM (OLD.state, OLD."shopifyProductId", OLD."colourName", OLD."splitAxis", OLD."valueKey") THEN RETURN NEW; END IF;
    IF TG_OP <> 'INSERT' THEN families := ARRAY[OLD."familyId"]; END IF;
    IF TG_OP <> 'DELETE' THEN families := array_append(families, NEW."familyId"); END IF;
  END IF;
  FOR family_id IN SELECT DISTINCT f FROM unnest(families) f WHERE f IS NOT NULL ORDER BY f LOOP
    IF TG_TABLE_NAME = 'Product' THEN
      PERFORM nexus_queue_shopify_colour_sync(family_id);
    ELSIF TG_OP = 'DELETE' THEN
      PERFORM nexus_queue_shopify_colour_sync(family_id, OLD."channelConnectionId", OLD.marketplace, OLD."aliasKey");
    ELSE
      PERFORM nexus_queue_shopify_colour_sync(family_id, NEW."channelConnectionId", NEW.marketplace, NEW."aliasKey");
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION nexus_capture_shopify_colour_structure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_capture_shopify_colour_structure() TO nexus_workspace_runtime;
DROP TRIGGER IF EXISTS nexus_shopify_colour_structure ON "Product";
CREATE TRIGGER nexus_shopify_colour_structure AFTER INSERT OR UPDATE OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION nexus_capture_shopify_colour_structure();
DROP TRIGGER IF EXISTS nexus_shopify_colour_confirmation ON "ShopifyColourProduct";
CREATE TRIGGER nexus_shopify_colour_confirmation AFTER INSERT OR UPDATE OF state, "shopifyProductId", "colourName", "splitAxis", "valueKey" OR DELETE ON "ShopifyColourProduct"
  FOR EACH ROW EXECUTE FUNCTION nexus_capture_shopify_colour_structure();

CREATE OR REPLACE FUNCTION nexus_capture_shopify_colour_settings() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE scope record;
BEGIN
  IF NEW."connectionMetadata"->'shopifyColourProducts' IS NOT DISTINCT FROM OLD."connectionMetadata"->'shopifyColourProducts' THEN RETURN NEW; END IF;
  FOR scope IN SELECT DISTINCT c."familyId", c.marketplace, c."aliasKey" FROM "ShopifyColourProduct" c
    WHERE c."channelConnectionId" = NEW.id ORDER BY c."familyId", c.marketplace, c."aliasKey" LOOP
    PERFORM nexus_queue_shopify_colour_sync(scope."familyId", NEW.id, scope.marketplace, scope."aliasKey");
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION nexus_capture_shopify_colour_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_capture_shopify_colour_settings() TO nexus_workspace_runtime;
DROP TRIGGER IF EXISTS nexus_shopify_colour_settings ON "ChannelConnection";
CREATE TRIGGER nexus_shopify_colour_settings AFTER UPDATE OF "connectionMetadata" ON "ChannelConnection"
  FOR EACH ROW EXECUTE FUNCTION nexus_capture_shopify_colour_settings();
