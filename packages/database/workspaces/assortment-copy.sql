-- AE.3 — the first copy: which products a share covers, who may read them, and catalog links.
-- Plan: docs/2026-09-16-assortment-engine-plan.md §16.
--
-- Shared by the generator (scripts/workspace-policies.mjs, which the disposable test database
-- applies) and the AE.3 migration, which ENDS WITH these exact bytes (policy-migrations.json;
-- check-policy-migration-parity.mjs). Change it only through a NEW migration ending with its new bytes.
--
-- The rules the database keeps, whatever the application does:
--   1. Which of the owner's products a follower may read is decided HERE, never by the caller:
--      only an active share, only asked from the follower business, only by one of its OWNERS.
--   2. A link can only join a product of the share's owner that the assortment covers to a
--      product of the share's follower, through an active share.
--   3. A link is never deleted; only detached. When a share ends, its links are detached.
--   4. One active link per follower product, and per (share, source product).

-- ── The products a share covers ─────────────────────────────────────────────────────────────
-- Top-level products of the owner that the assortment lists ("list") or does not exclude ("all"),
-- that are not deleted, plus their variations that are not deleted. INTERNAL: the runtime role
-- gets no EXECUTE, so it can only be reached through the checked functions below.
CREATE OR REPLACE FUNCTION nexus_assortment_share_product_ids(share_id text)
RETURNS TABLE (product_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH share AS (
    SELECT s."assortmentId", s."ownerWorkspaceId", a.selection
    FROM "AssortmentShare" s
    JOIN "Assortment" a ON a.id = s."assortmentId" AND a."workspaceId" = s."ownerWorkspaceId"
    WHERE s.id = share_id
  ), tops AS (
    SELECT p.id
    FROM share JOIN "Product" p ON p."workspaceId" = share."ownerWorkspaceId"
    WHERE p."parentId" IS NULL AND p."deletedAt" IS NULL
      AND CASE WHEN share.selection = 'list'
        THEN EXISTS (SELECT 1 FROM "AssortmentMember" m WHERE m."assortmentId" = share."assortmentId" AND m."productId" = p.id AND m.mode = 'include')
        ELSE NOT EXISTS (SELECT 1 FROM "AssortmentMember" m WHERE m."assortmentId" = share."assortmentId" AND m."productId" = p.id AND m.mode = 'exclude')
      END
  )
  SELECT id FROM tops
  UNION
  SELECT c.id FROM tops t JOIN "Product" c ON c."parentId" = t.id WHERE c."deletedAt" IS NULL
$$;
REVOKE ALL ON FUNCTION nexus_assortment_share_product_ids(text) FROM PUBLIC;

-- ── The follower asks what it may read ──────────────────────────────────────────────────────
-- Returns jsonb: {shareId, shareVersion, ownerWorkspaceId, fieldGroups, followSettings, products:
-- [{id, sku, parentId, version}]}, or {error, code, status} for a refusal the caller can show.
CREATE OR REPLACE FUNCTION nexus_assortment_copy_source(share_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  follower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  share "AssortmentShare"%ROWTYPE;
BEGIN
  IF follower_id IS NULL OR actor_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Sign in as an owner of this business profile to copy shared products.', 'code', 'session_required', 'status', 403);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WorkspaceMembership" m
    JOIN "Workspace" w ON w.id = m."workspaceId"
    JOIN "UserProfile" u ON u.id = m."userId"
    WHERE m."workspaceId" = follower_id AND m."userId" = actor_id
      AND m.status = 'active' AND w.status = 'active' AND u.status = 'active'
      AND EXISTS (SELECT 1 FROM "WorkspaceMemberRole" mr JOIN "Role" r ON r.id = mr."roleId"
        WHERE mr."membershipId" = m.id AND r.key = 'OWNER')
  ) THEN
    RETURN jsonb_build_object('error', 'An owner of this business profile must copy shared products.', 'code', 'workspace_owner_required', 'status', 403);
  END IF;
  SELECT * INTO share FROM "AssortmentShare" WHERE id = share_id AND "workspaceId" = follower_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This share is unavailable in this business profile.', 'code', 'share_not_found', 'status', 404);
  END IF;
  IF share.status <> 'active' THEN
    RETURN jsonb_build_object('error', format('This share is %s. Products can only be copied from an active share.', share.status), 'code', 'share_not_active', 'status', 409, 'currentStatus', share.status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = share."ownerWorkspaceId" AND w.status = 'active') THEN
    RETURN jsonb_build_object('error', 'The business that shared these products is unavailable.', 'code', 'owner_unavailable', 'status', 409);
  END IF;
  RETURN jsonb_build_object(
    'shareId', share.id, 'shareVersion', share.version, 'ownerWorkspaceId', share."ownerWorkspaceId",
    'fieldGroups', to_jsonb(share."fieldGroups"), 'followSettings', share."followSettings",
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'parentId', p."parentId", 'version', p.version) ORDER BY (p."parentId" IS NOT NULL), p.sku)
      FROM "Product" p WHERE p.id IN (SELECT product_id FROM nexus_assortment_share_product_ids(share.id))
    ), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION nexus_assortment_copy_source(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_assortment_copy_source(text) TO nexus_workspace_runtime;

-- ── Catalog links ───────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CatalogLink_linked_by_check') THEN
    ALTER TABLE "CatalogLink" ADD CONSTRAINT "CatalogLink_linked_by_check" CHECK ("linkedBy" IN ('created', 'matched'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CatalogLink_status_check') THEN
    ALTER TABLE "CatalogLink" ADD CONSTRAINT "CatalogLink_status_check"
      CHECK ((status = 'active' AND "detachedAt" IS NULL) OR (status = 'detached' AND "detachedAt" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CatalogLink_two_businesses_check') THEN
    ALTER TABLE "CatalogLink" ADD CONSTRAINT "CatalogLink_two_businesses_check" CHECK ("sourceWorkspaceId" <> "targetWorkspaceId");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CatalogLink_one_active_per_target"
  ON "CatalogLink" ("targetWorkspaceId", "targetProductId") WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS "CatalogLink_one_active_per_source"
  ON "CatalogLink" ("shareId", "sourceProductId") WHERE status = 'active';

ALTER TABLE "CatalogLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogLink" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CatalogLink" TO nexus_workspace_runtime;

-- The FOLLOWER owns its links: reads and writes them. The guard below decides which writes pass.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "CatalogLink";
CREATE POLICY nexus_workspace_isolation ON "CatalogLink" FOR ALL TO nexus_workspace_runtime
USING (("targetWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogLink"."targetWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("targetWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogLink"."targetWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- The OWNER may read which of its products are followed. A SEPARATE FOR SELECT policy — never a
-- wider USING on the policy above, which DELETE would consult alone (the BP.S1a trap).
DROP POLICY IF EXISTS nexus_catalog_link_source_read ON "CatalogLink";
CREATE POLICY nexus_catalog_link_source_read ON "CatalogLink" FOR SELECT TO nexus_workspace_runtime
USING (("sourceWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "CatalogLink"."sourceWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- The link guard. SECURITY DEFINER because it must look at the owner's product, which the
-- follower cannot read. Everything it trusts comes from the rows, not from the caller.
CREATE OR REPLACE FUNCTION nexus_catalog_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  context_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  share "AssortmentShare"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A catalog link is never deleted; detach it instead' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW."detachedAt" IS NOT NULL OR NEW."detachedReason" IS NOT NULL THEN
      RAISE EXCEPTION 'A new catalog link starts active' USING ERRCODE = '23514';
    END IF;
    IF context_id IS DISTINCT FROM NEW."targetWorkspaceId" THEN
      RAISE EXCEPTION 'Only the business that follows a product can link it' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO share FROM "AssortmentShare" WHERE id = NEW."shareId";
    IF NOT FOUND OR share."workspaceId" <> NEW."targetWorkspaceId" OR share."ownerWorkspaceId" <> NEW."sourceWorkspaceId" THEN
      RAISE EXCEPTION 'The link does not match its share' USING ERRCODE = '23514';
    END IF;
    IF share.status <> 'active' THEN
      RAISE EXCEPTION 'Products can only be linked through an active share' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM nexus_assortment_share_product_ids(share.id) x WHERE x.product_id = NEW."sourceProductId") THEN
      RAISE EXCEPTION 'The source product is not part of the shared assortment' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = NEW."targetProductId" AND p."workspaceId" = NEW."targetWorkspaceId" AND p."deletedAt" IS NULL) THEN
      RAISE EXCEPTION 'The follower product is not a product of the follower business' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW."shareId", NEW."sourceWorkspaceId", NEW."sourceProductId", NEW."targetWorkspaceId", NEW."targetProductId", NEW."linkedBy", NEW."createdByUserId", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD."shareId", OLD."sourceWorkspaceId", OLD."sourceProductId", OLD."targetWorkspaceId", OLD."targetProductId", OLD."linkedBy", OLD."createdByUserId", OLD."createdAt") THEN
    RAISE EXCEPTION 'A link''s products, share and origin cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'detached' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'A detached link stays detached; link the products again' USING ERRCODE = '23514';
  END IF;
  IF context_id IS DISTINCT FROM OLD."targetWorkspaceId" THEN
    -- The one write from outside the follower: an ended share detaching its links (trigger below).
    IF NOT (OLD.status = 'active' AND NEW.status = 'detached'
            AND EXISTS (SELECT 1 FROM "AssortmentShare" s WHERE s.id = OLD."shareId" AND s.status IN ('revoked', 'declined'))) THEN
      RAISE EXCEPTION 'Only the business that follows a product can change its link' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_catalog_link_guard ON "CatalogLink";
CREATE TRIGGER nexus_catalog_link_guard BEFORE INSERT OR UPDATE OR DELETE ON "CatalogLink"
  FOR EACH ROW EXECUTE FUNCTION nexus_catalog_link_guard();

-- An ended share detaches its links, in the same transaction as the end. Either business may end a
-- share, so this runs as definer: the follower's links must detach even when the OWNER revokes.
CREATE OR REPLACE FUNCTION nexus_assortment_share_detach_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('revoked', 'declined') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE "CatalogLink" SET status = 'detached', "detachedAt" = CURRENT_TIMESTAMP,
      "detachedReason" = format('share %s by the %s', NEW.status, NEW."endedBySide"), "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shareId" = NEW.id AND status = 'active';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_assortment_share_detach_links ON "AssortmentShare";
CREATE TRIGGER nexus_assortment_share_detach_links AFTER UPDATE ON "AssortmentShare"
  FOR EACH ROW EXECUTE FUNCTION nexus_assortment_share_detach_links();
