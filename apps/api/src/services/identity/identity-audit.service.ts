/**
 * MCP full control I2 — the identity audit: one bounded SQL per check of identity-checks.ts, run live on request in the
 * business the caller is bound to. Read-only: no write, no channel call.
 *
 * Every check is ONE statement that returns its findings in one shape — key (unique within the check, the keyset
 * order), sku, product_id, listing_id, channel, market, facts (jsonb) — so the audit reads a count and the first N
 * findings of each check in one round trip (`count(*) OVER ()` before the LIMIT), and identity-issues pages through
 * them with a keyset cursor (lib/pagination/cursor.ts). The business is named on the primary table of every statement
 * (`"workspaceId" = <bound business>`) and row-level security holds the rest.
 *
 * "Root" is a product's family parent: COALESCE(p."parentId", p.id). A deleted product (soft delete) takes part only in
 * the checks about deleted products (#9 parent deleted, #20 orphans).
 *
 * A check that needs a column this database does not have yet (ProductListingAlias.sku, from the eBay import by SKU)
 * is skipped and says why; it runs as soon as the column exists (read from the database, not assumed).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import {
  InvalidCursorError,
  cursorScope,
  decodeCursor,
  fitPage,
  pageOf,
  type CursorPosition,
  type Page,
} from '../../lib/pagination/cursor.js'
import { logger } from '../../utils/logger.js'
import { validateGtin } from '../listing-preflight.service.js'
import { ebayIndexGoneProductsSql } from '../advertising/ebay-listing-index-reads.js'
import {
  REQUIREMENT_MISSING,
  selectChecks,
  type IdentityCheck,
  type IdentityRequirement,
  type IdentitySeverity,
} from './identity-checks.js'

const sql = Prisma.sql

// ── SQL pieces ────────────────────────────────────────────────────────────────────────────────────────

/** A Shopify id without its `gid://shopify/<Type>/` prefix (Nexus stores both forms), or null when empty. */
export const shopifyIdSql = (expr: Prisma.Sql) =>
  sql`NULLIF(regexp_replace(btrim(${expr}), '^gid://shopify/[A-Za-z]+/', ''), '')`

/** A JSON value as text: a string, number or boolean; the first item of a list; an object's `value` (Amazon's shape). */
const jsonText = (v: Prisma.Sql) => sql`(CASE jsonb_typeof(${v})
  WHEN 'string' THEN (${v}) #>> '{}' WHEN 'number' THEN (${v}) #>> '{}' WHEN 'boolean' THEN (${v}) #>> '{}'
  WHEN 'array' THEN COALESCE((${v})->0->>'value', CASE WHEN jsonb_typeof((${v})->0) IN ('string', 'number') THEN (${v})->>0 END)
  WHEN 'object' THEN (${v})->>'value' END)`

const nonEmpty = (expr: Prisma.Sql) => sql`NULLIF(btrim(${expr}), '')`

/** A barcode as digits with leading zeros dropped (a UPC-A and its GTIN-13 are one code), or null when none. */
export const barcodeSql = (expr: Prisma.Sql) => sql`NULLIF(ltrim(regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g'), '0'), '')`

/** A brand compared without case, spaces or punctuation. */
const brandKey = (expr: Prisma.Sql) => sql`NULLIF(regexp_replace(lower(COALESCE(${expr}, '')), '[^[:alnum:]]', '', 'g'), '')`

/** The barcode a listing carries itself, where the channel sheets keep one. */
const listingBarcode = (pa: Prisma.Sql) => sql`COALESCE(
  ${nonEmpty(jsonText(sql`${pa}->'externally_assigned_product_identifier'`))}, ${nonEmpty(jsonText(sql`${pa}->'gtin'`))},
  ${nonEmpty(jsonText(sql`${pa}->'ean'`))}, ${nonEmpty(jsonText(sql`${pa}->'upc'`))},
  ${nonEmpty(jsonText(sql`${pa}->'itemSpecifics'->'EAN'`))}, ${nonEmpty(jsonText(sql`${pa}->'itemSpecifics'->'UPC'`))},
  ${nonEmpty(jsonText(sql`${pa}->'itemSpecifics'->'GTIN'`))})`

/** A product's barcodes, one row each (gtin, ean, upc), normalised. */
const productBarcodes = (p: string) => sql`(VALUES (${barcodeSql(sql`${Prisma.raw(p)}.gtin`)}), (${barcodeSql(sql`${Prisma.raw(p)}.ean`)}), (${barcodeSql(sql`${Prisma.raw(p)}.upc`)}))`

/** The listing joined to its product when the product is not deleted. */
const LIVE_LISTING = sql`"ChannelListing" cl JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NULL`
const PA = sql`cl."platformAttributes"`

/** One SQL per check, each returning: key, sku, product_id, listing_id, channel, market, facts. */
type CheckSql = (ws: string) => Prisma.Sql

