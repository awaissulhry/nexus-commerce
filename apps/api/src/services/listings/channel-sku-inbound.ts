/**
 * Inbound channel SKU (plan docs/sheet-ids-sku-rows/PLAN.md, step S6): the ONE way an order or a return that names a
 * marketplace SKU finds its product. Every order writer (Amazon, eBay, Shopify, Etsy) and both return ingests call it.
 *
 * Order of the steps:
 *   1. `productForChannelSku` on the connected account the line came from: the SKU the channel confirmed
 *      (`liveChannelSku`), the SKU Nexus sends (`channelSku`), the old stores. With a market, that market's listings
 *      first; a SKU no listing of that market holds is then looked for on the account's other markets (one Amazon EU
 *      seller SKU can sell in several markets). A SKU renamed in Nexus that the channel still holds is matched here.
 *   2. The writer's own ACCOUNT stores (`accountStores`, e.g. eBay variant listings): what this channel account holds
 *      in a store the resolver does not read. Tried before the master SKU, as each writer did before.
 *   3. The master SKU (`Product.sku`) of this business, read exactly as the writers read it before: a product in the
 *      trash matches too. Without a connected account (an order with no account link) only this step runs.
 *   4. The writer's own FALLBACKS (`fallbacks`, e.g. Amazon ASIN, eBay variation SKU, Shopify variant id), in order.
 *
 * The first step that names products decides. Two or more products → not linked, with one plain sentence naming their
 * SKUs (`problem`); the writer takes its own "unlinked" path. Nexus never picks one. Another business is never read
 * (row-level security; the resolver also filters by business), and another account's listings never match.
 *
 * Every read goes through the caller's client (`db`): a writer inside a transaction passes its `tx`.
 */
import type { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import { workspaceKey } from '@nexus/database/workspace-context'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { productForChannelSku, type ChannelSkuMatch, type ChannelSkuProductMatch } from './channel-sku.js'
import type { ChannelSkuSource } from './channel-sku.pure.js'

type Db = Prisma.TransactionClient

/** One store a writer reads itself: the products it names for this line ([] = none). */
export interface InboundSkuStore {
  /** Names the store in `via` (logs, tests): 'asin', 'ebayVariantListing', 'variationSku', 'shopifyVariant', … */
  name: string
  /** What the line is called in the sentence when this store names several products, e.g. "ASIN B0…". Default: the SKU. */
  label?: string
  find: () => Promise<string[]>
}

/** Where the match came from: a resolver step, or the name of a writer's own store. */
export type InboundSkuVia = ChannelSkuSource | string

/** Two or more products: not linked, and why, in one plain sentence. */
export interface InboundSkuProblem {
  code: 'AMBIGUOUS'
  productIds: string[]
  productSkus: string[]
  sentence: string
}

export type InboundSkuMatch =
  | { productId: string; listingId: string | null; via: InboundSkuVia; problem?: undefined }
  | { productId: null; listingId: null; via: InboundSkuVia; problem: InboundSkuProblem }
  | { productId: null; listingId: null; via: null; problem?: undefined }

const NO_MATCH: InboundSkuMatch = { productId: null, listingId: null, via: null }

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

/** The account's listings: the order's market first; a SKU none of its listings holds, then the account's other markets. */
async function onAccount(db: Db, input: { channel: string; connectionId: string; marketplace: string | null; sku: string }): Promise<ChannelSkuMatch | null> {
  const inMarket = await productForChannelSku(db, { channel: input.channel, channelConnectionId: input.connectionId, marketplace: input.marketplace, sku: input.sku })
  if (!input.marketplace) return inMarket
  // Settled in the market: a listing step matched (or is ambiguous), or the product's own listing there sends its master SKU.
  if (inMarket && (inMarket.ambiguous === true || inMarket.via !== 'product' || (inMarket as ChannelSkuProductMatch).listingId)) return inMarket
  const anyMarket = await productForChannelSku(db, { channel: input.channel, channelConnectionId: input.connectionId, sku: input.sku })
  if (anyMarket && (anyMarket.ambiguous || anyMarket.via !== 'product')) return anyMarket
  return inMarket
}

async function ambiguous(db: Db, channel: string, label: string, productIds: string[], via: InboundSkuVia): Promise<InboundSkuMatch> {
  const ids = [...new Set(productIds)].sort()
  const rows = await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } })
  const skus = ids.map(id => rows.find(row => row.id === id)?.sku ?? id)
  const where = channelLabel(channel) || 'channel'
  return {
    productId: null, listingId: null, via,
    problem: {
      code: 'AMBIGUOUS', productIds: ids, productSkus: skus,
      sentence: `The ${where} ${label} matches more than one product (${skus.join(', ')}). Nexus did not pick one, so this line is not linked to a product. Give each product its own SKU on this ${where} account.`,
    },
  }
}

