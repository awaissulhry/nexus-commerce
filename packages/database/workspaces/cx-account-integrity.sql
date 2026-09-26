-- Runtime invariants not expressible in Prisma. Shared by fresh bootstrap and migrations.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='"WebhookEvent"'::regclass AND conname='WebhookEvent_lease_pair_check') THEN
    ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_lease_pair_check"
      CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='"ChannelConnection"'::regclass AND conname='ChannelConnection_grant_version_check') THEN
    ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_grant_version_check" CHECK ("grantVersion" >= 0);
  END IF;
END $$;

-- Preserve deployed uniqueness, including unidentified-account sentinels. No obsolete global primary index.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_active_account_key"
  ON "ChannelConnection" ("channelType", COALESCE("marketplace", '~'), COALESCE("externalAccountId", '~'))
  WHERE "isActive" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_workspace_channel_primary_key"
  ON "ChannelConnection" ("workspaceId", "channelType") WHERE "isPrimary" = true;
CREATE INDEX IF NOT EXISTS "WebhookEvent_signatureOk_idx" ON "WebhookEvent" ("signatureOk") WHERE "signatureOk" = false;

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