const CHECK_SQL: Record<string, CheckSql> = {
  // #1 — a seller-owned id (eBay Item ID, Shopify product, Etsy listing) on two families or two listings of one family.
  'channel-id-on-two-families': (ws) => sql`
    SELECT x.channel || ' ' || x.market || ' ' || x.id AS key, min(x.root_sku) AS sku, NULL::text AS product_id,
      NULL::text AS listing_id, x.channel, x.market,
      jsonb_build_object('externalId', x.id, 'families', (array_agg(DISTINCT x.root_sku ORDER BY x.root_sku))[1:5],
        'familyCount', count(DISTINCT x.root_id), 'listingCount', count(*),
        'extraListings', count(DISTINCT x.alias_key) FILTER (WHERE x.alias_key <> '')) AS facts
    FROM (
      SELECT cl.channel, cl.marketplace AS market, r.id AS root_id, r.sku AS root_sku, cl."aliasKey" AS alias_key,
        CASE WHEN cl.channel = 'SHOPIFY' THEN ${shopifyIdSql(sql`cl."externalListingId"`)} ELSE ${nonEmpty(sql`cl."externalListingId"`)} END AS id
      FROM ${LIVE_LISTING} JOIN "Product" r ON r.id = COALESCE(p."parentId", p.id)
      WHERE cl."workspaceId" = ${ws} AND cl.channel IN ('EBAY', 'SHOPIFY', 'ETSY')
    ) x
    WHERE x.id IS NOT NULL
    GROUP BY x.channel, x.market, x.id
    HAVING count(DISTINCT x.root_id || '|' || x.alias_key) > 1`,

  // #2 — an id this business holds that another business also holds, from the cross-business function (I5): it answers
  // only the caller's own ids and names the other business only to its members.
  'channel-id-in-another-business': (ws) => sql`
    SELECT f.channel || ' ' || f.external_id AS key,
      (SELECT min(p.sku) FROM ${LIVE_LISTING} WHERE cl."workspaceId" = ${ws} AND cl.channel = f.channel
        AND ${shopifyIdSql(sql`cl."externalListingId"`)} = f.external_id) AS sku,
      NULL::text AS product_id, NULL::text AS listing_id, f.channel, NULL::text AS market,
      jsonb_build_object('externalId', f.external_id, 'heldBy', array_agg(DISTINCT f.holder ORDER BY f.holder),
        'listingsElsewhere', sum(f.listing_count)) AS facts
    FROM (
      SELECT c.channel, x.external_id, x.holder, x.listing_count
      FROM (VALUES ('EBAY'), ('SHOPIFY'), ('ETSY')) AS c(channel)
      CROSS JOIN LATERAL nexus_identity_foreign_ids(c.channel, NULL::text[]) x
    ) f
    GROUP BY f.channel, f.external_id`,

  // #3 — a listing id its own account did not hold at the last COMPLETE read of that account (ChannelHeldSweep), for
  // listings that existed when that read began. A truncated read never counts.
  'channel-id-not-held-by-account': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('externalId', btrim(cl."externalListingId"), 'accountId', cl."channelConnectionId", 'status', cl."listingStatus",
        'accountReadAt', s."lastCompleteAt") AS facts
    FROM ${LIVE_LISTING}
    JOIN "ChannelHeldSweep" s ON s."workspaceId" = ${ws} AND s."channelConnectionId" = cl."channelConnectionId" AND s.channel = cl.channel
      AND s."lastCompleteAt" IS NOT NULL
    WHERE cl."workspaceId" = ${ws} AND cl.channel IN ('EBAY', 'SHOPIFY', 'ETSY', 'AMAZON') AND cl."listingStatus" <> 'ENDED'
      AND ${nonEmpty(sql`cl."externalListingId"`)} IS NOT NULL AND cl."createdAt" < s."lastCompleteAt"
      AND NOT EXISTS (SELECT 1 FROM "ChannelHeldId" h WHERE h."channelConnectionId" = cl."channelConnectionId" AND h.channel = cl.channel
        AND h."endedAt" IS NULL
        AND h."externalId" = CASE WHEN cl.channel = 'SHOPIFY' THEN ${shopifyIdSql(sql`cl."externalListingId"`)} ELSE btrim(cl."externalListingId") END)`,

  // #4 — an id the account holds (still, by its last read) that no listing in this business carries.
  'channel-id-not-in-nexus': (ws) => sql`
    SELECT h.channel || ' ' || h."externalId" || ' ' || h."sellerSku" || ' ' || h.id AS key, NULLIF(h."sellerSku", '') AS sku,
      NULL::text AS product_id, NULL::text AS listing_id, h.channel, h.marketplace AS market,
      jsonb_build_object('externalId', h."externalId", 'sellerSku', NULLIF(h."sellerSku", ''), 'title', h.title, 'accountId', h."channelConnectionId",
        'firstSeenAt', h."firstSeenAt") AS facts
    FROM "ChannelHeldId" h
    WHERE h."workspaceId" = ${ws} AND h."endedAt" IS NULL AND h."matchState" = 'UNLINKED'`,

  // #5 — Nexus counts the listing as live, but it carries no channel id.
  'live-listing-without-channel-id': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('status', cl."listingStatus", 'accountId', cl."channelConnectionId") AS facts
    FROM ${LIVE_LISTING}
    WHERE cl."workspaceId" = ${ws} AND cl."listingStatus" = 'ACTIVE' AND cl."isPublished"
      AND ${nonEmpty(sql`cl."externalListingId"`)} IS NULL
      AND (cl.channel <> 'SHOPIFY' OR ${shopifyIdSql(sql`${PA}->>'shopifyProductId'`)} IS NULL)`,

  // #6 — the family's eBay listing and its shared variation rows (SharedListingMembership) name different Item IDs.
  'ebay-item-id-differs-from-shared-listing': (ws) => {
    const familyListing = (extra: Prisma.Sql) => sql`
      SELECT 1 FROM "ChannelListing" fl JOIN "Product" f ON f.id = fl."productId" AND f."deletedAt" IS NULL
      WHERE COALESCE(f."parentId", f.id) = r.id AND fl.channel = 'EBAY'
        AND fl.marketplace IN (m.marketplace, CASE m.marketplace WHEN 'UK' THEN 'GB' WHEN 'GB' THEN 'UK' END)
        AND ${nonEmpty(sql`fl."externalListingId"`)} IS NOT NULL ${extra}`
    return sql`
      SELECT r.sku || ' ' || m.marketplace || ' ' || m."itemId" AS key, r.sku, r.id AS product_id, NULL::text AS listing_id,
        'EBAY'::text AS channel, m.marketplace AS market,
        jsonb_build_object('sharedItemId', m."itemId", 'variations', count(*),
          'listingItemIds', (SELECT array_agg(DISTINCT btrim(fl."externalListingId") ORDER BY btrim(fl."externalListingId"))
            FROM "ChannelListing" fl JOIN "Product" f ON f.id = fl."productId" AND f."deletedAt" IS NULL
            WHERE COALESCE(f."parentId", f.id) = r.id AND fl.channel = 'EBAY'
              AND fl.marketplace IN (m.marketplace, CASE m.marketplace WHEN 'UK' THEN 'GB' WHEN 'GB' THEN 'UK' END)
              AND ${nonEmpty(sql`fl."externalListingId"`)} IS NOT NULL)) AS facts
      FROM "SharedListingMembership" m
      JOIN "Product" r ON r."workspaceId" = ${ws} AND r.sku = m."parentSku" AND r."deletedAt" IS NULL AND r."parentId" IS NULL
      WHERE m."workspaceId" = ${ws} AND m.status = 'ACTIVE'
      GROUP BY r.id, r.sku, m.marketplace, m."itemId"
      HAVING EXISTS (${familyListing(Prisma.empty)})
        AND NOT EXISTS (${familyListing(sql`AND btrim(fl."externalListingId") = m."itemId"`)})`
  },

  // #7 — an old product column (amazonAsin, parentAsin, ebayItemId, shopifyProductId) none of its listings carries.
  'legacy-channel-id-differs': (ws) => sql`
    SELECT p.sku || ' ' || p.id || ' ' || x.col AS key, p.sku, p.id AS product_id, NULL::text AS listing_id,
      x.channel, NULL::text AS market,
      jsonb_build_object('column', x.col, 'oldValue', x.legacy, 'listingIds', x.ids) AS facts
    FROM "Product" p
    CROSS JOIN LATERAL (
      SELECT 'amazonAsin'::text AS col, 'AMAZON'::text AS channel, upper(${nonEmpty(sql`p."amazonAsin"`)}) AS legacy,
        (SELECT array_agg(DISTINCT upper(btrim(l."externalListingId"))) FROM "ChannelListing" l
          WHERE l."productId" = p.id AND l.channel = 'AMAZON' AND ${nonEmpty(sql`l."externalListingId"`)} IS NOT NULL) AS ids
      UNION ALL
      SELECT 'parentAsin', 'AMAZON', upper(${nonEmpty(sql`p."parentAsin"`)}),
        (SELECT array_agg(DISTINCT v) FROM (
          SELECT upper(${nonEmpty(sql`l."externalParentId"`)}) AS v FROM "ChannelListing" l WHERE l."productId" = p.id AND l.channel = 'AMAZON'
          UNION ALL
          SELECT upper(${nonEmpty(sql`l."externalListingId"`)}) FROM "ChannelListing" l WHERE l."productId" = COALESCE(p."parentId", p.id) AND l.channel = 'AMAZON'
        ) s WHERE v IS NOT NULL)
      UNION ALL
      SELECT 'ebayItemId', 'EBAY', ${nonEmpty(sql`p."ebayItemId"`)},
        (SELECT array_agg(DISTINCT btrim(l."externalListingId")) FROM "ChannelListing" l
          WHERE l."productId" IN (p.id, COALESCE(p."parentId", p.id)) AND l.channel = 'EBAY' AND ${nonEmpty(sql`l."externalListingId"`)} IS NOT NULL)
      UNION ALL
      SELECT 'shopifyProductId', 'SHOPIFY', ${shopifyIdSql(sql`p."shopifyProductId"`)},
        (SELECT array_agg(DISTINCT v) FROM (
          SELECT ${shopifyIdSql(sql`l."externalListingId"`)} AS v FROM "ChannelListing" l
            WHERE l."productId" IN (p.id, COALESCE(p."parentId", p.id)) AND l.channel = 'SHOPIFY'
          UNION ALL
          SELECT ${shopifyIdSql(sql`l."platformAttributes"->>'shopifyProductId'`)} FROM "ChannelListing" l
            WHERE l."productId" IN (p.id, COALESCE(p."parentId", p.id)) AND l.channel = 'SHOPIFY'
        ) s WHERE v IS NOT NULL)
    ) x
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND x.legacy IS NOT NULL AND x.ids IS NOT NULL
      AND NOT (x.legacy = ANY (x.ids))`,

  // #8 — a variation's listing names another eBay/Etsy listing id, or another Amazon parent ASIN, than its parent's
  // listing on the same account, market and listing (alias). Shopify is #13.
  'child-listing-points-elsewhere': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('compared', CASE WHEN cl.channel = 'AMAZON' THEN 'parent ASIN' ELSE 'listing id' END,
        'variationValue', v.mine, 'parentValue', btrim(rl."externalListingId"), 'parentSku', r.sku, 'parentListingId', rl.id) AS facts
    FROM ${LIVE_LISTING}
    JOIN "Product" r ON r.id = p."parentId" AND r."deletedAt" IS NULL AND r.id <> p.id
    JOIN "ChannelListing" rl ON rl."productId" = r.id AND rl.channel = cl.channel AND rl.marketplace = cl.marketplace
      AND rl."channelConnectionId" IS NOT DISTINCT FROM cl."channelConnectionId" AND rl."aliasKey" = cl."aliasKey"
    CROSS JOIN LATERAL (SELECT ${nonEmpty(sql`CASE WHEN cl.channel = 'AMAZON' THEN cl."externalParentId" ELSE cl."externalListingId" END`)} AS mine) v
    WHERE cl."workspaceId" = ${ws} AND cl.channel IN ('EBAY', 'ETSY', 'AMAZON')
      AND v.mine IS NOT NULL AND ${nonEmpty(sql`rl."externalListingId"`)} IS NOT NULL
      AND upper(v.mine) <> upper(btrim(rl."externalListingId"))`,

  // #9 — broken families, one case each.
  'parent-deleted': (ws) => sql`
    SELECT p.sku || ' ' || p.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel, NULL::text AS market,
      jsonb_build_object('parentSku', par.sku, 'parentProductId', par.id) AS facts
    FROM "Product" p JOIN "Product" par ON par.id = p."parentId"
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND par."deletedAt" IS NOT NULL`,

  'parent-is-a-variation': (ws) => sql`
    SELECT p.sku || ' ' || p.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel, NULL::text AS market,
      jsonb_build_object('parentSku', par.sku, 'parentProductId', par.id, 'parentsParentId', par."parentId",
        'ownParent', par.id = p.id) AS facts
    FROM "Product" p JOIN "Product" par ON par.id = p."parentId" AND par."deletedAt" IS NULL
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND par."parentId" IS NOT NULL`,

  'children-under-non-parent': (ws) => sql`
    SELECT par.sku || ' ' || par.id AS key, par.sku, par.id AS product_id, NULL::text AS listing_id, NULL::text AS channel,
      NULL::text AS market,
      jsonb_build_object('variations', count(*), 'variationSkus', (array_agg(p.sku ORDER BY p.sku))[1:5]) AS facts
    FROM "Product" p
    JOIN "Product" par ON par.id = p."parentId" AND par.id <> p.id AND par."deletedAt" IS NULL AND par."parentId" IS NULL AND NOT par."isParent"
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL
    GROUP BY par.id, par.sku`,

  'listing-alias-on-a-variation': (ws) => sql`
    SELECT p.sku || ' ' || a.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, a.channel, a.marketplace AS market,
      jsonb_build_object('extraListingId', a.id, 'label', a.label, 'parentProductId', p."parentId") AS facts
    FROM "ProductListingAlias" a JOIN "Product" p ON p.id = a."productId" AND p."deletedAt" IS NULL AND p."parentId" IS NOT NULL
    WHERE a."workspaceId" = ${ws}`,

  // #10 — duplicates: an old eBay shell nobody adopted; SKUs equal once case and spaces are ignored.
  'unadopted-ebay-shell': (ws) => sql`
    SELECT p.sku || ' ' || p.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, 'EBAY'::text AS channel, NULL::text AS market,
      jsonb_build_object('itemIds', (SELECT array_agg(DISTINCT l.marketplace || ' ' || btrim(l."externalListingId"))
        FROM "ChannelListing" l WHERE l."productId" = p.id AND l.channel = 'EBAY' AND ${nonEmpty(sql`l."externalListingId"`)} IS NOT NULL)) AS facts
    FROM "Product" p
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND p."productType" = 'EBAY_LISTING_SHELL'
      AND NOT EXISTS (SELECT 1 FROM "ProductListingAlias" a WHERE a."adoptedFromProductId" = p.id)`,

  'sku-differs-only-in-case': (ws) => sql`
    SELECT 's ' || lower(btrim(p.sku)) AS key, min(p.sku) AS sku, NULL::text AS product_id, NULL::text AS listing_id,
      NULL::text AS channel, NULL::text AS market,
      jsonb_build_object('skus', (array_agg(p.sku ORDER BY p.sku))[1:5], 'productCount', count(*)) AS facts
    FROM "Product" p
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL
    GROUP BY lower(btrim(p.sku))
    HAVING count(*) > 1`,

  // #11 — SKU collisions, on the normalised value (case and spaces ignored).
  'listing-sku-equals-product-sku': (ws) => sql`
    SELECT a.sku || ' ' || a.id || ' ' || o.id AS key, r.sku, r.id AS product_id, NULL::text AS listing_id, a.channel, a.marketplace AS market,
      jsonb_build_object('listingSku', a.sku, 'extraListingId', a.id, 'productWithThatSku', o.sku, 'thatProductId', o.id) AS facts
    FROM "ProductListingAlias" a
    JOIN "Product" r ON r.id = a."productId" AND r."deletedAt" IS NULL
    JOIN "Product" o ON o."workspaceId" = ${ws} AND o."deletedAt" IS NULL AND lower(btrim(o.sku)) = lower(btrim(a.sku))
    WHERE a."workspaceId" = ${ws} AND ${nonEmpty(sql`a.sku`)} IS NOT NULL`,

  // An offer's SKU is another product's listing's seller SKU on the same account and market. A listing's seller SKUs
  // are its active offers' SKUs, or its product's SKU when it has no active offer (listing-claim-identity.ts).
  'offer-sku-equals-other-listing-sku': (ws) => sql`
    WITH seller AS (
      SELECT l.id AS listing_id, l.channel, l.marketplace, l."channelConnectionId" AS account, l."productId" AS product_id,
        lower(btrim(o2.sku)) AS sku_key
      FROM "Offer" o2 JOIN "ChannelListing" l ON l.id = o2."channelListingId"
      WHERE o2."workspaceId" = ${ws} AND o2."isActive" AND ${nonEmpty(sql`o2.sku`)} IS NOT NULL
      UNION
      SELECT l.id, l.channel, l.marketplace, l."channelConnectionId", l."productId", lower(btrim(lp.sku))
      FROM "ChannelListing" l JOIN "Product" lp ON lp.id = l."productId"
      WHERE l."workspaceId" = ${ws} AND NOT EXISTS (
        SELECT 1 FROM "Offer" o3 WHERE o3."channelListingId" = l.id AND o3."isActive" AND ${nonEmpty(sql`o3.sku`)} IS NOT NULL)
    )
    SELECT DISTINCT o.sku || ' ' || o.id || ' ' || s.listing_id AS key, p.sku, p.id AS product_id, cl.id AS listing_id,
      cl.channel, cl.marketplace AS market,
      jsonb_build_object('offerSku', o.sku, 'fulfillment', o."fulfillmentMethod"::text, 'otherListingId', s.listing_id,
        'otherProductSku', op.sku, 'accountId', cl."channelConnectionId") AS facts
    FROM "Offer" o
    JOIN ${LIVE_LISTING} ON cl.id = o."channelListingId"
    JOIN seller s ON s.sku_key = lower(btrim(o.sku)) AND s.channel = cl.channel AND s.marketplace = cl.marketplace
      AND s.account IS NOT DISTINCT FROM cl."channelConnectionId" AND s.listing_id <> cl.id AND s.product_id <> p.id
    JOIN "Product" op ON op.id = s.product_id AND op."deletedAt" IS NULL
    WHERE o."workspaceId" = ${ws} AND o."isActive" AND ${nonEmpty(sql`o.sku`)} IS NOT NULL`,

  'name-alias-equals-other-product-sku': (ws) => sql`
    SELECT s.alias || ' ' || s.id || ' ' || o.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel,
      NULL::text AS market,
      jsonb_build_object('alias', s.raw, 'otherProductSku', o.sku, 'otherProductId', o.id) AS facts
    FROM "SkuAlias" s
    JOIN "Product" p ON p.id = s."productId" AND p."deletedAt" IS NULL
    JOIN "Product" o ON o."workspaceId" = ${ws} AND o."deletedAt" IS NULL AND o.id <> p.id AND lower(btrim(o.sku)) = lower(btrim(s.alias))
    WHERE s."workspaceId" = ${ws}`,

  // #12 — the seller SKU the channel shows differs from the one Nexus would send (listing-claim-identity.ts). A variation
  // row of a multi-SKU item counts only when it is linked to a variation's listing (else it was linked to the family).
  'channel-sku-differs': (ws) => sql`
    SELECT p.sku || ' ' || cl.id || ' ' || h.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('channelSku', h."sellerSku", 'nexusSku', s.seller, 'externalId', h."externalId") AS facts
    FROM "ChannelHeldId" h
    JOIN ${LIVE_LISTING} ON cl.id = h."listingId"
    CROSS JOIN LATERAL (
      SELECT CASE WHEN count(DISTINCT o.sku) > 1 THEN NULL WHEN count(DISTINCT o.sku) = 1 THEN min(o.sku)
        WHEN btrim(p.sku) <> '' THEN p.sku END AS seller
      FROM "Offer" o WHERE o."channelListingId" = cl.id AND o."isActive" AND btrim(o.sku) <> ''
    ) s
    WHERE h."workspaceId" = ${ws} AND h."endedAt" IS NULL AND h."matchState" = 'LINKED' AND h."sellerSku" <> ''
      AND (h."parentExternalId" IS NULL OR p."parentId" IS NOT NULL)
      AND s.seller IS DISTINCT FROM h."sellerSku"`,

  // #13 — Shopify variants.
  'shopify-variant-on-two-products': (ws) => sql`
    SELECT 'v ' || x.vid AS key, min(x.sku) AS sku, NULL::text AS product_id, NULL::text AS listing_id, 'SHOPIFY'::text AS channel,
      NULL::text AS market,
      jsonb_build_object('variantId', x.vid, 'skus', (array_agg(DISTINCT x.sku ORDER BY x.sku))[1:5], 'productCount', count(DISTINCT x.product_id)) AS facts
    FROM (
      SELECT p.sku, p.id AS product_id, ${shopifyIdSql(sql`${PA}->>'variantId'`)} AS vid
      FROM ${LIVE_LISTING} WHERE cl."workspaceId" = ${ws} AND cl.channel = 'SHOPIFY'
    ) x
    WHERE x.vid IS NOT NULL
    GROUP BY x.vid
    HAVING count(DISTINCT x.product_id) > 1`,

  'shopify-variant-of-other-product': (ws) => sql`
    SELECT p.sku || ' ' || cl.id || ' ' || e.against AS key, p.sku, p.id AS product_id, cl.id AS listing_id, 'SHOPIFY'::text AS channel,
      cl.marketplace AS market,
      jsonb_build_object('shopifyProductId', e.mine, 'expected', e.expected, 'against', e.against) AS facts
    FROM ${LIVE_LISTING}
    LEFT JOIN "ShopifyColourProduct" scp ON scp.id = ${PA}->>'shopifyColourProductId'
    LEFT JOIN "ChannelListing" rl ON p."parentId" IS NOT NULL AND rl."productId" = p."parentId" AND rl.channel = 'SHOPIFY'
      AND rl.marketplace = cl.marketplace AND rl."channelConnectionId" IS NOT DISTINCT FROM cl."channelConnectionId" AND rl."aliasKey" = cl."aliasKey"
    CROSS JOIN LATERAL (
      SELECT 'own ids'::text AS against, ${shopifyIdSql(sql`cl."externalListingId"`)} AS mine,
        ${shopifyIdSql(sql`${PA}->>'shopifyProductId'`)} AS expected
      UNION ALL
      SELECT CASE WHEN ${PA}->>'shopifyColourProductId' IS NOT NULL THEN 'colour product' ELSE 'parent listing' END,
        ${shopifyIdSql(sql`COALESCE(${nonEmpty(sql`${PA}->>'shopifyProductId'`)}, cl."externalListingId")`)},
        CASE WHEN ${PA}->>'shopifyColourProductId' IS NOT NULL THEN ${shopifyIdSql(sql`scp."shopifyProductId"`)}
          ELSE ${shopifyIdSql(sql`COALESCE(${nonEmpty(sql`rl."platformAttributes"->>'shopifyProductId'`)}, rl."externalListingId")`)} END
    ) e
    WHERE cl."workspaceId" = ${ws} AND cl.channel = 'SHOPIFY' AND e.mine IS NOT NULL AND e.expected IS NOT NULL AND e.mine <> e.expected`,

  // #14 — shared accounts (an unrevoked ChannelAccountGrant): a live listing needs this business's claim on its seller SKU.
  'shared-account-listing-without-claim': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('accountId', cl."channelConnectionId", 'sellerSku', s.seller) AS facts
    FROM ${LIVE_LISTING}
    CROSS JOIN LATERAL (
      SELECT CASE WHEN count(DISTINCT o.sku) > 1 THEN NULL WHEN count(DISTINCT o.sku) = 1 THEN min(o.sku)
        WHEN btrim(p.sku) <> '' THEN p.sku END AS seller
      FROM "Offer" o WHERE o."channelListingId" = cl.id AND o."isActive" AND btrim(o.sku) <> ''
    ) s
    WHERE cl."workspaceId" = ${ws} AND cl."listingStatus" = 'ACTIVE' AND cl."channelConnectionId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "ChannelAccountGrant" g WHERE g."connectionId" = cl."channelConnectionId" AND g."revokedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "ChannelListingClaim" k WHERE k."connectionId" = cl."channelConnectionId"
        AND k.marketplace = cl.marketplace AND k."workspaceId" = ${ws} AND (k."channelListingId" = cl.id OR k."sellerSku" = s.seller))`,

  'claim-without-listing': (ws) => sql`
    SELECT k."sellerSku" || ' ' || k."connectionId" || ' ' || k.marketplace AS key, k."sellerSku" AS sku, NULL::text AS product_id,
      k."channelListingId" AS listing_id,
      (SELECT upper(c."channelType") FROM "ChannelConnection" c WHERE c.id = k."connectionId") AS channel, k.marketplace AS market,
      jsonb_build_object('accountId', k."connectionId", 'sellerSku', k."sellerSku", 'claimedAt', k."claimedAt") AS facts
    FROM "ChannelListingClaim" k
    WHERE k."workspaceId" = ${ws}
      AND NOT EXISTS (SELECT 1 FROM ${LIVE_LISTING} WHERE cl.id = k."channelListingId")`,

  // #15 — an account this business neither owns nor may publish on (no unrevoked publish grant).
  'listing-on-account-not-usable': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('accountId', cl."channelConnectionId", 'status', cl."listingStatus",
        'externalId', ${nonEmpty(sql`cl."externalListingId"`)},
        'access', CASE
          WHEN EXISTS (SELECT 1 FROM "ChannelAccountGrant" g WHERE g."connectionId" = cl."channelConnectionId" AND g."workspaceId" = ${ws} AND g."revokedAt" IS NULL) THEN 'read only'
          WHEN EXISTS (SELECT 1 FROM "ChannelAccountGrant" g WHERE g."connectionId" = cl."channelConnectionId" AND g."workspaceId" = ${ws}) THEN 'revoked'
          ELSE 'none' END) AS facts
    FROM ${LIVE_LISTING}
    WHERE cl."workspaceId" = ${ws} AND cl."channelConnectionId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c.id = cl."channelConnectionId" AND c."workspaceId" = ${ws})
      AND NOT EXISTS (SELECT 1 FROM "ChannelAccountGrant" g WHERE g."connectionId" = cl."channelConnectionId"
        AND g."workspaceId" = ${ws} AND g."revokedAt" IS NULL AND g.mode = 'publish')`,

  // #16 — a listing that names no account.
  'listing-without-account': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('status', cl."listingStatus", 'externalId', ${nonEmpty(sql`cl."externalListingId"`)}) AS facts
    FROM ${LIVE_LISTING}
    WHERE cl."workspaceId" = ${ws} AND cl."channelConnectionId" IS NULL`,

  // #17 — barcodes. The check digit is computed here (the same mod-10 as validateGtin), so the count is bounded.
  'gtin-invalid': (ws) => sql`
    SELECT p.sku || ' ' || p.id || ' ' || f.field AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel,
      NULL::text AS market,
      jsonb_build_object('field', f.field, 'value', f.raw) AS facts
    FROM "Product" p
    CROSS JOIN LATERAL (VALUES ('gtin', p.gtin), ('ean', p.ean), ('upc', p.upc)) AS f(field, raw)
    CROSS JOIN LATERAL (SELECT regexp_replace(btrim(f.raw), '[[:space:]-]', '', 'g') AS s) n
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND ${nonEmpty(sql`f.raw`)} IS NOT NULL
      AND CASE WHEN n.s ~ '^[0-9]+$' AND length(n.s) IN (8, 12, 13, 14)
        THEN (10 - (SELECT sum(substr(n.s, i, 1)::int * CASE WHEN (length(n.s) - 1 - i) % 2 = 0 THEN 3 ELSE 1 END)
                    FROM generate_series(1, length(n.s) - 1) AS i) % 10) % 10 <> substr(n.s, length(n.s), 1)::int
        ELSE true END`,

  'gtin-ean-upc-disagree': (ws) => sql`
    SELECT p.sku || ' ' || p.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel, NULL::text AS market,
      jsonb_build_object('gtin', p.gtin, 'ean', p.ean, 'upc', p.upc) AS facts
    FROM "Product" p
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL
      AND (SELECT count(DISTINCT c) FROM ${productBarcodes('p')} AS v(c) WHERE c IS NOT NULL) > 1`,

  'listing-gtin-differs': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('listingCode', lc.raw, 'productGtin', p.gtin, 'productEan', p.ean, 'productUpc', p.upc) AS facts
    FROM ${LIVE_LISTING}
    CROSS JOIN LATERAL (SELECT ${listingBarcode(PA)} AS raw) lc
    CROSS JOIN LATERAL (SELECT array_agg(DISTINCT c) AS codes FROM ${productBarcodes('p')} AS v(c) WHERE c IS NOT NULL) pc
    WHERE cl."workspaceId" = ${ws} AND ${barcodeSql(sql`lc.raw`)} IS NOT NULL AND pc.codes IS NOT NULL
      AND NOT (${barcodeSql(sql`lc.raw`)} = ANY (pc.codes))`,

  'parent-carries-gtin': (ws) => sql`
    SELECT p.sku || ' ' || p.id AS key, p.sku, p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel, NULL::text AS market,
      jsonb_build_object('gtin', p.gtin, 'ean', p.ean, 'upc', p.upc,
        'variations', (SELECT count(*) FROM "Product" ch WHERE ch."parentId" = p.id AND ch.id <> p.id AND ch."deletedAt" IS NULL)) AS facts
    FROM "Product" p
    WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND p."parentId" IS NULL
      AND COALESCE(${barcodeSql(sql`p.gtin`)}, ${barcodeSql(sql`p.ean`)}, ${barcodeSql(sql`p.upc`)}) IS NOT NULL
      AND EXISTS (SELECT 1 FROM "Product" ch WHERE ch."parentId" = p.id AND ch.id <> p.id AND ch."deletedAt" IS NULL)`,

  'gtin-missing-for-new-amazon-listing': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('status', cl."listingStatus") AS facts
    FROM ${LIVE_LISTING}
    WHERE cl."workspaceId" = ${ws} AND cl.channel = 'AMAZON' AND ${nonEmpty(sql`cl."externalListingId"`)} IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Product" ch WHERE ch."parentId" = p.id AND ch.id <> p.id AND ch."deletedAt" IS NULL)
      AND COALESCE(${barcodeSql(sql`p.gtin`)}, ${barcodeSql(sql`p.ean`)}, ${barcodeSql(sql`p.upc`)}) IS NULL
      AND ${barcodeSql(listingBarcode(PA))} IS NULL
      AND ${nonEmpty(jsonText(sql`${PA}->'merchant_suggested_asin'`))} IS NULL
      AND lower(COALESCE(${jsonText(sql`${PA}->'supplier_declared_has_product_identifier_exemption'`)}, '')) NOT IN ('true', 'yes', '1')`,

  // #18 — one barcode on two products of this business (the same code in two businesses is legal).
  'gtin-on-two-products': (ws) => sql`
    SELECT 'g ' || x.c AS key, min(x.sku) AS sku, NULL::text AS product_id, NULL::text AS listing_id, NULL::text AS channel,
      NULL::text AS market,
      jsonb_build_object('code', x.c, 'skus', (array_agg(DISTINCT x.sku ORDER BY x.sku))[1:5], 'productCount', count(DISTINCT x.id)) AS facts
    FROM (
      SELECT DISTINCT p.id, p.sku, v.c FROM "Product" p CROSS JOIN LATERAL ${productBarcodes('p')} AS v(c)
      WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND v.c IS NOT NULL
    ) x
    GROUP BY x.c
    HAVING count(DISTINCT x.id) > 1`,

  // #19 — brands.
  'brand-spelled-several-ways': (ws) => sql`
    SELECT 'b ' || x.k AS key, NULL::text AS sku, NULL::text AS product_id, NULL::text AS listing_id, NULL::text AS channel,
      NULL::text AS market,
      jsonb_build_object('spellings', (array_agg(DISTINCT x.brand ORDER BY x.brand))[1:8], 'products', count(*)) AS facts
    FROM (
      SELECT btrim(p.brand) AS brand, ${brandKey(sql`p.brand`)} AS k FROM "Product" p
      WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND ${nonEmpty(sql`p.brand`)} IS NOT NULL
    ) x
    WHERE x.k IS NOT NULL
    GROUP BY x.k
    HAVING count(DISTINCT x.brand) > 1`,

  'listing-brand-differs': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('listingBrand', lb.brand, 'productBrand', pb.brand) AS facts
    FROM ${LIVE_LISTING}
    LEFT JOIN "Product" r ON r.id = p."parentId"
    CROSS JOIN LATERAL (SELECT CASE cl.channel
      WHEN 'AMAZON' THEN COALESCE(${nonEmpty(jsonText(sql`${PA}->'brand'`))}, ${nonEmpty(jsonText(sql`${PA}->'attributes'->'brand'`))})
      WHEN 'EBAY' THEN COALESCE(${nonEmpty(jsonText(sql`${PA}->'itemSpecifics'->'Brand'`))}, ${nonEmpty(jsonText(sql`${PA}->'itemSpecifics'->'Marca'`))},
        ${nonEmpty(jsonText(sql`${PA}->'itemSpecifics'->'Marke'`))}, ${nonEmpty(jsonText(sql`${PA}->'itemSpecifics'->'Marque'`))})
      END AS brand) lb
    CROSS JOIN LATERAL (SELECT COALESCE(${nonEmpty(sql`p.brand`)}, ${nonEmpty(sql`r.brand`)}) AS brand) pb
    WHERE cl."workspaceId" = ${ws} AND cl.channel IN ('AMAZON', 'EBAY') AND lb.brand IS NOT NULL AND pb.brand IS NOT NULL
      AND ${brandKey(sql`lb.brand`)} IS DISTINCT FROM ${brandKey(sql`pb.brand`)}`,

  // #20 — orphans.
  'listing-on-deleted-product': (ws) => sql`
    SELECT p.sku || ' ' || cl.id AS key, p.sku, p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market,
      jsonb_build_object('status', cl."listingStatus", 'externalId', ${nonEmpty(sql`cl."externalListingId"`)}, 'productDeletedAt', p."deletedAt") AS facts
    FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NOT NULL
    WHERE cl."workspaceId" = ${ws}`,

  'listing-alias-without-listings': (ws) => sql`
    SELECT r.sku || ' ' || a.id AS key, r.sku, r.id AS product_id, NULL::text AS listing_id, a.channel, a.marketplace AS market,
      jsonb_build_object('extraListingId', a.id, 'label', a.label, 'status', a.status) AS facts
    FROM "ProductListingAlias" a JOIN "Product" r ON r.id = a."productId"
    WHERE a."workspaceId" = ${ws}
      AND NOT EXISTS (SELECT 1 FROM "ChannelListing" l WHERE l."aliasId" = a.id OR l."aliasKey" = a.id)`,

  'ebay-index-names-gone-product': (ws) => ebayIndexGoneProductsSql(ws),

  // #21 — an eBay account connected before Nexus recorded its seller.
  'ebay-account-without-identity': (ws) => sql`
    SELECT 'a ' || c.id AS key, NULL::text AS sku, NULL::text AS product_id, NULL::text AS listing_id, 'EBAY'::text AS channel,
      c.marketplace AS market,
      jsonb_build_object('accountId', c.id, 'account', COALESCE(c."accountLabel", c."displayName"), 'active', c."isActive") AS facts
    FROM "ChannelConnection" c
    WHERE c."workspaceId" = ${ws} AND upper(c."channelType") = 'EBAY' AND ${nonEmpty(sql`c."externalAccountId"`)} IS NULL`,
}

// ── Running a check ───────────────────────────────────────────────────────────────────────────────────

export interface IdentityFinding {
  check: string
  severity: IdentitySeverity
  /** The finding's place in its check (unique there, stable while the data stays the same). */
  key: string
  sku?: string
  productId?: string
  listingId?: string
  channel?: string
  market?: string
  details?: Record<string, unknown>
}

interface FindingRow {
  key: string
  sku: string | null
  product_id: string | null
  listing_id: string | null
  channel: string | null
  market: string | null
  facts: Record<string, unknown> | null
  total?: bigint | number
}

/** Texts in a finding are cut to this length; lists in it are already cut by the SQL. */
const TEXT_CAP = 160
const clip = (value: unknown): unknown => {
  if (typeof value === 'string') return value.length > TEXT_CAP ? `${value.slice(0, TEXT_CAP - 1)}…` : value
  if (Array.isArray(value)) return value.map(clip)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]))
  return value
}

/** #17 — the reason validateGtin gives, on each invalid barcode the SQL found (the same rule, said in words). */
function withReason(check: string, details: Record<string, unknown>): Record<string, unknown> {
  if (check !== 'gtin-invalid') return details
  const verdict = validateGtin(typeof details.value === 'string' ? details.value : null)
  return { ...details, reason: verdict.valid ? 'not a valid barcode' : verdict.reason }
}

function findingOf(check: IdentityCheck, row: FindingRow): IdentityFinding {
  const details = row.facts ? withReason(check.kind, clip(row.facts) as Record<string, unknown>) : undefined
  return {
    check: check.kind,
    severity: check.severity,
    key: row.key,
    ...(row.sku != null ? { sku: clip(row.sku) as string } : {}),
    ...(row.product_id != null ? { productId: row.product_id } : {}),
    ...(row.listing_id != null ? { listingId: row.listing_id } : {}),
    ...(row.channel != null ? { channel: row.channel } : {}),
    ...(row.market != null ? { market: row.market } : {}),
    ...(details && Object.keys(details).length ? { details } : {}),
  }
}

/**
 * The columns this database has of those a check may need. Read each time: a migration may have added one. `db`: the
 * caller's transaction, when it has one (a write guard reads inside the write's transaction).
 */
export async function availableRequirements(db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma): Promise<Set<IdentityRequirement>> {
  const [row] = await db.$queryRaw<Array<{ alias_sku: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ProductListingAlias' AND column_name = 'sku') AS alias_sku`
  const present = new Set<IdentityRequirement>()
  if (row?.alias_sku) present.add('listing-alias-sku')
  return present
}

