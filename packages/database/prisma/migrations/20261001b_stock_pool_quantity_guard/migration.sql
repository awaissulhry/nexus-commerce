-- Shared stock by SKU, PR 2 (Owner 2026-10-01): "I should not be able to change the quantity unless it's deriving from
-- its own pool or unless I'm changing it directly from the profile we are sourcing from."
--
-- No table changes. The shared policy file packages/database/workspaces/stock-pool.sql, which this migration ENDS WITH
-- byte for byte (policy-migrations.json), adds nexus_stock_pool_quantity_guard: while a product sells from another
-- business's stock, none of its listings may become a fixed number and no shared eBay variant of it may become pinned
-- (Amazon-managed listings excepted; buffers and turning a fixed number back to follow stay allowed).

-- Shared stock between business profiles — the lending permission, the product links, the work
-- queue and the safe doors. Plan: docs/2026-09-19-shared-stock-plan.md; contract:
-- docs/2026-09-19-shared-stock-build.md §1.
--
-- Shared by the generator (scripts/workspace-policies.mjs, which the disposable test database
-- applies) and the migration policy-migrations.json names for it, which ENDS WITH these exact bytes
-- (check-policy-migration-parity.mjs; first 20260919a_stock_pool). Change it only through a NEW
-- migration that ends with its new bytes.
--
-- Words: the LENDER (StockPoolGrant."ownerWorkspaceId") owns the warehouses and the stock rows.
-- The BORROWER (StockPoolGrant."workspaceId", StockPoolLink."workspaceId") sells from them.
--
-- The rules the database keeps, whatever the application does:
--   1. Consent cannot be skipped: an owner of the lender offers, and only an owner of the borrower
--      can make a pending grant active. Offered terms (the two businesses, the warehouses) never
--      change. A grant is never deleted.
--   2. A borrower product sells from a pool only through an ACTIVE grant AND an identity that names
--      the lender product: the SAME SKU in both businesses (a SKU link, StockPoolLink.sku; Owner
--      2026-10-01: "the SKU is the unique identification number for that specific profile"), or,
--      for links made before that, an ACTIVE catalog link. One active link per product; no chains;
--      never deleted. While a link is active, neither business may rename the SKU or delete the
--      product (Owner D1, 2026-10-01): disconnect first. And the borrower may not give it a fixed
--      number: its quantity is the lender's stock (nexus_stock_pool_quantity_guard).
--   3. The borrower never reads or writes the lender's stock tables. It passes through the doors
--      below, which check 1 and 2 from the rows (never from the caller), take the same product row
--      lock as every other stock writer (lockProductStock, FOR NO KEY UPDATE), change the numbers
--      and write the movement with the borrower and its order on it.
--   4. Every change that moves a pool number, whoever makes it (the app, raw SQL, a door, a trigger),
--      writes a StockPoolTask for each business whose listings must follow. No code path can forget.
--      Each such write also wakes the worker at commit (pg_notify 'nexus_stock_pool'), so the other
--      business's listings follow a sale in about a second, whichever process wrote it.
--   5. New sales use the pool only while it is on. A hold or a sale that already exists can always
--      be released, consumed or put back, so orders already made are never stranded.

-- ── Helpers (INTERNAL: the runtime role gets no EXECUTE) ────────────────────────────────────
-- A cuid-shaped id for rows written here: 'c' + 24 lowercase hex characters (the cuid alphabet).
CREATE OR REPLACE FUNCTION nexus_pool_id() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || txid_current()::text), 1, 24)
$$;
REVOKE ALL ON FUNCTION nexus_pool_id() FROM PUBLIC;

CREATE OR REPLACE FUNCTION nexus_pool_is_owner(workspace_id text, user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "WorkspaceMembership" m
    JOIN "Workspace" w ON w.id = m."workspaceId"
    JOIN "UserProfile" u ON u.id = m."userId"
    WHERE m."workspaceId" = workspace_id AND m."userId" = user_id
      AND m.status = 'active' AND w.status = 'active' AND u.status = 'active'
      AND EXISTS (SELECT 1 FROM "WorkspaceMemberRole" mr JOIN "Role" r ON r.id = mr."roleId"
        WHERE mr."membershipId" = m.id AND r.key = 'OWNER'))
