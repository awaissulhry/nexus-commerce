BEGIN;
-- An order's writer (eBay, Etsy, reserveOpenOrder) must lock its own products and their lenders'
-- sources together, in one sorted set. This door derives foreign ids from the caller's immutable
-- links, never from caller-supplied lender ids. The sources of ALL the product's links, active or
-- ended: doors 3/4a settle an order's pool holds on whatever source they were made on, so a hold
-- whose link ended locks that source too, and it must be in the same sorted set (review B2: taking
-- the product first and the ended link's source later deadlocked against a sorted writer). Links
-- whose grants are paused are included as before.
CREATE OR REPLACE FUNCTION nexus_lock_order_stock(product_ids text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  workspace_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = workspace_id AND w.status = 'active')
     OR (actor_id IS NOT NULL AND NOT nexus_pool_is_member(workspace_id, actor_id)) THEN
    RAISE EXCEPTION 'Select an active business profile.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(product_ids) pid WHERE NOT EXISTS (
    SELECT 1 FROM "Product" p WHERE p.id = pid AND p."workspaceId" = workspace_id
  )) THEN
    RAISE EXCEPTION 'Order products must belong to this business.' USING ERRCODE = '42501';
  END IF;
  -- Link INSERT takes the exclusive form in its BEFORE trigger, before FK Product locks.
  -- Multiple orders share this lock; only switching to a new source waits for them to finish.
  PERFORM pg_advisory_xact_lock_shared(hashtext('nexus_stock_pool_link'));
  PERFORM p.id FROM "Product" p
  WHERE p.id IN (
    SELECT own.id FROM "Product" own WHERE own."workspaceId" = workspace_id AND own.id = ANY(product_ids)
    UNION
    SELECT l."sourceProductId" FROM "StockPoolLink" l
    WHERE l."workspaceId" = workspace_id AND l."productId" = ANY(product_ids)
  )
  ORDER BY p.id COLLATE "C" FOR NO KEY UPDATE;
END $$;
REVOKE ALL ON FUNCTION nexus_lock_order_stock(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_lock_order_stock(text[]) TO nexus_workspace_runtime;
COMMIT;
