-- MCP full control I12 (docs/mcp-full-control/sections/04-identity.md §4.2 M3, D1 = B) — ChannelItemClaim: one
-- seller-owned channel id (eBay Item ID, Shopify product, Etsy listing), one owner, kept by a trigger on ChannelListing in
-- REPORT mode (a conflicting write is not refused; the identity audit reports it). Additive: one new global table, its
-- claims backfilled from today's listings (the first holder of each id, oldest first), and the trigger. ENFORCE is a
-- later migration, on the Owner's word, after audit #1 and #2 read 0 in production.

-- CreateTable
CREATE TABLE "ChannelItemClaim" (
    "channel" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "rootProductId" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL DEFAULT '',
    "connectionId" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelItemClaim_pkey" PRIMARY KEY ("channel","marketplace","externalId")
);

-- CreateIndex
CREATE INDEX "ChannelItemClaim_workspaceId_idx" ON "ChannelItemClaim"("workspaceId");

-- AddForeignKey
ALTER TABLE "ChannelItemClaim" ADD CONSTRAINT "ChannelItemClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: each seller-owned id today, claimed for its oldest live holder (a family's rows share it). Duplicates are left
-- to the audit, exactly as the trigger leaves them in report mode.
INSERT INTO "ChannelItemClaim" (channel, marketplace, "externalId", "workspaceId", "rootProductId", "aliasKey", "connectionId", "claimedAt")
SELECT DISTINCT ON (l.channel, l.marketplace, k.id)
  l.channel, l.marketplace, k.id, l."workspaceId", COALESCE(p."parentId", p.id), l."aliasKey", l."channelConnectionId", CURRENT_TIMESTAMP
FROM "ChannelListing" l
JOIN "Product" p ON p.id = l."productId" AND p."deletedAt" IS NULL
CROSS JOIN LATERAL (SELECT NULLIF(CASE WHEN l.channel = 'SHOPIFY' THEN regexp_replace(btrim(COALESCE(l."externalListingId", '')), '^gid://shopify/[A-Za-z]+/', '') ELSE btrim(COALESCE(l."externalListingId", '')) END, '') AS id) k
WHERE l.channel IN ('EBAY', 'SHOPIFY', 'ETSY') AND k.id IS NOT NULL
ORDER BY l.channel, l.marketplace, k.id, l."createdAt", l.id
ON CONFLICT (channel, marketplace, "externalId") DO NOTHING;