$$;
REVOKE ALL ON FUNCTION nexus_pool_is_owner(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION nexus_pool_is_member(workspace_id text, user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "WorkspaceMembership" m
    JOIN "Workspace" w ON w.id = m."workspaceId"
    JOIN "UserProfile" u ON u.id = m."userId"
    WHERE m."workspaceId" = workspace_id AND m."userId" = user_id
      AND m.status = 'active' AND w.status = 'active' AND u.status = 'active')
$$;
REVOKE ALL ON FUNCTION nexus_pool_is_member(text, text) FROM PUBLIC;

-- ── Values ──────────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolGrant_status_check') THEN
    ALTER TABLE "StockPoolGrant" ADD CONSTRAINT "StockPoolGrant_status_check"
      CHECK (status IN ('pending', 'active', 'paused', 'declined', 'revoked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolGrant_two_businesses_check') THEN
    ALTER TABLE "StockPoolGrant" ADD CONSTRAINT "StockPoolGrant_two_businesses_check" CHECK ("ownerWorkspaceId" <> "workspaceId");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolGrant_locations_check') THEN
    -- IS NOT NULL first: a CHECK whose expression is NULL passes (see AssortmentShare_field_groups_check).
    ALTER TABLE "StockPoolGrant" ADD CONSTRAINT "StockPoolGrant_locations_check"
      CHECK ("locationIds" IS NOT NULL AND cardinality("locationIds") BETWEEN 1 AND 50 AND array_position("locationIds", NULL) IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolGrant_ended_side_check') THEN
    ALTER TABLE "StockPoolGrant" ADD CONSTRAINT "StockPoolGrant_ended_side_check"
      CHECK (("endedBySide" IS NULL AND "endedAt" IS NULL) OR ("endedBySide" IN ('owner', 'borrower') AND "endedAt" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolLink_status_check') THEN
    ALTER TABLE "StockPoolLink" ADD CONSTRAINT "StockPoolLink_status_check"
      CHECK ((status = 'active' AND "endedAt" IS NULL AND "endedReason" IS NULL) OR (status = 'ended' AND "endedAt" IS NOT NULL AND "endedReason" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolLink_identity_check') THEN
    -- Exactly one identity: the SKU both products have (a SKU link), or the catalog link of an older link.
    ALTER TABLE "StockPoolLink" ADD CONSTRAINT "StockPoolLink_identity_check"
      CHECK (("catalogLinkId" IS NULL AND sku IS NOT NULL AND btrim(sku) <> '') OR ("catalogLinkId" IS NOT NULL AND sku IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StockPoolTask_kind_check') THEN
    ALTER TABLE "StockPoolTask" ADD CONSTRAINT "StockPoolTask_kind_check"
      CHECK ((kind = 'recascade' AND "movementId" IS NULL) OR (kind = 'settle' AND "movementId" IS NOT NULL));
  END IF;
END $$;

-- One open grant per lender and borrower. To change the warehouses, end it and offer a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "StockPoolGrant_one_open_grant"
  ON "StockPoolGrant" ("ownerWorkspaceId", "workspaceId") WHERE status IN ('pending', 'active', 'paused');
-- One source at a time: one active link per borrower product.
CREATE UNIQUE INDEX IF NOT EXISTS "StockPoolLink_one_active_per_product"
  ON "StockPoolLink" ("workspaceId", "productId") WHERE status = 'active';
-- The StockLevel trigger asks "does anyone borrow this lender product?" on every stock write.
CREATE INDEX IF NOT EXISTS "StockPoolLink_active_by_source"
  ON "StockPoolLink" ("sourceProductId") WHERE status = 'active';
-- The doors find a borrower order's holds and sales in the lender's ledger.
CREATE INDEX IF NOT EXISTS "StockReservation_pool_consumer"
  ON "StockReservation" ("consumerWorkspaceId", "consumerOrderRef") WHERE "consumerWorkspaceId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "StockMovement_pool_consumer"
  ON "StockMovement" ("consumerWorkspaceId", "consumerOrderRef") WHERE "consumerWorkspaceId" IS NOT NULL;

-- ── Row-level security for the grant (global: it links two businesses) ─────────────────────
ALTER TABLE "StockPoolGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockPoolGrant" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "StockPoolGrant" TO nexus_workspace_runtime;

-- The LENDER: reads and writes its outgoing grants. The guard below decides which writes pass.
DROP POLICY IF EXISTS nexus_workspace_isolation ON "StockPoolGrant";
CREATE POLICY nexus_workspace_isolation ON "StockPoolGrant" FOR ALL TO nexus_workspace_runtime
USING (("ownerWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockPoolGrant"."ownerWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active'))))) WITH CHECK (("ownerWorkspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockPoolGrant"."ownerWorkspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- The BORROWER: reads its incoming grants, and nothing else.
-- 🔴 A SEPARATE FOR SELECT policy, never a second arm on the FOR ALL policy above: DELETE consults
-- USING alone, so widening that USING would let the borrower delete the lender's row (the BP.S1a trap).
DROP POLICY IF EXISTS nexus_stock_pool_grant_borrower_read ON "StockPoolGrant";
CREATE POLICY nexus_stock_pool_grant_borrower_read ON "StockPoolGrant" FOR SELECT TO nexus_workspace_runtime
USING (("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '') AND EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = "StockPoolGrant"."workspaceId" AND w.status = 'active'
      AND (NULLIF(current_setting('nexus.actor_id', true), '') IS NULL OR EXISTS (
        SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
        WHERE m."workspaceId" = w.id AND m."userId" = current_setting('nexus.actor_id', true)
          AND m.status = 'active' AND u.status = 'active')))));

-- ── The grant guard: which side may make which change ───────────────────────────────────────
-- The acting side is the business in the request context and the person is nexus.actor_id; neither
-- is a parameter. SECURITY DEFINER only to read the lender's locations and both memberships.
CREATE OR REPLACE FUNCTION nexus_stock_pool_grant_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  context_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  side text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A stock lending permission is never deleted; end it instead' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.version <> 1
       OR NEW."respondedByUserId" IS NOT NULL OR NEW."respondedAt" IS NOT NULL
       OR NEW."pausedByUserId" IS NOT NULL OR NEW."pausedAt" IS NOT NULL
       OR NEW."endedBySide" IS NOT NULL OR NEW."endedByUserId" IS NOT NULL OR NEW."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A new stock lending permission starts pending and unanswered' USING ERRCODE = '23514';
    END IF;
    IF context_id IS DISTINCT FROM NEW."ownerWorkspaceId" THEN
      RAISE EXCEPTION 'Only the business that owns the stock can lend it' USING ERRCODE = '42501';
    END IF;
    IF actor_id IS NULL OR NEW."createdByUserId" IS DISTINCT FROM actor_id
       OR NOT nexus_pool_is_owner(NEW."ownerWorkspaceId", actor_id)
       OR NOT nexus_pool_is_member(NEW."workspaceId", actor_id) THEN
      RAISE EXCEPTION 'Stock is lent by an owner of the lending business who is also a member of the borrowing business' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(DISTINCT x) FROM unnest(NEW."locationIds") x) <> cardinality(NEW."locationIds") THEN
      RAISE EXCEPTION 'Each warehouse is lent once' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(NEW."locationIds") x
      WHERE NOT EXISTS (SELECT 1 FROM "StockLocation" l WHERE l.id = x AND l."workspaceId" = NEW."ownerWorkspaceId" AND l.type = 'WAREHOUSE' AND l."isActive")
    ) THEN
      RAISE EXCEPTION 'Only active warehouses of the lending business can be lent (never Amazon FBA stock)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW."ownerWorkspaceId" <> OLD."ownerWorkspaceId" OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."locationIds" IS DISTINCT FROM OLD."locationIds"
     OR NEW."createdByUserId" <> OLD."createdByUserId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'What a stock lending permission offers cannot change; end it and offer a new one' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Every change to a stock lending permission must advance its version by one' USING ERRCODE = '23514';
  END IF;

  side := CASE WHEN context_id = OLD."ownerWorkspaceId" THEN 'owner'
               WHEN context_id = OLD."workspaceId" THEN 'borrower' END;
  IF side IS NULL THEN
    RAISE EXCEPTION 'Only the two businesses in a stock lending permission can change it' USING ERRCODE = '42501';
  END IF;
  IF actor_id IS NULL OR NOT nexus_pool_is_owner(context_id, actor_id) THEN
    RAISE EXCEPTION 'Only an owner of the business can change a stock lending permission' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    (side = 'owner' AND (
      (OLD.status = 'pending' AND NEW.status = 'revoked') OR
      (OLD.status = 'active' AND NEW.status IN ('paused', 'revoked')) OR
      (OLD.status = 'paused' AND NEW.status IN ('active', 'revoked'))))
    OR
    (side = 'borrower' AND (
      (OLD.status = 'pending' AND NEW.status IN ('active', 'declined')) OR
      (OLD.status IN ('active', 'paused') AND NEW.status = 'revoked')))
  ) THEN
    RAISE EXCEPTION 'The % cannot change a % stock lending permission to %', side, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('revoked', 'declined') AND (NEW."endedBySide" IS DISTINCT FROM side OR NEW."endedAt" IS NULL OR NEW."endedByUserId" IS DISTINCT FROM actor_id) THEN
    RAISE EXCEPTION 'An ended stock lending permission records which side ended it, who and when' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('pending', 'active', 'paused') AND NEW."endedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'An open stock lending permission has no end' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_grant_guard ON "StockPoolGrant";
CREATE TRIGGER nexus_stock_pool_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockPoolGrant"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_grant_guard();

-- After a status change: an ended grant ends its links (their own trigger then queues the listing
-- work); a pause or a resume queues the work directly, because the links stay.
CREATE OR REPLACE FUNCTION nexus_stock_pool_grant_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  IF NEW.status IN ('revoked', 'declined') THEN
    UPDATE "StockPoolLink" SET status = 'ended', "endedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP,
      "endedReason" = CASE WHEN NEW."endedBySide" = 'owner' THEN 'The lending business ended the shared stock.'
                           ELSE 'This business left the shared stock.' END
    WHERE "grantId" = NEW.id AND status = 'active';
  ELSIF (OLD.status = 'active') <> (NEW.status = 'active') THEN
    INSERT INTO "StockPoolTask" (id, "workspaceId", kind, "productId", reason)
    SELECT nexus_pool_id(), l."workspaceId", 'recascade', l."productId", 'grant'
    FROM "StockPoolLink" l WHERE l."grantId" = NEW.id AND l.status = 'active';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_grant_changed ON "StockPoolGrant";
CREATE TRIGGER nexus_stock_pool_grant_changed AFTER UPDATE ON "StockPoolGrant"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_grant_changed();

-- ── The borrower's answer ───────────────────────────────────────────────────────────────────
-- The borrower has no UPDATE policy on StockPoolGrant, so it answers here. SECURITY DEFINER lets it
-- write the lender's row; everything else is re-checked: the request's business must be the
-- borrower, the person an active OWNER of it, the version must match, and the guard above still
-- validates the change (it fires on this UPDATE with the borrower's context).
-- Returns jsonb: {grant}, or {error, code, status} for a refusal the caller can show.
CREATE OR REPLACE FUNCTION nexus_stock_pool_grant_respond(grant_id text, decision text, expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  pool_grant "StockPoolGrant"%ROWTYPE;
  next_status text;
BEGIN
  IF borrower_id IS NULL OR actor_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Sign in as an owner of this business profile to answer.', 'code', 'session_required', 'status', 403);
  END IF;
  IF NOT nexus_pool_is_owner(borrower_id, actor_id) THEN
    RETURN jsonb_build_object('error', 'An owner of this business profile must answer.', 'code', 'workspace_owner_required', 'status', 403);
  END IF;
  next_status := CASE decision WHEN 'accept' THEN 'active' WHEN 'decline' THEN 'declined' WHEN 'leave' THEN 'revoked' END;
  IF next_status IS NULL THEN
    RETURN jsonb_build_object('error', 'Choose accept, decline or leave.', 'code', 'invalid_decision', 'status', 400);
  END IF;

  SELECT * INTO pool_grant FROM "StockPoolGrant" WHERE id = grant_id AND "workspaceId" = borrower_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This shared stock offer is unavailable in this business profile.', 'code', 'grant_not_found', 'status', 404);
  END IF;
  IF pool_grant.version <> expected_version THEN
    RETURN jsonb_build_object('error', 'This shared stock changed since you loaded it. Review it again.', 'code', 'grant_changed', 'status', 409,
      'currentStatus', pool_grant.status, 'currentVersion', pool_grant.version);
  END IF;
  IF NOT ((decision IN ('accept', 'decline') AND pool_grant.status = 'pending')
       OR (decision = 'leave' AND pool_grant.status IN ('active', 'paused'))) THEN
    RETURN jsonb_build_object('error', format('Shared stock that is %s cannot be answered with %s.', pool_grant.status, decision), 'code', 'grant_state', 'status', 409,
      'currentStatus', pool_grant.status, 'currentVersion', pool_grant.version);
  END IF;
  IF decision = 'accept' AND NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = pool_grant."ownerWorkspaceId" AND w.status = 'active') THEN
    RETURN jsonb_build_object('error', 'The business that lends this stock is unavailable.', 'code', 'lender_unavailable', 'status', 409);
  END IF;

  UPDATE "StockPoolGrant" SET
    status = next_status,
    version = pool_grant.version + 1,
    "updatedAt" = CURRENT_TIMESTAMP,
    "respondedByUserId" = CASE WHEN decision IN ('accept', 'decline') THEN actor_id ELSE pool_grant."respondedByUserId" END,
    "respondedAt" = CASE WHEN decision IN ('accept', 'decline') THEN CURRENT_TIMESTAMP ELSE pool_grant."respondedAt" END,
    "endedBySide" = CASE WHEN decision IN ('decline', 'leave') THEN 'borrower' END,
    "endedByUserId" = CASE WHEN decision IN ('decline', 'leave') THEN actor_id END,
    "endedAt" = CASE WHEN decision IN ('decline', 'leave') THEN CURRENT_TIMESTAMP END
  WHERE id = grant_id
  RETURNING * INTO pool_grant;

  RETURN jsonb_build_object('grant', to_jsonb(pool_grant));
END $$;
REVOKE ALL ON FUNCTION nexus_stock_pool_grant_respond(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_stock_pool_grant_respond(text, text, integer) TO nexus_workspace_runtime;

-- ── The link guard ──────────────────────────────────────────────────────────────────────────
-- StockPoolLink is borrower-owned (its generated isolation policy scopes it). SECURITY DEFINER
-- because it must look at the grant, the catalog link and the lender's product. Everything it
-- trusts comes from the rows, not from the caller. A SKU link (no catalog link) names the SKU, and
-- both products must have exactly that SKU (StockPoolLink_identity_check: one identity or the other).
CREATE OR REPLACE FUNCTION nexus_stock_pool_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  context_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  pool_grant "StockPoolGrant"%ROWTYPE;
  catalog "CatalogLink"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A shared stock link is never deleted; end it instead' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (NEW."catalogLinkId" IS NULL) = (NEW.sku IS NULL) OR btrim(COALESCE(NEW.sku, 'x')) = '' THEN
      RAISE EXCEPTION 'A shared stock link has exactly one identity: the SKU both products have, or (older links) a catalog link' USING ERRCODE = '23514';
    END IF;
    -- Links are rare; one at a time closes the race between two links that would form a chain.
    PERFORM pg_advisory_xact_lock(hashtext('nexus_stock_pool_link'));
    IF NEW.status <> 'active' OR NEW."endedAt" IS NOT NULL OR NEW."endedReason" IS NOT NULL OR NEW."endedByUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'A new shared stock link starts active' USING ERRCODE = '23514';
    END IF;
    IF context_id IS DISTINCT FROM NEW."workspaceId" THEN
      RAISE EXCEPTION 'Only the business that borrows stock can link its products' USING ERRCODE = '42501';
    END IF;
    IF actor_id IS NULL OR NEW."createdByUserId" IS DISTINCT FROM actor_id OR NOT nexus_pool_is_owner(context_id, actor_id) THEN
      RAISE EXCEPTION 'Only an owner of this business can switch a product to shared stock' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO pool_grant FROM "StockPoolGrant" WHERE id = NEW."grantId";
    IF NOT FOUND OR pool_grant."workspaceId" <> NEW."workspaceId" THEN
      RAISE EXCEPTION 'The link does not match its shared stock' USING ERRCODE = '23514';
    END IF;
    IF pool_grant.status <> 'active' THEN
      RAISE EXCEPTION 'Products can only be switched to shared stock that is on' USING ERRCODE = '23514';
    END IF;
    IF NEW."catalogLinkId" IS NOT NULL THEN
      -- An older link: made through a product share. New links are SKU links (below).
      SELECT * INTO catalog FROM "CatalogLink" WHERE id = NEW."catalogLinkId";
      IF NOT FOUND OR catalog.status <> 'active' OR catalog."targetWorkspaceId" <> NEW."workspaceId" OR catalog."targetProductId" <> NEW."productId"
         OR catalog."sourceWorkspaceId" <> pool_grant."ownerWorkspaceId" OR catalog."sourceProductId" <> NEW."sourceProductId" THEN
        RAISE EXCEPTION 'Only a product linked to a product of the lending business can use its stock' USING ERRCODE = '23514';
      END IF;
    END IF;
    -- Both product rows, in one sorted order, FOR KEY SHARE: a SKU rename or a delete (FOR UPDATE) of either
    -- waits for this link, and its product guard then sees it; or this waits for the rename, and the checks
    -- below read the new SKU. Stock writers (FOR NO KEY UPDATE) are not blocked.
    PERFORM 1 FROM "Product" p WHERE p.id IN (NEW."productId", NEW."sourceProductId") ORDER BY p.id COLLATE "C" FOR KEY SHARE;
    IF NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = NEW."productId" AND p."workspaceId" = NEW."workspaceId" AND p."deletedAt" IS NULL
                   AND (NEW."catalogLinkId" IS NOT NULL OR p.sku = NEW.sku)) THEN
      RAISE EXCEPTION '%', CASE WHEN NEW."catalogLinkId" IS NULL THEN 'The product is not a product of this business with this SKU'
        ELSE 'The product is not a product of this business' END USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = NEW."sourceProductId" AND p."workspaceId" = pool_grant."ownerWorkspaceId" AND p."deletedAt" IS NULL
                   AND (NEW."catalogLinkId" IS NOT NULL OR p.sku = NEW.sku)) THEN
      RAISE EXCEPTION '%', CASE WHEN NEW."catalogLinkId" IS NULL THEN 'The lending business has no product with this SKU'
        ELSE 'The lending business no longer has this product' END USING ERRCODE = '23514';
    END IF;
    -- No chains: a product that sells from a pool cannot lend onward, and a borrowed product is not a source.
    IF EXISTS (SELECT 1 FROM "StockPoolLink" l WHERE l."sourceProductId" = NEW."productId" AND l.status = 'active')
       OR EXISTS (SELECT 1 FROM "StockPoolLink" l WHERE l."productId" = NEW."sourceProductId" AND l.status = 'active') THEN
      RAISE EXCEPTION 'Shared stock cannot be passed on: a product either lends or borrows, never both' USING ERRCODE = '23514';
    END IF;
    -- Version 1 does not move lots or serial numbers through a pool.
    IF EXISTS (SELECT 1 FROM "Lot" x WHERE x."productId" = NEW."sourceProductId" AND x."unitsRemaining" > 0)
       OR EXISTS (SELECT 1 FROM "SerialNumber" x WHERE x."productId" = NEW."sourceProductId") THEN
      RAISE EXCEPTION 'This product is tracked by lot or serial number. Shared stock does not support that yet' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW."workspaceId", NEW."grantId", NEW."catalogLinkId", NEW.sku, NEW."productId", NEW."sourceProductId", NEW."createdByUserId", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD."workspaceId", OLD."grantId", OLD."catalogLinkId", OLD.sku, OLD."productId", OLD."sourceProductId", OLD."createdByUserId", OLD."createdAt") THEN
    RAISE EXCEPTION 'A shared stock link''s products, permission and origin cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'ended' THEN
    RAISE EXCEPTION 'An ended shared stock link stays ended; switch the product again' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'active' THEN
    RETURN NEW; -- updatedAt only
  END IF;
  -- active → ended: the borrower switching the product to its own stock, or an ending grant or
  -- catalog link (the definer triggers above and below, from whichever business ended it).
  IF context_id IS DISTINCT FROM OLD."workspaceId" THEN
    IF NOT (EXISTS (SELECT 1 FROM "StockPoolGrant" g WHERE g.id = OLD."grantId" AND g.status IN ('revoked', 'declined'))
            OR EXISTS (SELECT 1 FROM "CatalogLink" c WHERE c.id = OLD."catalogLinkId" AND c.status = 'detached')) THEN
      RAISE EXCEPTION 'Only the business that borrows stock can switch its products back' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."endedByUserId" IS NOT NULL AND NEW."endedByUserId" IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'An ended link records the person who ended it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_link_guard ON "StockPoolLink";
CREATE TRIGGER nexus_stock_pool_link_guard BEFORE INSERT OR UPDATE OR DELETE ON "StockPoolLink"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_link_guard();

-- A link that starts or ends means that product's listings must follow a new source.
CREATE OR REPLACE FUNCTION nexus_stock_pool_link_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO "StockPoolTask" (id, "workspaceId", kind, "productId", reason)
    VALUES (nexus_pool_id(), NEW."workspaceId", 'recascade', NEW."productId", 'link');
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_link_changed ON "StockPoolLink";
CREATE TRIGGER nexus_stock_pool_link_changed AFTER INSERT OR UPDATE ON "StockPoolLink"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_link_changed();

-- A detached catalog link (the product share ended, from either side) ends the pool links that
-- relied on it: without it, nothing says which lender product the borrower product is.
CREATE OR REPLACE FUNCTION nexus_stock_pool_catalog_detached() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'detached' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE "StockPoolLink" SET status = 'ended', "endedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP,
      "endedReason" = 'The product share with the lending business ended.'
    WHERE "catalogLinkId" = NEW.id AND status = 'active';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_catalog_detached ON "CatalogLink";
CREATE TRIGGER nexus_stock_pool_catalog_detached AFTER UPDATE ON "CatalogLink"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_catalog_detached();

-- ── A connected product keeps its SKU (Owner D1, 2026-10-01) ────────────────────────────────
-- While a product shares stock (it borrows, or it lends to another business), neither business may
-- rename its SKU, delete it (soft or hard) or move it: the SKU is what connects the two. Disconnect
-- first. Every link counts, SKU links and older ones. SECURITY DEFINER: the lender must see the
-- borrower's links, and the other business's name for the sentence.
-- Races with a new link: a SKU rename or a hard delete takes FOR UPDATE on the row, which the link
-- guard's FOR KEY SHARE waits for (or makes wait). A soft delete is a plain update (FOR NO KEY UPDATE),
-- so it takes the link lock shared first: a link being made finishes before this check reads.
CREATE OR REPLACE FUNCTION nexus_stock_pool_product_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  other_name text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sku IS NOT DISTINCT FROM OLD.sku AND NEW."workspaceId" IS NOT DISTINCT FROM OLD."workspaceId"
       AND NOT (OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    IF NEW.sku IS NOT DISTINCT FROM OLD.sku AND NEW."workspaceId" IS NOT DISTINCT FROM OLD."workspaceId" THEN
      PERFORM pg_advisory_xact_lock_shared(hashtext('nexus_stock_pool_link'));
    END IF;
  END IF;
  SELECT lender.name INTO other_name
  FROM "StockPoolLink" l JOIN "StockPoolGrant" g ON g.id = l."grantId" JOIN "Workspace" lender ON lender.id = g."ownerWorkspaceId"
  WHERE l."productId" = OLD.id AND l.status = 'active'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% sells from the stock of %. Disconnect it first (Matrix, Stock source), then change it.', OLD.sku, other_name
      USING ERRCODE = '23514';
  END IF;
  SELECT borrower.name INTO other_name
  FROM "StockPoolLink" l JOIN "Workspace" borrower ON borrower.id = l."workspaceId"
  WHERE l."sourceProductId" = OLD.id AND l.status = 'active'
  ORDER BY borrower.name
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% shares its stock with %. Disconnect it there first, then change it.', OLD.sku, other_name
      USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_product_guard ON "Product";
CREATE TRIGGER nexus_stock_pool_product_guard BEFORE UPDATE OF sku, "deletedAt", "workspaceId" OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_product_guard();

-- ── A product that sells from a lent stock has no fixed number (Owner, 2026-10-01) ─────────────
-- "I should not be able to change the quantity unless it's deriving from its own pool or unless I'm changing it
-- directly from the profile we are sourcing from." While a product of this business sells from another business's
-- stock, none of its listings may BECOME a fixed number (ChannelListing."followMasterQuantity" → false), and no shared
-- eBay variant of it may become pinned (SharedListingMembership."pinnedQuantity" → a number): its quantity is the
-- lender's stock, changed in the lender. Connecting turns the fixed numbers it had back to follow
-- (pool-links.service.ts). Amazon-managed (FBA) listings show Amazon's own number and are not touched. A buffer stays
-- allowed: it only holds units back. Turning a fixed number back to follow is always allowed.
CREATE OR REPLACE FUNCTION nexus_stock_pool_quantity_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  lender_name text;
  product_sku text;
BEGIN
  IF TG_TABLE_NAME = 'ChannelListing' THEN
    IF NEW."followMasterQuantity" IS DISTINCT FROM false OR NEW."fulfillmentMethod" = 'FBA'
       OR (TG_OP = 'UPDATE' AND OLD."followMasterQuantity" IS NOT DISTINCT FROM false) THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW."pinnedQuantity" IS NULL OR NEW."productId" IS NULL
       OR (TG_OP = 'UPDATE' AND OLD."pinnedQuantity" IS NOT NULL) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT lender.name, p.sku INTO lender_name, product_sku
  FROM "StockPoolLink" l
  JOIN "StockPoolGrant" g ON g.id = l."grantId"
  JOIN "Workspace" lender ON lender.id = g."ownerWorkspaceId"
  JOIN "Product" p ON p.id = l."productId"
  WHERE l."productId" = NEW."productId" AND l.status = 'active'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% sells from the stock of %, so its quantity follows that stock. Change the stock in %, or disconnect it first (Matrix, Stock source).',
      product_sku, lender_name, lender_name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_quantity_guard ON "ChannelListing";
CREATE TRIGGER nexus_stock_pool_quantity_guard BEFORE INSERT OR UPDATE OF "followMasterQuantity" ON "ChannelListing"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_quantity_guard();
DROP TRIGGER IF EXISTS nexus_stock_pool_quantity_guard ON "SharedListingMembership";
CREATE TRIGGER nexus_stock_pool_quantity_guard BEFORE INSERT OR UPDATE OF "pinnedQuantity" ON "SharedListingMembership"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_quantity_guard();

-- ── Every pool stock change queues the borrowers' listing work ──────────────────────────────
-- Fires on EVERY stock write in every business, so the first question is one index probe: does
-- anyone borrow this product? Almost always no. When yes, one task per borrower whose grant is on
-- and lends this location. The lender's own listings are not queued here: its own writers
-- cascade them, and the doors queue the lender explicitly.
CREATE OR REPLACE FUNCTION nexus_stock_pool_level_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  product_id text := CASE WHEN TG_OP = 'DELETE' THEN OLD."productId" ELSE NEW."productId" END;
  location_id text := CASE WHEN TG_OP = 'DELETE' THEN OLD."locationId" ELSE NEW."locationId" END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.quantity = OLD.quantity AND NEW.reserved = OLD.reserved AND NEW.available = OLD.available
       AND NEW."productId" = OLD."productId" AND NEW."locationId" = OLD."locationId" THEN
      RETURN NULL;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "StockPoolLink" l WHERE l."sourceProductId" = product_id AND l.status = 'active') THEN
    RETURN NULL;
  END IF;
  INSERT INTO "StockPoolTask" (id, "workspaceId", kind, "productId", reason)
  SELECT nexus_pool_id(), l."workspaceId", 'recascade', l."productId", 'stock'
  FROM "StockPoolLink" l JOIN "StockPoolGrant" g ON g.id = l."grantId"
  WHERE l."sourceProductId" = product_id AND l.status = 'active'
    AND g.status = 'active' AND location_id = ANY(g."locationIds");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_level_changed ON "StockLevel";
CREATE TRIGGER nexus_stock_pool_level_changed AFTER INSERT OR UPDATE OR DELETE ON "StockLevel"
  FOR EACH ROW EXECUTE FUNCTION nexus_stock_pool_level_changed();

-- ── Wake the worker (Owner, 2026-10-01: "in real time") ─────────────────────────────────────
-- Every statement that queues pool work signals 'nexus_stock_pool'. Postgres delivers it at COMMIT
-- (never for a rolled-back write) and folds repeats in one transaction into one. The worker LISTENs on a
-- direct connection and runs at once; its poll stays as the backstop. The payload is empty: the worker
-- asks nexus_pool_pending_workspaces which businesses have work, so nothing about a business travels.
CREATE OR REPLACE FUNCTION nexus_stock_pool_task_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nexus_stock_pool', '');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS nexus_stock_pool_task_wake ON "StockPoolTask";
CREATE TRIGGER nexus_stock_pool_task_wake AFTER INSERT ON "StockPoolTask"
  FOR EACH STATEMENT EXECUTE FUNCTION nexus_stock_pool_task_wake();

-- ── What each side may know about a grant ───────────────────────────────────────────────────
-- The borrower cannot read the lender's locations, and the lender cannot read the borrower's links or
-- listings. These two functions answer either side of a grant — and only them — with names and
-- counts, never rows of the other business.

-- The lent warehouses (id, code, name, and whether each is still an active warehouse) and how many of
-- the borrower's products use the grant now.
CREATE OR REPLACE FUNCTION nexus_pool_grant_details(grant_ids text[])
RETURNS TABLE (grant_id text, linked_products integer, locations jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.id,
    (SELECT count(*)::integer FROM "StockPoolLink" l WHERE l."grantId" = g.id AND l.status = 'active'),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x, 'code', sl.code, 'name', sl.name,
                'usable', COALESCE(sl.type = 'WAREHOUSE' AND sl."isActive", false)) ORDER BY sl.code COLLATE "C", x)
              FROM unnest(g."locationIds") x LEFT JOIN "StockLocation" sl ON sl.id = x AND sl."workspaceId" = g."ownerWorkspaceId"), '[]'::jsonb)
  FROM "StockPoolGrant" g
  WHERE g.id = ANY(grant_ids)
    AND NULLIF(current_setting('nexus.workspace_id', true), '') IN (g."ownerWorkspaceId", g."workspaceId")
$$;
REVOKE ALL ON FUNCTION nexus_pool_grant_details(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_grant_details(text[]) TO nexus_workspace_runtime;

-- What pausing or ending a grant does to the borrower's listings, as counts (the preview, plan §4). It
-- follows the derivation core's precedence (sync-control-core.ts): Amazon-managed (FBA) → offer closed
-- → paused by channel policy or by the listing → fixed number → follows (to its own warehouse stock
-- when it has some, otherwise to 0). Shared eBay variants: excluded, or follow. Listings that ended are
-- not counted.
CREATE OR REPLACE FUNCTION nexus_pool_grant_impact(grant_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  context_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  pool_grant "StockPoolGrant"%ROWTYPE;
  result jsonb;
BEGIN
  SELECT * INTO pool_grant FROM "StockPoolGrant" WHERE id = grant_id;
  IF NOT FOUND OR context_id IS NULL OR context_id NOT IN (pool_grant."ownerWorkspaceId", pool_grant."workspaceId") THEN
    RETURN jsonb_build_object('error', 'This shared stock is unavailable in this business profile.', 'code', 'grant_not_found', 'status', 404);
  END IF;
  WITH linked AS (
    SELECT l."productId" FROM "StockPoolLink" l WHERE l."grantId" = pool_grant.id AND l.status = 'active'
  ), own AS (
    SELECT lv."productId",
      COALESCE(SUM(lv.available) FILTER (WHERE sl.type = 'WAREHOUSE'), 0) AS available,
      COALESCE(SUM(lv.quantity) FILTER (WHERE sl.type = 'AMAZON_FBA'), 0) AS fba
    FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id = lv."locationId"
    WHERE lv."workspaceId" = pool_grant."workspaceId" AND lv."productId" IN (SELECT "productId" FROM linked)
    GROUP BY lv."productId"
  ), listing AS (
    SELECT
      CASE
        WHEN cl."fulfillmentMethod" = 'FBA' OR (cl.channel = 'AMAZON' AND (p."fulfillmentMethod" = 'FBA' OR COALESCE(o.fba, 0) > 0)) THEN 'fba'
        WHEN cl."offerClosedAt" IS NOT NULL THEN 'closed'
        WHEN EXISTS (SELECT 1 FROM "SyncChannelPolicy" sp WHERE sp."workspaceId" = cl."workspaceId" AND sp.channel = cl.channel
                       AND sp.marketplace IN (cl.marketplace, '*') AND sp."pushesPaused"
                       -- A policy with no account is for every account; one with an account, only for that account's listings.
                       AND (sp."channelConnectionId" IS NULL OR sp."channelConnectionId" = cl."channelConnectionId")) OR cl."syncPaused" THEN 'paused'
        WHEN NOT cl."followMasterQuantity" THEN 'pinned'
        WHEN COALESCE(o.available, 0) > 0 THEN 'toOwn'
        ELSE 'toZero'
      END AS bucket
    FROM "ChannelListing" cl
    JOIN "Product" p ON p.id = cl."productId"
    LEFT JOIN own o ON o."productId" = cl."productId"
    WHERE cl."workspaceId" = pool_grant."workspaceId" AND cl."productId" IN (SELECT "productId" FROM linked)
      AND cl."listingStatus" NOT IN ('ENDED', 'REMOVED')
  ), shared AS (
    SELECT CASE WHEN NOT m."followPool" THEN 'excluded' WHEN COALESCE(o.available, 0) > 0 THEN 'toOwn' ELSE 'toZero' END AS bucket
    FROM "SharedListingMembership" m LEFT JOIN own o ON o."productId" = m."productId"
    WHERE m."workspaceId" = pool_grant."workspaceId" AND m."productId" IN (SELECT "productId" FROM linked) AND m.status = 'ACTIVE'
  )
  SELECT jsonb_build_object(
    'grantId', pool_grant.id,
    'linkedProducts', (SELECT count(*) FROM linked),
    'listings', jsonb_build_object(
      'toZero', (SELECT count(*) FROM listing WHERE bucket = 'toZero'),
      'toOwn', (SELECT count(*) FROM listing WHERE bucket = 'toOwn'),
      'pinned', (SELECT count(*) FROM listing WHERE bucket = 'pinned'),
      'paused', (SELECT count(*) FROM listing WHERE bucket = 'paused'),
      'closed', (SELECT count(*) FROM listing WHERE bucket = 'closed'),
      'fba', (SELECT count(*) FROM listing WHERE bucket = 'fba')),
    'sharedVariants', jsonb_build_object(
      'toZero', (SELECT count(*) FROM shared WHERE bucket = 'toZero'),
      'toOwn', (SELECT count(*) FROM shared WHERE bucket = 'toOwn'),
      'excluded', (SELECT count(*) FROM shared WHERE bucket = 'excluded')))
  INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION nexus_pool_grant_impact(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_grant_impact(text) TO nexus_workspace_runtime;

-- ── Which businesses have pool work waiting ─────────────────────────────────────────────────
-- For the worker that finds work no code of ours kicked (a lender's own sale, an import). It answers
-- ONLY a caller with no business context (the worker's system context), and only with business ids.
CREATE OR REPLACE FUNCTION nexus_pool_pending_workspaces()
RETURNS TABLE (workspace_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT t."workspaceId" FROM "StockPoolTask" t
  WHERE NULLIF(current_setting('nexus.workspace_id', true), '') IS NULL
    AND (t."claimedAt" IS NULL OR t."claimedAt" < CURRENT_TIMESTAMP - interval '2 minutes')
$$;
REVOKE ALL ON FUNCTION nexus_pool_pending_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_pending_workspaces() TO nexus_workspace_runtime;

-- ── The safe doors ──────────────────────────────────────────────────────────────────────────
-- Every door runs in the BORROWER's context (nexus.workspace_id). None takes the lender, the
-- lender product, a location or a grant as a parameter: all of them come from the borrower's own
-- link. Refusals return jsonb {error, code, status} (a sentence for a person, a stable code).

-- INTERNAL: the borrower's link for a product, if new sales may use the pool right now. An older link
-- needs its catalog link active; a SKU link needs both products alive with the link's SKU (the product
-- guard keeps them so; this is the read-side check).
CREATE OR REPLACE FUNCTION nexus_pool_effective_link(borrower_id text, product_id text)
RETURNS TABLE (link_id text, grant_id text, owner_id text, source_product_id text, location_ids text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, g.id, g."ownerWorkspaceId", l."sourceProductId", g."locationIds"
  FROM "StockPoolLink" l
  JOIN "StockPoolGrant" g ON g.id = l."grantId"
  JOIN "Workspace" lender ON lender.id = g."ownerWorkspaceId"
  JOIN "Workspace" borrower ON borrower.id = l."workspaceId"
  WHERE l."workspaceId" = borrower_id AND l."productId" = product_id AND l.status = 'active'
    AND g."workspaceId" = borrower_id AND g.status = 'active'
    AND lender.status = 'active' AND borrower.status = 'active'
    AND CASE WHEN l."catalogLinkId" IS NOT NULL
      THEN EXISTS (SELECT 1 FROM "CatalogLink" c WHERE c.id = l."catalogLinkId" AND c.status = 'active')
      ELSE EXISTS (SELECT 1 FROM "Product" mine WHERE mine.id = l."productId" AND mine."workspaceId" = borrower_id AND mine."deletedAt" IS NULL AND mine.sku = l.sku)
       AND EXISTS (SELECT 1 FROM "Product" theirs WHERE theirs.id = l."sourceProductId" AND theirs."workspaceId" = g."ownerWorkspaceId" AND theirs."deletedAt" IS NULL AND theirs.sku = l.sku)
    END
$$;
REVOKE ALL ON FUNCTION nexus_pool_effective_link(text, text) FROM PUBLIC;

-- INTERNAL: recompute the lender product's cached total (WAREHOUSE quantity only), exactly as
-- recomputeProductTotalStock does, and queue the lender's own bookkeeping for one movement.
CREATE OR REPLACE FUNCTION nexus_pool_after_write(owner_id text, source_product_id text, movement_id text, touches_quantity boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF touches_quantity THEN
    UPDATE "Product" SET "totalStock" = COALESCE((
      SELECT SUM(lv.quantity) FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id = lv."locationId"
      WHERE lv."productId" = source_product_id AND sl.type = 'WAREHOUSE'), 0), "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = source_product_id;
  END IF;
  INSERT INTO "StockPoolTask" (id, "workspaceId", kind, "productId", "movementId", reason)
  VALUES (nexus_pool_id(), owner_id, 'settle', source_product_id, movement_id, 'door');
END $$;
REVOKE ALL ON FUNCTION nexus_pool_after_write(text, text, text, boolean) FROM PUBLIC;

-- Door 1 — CHECK. For each of the borrower's products that sells from a pool right now, one row per
-- lent location: its code and its numbers (0 for a location that is no longer an active warehouse).
-- A product with no row uses its own stock. Reads only; takes no lock.
CREATE OR REPLACE FUNCTION nexus_pool_available(product_ids text[])
RETURNS TABLE (product_id text, grant_id text, owner_workspace_id text, location_id text, location_code text, quantity integer, reserved integer, available integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF borrower_id IS NULL OR product_ids IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT pid, e.grant_id, e.owner_id, loc_id, sl.code,
         CASE WHEN sl.type = 'WAREHOUSE' AND sl."isActive" THEN COALESCE(lv.quantity, 0) ELSE 0 END,
         CASE WHEN sl.type = 'WAREHOUSE' AND sl."isActive" THEN COALESCE(lv.reserved, 0) ELSE 0 END,
         CASE WHEN sl.type = 'WAREHOUSE' AND sl."isActive" THEN COALESCE(lv.available, 0) ELSE 0 END
  FROM (SELECT DISTINCT unnest(product_ids) AS pid) ids
  CROSS JOIN LATERAL nexus_pool_effective_link(borrower_id, ids.pid) e
  CROSS JOIN LATERAL unnest(e.location_ids) AS loc_id
  LEFT JOIN "StockLocation" sl ON sl.id = loc_id AND sl."workspaceId" = e.owner_id
  LEFT JOIN "StockLevel" lv ON lv."locationId" = loc_id AND lv."productId" = e.source_product_id
    AND lv."variationId" IS NULL AND lv."workspaceId" = e.owner_id
  ORDER BY pid, sl.code COLLATE "C", loc_id;
END $$;
REVOKE ALL ON FUNCTION nexus_pool_available(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_available(text[]) TO nexus_workspace_runtime;

-- Door 1, for a preview — the pool numbers a borrower product WOULD follow if it were switched to
-- this grant now: the same rows as door 1, for the lender product with the SAME SKU instead of a pool
-- link. Only for the borrower, only while the grant is on. Reads only.
CREATE OR REPLACE FUNCTION nexus_pool_preview(grant_id text, product_ids text[])
RETURNS TABLE (product_id text, source_product_id text, location_id text, location_code text, quantity integer, reserved integer, available integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF borrower_id IS NULL OR product_ids IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT mine.id, theirs.id, loc_id, sl.code,
         CASE WHEN sl.type = 'WAREHOUSE' AND sl."isActive" THEN COALESCE(lv.quantity, 0) ELSE 0 END,
         CASE WHEN sl.type = 'WAREHOUSE' AND sl."isActive" THEN COALESCE(lv.reserved, 0) ELSE 0 END,
         CASE WHEN sl.type = 'WAREHOUSE' AND sl."isActive" THEN COALESCE(lv.available, 0) ELSE 0 END
  FROM "StockPoolGrant" g
  JOIN "Workspace" lender ON lender.id = g."ownerWorkspaceId" AND lender.status = 'active'
  JOIN "Product" mine ON mine."workspaceId" = borrower_id AND mine.id = ANY(product_ids) AND mine."deletedAt" IS NULL
  JOIN "Product" theirs ON theirs."workspaceId" = g."ownerWorkspaceId" AND theirs.sku = mine.sku AND theirs."deletedAt" IS NULL
  CROSS JOIN LATERAL unnest(g."locationIds") AS loc_id
  LEFT JOIN "StockLocation" sl ON sl.id = loc_id AND sl."workspaceId" = g."ownerWorkspaceId"
  LEFT JOIN "StockLevel" lv ON lv."locationId" = loc_id AND lv."productId" = theirs.id
    AND lv."variationId" IS NULL AND lv."workspaceId" = g."ownerWorkspaceId"
  WHERE g.id = grant_id AND g."workspaceId" = borrower_id AND g.status = 'active'
  ORDER BY mine.id, sl.code COLLATE "C", loc_id;
END $$;
REVOKE ALL ON FUNCTION nexus_pool_preview(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_preview(text, text[]) TO nexus_workspace_runtime;

-- Which of the borrower's products can connect to this grant's lender BY SKU, and why not. One row per
-- given product of the borrower: its SKU, the lender product with exactly that SKU when it can connect,
-- and otherwise a reason code — product_deleted · no_match (the lender has no product with this SKU) ·
-- source_deleted · product_lends (this product lends its own stock: no chains) · source_borrows (the
-- lender's product sells from a pool itself) · tracked (lots or serial numbers). It answers only the
-- borrower, only for a grant it accepted (on or paused), and only about SKUs the borrower already has.
CREATE OR REPLACE FUNCTION nexus_pool_sku_matches(grant_id text, product_ids text[])
RETURNS TABLE (product_id text, sku text, source_product_id text, refusal_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.sku, CASE WHEN m.code IS NULL THEN m.source_id END, m.code
  FROM (
    SELECT mine.id, mine.sku, theirs.id AS source_id,
      CASE
        WHEN mine."deletedAt" IS NOT NULL THEN 'product_deleted'
        WHEN theirs.id IS NULL THEN 'no_match'
        WHEN theirs."deletedAt" IS NOT NULL THEN 'source_deleted'
        WHEN EXISTS (SELECT 1 FROM "StockPoolLink" l WHERE l."sourceProductId" = mine.id AND l.status = 'active') THEN 'product_lends'
        WHEN EXISTS (SELECT 1 FROM "StockPoolLink" l WHERE l."productId" = theirs.id AND l.status = 'active') THEN 'source_borrows'
        WHEN EXISTS (SELECT 1 FROM "Lot" x WHERE x."productId" = theirs.id AND x."unitsRemaining" > 0)
          OR EXISTS (SELECT 1 FROM "SerialNumber" x WHERE x."productId" = theirs.id) THEN 'tracked'
      END AS code
    FROM "StockPoolGrant" g
    JOIN "Product" mine ON mine."workspaceId" = g."workspaceId" AND mine.id = ANY(product_ids)
    LEFT JOIN "Product" theirs ON theirs."workspaceId" = g."ownerWorkspaceId" AND theirs.sku = mine.sku
    WHERE g.id = grant_id AND g."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
      AND g.status IN ('active', 'paused')
  ) m
  ORDER BY m.id COLLATE "C"
$$;
REVOKE ALL ON FUNCTION nexus_pool_sku_matches(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_sku_matches(text, text[]) TO nexus_workspace_runtime;

-- The borrower's products a grant can serve, a page at a time (by product id): every live product whose
-- SKU the lender also has, plus any product that uses this grant now. Same audience as above.
CREATE OR REPLACE FUNCTION nexus_pool_sku_candidates(grant_id text, after_product_id text, take integer)
RETURNS TABLE (product_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT mine.id
  FROM "StockPoolGrant" g
  JOIN "Product" mine ON mine."workspaceId" = g."workspaceId" AND mine."deletedAt" IS NULL
  WHERE g.id = grant_id AND g."workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), '')
    AND g.status IN ('active', 'paused')
    AND (after_product_id IS NULL OR mine.id COLLATE "C" > after_product_id COLLATE "C")
    AND (EXISTS (SELECT 1 FROM "Product" theirs WHERE theirs."workspaceId" = g."ownerWorkspaceId" AND theirs.sku = mine.sku AND theirs."deletedAt" IS NULL)
      OR EXISTS (SELECT 1 FROM "StockPoolLink" l WHERE l."workspaceId" = g."workspaceId" AND l."productId" = mine.id AND l."grantId" = g.id AND l.status = 'active'))
  ORDER BY mine.id COLLATE "C"
  LIMIT LEAST(GREATEST(COALESCE(take, 100), 1), 500)
$$;
REVOKE ALL ON FUNCTION nexus_pool_sku_candidates(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_sku_candidates(text, text, integer) TO nexus_workspace_runtime;

-- Door 2 — HOLD. Hold `hold_quantity` units of the lender's stock for one borrower order.
-- One hold per borrower order and product, ever: a second call (a retry, a re-poll, a webhook and a
-- poll) returns the first hold, whatever its state, and never makes another (so a re-ingested order
-- cannot be held and taken twice). The whole quantity comes from ONE lent warehouse, the one with
-- the most available (then by code), so a hold never splits across locations.
CREATE OR REPLACE FUNCTION nexus_pool_reserve(product_id text, hold_quantity integer, order_ref text, actor text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  e record;
  existing record;
  lvl record;
  total integer;
  reservation_id text := nexus_pool_id();
  movement_id text := nexus_pool_id();
BEGIN
  IF borrower_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Select a business profile.', 'code', 'workspace_required', 'status', 400);
  END IF;
  IF hold_quantity IS NULL OR hold_quantity <= 0 THEN
    RETURN jsonb_build_object('error', 'Hold at least 1 unit.', 'code', 'invalid_quantity', 'status', 400);
  END IF;
  IF order_ref IS NULL OR btrim(order_ref) = '' THEN
    RETURN jsonb_build_object('error', 'A hold needs the order it is for.', 'code', 'order_required', 'status', 400);
  END IF;
  SELECT * INTO e FROM nexus_pool_effective_link(borrower_id, product_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This product does not sell from shared stock right now.', 'code', 'not_pooled', 'status', 409);
  END IF;

  PERFORM 1 FROM "Product" WHERE id = e.source_product_id FOR NO KEY UPDATE; -- the stock lock (stock-lock.ts)

  SELECT r.id, r.quantity, CASE WHEN r."consumedAt" IS NOT NULL THEN 'consumed' WHEN r."releasedAt" IS NOT NULL THEN 'released' ELSE 'open' END AS state
    INTO existing
  FROM "StockReservation" r JOIN "StockLevel" lv ON lv.id = r."stockLevelId"
  WHERE r."consumerWorkspaceId" = borrower_id AND r."consumerOrderRef" = order_ref AND lv."productId" = e.source_product_id
  ORDER BY r."createdAt", r.id LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('reservationId', existing.id, 'quantity', existing.quantity, 'state', existing.state, 'reused', true);
  END IF;

  SELECT lv.id, lv.quantity, lv.reserved, lv.available, lv."locationId", sl.code INTO lvl
  FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id = lv."locationId"
  WHERE lv."workspaceId" = e.owner_id AND lv."productId" = e.source_product_id AND lv."variationId" IS NULL
    AND lv."locationId" = ANY(e.location_ids) AND sl.type = 'WAREHOUSE' AND sl."isActive" AND lv.available >= hold_quantity
  ORDER BY lv.available DESC, sl.code COLLATE "C", lv.id
  LIMIT 1;
  IF NOT FOUND THEN
    SELECT COALESCE(SUM(lv.available), 0) INTO total
    FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id = lv."locationId"
    WHERE lv."workspaceId" = e.owner_id AND lv."productId" = e.source_product_id AND lv."variationId" IS NULL
      AND lv."locationId" = ANY(e.location_ids) AND sl.type = 'WAREHOUSE' AND sl."isActive";
    RETURN jsonb_build_object('error', format('Only %s available in shared stock; %s needed in one warehouse.', total, hold_quantity),
      'code', 'insufficient', 'status', 409, 'available', total);
  END IF;

  UPDATE "StockLevel" SET reserved = reserved + hold_quantity, available = available - hold_quantity, "lastUpdatedAt" = CURRENT_TIMESTAMP
  WHERE id = lvl.id;
  INSERT INTO "StockReservation" (id, "workspaceId", "stockLevelId", quantity, reason, kind, "expiresAt", "createdAt", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef")
  VALUES (reservation_id, e.owner_id, lvl.id, hold_quantity, 'OPEN_ORDER', 'HARD', CURRENT_TIMESTAMP + interval '365 days', CURRENT_TIMESTAMP, e.grant_id, borrower_id, order_ref);
  INSERT INTO "StockMovement" (id, "workspaceId", "productId", "locationId", change, "balanceAfter", "quantityBefore", reason, "referenceType", "referenceId", "reservationId", notes, actor, "createdAt", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef")
  VALUES (movement_id, e.owner_id, e.source_product_id, lvl."locationId", 0, lvl.quantity, lvl.quantity, 'RESERVATION_CREATED', 'StockReservation', reservation_id, reservation_id,
    format('Held %s for a shared-stock order', hold_quantity), actor, CURRENT_TIMESTAMP, e.grant_id, borrower_id, order_ref);
  PERFORM nexus_pool_after_write(e.owner_id, e.source_product_id, movement_id, false);

  RETURN jsonb_build_object('reservationId', reservation_id, 'quantity', hold_quantity, 'state', 'open', 'reused', false,
    'locationCode', lvl.code, 'availableAfter', lvl.available - hold_quantity, 'grantId', e.grant_id);
END $$;
REVOKE ALL ON FUNCTION nexus_pool_reserve(text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_reserve(text, integer, text, text) TO nexus_workspace_runtime;

-- INTERNAL: the borrower's open holds for an order (optionally one borrower product), whatever the
-- state of its grant and links now — orders already made are never stranded.
CREATE OR REPLACE FUNCTION nexus_pool_open_holds(borrower_id text, order_ref text, product_id text)
RETURNS TABLE (reservation_id text, source_product_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, lv."productId"
  FROM "StockReservation" r JOIN "StockLevel" lv ON lv.id = r."stockLevelId"
  WHERE r."consumerWorkspaceId" = borrower_id AND r."consumerOrderRef" = order_ref
    AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL
    AND (product_id IS NULL OR lv."productId" IN (
      SELECT l."sourceProductId" FROM "StockPoolLink" l WHERE l."workspaceId" = borrower_id AND l."productId" = product_id))
  ORDER BY lv."productId" COLLATE "C", r.id
$$;
REVOKE ALL ON FUNCTION nexus_pool_open_holds(text, text, text) FROM PUBLIC;

-- Door 3/4a helper, for the borrower's repair job (reservation reconcile) — the borrower's own orders
-- that still have an OPEN hold in a pool, oldest first. The job then gives back (cancelled) or takes
-- out (shipped) through doors 3 and 4a, as it does for its own holds. Order references only: nothing
-- about the lender. Reads only.
CREATE OR REPLACE FUNCTION nexus_pool_open_hold_orders(max_orders integer)
RETURNS TABLE (order_ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF borrower_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT r."consumerOrderRef"
  FROM "StockReservation" r
  WHERE r."consumerWorkspaceId" = borrower_id AND r."consumerOrderRef" IS NOT NULL
    AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL
  GROUP BY r."consumerOrderRef"
  ORDER BY min(r."createdAt"), r."consumerOrderRef" COLLATE "C"
  LIMIT GREATEST(1, LEAST(COALESCE(max_orders, 500), 5000));
END $$;
REVOKE ALL ON FUNCTION nexus_pool_open_hold_orders(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_open_hold_orders(integer) TO nexus_workspace_runtime;

-- For the ship-from copy (step 4, services/stock-pool/shared-warehouses.ts) — the warehouses lent to the
-- CALLING business by its grants that are on or paused: each lent location's code and name, and the
-- address of the lender's warehouse behind it (null when the location has none). The borrower must
-- ship from that address; it learns nothing else about the lender. Reads only.
CREATE OR REPLACE FUNCTION nexus_pool_lent_addresses()
RETURNS TABLE (grant_id text, grant_status text, lender_name text, location_id text, location_code text, location_name text,
  address_line1 text, address_line2 text, city text, postal_code text, country text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF borrower_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT g.id, g.status::text, lender.name, sl.id, sl.code, sl.name,
         w."addressLine1", w."addressLine2", w.city, w."postalCode", w.country
  FROM "StockPoolGrant" g
  JOIN "Workspace" lender ON lender.id = g."ownerWorkspaceId"
  CROSS JOIN LATERAL unnest(g."locationIds") AS loc_id
  JOIN "StockLocation" sl ON sl.id = loc_id AND sl."workspaceId" = g."ownerWorkspaceId"
  LEFT JOIN "Warehouse" w ON w.id = sl."warehouseId" AND w."workspaceId" = g."ownerWorkspaceId"
  WHERE g."workspaceId" = borrower_id AND g.status IN ('active', 'paused')
  ORDER BY sl.code COLLATE "C", sl.id;
END $$;
REVOKE ALL ON FUNCTION nexus_pool_lent_addresses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_lent_addresses() TO nexus_workspace_runtime;

-- For the ship-from of one order (step 4) — the lent locations the CALLING business's order took its
-- pool units from (takes, and holds that were not given back), most units first. Empty when the order
-- took nothing from a pool. Works after a pause or an end: an order already made ships from where its
-- units are. Reads only.
CREATE OR REPLACE FUNCTION nexus_pool_order_locations(order_ref text)
RETURNS TABLE (location_id text, units integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF borrower_id IS NULL OR order_ref IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT x.loc, SUM(x.u)::integer
  FROM (
    SELECT m."locationId" AS loc, -m.change AS u FROM "StockMovement" m
    WHERE m."consumerWorkspaceId" = borrower_id AND m."consumerOrderRef" = order_ref AND m.reason = 'ORDER_PLACED' AND m.change < 0
    UNION ALL
    SELECT lv."locationId", r.quantity FROM "StockReservation" r JOIN "StockLevel" lv ON lv.id = r."stockLevelId"
    WHERE r."consumerWorkspaceId" = borrower_id AND r."consumerOrderRef" = order_ref AND r."releasedAt" IS NULL
  ) x
  WHERE x.loc IS NOT NULL
  GROUP BY x.loc
  ORDER BY SUM(x.u) DESC, x.loc COLLATE "C";
END $$;
REVOKE ALL ON FUNCTION nexus_pool_order_locations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_order_locations(text) TO nexus_workspace_runtime;

-- Door 3 — GIVE BACK. Release the open holds of one borrower order (all its products, or one).
-- Idempotent: a settled hold is skipped. Works after a pause or an end.
CREATE OR REPLACE FUNCTION nexus_pool_release(order_ref text, product_id text DEFAULT NULL, actor text DEFAULT NULL, why text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  hold record;
  r record;
  lvl record;
  released integer := 0;
  units integer := 0;
  movement_id text;
BEGIN
  IF borrower_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Select a business profile.', 'code', 'workspace_required', 'status', 400);
  END IF;
  IF order_ref IS NULL OR btrim(order_ref) = '' THEN
    RETURN jsonb_build_object('error', 'Name the order whose hold is given back.', 'code', 'order_required', 'status', 400);
  END IF;
  FOR hold IN SELECT * FROM nexus_pool_open_holds(borrower_id, order_ref, product_id) LOOP
    PERFORM 1 FROM "Product" WHERE id = hold.source_product_id FOR NO KEY UPDATE;
    SELECT * INTO r FROM "StockReservation" WHERE id = hold.reservation_id FOR UPDATE;
    IF r."releasedAt" IS NOT NULL OR r."consumedAt" IS NOT NULL THEN CONTINUE; END IF; -- settled while waiting
    SELECT * INTO lvl FROM "StockLevel" WHERE id = r."stockLevelId";
    UPDATE "StockLevel" SET reserved = GREATEST(0, reserved - r.quantity), available = quantity - GREATEST(0, reserved - r.quantity), "lastUpdatedAt" = CURRENT_TIMESTAMP
    WHERE id = lvl.id;
    UPDATE "StockReservation" SET "releasedAt" = CURRENT_TIMESTAMP WHERE id = r.id;
    movement_id := nexus_pool_id();
    INSERT INTO "StockMovement" (id, "workspaceId", "productId", "locationId", change, "balanceAfter", "quantityBefore", reason, "referenceType", "referenceId", "reservationId", notes, actor, "createdAt", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef")
    VALUES (movement_id, r."workspaceId", lvl."productId", lvl."locationId", 0, lvl.quantity, lvl.quantity, 'RESERVATION_RELEASED', 'StockReservation', r.id, r.id,
      COALESCE(why, 'Shared-stock hold given back'), actor, CURRENT_TIMESTAMP, r."poolGrantId", borrower_id, order_ref);
    PERFORM nexus_pool_after_write(r."workspaceId", lvl."productId", movement_id, false);
    released := released + 1;
    units := units + r.quantity;
  END LOOP;
  RETURN jsonb_build_object('released', released, 'units', units);
END $$;
REVOKE ALL ON FUNCTION nexus_pool_release(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_release(text, text, text, text) TO nexus_workspace_runtime;

-- Door 4a — TAKE OUT a hold. The order shipped: the held units leave the lender's warehouse.
-- Idempotent: a settled hold is skipped. Works after a pause or an end.
CREATE OR REPLACE FUNCTION nexus_pool_consume(order_ref text, product_id text DEFAULT NULL, actor text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  hold record;
  r record;
  lvl record;
  consumed integer := 0;
  units integer := 0;
  movement_id text;
  next_reserved integer;
BEGIN
  IF borrower_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Select a business profile.', 'code', 'workspace_required', 'status', 400);
  END IF;
  IF order_ref IS NULL OR btrim(order_ref) = '' THEN
    RETURN jsonb_build_object('error', 'Name the order whose hold is taken out.', 'code', 'order_required', 'status', 400);
  END IF;
  FOR hold IN SELECT * FROM nexus_pool_open_holds(borrower_id, order_ref, product_id) LOOP
    PERFORM 1 FROM "Product" WHERE id = hold.source_product_id FOR NO KEY UPDATE;
    SELECT * INTO r FROM "StockReservation" WHERE id = hold.reservation_id FOR UPDATE;
    IF r."releasedAt" IS NOT NULL OR r."consumedAt" IS NOT NULL THEN CONTINUE; END IF;
    SELECT * INTO lvl FROM "StockLevel" WHERE id = r."stockLevelId";
    IF lvl.quantity < r.quantity THEN
      RAISE EXCEPTION 'Shared stock ledger is inconsistent: % held but % on hand (level %)', r.quantity, lvl.quantity, lvl.id USING ERRCODE = '23514';
    END IF;
    next_reserved := GREATEST(0, lvl.reserved - r.quantity);
    UPDATE "StockLevel" SET quantity = quantity - r.quantity, reserved = next_reserved, available = (quantity - r.quantity) - next_reserved, "lastUpdatedAt" = CURRENT_TIMESTAMP
    WHERE id = lvl.id;
    UPDATE "StockReservation" SET "consumedAt" = CURRENT_TIMESTAMP WHERE id = r.id;
    movement_id := nexus_pool_id();
    INSERT INTO "StockMovement" (id, "workspaceId", "productId", "locationId", change, "balanceAfter", "quantityBefore", reason, "referenceType", "referenceId", "reservationId", notes, actor, "createdAt", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef")
    VALUES (movement_id, r."workspaceId", lvl."productId", lvl."locationId", -r.quantity, lvl.quantity - r.quantity, lvl.quantity, 'RESERVATION_CONSUMED', 'StockReservation', r.id, r.id,
      'Shared-stock order shipped', actor, CURRENT_TIMESTAMP, r."poolGrantId", borrower_id, order_ref);
    PERFORM nexus_pool_after_write(r."workspaceId", lvl."productId", movement_id, true);
    consumed := consumed + 1;
    units := units + r.quantity;
  END LOOP;
  RETURN jsonb_build_object('consumed', consumed, 'units', units);
END $$;
REVOKE ALL ON FUNCTION nexus_pool_consume(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_consume(text, text, text) TO nexus_workspace_runtime;

-- Door 4b — TAKE OUT at once. A sale with no hold (eBay takes stock when the order arrives). Takes
-- the whole quantity or nothing, from the lent warehouses with the most available first (it may
-- split). One take per borrower order and product, ever: a second call returns the first.
CREATE OR REPLACE FUNCTION nexus_pool_take(product_id text, take_quantity integer, order_ref text, actor text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  e record;
  lvl record;
  already integer;
  total integer;
  remaining integer := take_quantity;
  part integer;
  movement_id text;
  movements jsonb := '[]'::jsonb;
BEGIN
  IF borrower_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Select a business profile.', 'code', 'workspace_required', 'status', 400);
  END IF;
  IF take_quantity IS NULL OR take_quantity <= 0 THEN
    RETURN jsonb_build_object('error', 'Take at least 1 unit.', 'code', 'invalid_quantity', 'status', 400);
  END IF;
  IF order_ref IS NULL OR btrim(order_ref) = '' THEN
    RETURN jsonb_build_object('error', 'A sale needs the order it is for.', 'code', 'order_required', 'status', 400);
  END IF;
  SELECT * INTO e FROM nexus_pool_effective_link(borrower_id, product_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This product does not sell from shared stock right now.', 'code', 'not_pooled', 'status', 409);
  END IF;

  PERFORM 1 FROM "Product" WHERE id = e.source_product_id FOR NO KEY UPDATE;

  SELECT -SUM(m.change) INTO already FROM "StockMovement" m
  WHERE m."consumerWorkspaceId" = borrower_id AND m."consumerOrderRef" = order_ref AND m."productId" = e.source_product_id AND m.reason = 'ORDER_PLACED';
  IF already IS NOT NULL THEN
    RETURN jsonb_build_object('taken', already, 'reused', true);
  END IF;

  SELECT COALESCE(SUM(lv.available), 0) INTO total
  FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id = lv."locationId"
  WHERE lv."workspaceId" = e.owner_id AND lv."productId" = e.source_product_id AND lv."variationId" IS NULL
    AND lv."locationId" = ANY(e.location_ids) AND sl.type = 'WAREHOUSE' AND sl."isActive";
  IF total < take_quantity THEN
    RETURN jsonb_build_object('error', format('Only %s available in shared stock; %s sold.', total, take_quantity),
      'code', 'insufficient', 'status', 409, 'available', total);
  END IF;

  FOR lvl IN
    SELECT lv.id, lv.quantity, lv.available, lv."locationId" FROM "StockLevel" lv JOIN "StockLocation" sl ON sl.id = lv."locationId"
    WHERE lv."workspaceId" = e.owner_id AND lv."productId" = e.source_product_id AND lv."variationId" IS NULL
      AND lv."locationId" = ANY(e.location_ids) AND sl.type = 'WAREHOUSE' AND sl."isActive" AND lv.available > 0
    ORDER BY lv.available DESC, sl.code COLLATE "C", lv.id
  LOOP
    EXIT WHEN remaining = 0;
    part := LEAST(remaining, lvl.available);
    UPDATE "StockLevel" SET quantity = quantity - part, available = available - part, "lastUpdatedAt" = CURRENT_TIMESTAMP WHERE id = lvl.id;
    movement_id := nexus_pool_id();
    INSERT INTO "StockMovement" (id, "workspaceId", "productId", "locationId", change, "balanceAfter", "quantityBefore", reason, "referenceType", "referenceId", notes, actor, "createdAt", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef")
    VALUES (movement_id, e.owner_id, e.source_product_id, lvl."locationId", -part, lvl.quantity - part, lvl.quantity, 'ORDER_PLACED', 'Order', order_ref,
      'Shared-stock sale', actor, CURRENT_TIMESTAMP, e.grant_id, borrower_id, order_ref);
    PERFORM nexus_pool_after_write(e.owner_id, e.source_product_id, movement_id, true);
    movements := movements || jsonb_build_object('movementId', movement_id, 'units', part);
    remaining := remaining - part;
  END LOOP;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'Shared stock changed while taking: % units short', remaining USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object('taken', take_quantity, 'reused', false, 'movements', movements, 'grantId', e.grant_id);
END $$;
REVOKE ALL ON FUNCTION nexus_pool_take(text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_take(text, integer, text, text) TO nexus_workspace_runtime;

-- Door 5 — PUT BACK. Units of a borrower order that left the pool come back to it: a cancelled sale
-- that was already taken (ORDER_CANCELLED) or a return put back on the shelf (RETURN_RESTOCKED).
-- They go to the lent warehouse this order took the most units from (then by code). Never more
-- than the order took out, counting every earlier put-back. One put-back per reason and
-- `put_back_ref` (the order for a cancellation, the return for a return). Works after a pause or an
-- end: the unit is physically back in the lender's warehouse either way.
CREATE OR REPLACE FUNCTION nexus_pool_put_back(product_id text, put_quantity integer, order_ref text, put_back_ref text, why text, actor text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET TimeZone = 'UTC' AS $$
DECLARE
  borrower_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  sold record;
  taken integer;
  returned integer;
  existing_id text;
  lvl record;
  level_id text;
  quantity_before integer;
  movement_id text := nexus_pool_id();
BEGIN
  IF borrower_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Select a business profile.', 'code', 'workspace_required', 'status', 400);
  END IF;
  IF put_quantity IS NULL OR put_quantity <= 0 THEN
    RETURN jsonb_build_object('error', 'Put back at least 1 unit.', 'code', 'invalid_quantity', 'status', 400);
  END IF;
  IF why IS NULL OR why NOT IN ('ORDER_CANCELLED', 'RETURN_RESTOCKED') THEN
    RETURN jsonb_build_object('error', 'Stock is put back for a cancelled sale or a return.', 'code', 'invalid_reason', 'status', 400);
  END IF;
  IF order_ref IS NULL OR btrim(order_ref) = '' OR put_back_ref IS NULL OR btrim(put_back_ref) = '' THEN
    RETURN jsonb_build_object('error', 'Name the order, and the cancellation or return.', 'code', 'order_required', 'status', 400);
  END IF;

  -- The lender product, grant and warehouse come from what this order took out of the pool: the
  -- warehouse it took the most units from. (Movements of one take share a timestamp, so "the last
  -- one" would not be a rule.)
  SELECT m."productId", m."poolGrantId", m."locationId", m."workspaceId" INTO sold
  FROM "StockMovement" m LEFT JOIN "StockLocation" sl ON sl.id = m."locationId"
  WHERE m."consumerWorkspaceId" = borrower_id AND m."consumerOrderRef" = order_ref
    AND m.reason IN ('ORDER_PLACED', 'RESERVATION_CONSUMED') AND m.change < 0
    AND m."productId" IN (SELECT l."sourceProductId" FROM "StockPoolLink" l WHERE l."workspaceId" = borrower_id AND l."productId" = product_id)
  GROUP BY m."productId", m."poolGrantId", m."locationId", m."workspaceId", sl.code
  ORDER BY SUM(m.change) ASC, sl.code COLLATE "C", m."locationId"
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'This order did not take this product from shared stock.', 'code', 'not_from_pool', 'status', 409);
  END IF;

  PERFORM 1 FROM "Product" WHERE id = sold."productId" FOR NO KEY UPDATE;

  SELECT m.id INTO existing_id FROM "StockMovement" m
  WHERE m."consumerWorkspaceId" = borrower_id AND m."consumerOrderRef" = order_ref AND m."productId" = sold."productId"
    AND m.reason = why::"StockMovementReason" AND m."referenceId" = put_back_ref
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('movementId', existing_id, 'reused', true);
  END IF;

  SELECT COALESCE(-SUM(m.change) FILTER (WHERE m.reason IN ('ORDER_PLACED', 'RESERVATION_CONSUMED')), 0),
         COALESCE(SUM(m.change) FILTER (WHERE m.reason IN ('ORDER_CANCELLED', 'RETURN_RESTOCKED')), 0)
    INTO taken, returned
  FROM "StockMovement" m
  WHERE m."consumerWorkspaceId" = borrower_id AND m."consumerOrderRef" = order_ref AND m."productId" = sold."productId";
  IF returned + put_quantity > taken THEN
    RETURN jsonb_build_object('error', format('This order took %s from shared stock and %s are already back; %s more cannot come back.', taken, returned, put_quantity),
      'code', 'more_than_sold', 'status', 409, 'taken', taken, 'returned', returned);
  END IF;

  SELECT lv.id, lv.quantity INTO lvl FROM "StockLevel" lv
  WHERE lv."workspaceId" = sold."workspaceId" AND lv."locationId" = sold."locationId" AND lv."productId" = sold."productId" AND lv."variationId" IS NULL;
  IF FOUND THEN
    level_id := lvl.id;
    quantity_before := lvl.quantity;
    UPDATE "StockLevel" SET quantity = quantity + put_quantity, available = available + put_quantity, "lastUpdatedAt" = CURRENT_TIMESTAMP WHERE id = level_id;
  ELSE
    level_id := nexus_pool_id();
    quantity_before := 0;
    INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt", "createdAt", "syncStatus")
    VALUES (level_id, sold."workspaceId", sold."locationId", sold."productId", put_quantity, 0, put_quantity, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SYNCED');
  END IF;
  INSERT INTO "StockMovement" (id, "workspaceId", "productId", "locationId", change, "balanceAfter", "quantityBefore", reason, "referenceType", "referenceId", notes, actor, "createdAt", "poolGrantId", "consumerWorkspaceId", "consumerOrderRef")
  VALUES (movement_id, sold."workspaceId", sold."productId", sold."locationId", put_quantity, quantity_before + put_quantity, quantity_before, why::"StockMovementReason",
    CASE WHEN why = 'RETURN_RESTOCKED' THEN 'Return' ELSE 'Order' END, put_back_ref,
    CASE WHEN why = 'RETURN_RESTOCKED' THEN 'Shared-stock return put back' ELSE 'Shared-stock sale cancelled' END, actor, CURRENT_TIMESTAMP, sold."poolGrantId", borrower_id, order_ref);
  PERFORM nexus_pool_after_write(sold."workspaceId", sold."productId", movement_id, true);
  RETURN jsonb_build_object('movementId', movement_id, 'reused', false, 'units', put_quantity);
END $$;
REVOKE ALL ON FUNCTION nexus_pool_put_back(text, integer, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_put_back(text, integer, text, text, text, text) TO nexus_workspace_runtime;