/** Why a check cannot run here, or null when it can. */
export function skipReason(check: IdentityCheck, present: Set<IdentityRequirement>): string | null {
  return check.requires && !present.has(check.requires) ? REQUIREMENT_MISSING[check.requires] : null
}

/**
 * One check's findings in key order: strictly after `after` (a key) when given, at most `limit`. With `withTotal`, the
 * number of all its findings comes in the same statement (counted before the cursor and the limit).
 */
export async function runCheck(
  check: IdentityCheck,
  options: { after?: string | null; limit: number; withTotal?: boolean },
): Promise<{ findings: IdentityFinding[]; total: number | null }> {
  const build = CHECK_SQL[check.kind]
  if (!build) throw new Error(`identity check ${check.kind} has no SQL`)
  const body = build(workspaceIdForQuery())
  const after = options.after == null ? Prisma.empty : sql`WHERE t.key COLLATE "C" > ${options.after}::text COLLATE "C"`
  const counted = options.withTotal ? sql`, count(*) OVER () AS total` : Prisma.empty
  const rows = await prisma.$queryRaw<FindingRow[]>`
    SELECT t.* FROM (SELECT q.* ${counted} FROM (${body}) q) t ${after}
    ORDER BY t.key COLLATE "C" LIMIT ${Math.max(0, options.limit)}`
  let total: number | null = null
  if (options.withTotal) {
    if (rows.length) total = Number(rows[0].total ?? 0)
    else if (options.after == null) total = 0
  }
  return { findings: rows.map((row) => findingOf(check, row)), total }
}

