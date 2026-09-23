-- Etsy OAuth identifies a USER, while order webhooks identify that user's SHOP.
-- Only connector-verified identity is a routing key; labels and credentials stay untouched.
CREATE OR REPLACE FUNCTION nexus_channel_inbound_aliases(conn "ChannelConnection") RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(SELECT DISTINCT alias FROM unnest(ARRAY[
    CASE WHEN conn."channelType" = 'SHOPIFY' THEN conn.identity->'extra'->>'myshopifyDomain' END,
    CASE WHEN conn."channelType" = 'SHOPIFY' THEN conn.identity->>'username' END,
    CASE WHEN conn."channelType" = 'EBAY' THEN conn.identity->>'username' END,
    CASE WHEN conn."channelType" = 'EBAY' THEN conn.identity->>'userId' END,
    CASE WHEN conn."channelType" = 'EBAY' THEN conn."ebaySignInName" END,
    CASE WHEN conn."channelType" = 'ETSY' AND conn.identity->'extra'->>'shopId' ~ '^[1-9][0-9]*$'
      THEN conn.identity->'extra'->>'shopId' END
  ]) alias WHERE alias IS NOT NULL AND alias <> '')
$$;

-- Existing active connections need the alias immediately, without reauthorization.
UPDATE "ChannelAccountRoute" r
   SET "inboundAliases" = nexus_channel_inbound_aliases(c)
  FROM "ChannelConnection" c
 WHERE c.id = r."connectionId" AND c."channelType" = 'ETSY';
