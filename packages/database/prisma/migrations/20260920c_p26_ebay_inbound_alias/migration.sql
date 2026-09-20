-- P2.6 — the routing index learns eBay's username.
--
-- An `AUTHORIZATION_REVOCATION` names the eBay USERNAME (`xaviaracing`), while the
-- connection is keyed by eBay's user id (`5UsgfG3BTHa`). Without a key for the name eBay
-- actually sends, a revocation cannot be attributed to a connection, and the only way to
-- act on it would be "the connected eBay account" — the ambient resolution the MAP.3
-- ratchet refuses, and rightly: with two eBay accounts it revokes the wrong seller.
--
-- P2.1 built `inboundAliases` for exactly this, for Shopify's shop domain. This extends
-- the same function to eBay rather than inventing a second mechanism.
CREATE OR REPLACE FUNCTION nexus_channel_inbound_aliases(conn "ChannelConnection") RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(SELECT DISTINCT alias FROM unnest(ARRAY[
    CASE WHEN conn."channelType" = 'SHOPIFY' THEN conn.identity->'extra'->>'myshopifyDomain' END,
    CASE WHEN conn."channelType" = 'SHOPIFY' THEN conn.identity->>'username' END,
    -- eBay sends the username on a revocation and the user id elsewhere. Both are
    -- names eBay itself uses for this account, which is the bar for an inbound alias:
    -- an operator-editable label must never become a routing key.
    CASE WHEN conn."channelType" = 'EBAY' THEN conn.identity->>'username' END,
    CASE WHEN conn."channelType" = 'EBAY' THEN conn.identity->>'userId' END,
    CASE WHEN conn."channelType" = 'EBAY' THEN conn."ebaySignInName" END
  ]) alias WHERE alias IS NOT NULL AND alias <> '')
$$;

-- The trigger already calls the function, so only the existing rows need refreshing.
UPDATE "ChannelAccountRoute" r
   SET "inboundAliases" = nexus_channel_inbound_aliases(c)
  FROM "ChannelConnection" c
 WHERE c.id = r."connectionId";
