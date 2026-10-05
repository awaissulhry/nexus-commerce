/**
 * MCP full control I3 — read a product family's identity, and find what an id is. Plan:
 * docs/mcp-full-control/sections/04-identity.md §3 (`product-identity`, `find-by-id`).
 *
 * Every id a family carries, from every place Nexus keeps one: the products (SKU, GTIN/EAN/UPC, the old channel-id
 * columns, SKU aliases), their listings (ASIN and parent ASIN, eBay Item ID, Shopify product / variant / inventory
 * item, Etsy listing id, account, extra listing, seller SKU and offers), the extra listings (ProductListingAlias), the
 * shared eBay variation rows (SharedListingMembership), the Shopify colour products and the shared-account claims.
 *
 * Inside the business the caller is bound to only (row-level security, and the business named on each raw query).
 * find-by-id also says whether another business holds a seller-owned id this business holds (I5,
 * nexus_identity_foreign_ids: the other business is named only to its members). Read-only; a deleted product is not
 * found and never a result (MCP.12).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { MAX_RESULT_BYTES } from '../../lib/pagination/cursor.js'
import { identitySellerSku } from '../listing-claim-identity.js'
import { availableRequirements, barcodeSql, shopifyIdSql } from './identity-audit.service.js'
import { ebayIndexItemMatchSql } from '../advertising/ebay-listing-index-reads.js'

const sql = Prisma.sql

/** A Shopify id without its `gid://shopify/<Type>/` prefix: Nexus stores both forms. */
export const shortShopifyId = (value: unknown): string | null => {
  if (value == null) return null
  const text = String(value).trim().replace(/^gid:\/\/shopify\/[A-Za-z]+\//, '')
  return text || null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const compact = <T extends Record<string, unknown>>(row: T): Partial<T> =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>

// ── product-identity ──────────────────────────────────────────────────────────────────────────────────

/** Per family, at most this many variations and listings are named; the rest are counted. */
const MEMBER_CAP = 60
const LISTING_CAP = 80
const MEMBERSHIP_CAP = 60

export interface IdentityFilters {
  channel?: string
  market?: string
}

interface ListingRow {
  id: string
  product_id: string
  channel: string
  marketplace: string
  channel_connection_id: string | null
  alias_key: string
  listing_status: string
  is_published: boolean
  external_listing_id: string | null
  external_parent_id: string | null
  shopify_product_id: string | null
  shopify_variant_id: string | null
  shopify_inventory_item_id: string | null
  shopify_colour_product_id: string | null
  channel_sku: string | null
  live_channel_sku: string | null
}

/** The ids a listing carries, named for its channel. */
function listingIds(row: ListingRow): Record<string, string> {
  const own = text(row.external_listing_id)
  switch (row.channel) {
    case 'AMAZON':
      return compact({ asin: own, parentAsin: text(row.external_parent_id) }) as Record<string, string>
    case 'EBAY':
      return compact({ itemId: own }) as Record<string, string>
    case 'ETSY':
      return compact({ etsyListingId: own }) as Record<string, string>
    case 'SHOPIFY':
      return compact({
        shopifyProductId: shortShopifyId(row.shopify_product_id) ?? shortShopifyId(own),
        shopifyVariantId: shortShopifyId(row.shopify_variant_id),
        shopifyInventoryItemId: shortShopifyId(row.shopify_inventory_item_id),
        shopifyColourProduct: row.shopify_colour_product_id,
      }) as Record<string, string>
    default:
      return compact({ externalId: own }) as Record<string, string>
  }
}

export type ProductIdentity = Awaited<ReturnType<typeof readProductIdentity>>

/**
 * The identity of the family a product belongs to (named by the product or any of its variations), or null when the
 * product is not found here (another business's, deleted, or no such id).
 */
export async function readProductIdentity(productId: string, filters: IdentityFilters = {}) {
  const ws = workspaceIdForQuery()
  const asked = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!asked) return null
  const notes: string[] = []
  let rootId = asked.parentId && asked.parentId !== asked.id ? asked.parentId : asked.id
  if (asked.parentId === asked.id) notes.push('This product names itself as its parent; it is shown as its own family.')
  const PRODUCT_SELECT = {
    id: true, sku: true, name: true, brand: true, gtin: true, ean: true, upc: true, isParent: true, parentId: true, productType: true,
    amazonAsin: true, parentAsin: true, ebayItemId: true, shopifyProductId: true,
  } as const
  let root = await prisma.product.findFirst({ where: { id: rootId, deletedAt: null }, select: PRODUCT_SELECT })
  if (!root) {
    notes.push('Its parent product was deleted: this variation belongs to no live family, so it is shown alone.')
    rootId = asked.id
    root = await prisma.product.findFirstOrThrow({ where: { id: asked.id }, select: PRODUCT_SELECT })
  } else if (root.parentId && root.parentId !== root.id) {
    notes.push('Its parent is itself a variation of another product (a nested family): the parent\'s own family is not shown.')
  }
  const childWhere = { parentId: root.id, deletedAt: null, NOT: { id: root.id } }
  const [children, childCount] = await Promise.all([
    prisma.product.findMany({ where: childWhere, select: PRODUCT_SELECT, orderBy: [{ sku: 'asc' }, { id: 'asc' }], take: MEMBER_CAP }),
    prisma.product.count({ where: childWhere }),
  ])
  const members = [root, ...children]
  // Listings are read for the whole family, not only the variations named: a family's ids are all of them.
  const familyIds = childCount > children.length
    ? [root.id, ...(await prisma.product.findMany({ where: childWhere, select: { id: true } })).map((c) => c.id)]
    : members.map((m) => m.id)
  const skuOf = new Map(members.map((m) => [m.id, m.sku]))

  const listingFilter = sql`${filters.channel ? sql`AND cl.channel = ${filters.channel}` : Prisma.empty}
    ${filters.market ? sql`AND cl.marketplace = ${filters.market}` : Prisma.empty}`
  const [listings, [{ n: listingTotal }]] = await Promise.all([
    prisma.$queryRaw<ListingRow[]>`
      SELECT cl.id, cl."productId" AS product_id, cl.channel, cl.marketplace, cl."channelConnectionId" AS channel_connection_id,
        cl."aliasKey" AS alias_key, cl."listingStatus" AS listing_status, cl."isPublished" AS is_published,
        cl."externalListingId" AS external_listing_id, cl."externalParentId" AS external_parent_id,
        cl."platformAttributes"->>'shopifyProductId' AS shopify_product_id, cl."platformAttributes"->>'variantId' AS shopify_variant_id,
        cl."platformAttributes"->>'inventoryItemId' AS shopify_inventory_item_id,
        cl."platformAttributes"->>'shopifyColourProductId' AS shopify_colour_product_id,
        cl."channelSku" AS channel_sku, cl."liveChannelSku" AS live_channel_sku
      FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
      WHERE cl."workspaceId" = ${ws} AND cl."productId" = ANY(${familyIds}::text[]) ${listingFilter}
      ORDER BY cl.channel, cl.marketplace, cl."aliasKey", (cl."productId" <> ${root.id}), p.sku, cl.id
      LIMIT ${LISTING_CAP}`,
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "ChannelListing" cl WHERE cl."workspaceId" = ${ws} AND cl."productId" = ANY(${familyIds}::text[]) ${listingFilter}`,
  ])
  const listingIdsShown = listings.map((l) => l.id)
  const productsOfListings = [...new Set(listings.map((l) => l.product_id))].filter((id) => !skuOf.has(id))
  if (productsOfListings.length) {
    for (const p of await prisma.product.findMany({ where: { id: { in: productsOfListings } }, select: { id: true, sku: true } })) skuOf.set(p.id, p.sku)
  }

  const present = await availableRequirements()
  const [offers, claims, aliases, aliasSkus, skuAliases, colours] = await Promise.all([
    prisma.offer.findMany({
      where: { channelListingId: { in: listingIdsShown } },
      select: { channelListingId: true, fulfillmentMethod: true, sku: true, isActive: true },
      orderBy: [{ fulfillmentMethod: 'asc' }],
    }),
    prisma.channelListingClaim.findMany({
      where: { workspaceId: ws, channelListingId: { in: listingIdsShown } },
      select: { channelListingId: true, connectionId: true, marketplace: true, sellerSku: true },
    }),
    prisma.productListingAlias.findMany({
      where: {
        productId: { in: familyIds },
        ...(filters.channel ? { channel: filters.channel } : {}),
        ...(filters.market ? { marketplace: filters.market } : {}),
      },
      select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, label: true, position: true, status: true, adoptedFromProductId: true },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { position: 'asc' }, { id: 'asc' }],
    }),
    // The extra listing's own SKU, once the listing-SKU column exists (the eBay import by SKU adds it).
    present.has('listing-alias-sku')
      ? prisma.$queryRaw<Array<{ id: string; sku: string | null }>>`
          SELECT a.id, a.sku FROM "ProductListingAlias" a WHERE a."workspaceId" = ${ws} AND a."productId" = ANY(${familyIds}::text[])`
      : Promise.resolve([] as Array<{ id: string; sku: string | null }>),
    prisma.skuAlias.findMany({ where: { productId: { in: members.map((m) => m.id) } }, select: { productId: true, raw: true }, orderBy: { raw: 'asc' } }),
    !filters.channel || filters.channel === 'SHOPIFY'
      ? prisma.shopifyColourProduct.findMany({
          where: { familyId: root.id, ...(filters.market ? { marketplace: filters.market } : {}) },
          select: { id: true, channelConnectionId: true, marketplace: true, aliasKey: true, valueKey: true, colourName: true, shopifyProductId: true, state: true },
          orderBy: [{ valueKey: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
  ])
  const memberships = !filters.channel || filters.channel === 'EBAY'
    ? await prisma.sharedListingMembership.findMany({
        where: { OR: [{ parentSku: root.sku }, { productId: { in: familyIds } }], ...(filters.market ? { marketplace: filters.market } : {}) },
        select: { marketplace: true, itemId: true, parentSku: true, sku: true, productId: true, status: true, channelConnectionId: true },
        orderBy: [{ marketplace: 'asc' }, { itemId: 'asc' }, { sku: 'asc' }],
        take: MEMBERSHIP_CAP + 1,
      })
    : []

  const accountIds = [...new Set([
    ...listings.map((l) => l.channel_connection_id), ...aliases.map((a) => a.channelConnectionId),
    ...colours.map((c) => c.channelConnectionId), ...memberships.map((m) => m.channelConnectionId),
  ].filter((id): id is string => Boolean(id)))]
  const accounts = new Map((await prisma.channelConnection.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, channelType: true, accountLabel: true, displayName: true, workspaceId: true },
  })).map((c) => [c.id, c]))
  const accountOf = (id: string | null) => {
    if (!id) return null
    const account = accounts.get(id)
    // An account this business can no longer see (not its own, and not shared with it any more).
    if (!account) return { accountId: id, visible: false }
    return compact({ accountId: id, label: account.accountLabel ?? account.displayName ?? null, ownedHere: account.workspaceId === ws })
  }
  const aliasById = new Map(aliases.map((a) => [a.id, a]))
  const aliasSkuById = new Map(aliasSkus.map((a) => [a.id, a.sku]))

  const sharedListings = new Map<string, { market: string; itemId: string; parentSku: string; status: string[]; variations: Array<Record<string, unknown>> }>()
  for (const m of memberships.slice(0, MEMBERSHIP_CAP)) {
    const key = `${m.marketplace} ${m.itemId} ${m.parentSku}`
    const entry = sharedListings.get(key) ?? { market: m.marketplace, itemId: m.itemId, parentSku: m.parentSku, status: [], variations: [] }
    if (!entry.status.includes(m.status)) entry.status.push(m.status)
    entry.variations.push(compact({ sku: m.sku, productId: m.productId, status: m.status }))
    sharedListings.set(key, entry)
  }

  const out = {
    family: compact({
      rootProductId: root.id,
      rootSku: root.sku,
      name: root.name,
      isParent: root.isParent,
      productType: root.productType,
      variations: childCount,
      askedFor: asked.id === root.id ? null : asked.id,
      notes: notes.length ? notes : null,
    }),
    products: members.map((m) => compact({
      productId: m.id,
      sku: m.sku,
      role: m.id === root.id ? (childCount > 0 ? 'parent' : 'single') : 'variation',
      brand: m.brand,
      gtin: m.gtin,
      ean: m.ean,
      upc: m.upc,
      oldColumns: Object.keys(compact({ amazonAsin: m.amazonAsin, parentAsin: m.parentAsin, ebayItemId: m.ebayItemId, shopifyProductId: m.shopifyProductId })).length
        ? compact({ amazonAsin: m.amazonAsin, parentAsin: m.parentAsin, ebayItemId: m.ebayItemId, shopifyProductId: m.shopifyProductId })
        : null,
      skuAliases: skuAliases.filter((s) => s.productId === m.id).map((s) => s.raw).slice(0, 10),
    })),
    listings: listings.map((l) => {
      const own = offers.filter((o) => o.channelListingId === l.id)
      const alias = l.alias_key ? aliasById.get(l.alias_key) : undefined
      const claim = claims.find((c) => c.channelListingId === l.id)
      return compact({
        listingId: l.id,
        productId: l.product_id,
        sku: skuOf.get(l.product_id) ?? null,
        channel: l.channel,
        market: l.marketplace,
        account: accountOf(l.channel_connection_id),
        extraListing: l.alias_key
          ? compact({ id: l.alias_key, label: alias?.label ?? null, sku: aliasSkuById.get(l.alias_key) ?? null })
          : null,
        status: l.listing_status,
        draft: l.listing_status === 'DRAFT',
        ids: listingIds(l),
        // S8 — the listing's own SKU first: the same seller SKU the identity audit compares (listing-claim-identity.ts).
        sellerSku: identitySellerSku({ channelSku: l.channel_sku, liveChannelSku: l.live_channel_sku, product: { sku: skuOf.get(l.product_id) ?? null }, offers: own }),
        offers: own.map((o) => ({ fulfillment: String(o.fulfillmentMethod), sku: o.sku, active: o.isActive })),
        claim: claim ? { accountId: claim.connectionId, market: claim.marketplace, sellerSku: claim.sellerSku } : null,
      })
    }),
    extraListings: aliases.map((a) => compact({
      id: a.id,
      onProductSku: skuOf.get(a.productId) ?? null,
      channel: a.channel,
      market: a.marketplace,
      account: accountOf(a.channelConnectionId),
      label: a.label,
      position: a.position,
      status: a.status,
      sku: aliasSkuById.get(a.id) ?? null,
      adoptedFromProductId: a.adoptedFromProductId,
    })),
    sharedEbayListings: [...sharedListings.values()],
    shopifyColourProducts: colours.map((c) => compact({
      colour: c.colourName ?? c.valueKey,
      valueKey: c.valueKey,
      shopifyProductId: shortShopifyId(c.shopifyProductId),
      state: c.state,
      market: c.marketplace,
      extraListing: c.aliasKey || null,
      account: accountOf(c.channelConnectionId),
    })),
    ...(present.has('listing-alias-sku') ? {} : { extraListingSku: 'not available until the listing-SKU column exists' }),
    more: compact({
      variations: childCount > children.length ? childCount - children.length : null,
      listings: Number(listingTotal) > listings.length ? Number(listingTotal) - listings.length : null,
      sharedVariations: memberships.length > MEMBERSHIP_CAP ? `more than ${MEMBERSHIP_CAP} shown` : null,
    }),
  }
  // Held under the size limit: listings go first, from the end, and `more` says how many.
  let shownListings = out.listings.length
  while (shownListings > 1 && Buffer.byteLength(JSON.stringify(out)) > MAX_RESULT_BYTES) {
    out.listings.pop()
    shownListings--
    out.more = { ...out.more, listings: Number(listingTotal) - shownListings }
  }
  return out
}

// ── find-by-id ────────────────────────────────────────────────────────────────────────────────────────

export const FIND_KINDS = ['sku', 'asin', 'ebay-item-id', 'shopify-id', 'etsy-listing-id', 'gtin', 'product-id'] as const
export type FindKind = (typeof FIND_KINDS)[number]

/** The most matches one answer names; more are counted. */
const MATCH_CAP = 50

interface Branch {
  kind: FindKind
  matchedAs: string
  /** Columns: product_id, listing_id, channel, market, account_id, value. */
  sql: Prisma.Sql
}

const LIVE_LISTING = sql`"ChannelListing" cl JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NULL`
const LISTING_COLUMNS = sql`p.id AS product_id, cl.id AS listing_id, cl.channel, cl.marketplace AS market, cl."channelConnectionId" AS account_id`
const PRODUCT_COLUMNS = sql`p.id AS product_id, NULL::text AS listing_id, NULL::text AS channel, NULL::text AS market, NULL::text AS account_id`

function branches(query: string, ws: string, aliasSku: boolean): Branch[] {
  const q = query.trim()
  const lower = q.toLowerCase()
  const upper = q.toUpperCase()
  const shopify = shortShopifyId(q) ?? q
  const compactCode = q.replace(/[\s-]/g, '')
  const barcode = /^[0-9]{6,14}$/.test(compactCode) ? compactCode.replace(/^0+/, '') : ''
  const liveProduct = sql`p."workspaceId" = ${ws} AND p."deletedAt" IS NULL`
  const list: Branch[] = [
    { kind: 'product-id', matchedAs: 'Nexus product id', sql: sql`SELECT ${PRODUCT_COLUMNS}, p.id AS value FROM "Product" p WHERE ${liveProduct} AND p.id = ${q}` },
    { kind: 'sku', matchedAs: 'product SKU', sql: sql`SELECT ${PRODUCT_COLUMNS}, p.sku AS value FROM "Product" p WHERE ${liveProduct} AND lower(btrim(p.sku)) = ${lower}` },
    {
      kind: 'sku', matchedAs: 'SKU alias',
      sql: sql`SELECT ${PRODUCT_COLUMNS}, s.raw AS value FROM "SkuAlias" s JOIN "Product" p ON p.id = s."productId"
        WHERE s."workspaceId" = ${ws} AND ${liveProduct} AND (s.alias = ${lower} OR lower(btrim(s.raw)) = ${lower})`,
    },
    {
      kind: 'sku', matchedAs: 'offer SKU',
      sql: sql`SELECT ${LISTING_COLUMNS}, o.sku AS value FROM "Offer" o JOIN ${LIVE_LISTING} ON cl.id = o."channelListingId"
        WHERE o."workspaceId" = ${ws} AND lower(btrim(o.sku)) = ${lower}`,
    },
    {
      kind: 'sku', matchedAs: 'shared eBay variation SKU',
      sql: sql`SELECT m."productId" AS product_id, NULL::text AS listing_id, 'EBAY'::text AS channel, m.marketplace AS market,
          m."channelConnectionId" AS account_id, m.sku || ' (Item ID ' || m."itemId" || ')' AS value
        FROM "SharedListingMembership" m
        WHERE m."workspaceId" = ${ws} AND lower(btrim(m.sku)) = ${lower}
          AND (m."productId" IS NULL OR EXISTS (SELECT 1 FROM "Product" mp WHERE mp.id = m."productId" AND mp."deletedAt" IS NULL))`,
    },
    {
      kind: 'sku', matchedAs: 'seller SKU claimed on a shared account',
      sql: sql`SELECT cl."productId" AS product_id, k."channelListingId" AS listing_id, cl.channel, k.marketplace AS market,
          k."connectionId" AS account_id, k."sellerSku" AS value
        FROM "ChannelListingClaim" k LEFT JOIN "ChannelListing" cl ON cl.id = k."channelListingId"
        WHERE k."workspaceId" = ${ws} AND lower(btrim(k."sellerSku")) = ${lower}
          AND (cl.id IS NULL OR EXISTS (SELECT 1 FROM "Product" kp WHERE kp.id = cl."productId" AND kp."deletedAt" IS NULL))`,
    },
    ...(aliasSku ? [{
      kind: 'sku' as const, matchedAs: 'extra listing SKU',
      sql: sql`SELECT p.id AS product_id, NULL::text AS listing_id, a.channel, a.marketplace AS market, a."channelConnectionId" AS account_id,
          a.sku AS value
        FROM "ProductListingAlias" a JOIN "Product" p ON p.id = a."productId"
        WHERE a."workspaceId" = ${ws} AND ${liveProduct} AND lower(btrim(a.sku)) = ${lower}`,
    }] : []),
    {
      kind: 'asin', matchedAs: 'ASIN',
      sql: sql`SELECT ${LISTING_COLUMNS}, cl."externalListingId" AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'AMAZON' AND upper(btrim(cl."externalListingId")) = ${upper}`,
    },
    {
      kind: 'asin', matchedAs: 'parent ASIN',
      sql: sql`SELECT ${LISTING_COLUMNS}, cl."externalParentId" AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'AMAZON' AND upper(btrim(cl."externalParentId")) = ${upper}`,
    },
    {
      kind: 'asin', matchedAs: 'old product column amazonAsin / parentAsin',
      sql: sql`SELECT ${PRODUCT_COLUMNS}, COALESCE(p."amazonAsin", p."parentAsin") AS value FROM "Product" p
        WHERE ${liveProduct} AND (upper(btrim(p."amazonAsin")) = ${upper} OR upper(btrim(p."parentAsin")) = ${upper})`,
    },
    {
      kind: 'ebay-item-id', matchedAs: 'eBay Item ID',
      sql: sql`SELECT ${LISTING_COLUMNS}, cl."externalListingId" AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'EBAY' AND btrim(cl."externalListingId") = ${q}`,
    },
    {
      kind: 'ebay-item-id', matchedAs: 'shared eBay listing (its variation rows)',
      sql: sql`SELECT DISTINCT r.id AS product_id, NULL::text AS listing_id, 'EBAY'::text AS channel, m.marketplace AS market,
          m."channelConnectionId" AS account_id, m."itemId" || ' (parent SKU ' || m."parentSku" || ')' AS value
        FROM "SharedListingMembership" m
        LEFT JOIN "Product" r ON r."workspaceId" = ${ws} AND r.sku = m."parentSku" AND r."deletedAt" IS NULL
        WHERE m."workspaceId" = ${ws} AND m."itemId" = ${q}`,
    },
    {
      kind: 'ebay-item-id', matchedAs: 'eBay listing index',
      sql: ebayIndexItemMatchSql(ws, q),
    },
    {
      kind: 'ebay-item-id', matchedAs: 'old product column ebayItemId',
      sql: sql`SELECT ${PRODUCT_COLUMNS}, p."ebayItemId" AS value FROM "Product" p WHERE ${liveProduct} AND btrim(p."ebayItemId") = ${q}`,
    },
    {
      kind: 'shopify-id', matchedAs: 'Shopify product',
      sql: sql`SELECT ${LISTING_COLUMNS}, ${shopify}::text AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'SHOPIFY'
          AND (${shopifyIdSql(sql`cl."externalListingId"`)} = ${shopify} OR ${shopifyIdSql(sql`cl."platformAttributes"->>'shopifyProductId'`)} = ${shopify})`,
    },
    {
      kind: 'shopify-id', matchedAs: 'Shopify variant',
      sql: sql`SELECT ${LISTING_COLUMNS}, ${shopify}::text AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'SHOPIFY' AND ${shopifyIdSql(sql`cl."platformAttributes"->>'variantId'`)} = ${shopify}`,
    },
    {
      kind: 'shopify-id', matchedAs: 'Shopify inventory item',
      sql: sql`SELECT ${LISTING_COLUMNS}, ${shopify}::text AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'SHOPIFY' AND ${shopifyIdSql(sql`cl."platformAttributes"->>'inventoryItemId'`)} = ${shopify}`,
    },
    {
      kind: 'shopify-id', matchedAs: 'Shopify colour product',
      sql: sql`SELECT p.id AS product_id, NULL::text AS listing_id, 'SHOPIFY'::text AS channel, c.marketplace AS market,
          c."channelConnectionId" AS account_id, COALESCE(c."colourName", c."valueKey") AS value
        FROM "ShopifyColourProduct" c JOIN "Product" p ON p.id = c."familyId"
        WHERE c."workspaceId" = ${ws} AND ${liveProduct} AND ${shopifyIdSql(sql`c."shopifyProductId"`)} = ${shopify}`,
    },
    {
      kind: 'shopify-id', matchedAs: 'old product column shopifyProductId',
      sql: sql`SELECT ${PRODUCT_COLUMNS}, p."shopifyProductId" AS value FROM "Product" p
        WHERE ${liveProduct} AND ${shopifyIdSql(sql`p."shopifyProductId"`)} = ${shopify}`,
    },
    {
      kind: 'etsy-listing-id', matchedAs: 'Etsy listing id',
      sql: sql`SELECT ${LISTING_COLUMNS}, cl."externalListingId" AS value FROM ${LIVE_LISTING}
        WHERE cl."workspaceId" = ${ws} AND cl.channel = 'ETSY' AND btrim(cl."externalListingId") = ${q}`,
    },
    ...(barcode ? [{
      kind: 'gtin' as const, matchedAs: 'GTIN / EAN / UPC',
      sql: sql`SELECT ${PRODUCT_COLUMNS}, f.field || ' ' || f.raw AS value
        FROM "Product" p CROSS JOIN LATERAL (VALUES ('gtin', p.gtin), ('ean', p.ean), ('upc', p.upc)) AS f(field, raw)
        WHERE ${liveProduct} AND ${barcodeSql(sql`f.raw`)} = ${barcode}`,
    }] : []),
  ]
  return list
}

interface MatchRow {
  ord: number
  matched_as: string
  kind: string
  product_id: string | null
  listing_id: string | null
  channel: string | null
  market: string | null
  account_id: string | null
  value: string | null
}

export interface FoundId {
  kind: FindKind
  matchedAs: string
  value?: string
  productId?: string
  sku?: string
  family?: { rootProductId: string; rootSku: string }
  listingId?: string
  channel?: string
  market?: string
  accountId?: string
}

/** The seller-owned channels an id of this kind can be on (an ASIN or a GTIN is a catalogue id, legal in several businesses). */
const SELLER_CHANNELS: Partial<Record<FindKind, string[]>> = { 'ebay-item-id': ['EBAY'], 'shopify-id': ['SHOPIFY'], 'etsy-listing-id': ['ETSY'] }

export interface HeldElsewhere {
  channel: string
  /** The other business's name when the person asking is a member of it, else "another business". */
  heldBy: string
  listings: number
}

/**
 * I5 — does another business also hold this id (a seller-owned one this business holds itself)? Asked of
 * nexus_identity_foreign_ids, which answers only the caller's own ids and names a business only to its members.
 */
async function heldElsewhere(query: string, kind?: FindKind): Promise<HeldElsewhere[]> {
  const channels = kind ? SELLER_CHANNELS[kind] ?? [] : ['EBAY', 'SHOPIFY', 'ETSY']
  if (channels.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ channel: string; holder: string; listing_count: number }>>`
    SELECT c.channel, x.holder, x.listing_count
    FROM unnest(${channels}::text[]) AS c(channel)
    CROSS JOIN LATERAL nexus_identity_foreign_ids(c.channel, ARRAY[${query.trim()}]::text[]) x
    ORDER BY c.channel, x.holder`
  return rows.map((row) => ({ channel: row.channel, heldBy: row.holder, listings: Number(row.listing_count) }))
}

/** Where an id is used in this business: every place, by kind, bounded; and whether another business holds it too. */
export async function findById(query: string, kind?: FindKind): Promise<{ matches: FoundId[]; more: number; families: Array<{ rootProductId: string; rootSku: string; matches: number }>; elsewhere: HeldElsewhere[] }> {
  const ws = workspaceIdForQuery()
  const present = await availableRequirements()
  const chosen = branches(query, ws, present.has('listing-alias-sku')).filter((b) => !kind || b.kind === kind)
  if (chosen.length === 0) return { matches: [], more: 0, families: [], elsewhere: [] }
  const union = Prisma.join(chosen.map((b, i) => sql`
    SELECT ${i}::int AS ord, ${b.matchedAs}::text AS matched_as, ${b.kind}::text AS kind, u.product_id, u.listing_id, u.channel, u.market,
      u.account_id, u.value FROM (${b.sql}) u`), ' UNION ALL ')
  const rows = await prisma.$queryRaw<MatchRow[]>`
    SELECT * FROM (${union}) m ORDER BY m.ord, m.product_id, m.listing_id, m.value LIMIT ${MATCH_CAP + 1}`
  const shown = rows.slice(0, MATCH_CAP)
  let more = 0
  if (rows.length > MATCH_CAP) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM (${union}) m`
    more = Number(n) - MATCH_CAP
  }

  // Each matched product's SKU and family (live products only: a deleted one is never a result).
  const productIds = [...new Set(shown.map((r) => r.product_id).filter((id): id is string => Boolean(id)))]
  const products = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true, sku: true, parentId: true } })
    : []
  const parentIds = [...new Set(products.map((p) => p.parentId).filter((id): id is string => Boolean(id)))]
  const parents = parentIds.length
    ? await prisma.product.findMany({ where: { id: { in: parentIds }, deletedAt: null }, select: { id: true, sku: true } })
    : []
  const productById = new Map(products.map((p) => [p.id, p]))
  const parentById = new Map(parents.map((p) => [p.id, p]))
  const familyOf = (id: string) => {
    const p = productById.get(id)
    if (!p) return null
    const parent = p.parentId && p.parentId !== p.id ? parentById.get(p.parentId) : undefined
    return parent ? { rootProductId: parent.id, rootSku: parent.sku } : { rootProductId: p.id, rootSku: p.sku }
  }

  const matches = shown.map((r) => {
    const product = r.product_id ? productById.get(r.product_id) : undefined
    return compact({
      kind: r.kind as FindKind,
      matchedAs: r.matched_as,
      value: r.value,
      productId: product?.id ?? null,
      sku: product?.sku ?? null,
      family: product ? familyOf(product.id) : null,
      listingId: r.listing_id,
      channel: r.channel,
      market: r.market,
      accountId: r.account_id,
    }) as FoundId
  })
  const families = new Map<string, { rootProductId: string; rootSku: string; matches: number }>()
  for (const m of matches) {
    if (!m.family) continue
    const entry = families.get(m.family.rootProductId) ?? { ...m.family, matches: 0 }
    entry.matches++
    families.set(m.family.rootProductId, entry)
  }
  const elsewhere = matches.some((m) => SELLER_CHANNELS[m.kind]) ? await heldElsewhere(query, kind) : []
  return { matches, more, families: [...families.values()], elsewhere }
}