async function fromStore(db: Db, channel: string, defaultLabel: string, store: InboundSkuStore): Promise<InboundSkuMatch | null> {
  const ids = [...new Set((await store.find()).filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (!ids.length) return null
  if (ids.length > 1) return ambiguous(db, channel, store.label ?? defaultLabel, ids, store.name)
  return { productId: ids[0], listingId: null, via: store.name }
}

/** Which product an order or return line names (see the file header for the steps). Never throws for "no match". */
export async function matchInboundSku(db: Db, input: {
  channel: string
  /** The connected account the line came from; null/absent = unknown (only the master SKU and the fallbacks run). */
  channelConnectionId?: string | null
  /** The order's market as listings store it ('IT', 'DE', …); absent = every market of the account. */
  marketplace?: string | null
  /** The marketplace's own SKU text for the line. */
  sku?: string | null
  /** The writer's own stores of this account, before the master SKU. */
  accountStores?: InboundSkuStore[]
  /** The writer's own fallbacks, after the master SKU, in order. */
  fallbacks?: InboundSkuStore[]
}): Promise<InboundSkuMatch> {
  const channel = String(input.channel ?? '').trim().toUpperCase()
  const sku = text(input.sku)
  const connectionId = text(input.channelConnectionId)
  const label = sku ? `SKU ${sku}` : 'line'
  let master: InboundSkuMatch | null = null

  if (sku && connectionId) {
    const found = await onAccount(db, { channel, connectionId, marketplace: text(input.marketplace), sku })
    if (found?.ambiguous === true) return ambiguous(db, channel, label, found.productIds, found.via)
    const one = found as ChannelSkuProductMatch | null
    if (one && one.via !== 'product') return { productId: one.productId, listingId: one.listingId, via: one.via }
    if (one) master = { productId: one.productId, listingId: one.listingId, via: 'product' }
  }
  if (sku && !master) {
    // The master SKU exactly as every writer read it before S6: this business's product with this SKU, IN THE TRASH
    // TOO (the resolver's own last step leaves trashed products out). Parity: an order for a trashed product's SKU
    // links to it and takes its stock, as it always did.
    const product = await db.product.findUnique({ where: { workspace_sku: workspaceKey({ sku }) }, select: { id: true } })
    if (product) master = { productId: product.id, listingId: null, via: 'product' }
  }

  for (const store of input.accountStores ?? []) {
    const found = await fromStore(db, channel, label, store)
    if (found) return found
  }
  if (master) return master
  for (const store of input.fallbacks ?? []) {
    const found = await fromStore(db, channel, label, store)
    if (found) return found
  }
  return NO_MATCH
}

/**
 * A writer's store for Shopify: the order line's variant id, matched to the listing on THIS store that records that
 * variant (`platformAttributes.variantId`, written when Nexus publishes or links the variant). Nothing without a
 * known store or a numeric variant id. Products in the trash are left out.
 */
export function shopifyVariantListingStore(db: Db, channelConnectionId: string | null | undefined, variantId: unknown): InboundSkuStore {
  const id = typeof variantId === 'number' || typeof variantId === 'string' ? String(variantId).split('/').at(-1)!.trim() : ''
  return {
    name: 'shopifyVariant',
    label: `variant ${id}`,
    find: async () => {
      const connectionId = text(channelConnectionId)
      if (!connectionId || !/^\d+$/.test(id)) return []
      const rows = await db.$queryRaw<Array<{ productId: string }>>`
        SELECT DISTINCT cl."productId" FROM "ChannelListing" cl
        JOIN "Product" p ON p.id = cl."productId" AND p."deletedAt" IS NULL
        WHERE cl."workspaceId" = ${workspaceIdForQuery()} AND cl."channelConnectionId" = ${connectionId} AND cl.channel = 'SHOPIFY'
          AND cl."platformAttributes" ->> 'variantId' IN (${id}, ${`gid://shopify/ProductVariant/${id}`})`
      return rows.map(row => row.productId)
    },
  }
}
