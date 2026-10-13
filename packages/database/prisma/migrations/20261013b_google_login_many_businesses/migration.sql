BEGIN;
SET LOCAL lock_timeout='5s';
-- One Google login in many businesses (Owner 2026-10-13: "ONE Google login must work for ALL my businesses").
-- Only channel GOOGLE gets this exception; Amazon, eBay, Shopify and Etsy keep one seller account = one business.
--
-- 1. GoogleAccountLink: a Google Ads account, a Merchant Center account and a GA4 property may be chosen by ONE business
--    only. A global unique index on (product, externalId); the manager account (loginCustomerId) stays out of it, as one
--    manager may serve many businesses. Step 1a went live with no Google connection, so the table holds no duplicate.
-- 2. The shared policy file packages/database/workspaces/cx-account-integrity.sql, which this migration ENDS WITH byte for
--    byte (policy-migrations.json):
--    - "ChannelConnection_active_account_key" skips GOOGLE rows (same name, columns and predicate for every other
--      channel). It is dropped first: CREATE ... IF NOT EXISTS would keep the old predicate under the same name.
--    - "ChannelConnection_google_active_login_key": one active connection per Google login per business. Each business
--      keeps its own connection row and its own refresh token.
--    - nexus_channel_route_sync: GOOGLE writes no ChannelAccountOwnership row (no single owning business). Its route row
--      is still kept. Google sends no webhooks, so no inbound routing depends on ownership.
-- Index and function replace only; no data is moved. One transaction with a 5 s lock_timeout (as 20261006a): DROP INDEX
-- locks ChannelConnection, so the release fails fast and is retried rather than queue traffic. policyMigrationBody strips
-- the BEGIN/COMMIT for the parity check.

CREATE UNIQUE INDEX IF NOT EXISTS "GoogleAccountLink_product_externalId_key" ON "GoogleAccountLink"("product", "externalId");

DROP INDEX IF EXISTS "ChannelConnection_active_account_key";

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
-- GOOGLE (Owner 2026-10-13): one Google login may be connected in many businesses, once per business, each with its
-- own connection row and refresh token. Every other channel keeps one seller account = one business.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_active_account_key"
  ON "ChannelConnection" ("channelType", COALESCE("marketplace", '~'), COALESCE("externalAccountId", '~'))
  WHERE "isActive" = true AND "channelType" <> 'GOOGLE';
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelConnection_google_active_login_key"
  ON "ChannelConnection" ("workspaceId", COALESCE("externalAccountId", '~'))
  WHERE "isActive" = true AND "channelType" = 'GOOGLE';
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
      -- GOOGLE claims no single owning business (the indexes above); its route row is still kept.
      IF NEW."externalAccountId" IS NOT NULL AND NEW."channelType" <> 'GOOGLE' THEN
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
COMMIT;
