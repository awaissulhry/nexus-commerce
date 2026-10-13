-- Google Ads AAA (the account picker, C2) — which of the given Google ids ANOTHER business has already picked.
--
-- One Google login may be connected in many businesses (20261013b), but a Google Ads account, a Merchant Center account
-- and a GA4 property may be picked by ONE business only: the global unique index "GoogleAccountLink_product_externalId_key"
-- on (product, externalId). Row-level security hides the other businesses' GoogleAccountLink rows, so the picker could not
-- tell that an account was taken until Save was refused. This function answers exactly that, and nothing more:
--
--   * an id asked about is returned when a GoogleAccountLink row of ANOTHER business holds it for that product: the same
--     rows the unique index compares (any row, whatever the state of its connection), so the picker and Save agree;
--   * it returns only ids the caller passed in: never a business name, a business id, a connection or a label;
--   * the caller's own picks are never returned;
--   * product is ADS, MERCHANT or GA4; a NULL or empty list answers nothing. The unique index answers each id, so the
--     list is not capped (a large Google Ads manager login may reach many accounts).
--
-- The API asks only about ids Google offered the caller's own sign-in; the answer is the same yes or no a refused Save
-- already gives (409 taken_by_other_business).
-- SECURITY DEFINER so it can read the other businesses' links; EXECUTE to the runtime role only.
CREATE OR REPLACE FUNCTION nexus_google_links_taken(p_product text, p_ids text[])
RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  caller_ws text := NULLIF(current_setting('nexus.workspace_id', true), '');
BEGIN
  IF caller_ws IS NULL THEN
    RAISE EXCEPTION 'nexus_google_links_taken needs a business' USING ERRCODE = '42501';
  END IF;
  IF p_product IS NULL OR p_product NOT IN ('ADS', 'MERCHANT', 'GA4') THEN
    RAISE EXCEPTION 'nexus_google_links_taken answers ADS, MERCHANT or GA4, not %', p_product USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT DISTINCT l."externalId"
  FROM "GoogleAccountLink" l
  WHERE l.product = p_product AND l."externalId" = ANY (p_ids) AND l."workspaceId" <> caller_ws
  ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION nexus_google_links_taken(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexus_google_links_taken(text, text[]) TO nexus_workspace_runtime;