// ── identity-audit: every check, counted, with the first examples ────────────────────────────────────

export interface AuditedCheck {
  check: string
  number: number
  severity: IdentitySeverity
  title: string
  count: number
  examples: IdentityFinding[]
  explanation: string
  fix: { tool: string | null; available: boolean; how: string }
}

export interface IdentityAudit {
  summary: { errors: number; warnings: number; info: number; checksRun: number }
  /** The checks that found something, errors first, then by catalogue row. */
  findings: AuditedCheck[]
  /** The checks that ran and found nothing. */
  clean: string[]
  /** Checks that did not run here, and why. */
  skipped: Array<{ check: string; reason: string }>
  /** Checks whose SQL failed: never read as clean. */
  failed: string[]
}

const SEVERITY_RANK: Record<IdentitySeverity, number> = { error: 0, warning: 1, info: 2 }

export async function auditIdentity(options: {
  checks?: readonly string[]
  severity?: IdentitySeverity
  examples: number
  /** Is the fix tool registered now? (Most of the plan's fix tools come in later steps.) */
  toolExists?: (name: string) => boolean
}): Promise<IdentityAudit> {
  const present = await availableRequirements()
  const audit: IdentityAudit = { summary: { errors: 0, warnings: 0, info: 0, checksRun: 0 }, findings: [], clean: [], skipped: [], failed: [] }
  for (const check of selectChecks(options)) {
    const skip = skipReason(check, present)
    if (skip) {
      audit.skipped.push({ check: check.kind, reason: skip })
      continue
    }
    let result: Awaited<ReturnType<typeof runCheck>>
    try {
      result = await runCheck(check, { limit: options.examples, withTotal: true })
    } catch (error) {
      logger.warn('[identity-audit] a check failed', { check: check.kind, error: error instanceof Error ? error.message : String(error) })
      audit.failed.push(check.kind)
      continue
    }
    audit.summary.checksRun++
    const count = result.total ?? 0
    if (count === 0) {
      audit.clean.push(check.kind)
      continue
    }
    audit.summary[check.severity === 'error' ? 'errors' : check.severity === 'warning' ? 'warnings' : 'info'] += count
    audit.findings.push({
      check: check.kind,
      number: check.number,
      severity: check.severity,
      title: check.title,
      count,
      examples: result.findings,
      explanation: check.explanation,
      fix: { tool: check.fix.tool, available: check.fix.tool ? (options.toolExists?.(check.fix.tool) ?? false) : false, how: check.fix.how },
    })
  }
  audit.findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.number - b.number)
  return audit
}