-- ── Row-level security, the mode and the trigger: workspaces/channel-item-claim.sql, byte for byte ──────────────────
-- MCP full control I12 (plan section 04 §4.2 M3, D1 = B) — one seller-owned channel id, one owner.
--
-- An eBay Item ID, a Shopify product or an Etsy listing belongs to one seller account, so to one business, one product
-- family and one listing (an extra listing has its own key). ChannelItemClaim records who holds each such id; the
-- trigger below keeps it from every ChannelListing write, whichever of the many writers made it. A family's variations
-- share their parent's claim. An ASIN is a catalogue id (several businesses may list one): never claimed.
--
-- REPORT mode (now): a write that meets another owner's claim is NOT refused and changes no claim — the identity audit
-- reports the duplicate (#1 in one business, #2 across businesses). ENFORCE mode refuses that write (P0001). It is
-- switched by a later migration that replaces nexus_item_claim_mode(), only after audit #1 and #2 read 0 in production,
-- on the Owner's word. In report mode the claim bookkeeping can never block a listing write: any failure in it is a
-- warning.
--
-- The runtime role reads its own business's claims and writes none: only the trigger (SECURITY DEFINER) does.

ALTER TABLE "ChannelItemClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelItemClaim" FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON "ChannelItemClaim" FROM nexus_workspace_runtime;
GRANT SELECT ON TABLE "ChannelItemClaim" TO nexus_workspace_runtime;
DROP POLICY IF EXISTS nexus_workspace_isolation ON "ChannelItemClaim";
CREATE POLICY nexus_workspace_isolation ON "ChannelItemClaim" FOR SELECT TO nexus_workspace_runtime
USING ("workspaceId" = NULLIF(current_setting('nexus.workspace_id', true), ''));

-- 'report' | 'enforce'. A migration replaces this function to change the mode; nothing else may.
CREATE OR REPLACE FUNCTION nexus_item_claim_mode() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'report'::text $$;

-- The id a claim is keyed by: Shopify's without its gid:// prefix, every id trimmed; null when there is none.
CREATE OR REPLACE FUNCTION nexus_item_claim_key(channel_name text, raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(CASE WHEN channel_name = 'SHOPIFY' THEN regexp_replace(btrim(COALESCE(raw, '')), '^gid://shopify/[A-Za-z]+/', '') ELSE btrim(COALESCE(raw, '')) END, '')
$$;

CREATE OR REPLACE FUNCTION nexus_channel_item_claim() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  new_id text;
  old_id text;
  new_root text;
  holder "ChannelItemClaim"%ROWTYPE;
  conflict boolean := false;
BEGIN
  -- Nothing to do for other channels, or for an update that moved none of the claim's columns.
  IF NOT ((TG_OP <> 'DELETE' AND NEW.channel IN ('EBAY', 'SHOPIFY', 'ETSY')) OR (TG_OP <> 'INSERT' AND OLD.channel IN ('EBAY', 'SHOPIFY', 'ETSY'))) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."externalListingId" IS NOT DISTINCT FROM NEW."externalListingId" AND OLD."productId" = NEW."productId"
      AND OLD."aliasKey" = NEW."aliasKey" AND OLD.marketplace = NEW.marketplace AND OLD.channel = NEW.channel THEN
    RETURN NULL;
  END IF;
  BEGIN
    -- Release: the id an UPDATE or DELETE took off, when no other row of the holding family's listing still carries it.
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.channel IN ('EBAY', 'SHOPIFY', 'ETSY') THEN
      old_id := nexus_item_claim_key(OLD.channel, OLD."externalListingId");
      IF old_id IS NOT NULL AND (TG_OP = 'DELETE' OR old_id IS DISTINCT FROM nexus_item_claim_key(NEW.channel, NEW."externalListingId")
          OR OLD."productId" IS DISTINCT FROM NEW."productId" OR OLD."aliasKey" IS DISTINCT FROM NEW."aliasKey"
          OR OLD.marketplace IS DISTINCT FROM NEW.marketplace OR OLD.channel IS DISTINCT FROM NEW.channel) THEN
        DELETE FROM "ChannelItemClaim" c
        WHERE c.channel = OLD.channel AND c.marketplace = OLD.marketplace AND c."externalId" = old_id AND c."workspaceId" = OLD."workspaceId"
          AND NOT EXISTS (
            SELECT 1 FROM "ChannelListing" l JOIN "Product" p ON p.id = l."productId"
            WHERE l.id <> OLD.id AND l.channel = c.channel AND l.marketplace = c.marketplace AND l."workspaceId" = c."workspaceId"
              AND l."aliasKey" = c."aliasKey" AND COALESCE(p."parentId", p.id) = c."rootProductId"
              AND nexus_item_claim_key(l.channel, l."externalListingId") = c."externalId");
      END IF;
    END IF;

    -- Claim: the id an INSERT or UPDATE put on, for the row's family and listing.
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.channel IN ('EBAY', 'SHOPIFY', 'ETSY') THEN
      new_id := nexus_item_claim_key(NEW.channel, NEW."externalListingId");
      IF new_id IS NOT NULL THEN
        SELECT COALESCE(p."parentId", p.id) INTO new_root FROM "Product" p WHERE p.id = NEW."productId";
        INSERT INTO "ChannelItemClaim" (channel, marketplace, "externalId", "workspaceId", "rootProductId", "aliasKey", "connectionId")
        VALUES (NEW.channel, NEW.marketplace, new_id, NEW."workspaceId", new_root, NEW."aliasKey", NEW."channelConnectionId")
        ON CONFLICT (channel, marketplace, "externalId") DO NOTHING;
        IF NOT FOUND THEN
          SELECT * INTO holder FROM "ChannelItemClaim" WHERE channel = NEW.channel AND marketplace = NEW.marketplace AND "externalId" = new_id;
          conflict := NOT (holder."workspaceId" = NEW."workspaceId" AND holder."rootProductId" = new_root AND holder."aliasKey" = NEW."aliasKey");
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The bookkeeping never blocks a listing write in report mode.
    IF nexus_item_claim_mode() = 'enforce' THEN RAISE; END IF;
    RAISE WARNING 'channel item claim skipped: %', SQLERRM;
    conflict := false;
  END;

  IF conflict AND nexus_item_claim_mode() = 'enforce' THEN
    RAISE EXCEPTION 'The % item % (%) is already held by another listing.', NEW.channel, new_id, NEW.marketplace USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION nexus_channel_item_claim() FROM PUBLIC;

DROP TRIGGER IF EXISTS nexus_channel_item_claim ON "ChannelListing";
CREATE TRIGGER nexus_channel_item_claim AFTER INSERT OR UPDATE OF "externalListingId", "productId", "aliasKey", marketplace, channel OR DELETE ON "ChannelListing"
FOR EACH ROW EXECUTE FUNCTION nexus_channel_item_claim();
