-- Meta ads M1 (the asset picker) — which of the given Meta ids ANOTHER business has already picked.
--
-- One Meta system user may be connected in many businesses (20261020e), but a Meta ad account, a Facebook Page and an
-- Instagram account may be picked by ONE business only: the global unique index "MetaAccountLink_product_externalId_key"
-- on (product, externalId). Row-level security hides the other businesses' MetaAccountLink rows, so the picker could not
-- tell that an asset was taken until Save was refused. This function answers exactly that, and nothing more:
--
--   * an id asked about is returned when a MetaAccountLink row of ANOTHER business holds it for that product: the same
--     rows the unique index compares (any row, whatever the state of its connection), so the picker and Save agree;
--   * it returns only ids the caller passed in: never a business name, a business id, a connection or a label;
--   * the caller's own picks are never returned;
--   * product is AD_ACCOUNT, PAGE or INSTAGRAM; a NULL or empty list answers nothing;
--   * PORTFOLIO (Meta ads step 10, 20261021r10): a Meta business portfolio id asked about is returned when an AD_ACCOUNT
--     link of ANOTHER business names it as its ad account's portfolio (metadata->>'businessId', stored on Save). Two
--     businesses whose ad accounts sit in one portfolio then never read that portfolio's media library through Nexus.
--
-- The API asks only about ids Meta offered the caller's own system user; the answer is the same yes or no a refused Save
-- already gives (409 taken_by_other_business).
-- SECURITY DEFINER so it can read the other businesses' links; EXECUTE to the runtime role only.
CREATE OR REPLACE FUNCTION nexus_meta_links_taken(p_product text, p_ids text[])
RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  caller_ws text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF caller_ws IS NULL THEN
    RAISE EXCEPTION 'nexus_meta_links_taken needs a business' USING ERRCODE = '42501';
  END IF;
  IF p_product IS NULL OR p_product NOT IN ('AD_ACCOUNT', 'PAGE', 'INSTAGRAM', 'PORTFOLIO') THEN
    RAISE EXCEPTION 'nexus_meta_links_taken answers AD_ACCOUNT, PAGE, INSTAGRAM or PORTFOLIO, not %', p_product USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  IF p_product = 'PORTFOLIO' THEN
    RETURN QUERY
    SELECT DISTINCT l.metadata ->> 'businessId'
    FROM "MetaAccountLink" l
    WHERE l.product = 'AD_ACCOUNT' AND l.metadata ->> 'businessId' = ANY (p_ids) AND l."workspaceId" <> caller_ws
    ORDER BY 1;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT DISTINCT l."externalId"
  FROM "MetaAccountLink" l
  WHERE l.product = p_product AND l."externalId" = ANY (p_ids) AND l."workspaceId" <> caller_ws
  ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION nexus_meta_links_taken(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_meta_links_taken(text, text[]) TO nexus_workspace_runtime;
