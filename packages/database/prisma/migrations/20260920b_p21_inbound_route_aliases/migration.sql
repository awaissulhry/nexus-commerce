-- P2.1 — the routing index learns the name a channel actually puts on a webhook.
--
-- `ChannelAccountRoute` is the one table an ingress endpoint may read without a
-- business profile, and it is how a verified notification finds its workspace. It
-- keys on `ChannelConnection.externalAccountId`, which for Shopify is the shop's
-- GraphQL id: `gid://shopify/Shop/72991867207`.
--
-- Shopify's webhooks do not carry that id. They carry `X-Shopify-Shop-Domain`, e.g.
-- `xaviaracing.myshopify.com`. So there was no key to route a Shopify webhook by, the
-- receivers ran with no workspace at all, and every ledger write they attempted threw
-- `Select a business profile` into a catch block. Measured before this change: a
-- receiver's own `markWebhookProcessed` left zero rows behind.
--
-- `destinationIds` was the obvious place and is the wrong one: two triggers rewrite it
-- wholesale from `ConnectionScope`, so anything else written there is erased by the
-- next scope change. A separate column is the only one that survives.
ALTER TABLE "ChannelAccountRoute"
  ADD COLUMN IF NOT EXISTS "inboundAliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The aliases a connection publishes to its channel. Only names the CHANNEL sends us
-- belong here — a display name an operator can edit must never become a routing key.
CREATE OR REPLACE FUNCTION nexus_channel_inbound_aliases(conn "ChannelConnection") RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(SELECT DISTINCT alias FROM unnest(ARRAY[
    CASE WHEN conn."channelType" = 'SHOPIFY' THEN conn.identity->'extra'->>'myshopifyDomain' END,
    CASE WHEN conn."channelType" = 'SHOPIFY' THEN conn.identity->>'username' END
  ]) alias WHERE alias IS NOT NULL AND alias <> '')
$$;

-- Same body as 20260908b, with the alias column added. Replaced whole rather than
-- patched: the trigger is one statement and a partial redefinition would silently drop
-- the account-ownership guard it also carries.
CREATE OR REPLACE FUNCTION nexus_channel_route_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN DELETE FROM "ChannelAccountRoute" WHERE "connectionId" = OLD.id; RETURN OLD; END IF;
      IF NEW."externalAccountId" IS NOT NULL THEN
        INSERT INTO "ChannelAccountOwnership" ("channelType", environment, "externalAccountId", "workspaceId")
          VALUES (NEW."channelType", COALESCE(NEW."connectionMetadata"->>'environment', 'production'), NEW."externalAccountId", NEW."workspaceId")
          ON CONFLICT DO NOTHING;
        IF NOT EXISTS (SELECT 1 FROM "ChannelAccountOwnership" WHERE "channelType" = NEW."channelType" AND environment = COALESCE(NEW."connectionMetadata"->>'environment', 'production') AND "externalAccountId" = NEW."externalAccountId" AND "workspaceId" = NEW."workspaceId") THEN
          RAISE EXCEPTION 'This seller account belongs to another business profile' USING ERRCODE = '23505';
        END IF;
      END IF;
      IF NEW."isActive" THEN
        INSERT INTO "ChannelAccountRoute" ("connectionId", "workspaceId", "channelType", "externalAccountId", "destinationIds", "inboundAliases")
          VALUES (NEW.id, NEW."workspaceId", NEW."channelType", NEW."externalAccountId", ARRAY(
            SELECT DISTINCT identifier FROM "ConnectionScope" s CROSS JOIN LATERAL unnest(ARRAY[s."externalId", s.metadata->>'accountId']) identifier
            WHERE s."connectionId" = NEW.id AND s."isActive" AND s.kind = 'profile' AND identifier IS NOT NULL
          ), nexus_channel_inbound_aliases(NEW))
          ON CONFLICT ("connectionId") DO UPDATE SET "workspaceId" = EXCLUDED."workspaceId", "channelType" = EXCLUDED."channelType", "externalAccountId" = EXCLUDED."externalAccountId", "destinationIds" = EXCLUDED."destinationIds", "inboundAliases" = EXCLUDED."inboundAliases";
      ELSE DELETE FROM "ChannelAccountRoute" WHERE "connectionId" = NEW.id; END IF;
      RETURN NEW;
    END $$;

-- Backfill the connections that already exist; the trigger only fires on a write.
UPDATE "ChannelAccountRoute" r
   SET "inboundAliases" = nexus_channel_inbound_aliases(c)
  FROM "ChannelConnection" c
 WHERE c.id = r."connectionId";

-- No uniqueness is declared on the aliases themselves. Two workspaces cannot already
-- hold the same shop: `ChannelAccountOwnership` refuses the second connection by its
-- `externalAccountId`, which for Shopify is the shop GID the domain belongs to. An
-- index on an array element would also have keyed on whichever alias happened to sort
-- first, which is not a property this data has.
CREATE INDEX IF NOT EXISTS "ChannelAccountRoute_inboundAliases_idx"
  ON "ChannelAccountRoute" USING GIN ("inboundAliases");
