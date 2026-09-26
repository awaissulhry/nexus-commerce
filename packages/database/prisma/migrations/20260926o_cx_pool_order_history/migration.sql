BEGIN;
-- Pool movements live in the lender's ledger and carry consumerOrderRef, not the borrower's
-- orderId. Return only whether this caller's order still owes stock; no lender rows are exposed.
-- Historical movements remain authoritative after grants pause/end or products switch stock.
-- Only units taken at ingest (ORDER_PLACED, door 4b) are owed back: a consumed hold's units
-- (RESERVATION_CONSUMED) shipped, and shipped units come back only through a return (stock model R4).
CREATE OR REPLACE FUNCTION nexus_pool_restore_pending(order_ref text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  workspace_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = workspace_id AND w.status = 'active')
     OR (actor_id IS NOT NULL AND NOT nexus_pool_is_member(workspace_id, actor_id)) THEN
    RAISE EXCEPTION 'Select an active business profile.' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT m."productId" FROM "StockMovement" m
    WHERE m."consumerWorkspaceId" = workspace_id AND m."consumerOrderRef" = order_ref
      AND EXISTS (SELECT 1 FROM "Order" o WHERE o.id = order_ref AND o."workspaceId" = workspace_id)
    GROUP BY m."productId"
    HAVING COALESCE(-SUM(m.change) FILTER (WHERE m.reason = 'ORDER_PLACED' AND m.change < 0), 0)
      > COALESCE(SUM(m.change) FILTER (WHERE m.reason IN ('ORDER_CANCELLED', 'RETURN_RESTOCKED') AND m.change > 0), 0)
  );
END $$;
REVOKE ALL ON FUNCTION nexus_pool_restore_pending(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_restore_pending(text) TO nexus_workspace_runtime;

-- An order's hold for a product stays on the side it was first made (stock model, hold identity).
-- Door 2 answers not_pooled before it looks for the order's hold, so after a grant pauses or ends
-- a re-read would hold the order again from own stock while its pool hold still stands. This says
-- whether this caller's order already has a pool hold (any state: door 2 holds once, ever) for this
-- product, through any of its links, active or ended. Its own reservation id and state only.
CREATE OR REPLACE FUNCTION nexus_pool_order_hold(order_ref text, product_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  workspace_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
  held record;
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = workspace_id AND w.status = 'active')
     OR (actor_id IS NOT NULL AND NOT nexus_pool_is_member(workspace_id, actor_id)) THEN
    RAISE EXCEPTION 'Select an active business profile.' USING ERRCODE = '42501';
  END IF;
  SELECT r.id, r.quantity, CASE WHEN r."consumedAt" IS NOT NULL THEN 'consumed' WHEN r."releasedAt" IS NOT NULL THEN 'released' ELSE 'open' END AS state
    INTO held
  FROM "StockReservation" r JOIN "StockLevel" lv ON lv.id = r."stockLevelId"
  WHERE r."consumerWorkspaceId" = workspace_id AND r."consumerOrderRef" = order_ref
    AND EXISTS (SELECT 1 FROM "Order" o WHERE o.id = order_ref AND o."workspaceId" = workspace_id)
    AND lv."productId" IN (SELECT l."sourceProductId" FROM "StockPoolLink" l WHERE l."workspaceId" = workspace_id AND l."productId" = product_id)
  ORDER BY r."createdAt", r.id LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('reservationId', held.id, 'quantity', held.quantity, 'state', held.state, 'reused', true);
END $$;
REVOKE ALL ON FUNCTION nexus_pool_order_hold(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_order_hold(text, text) TO nexus_workspace_runtime;

-- What this caller's order took from shared stock for a product, through any of its links (active
-- or ended): units that left the lender's shelves for the order (consumed holds and takes without a
-- hold). The own-stock consume cap counts them, so an order's product is never taken from both
-- ledgers beyond what it ordered. Units only; no lender rows.
CREATE OR REPLACE FUNCTION nexus_pool_order_taken(order_ref text, product_id text)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  workspace_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = workspace_id AND w.status = 'active')
     OR (actor_id IS NOT NULL AND NOT nexus_pool_is_member(workspace_id, actor_id)) THEN
    RAISE EXCEPTION 'Select an active business profile.' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT -SUM(m.change) FROM "StockMovement" m
    WHERE m."consumerWorkspaceId" = workspace_id AND m."consumerOrderRef" = order_ref
      AND m.reason IN ('ORDER_PLACED', 'RESERVATION_CONSUMED') AND m.change < 0
      AND EXISTS (SELECT 1 FROM "Order" o WHERE o.id = order_ref AND o."workspaceId" = workspace_id)
      AND m."productId" IN (SELECT l."sourceProductId" FROM "StockPoolLink" l WHERE l."workspaceId" = workspace_id AND l."productId" = product_id)
  ), 0)::integer;
END $$;
REVOKE ALL ON FUNCTION nexus_pool_order_taken(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_order_taken(text, text) TO nexus_workspace_runtime;

-- Stock model R4: did this caller's order consume shared stock (a pool hold taken out when it
-- shipped)? Shipment evidence that the borrower's own ledger cannot show. Yes or no only.
CREATE OR REPLACE FUNCTION nexus_pool_order_shipped(order_ref text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  workspace_id text := NULLIF(current_setting('nexus.workspace_id', true), '');
  actor_id text := NULLIF(current_setting('nexus.actor_id', true), '');
BEGIN
  IF workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w.id = workspace_id AND w.status = 'active')
     OR (actor_id IS NOT NULL AND NOT nexus_pool_is_member(workspace_id, actor_id)) THEN
    RAISE EXCEPTION 'Select an active business profile.' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "StockMovement" m
    WHERE m."consumerWorkspaceId" = workspace_id AND m."consumerOrderRef" = order_ref
      AND m.reason = 'RESERVATION_CONSUMED' AND m.change < 0
      AND EXISTS (SELECT 1 FROM "Order" o WHERE o.id = order_ref AND o."workspaceId" = workspace_id)
  );
END $$;
REVOKE ALL ON FUNCTION nexus_pool_order_shipped(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_pool_order_shipped(text) TO nexus_workspace_runtime;
COMMIT;