// ── identity-issues: every finding, one page at a time ────────────────────────────────────────────────

export interface IssuesPage extends Page<IdentityFinding> {
  skipped: Array<{ check: string; reason: string }>
  cut: number
}

/** A finding's place in the list: its check, then its key in that check. */
const positionOf = (finding: IdentityFinding): CursorPosition => ({ values: [finding.check], id: finding.key })

/**
 * The findings of the chosen checks, check by check in registry order and by key within a check, from just after the
 * cursor. Reads at most `size + 1` findings (the extra one only says another page exists).
 */
export async function identityIssuesPage(options: {
  checks?: readonly string[]
  severity?: IdentitySeverity
  size: number
  cursor?: string | null
}): Promise<IssuesPage> {
  const scope = cursorScope('identity-issues', {
    business: workspaceIdForQuery(),
    checks: options.checks?.length ? [...options.checks].sort() : undefined,
    severity: options.severity,
  })
  const start = decodeCursor(scope, options.cursor)
  const present = await availableRequirements()
  const chosen = selectChecks(options)
  const skipped = chosen.flatMap((check) => {
    const reason = skipReason(check, present)
    return reason ? [{ check: check.kind, reason }] : []
  })
  const runnable = chosen.filter((check) => !skipReason(check, present))
  let from = 0
  if (start) {
    const kind = start.values[0]
    from = runnable.findIndex((check) => check.kind === kind)
    if (typeof kind !== 'string' || from < 0) throw new InvalidCursorError()
  }
  const found: IdentityFinding[] = []
  for (let i = from; i < runnable.length && found.length <= options.size; i++) {
    const after = start && i === from ? start.id : null
    const { findings } = await runCheck(runnable[i], { after, limit: options.size + 1 - found.length })
    found.push(...findings)
  }
  const page = pageOf(found, options.size, scope, positionOf)
  const fitted = fitPage(page, scope, positionOf)
  return { ...fitted, skipped }
}
