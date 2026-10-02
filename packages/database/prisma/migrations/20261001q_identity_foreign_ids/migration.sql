-- MCP full control I5 (section 04 §4.2 M2) — additive: one read-only function, no table change.
-- Its body is workspaces/identity-foreign.sql, byte for byte (check-policy-migration-parity.mjs).
-- MCP full control I5 (plan section 04 §4.2 M2) — which of this business's own channel ids another business also holds.
--
-- A seller-owned id (an eBay Item ID, a Shopify product, an Etsy listing) belongs to one seller account and so to one
-- business. Row-level security hides the other business's listings, so a business cannot see that an id it holds is
-- also held elsewhere (the 2026-10-01 import carried another account's Item IDs into a second business). This function
-- answers exactly that, and nothing more:
--
--   * only ids the CALLER holds itself, on a listing of a live product, are compared — an id the caller does not hold
--     is never answered, so no business can probe another's ids;
--   * per id and holding business: how many live listings hold it there;
--   * the other business is NAMED only to a person who is an active member of it (the session's actor); everyone
--     else, a system caller included, reads "another business" and no id of it;
--   * an ASIN or a GTIN is a catalogue id, legal in several businesses: AMAZON is not answered;
--   * external_ids NULL = every id the caller holds on that channel; otherwise at most 1000 ids per call.
--
-- SECURITY DEFINER so it can read the other businesses' listings; EXECUTE to the runtime role only.
CREATE OR REPLACE FUNCTION nexus_identity_foreign_ids(channel_name text, external_ids text[])
RETURNS TABLE (external_id text, holder text, holder_workspace_id text, listing_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  caller_ws text := NULLIF(current_setting('nexus.workspace_id', true), '');
  caller_actor text := NULLIF(current_setting('nexus.actor_id', true), '');
  wanted_channel text := upper(btrim(COALESCE(channel_name, '')));
BEGIN
  IF caller_ws IS NULL THEN
    RAISE EXCEPTION 'nexus_identity_foreign_ids needs a business' USING ERRCODE = '42501';
  END IF;
  IF wanted_channel NOT IN ('EBAY', 'SHOPIFY', 'ETSY') THEN
    RAISE EXCEPTION 'nexus_identity_foreign_ids answers seller-owned ids only (EBAY, SHOPIFY, ETSY), not %', wanted_channel USING ERRCODE = '22023';
  END IF;
  IF external_ids IS NOT NULL AND cardinality(external_ids) > 1000 THEN
    RAISE EXCEPTION 'nexus_identity_foreign_ids takes at most 1000 ids per call' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH own AS (
    -- The caller's own ids on this channel (Shopify ids without their gid:// prefix), limited to the ids asked about.
    SELECT DISTINCT regexp_replace(btrim(cl."externalListingId"), '^gid://shopify/[A-Za-z]+/', '') AS id
    FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NULL
    WHERE cl."workspaceId" = caller_ws AND cl.channel = wanted_channel AND NULLIF(btrim(cl."externalListingId"), '') IS NOT NULL
      AND (external_ids IS NULL OR regexp_replace(btrim(cl."externalListingId"), '^gid://shopify/[A-Za-z]+/', '') = ANY (
        SELECT regexp_replace(btrim(a.raw), '^gid://shopify/[A-Za-z]+/', '') FROM unnest(external_ids) AS a(raw)))
  ), elsewhere AS (
    SELECT own.id, cl."workspaceId" AS ws, count(*)::integer AS n
    FROM own
    JOIN "ChannelListing" cl ON cl.channel = wanted_channel
      AND cl."externalListingId" IN (own.id, 'gid://shopify/Product/' || own.id)
    JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NULL
    WHERE cl."workspaceId" <> caller_ws
    GROUP BY own.id, cl."workspaceId"
  )
  SELECT e.id,
    CASE WHEN member.ok THEN w.name ELSE 'another business' END,
    CASE WHEN member.ok THEN e.ws END,
    e.n
  FROM elsewhere e
  JOIN "Workspace" w ON w.id = e.ws
  CROSS JOIN LATERAL (SELECT caller_actor IS NOT NULL AND w.status = 'active' AND EXISTS (
    SELECT 1 FROM "WorkspaceMembership" m JOIN "UserProfile" u ON u.id = m."userId"
    WHERE m."workspaceId" = e.ws AND m."userId" = caller_actor AND m.status = 'active' AND u.status = 'active') AS ok) member
  ORDER BY 1, 2;
END $$;
REVOKE ALL ON FUNCTION nexus_identity_foreign_ids(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_identity_foreign_ids(text, text[]) TO nexus_workspace_runtime;
