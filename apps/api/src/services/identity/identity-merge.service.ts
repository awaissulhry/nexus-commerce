/**
 * MCP full control I11 — duplicate products (section 04 §2 #10): adopt an old eBay listing shell as an extra listing of
 * the real product, or merge a duplicate into the product it duplicates — SAFE cases only.
 *
 * Shell adoption (moved here from apps/api/scripts/pes5-adopt-shells.mts, which now calls adoptShellListing): an
 * EBAY_LISTING_SHELL is a placeholder product holding one eBay listing of another product. Adopting it, in one
 * transaction: an extra listing (ProductListingAlias) on the real product's family parent with adoptedFromProductId =
 * the shell; the shell's listing moved onto it (aliasId AND aliasKey, which travel together); the shell soft-deleted.
 * Nothing is sent to eBay. (The script set aliasId but left aliasKey empty, so the moved row stayed the primary
 * listing of its coordinate; the service writes both.)
 *
 * Merge: the duplicate is soft-deleted and its SKU (and its SKU aliases) become SKU aliases of the product kept, so a
 * stock file that names the old SKU finds the product kept. 0(a): a trashed duplicate (or shell) is made unreachable in
 * the same transaction — its SKU becomes a tombstone and its barcodes and old channel ids are cleared — because order
 * ingest and stock imports find products by those and do not skip deleted ones. Only when the duplicate holds nothing that could be
 * lost: no stock, no FBA units, no order lines, no listing, no shared-stock or catalogue link to another business, no
 * ad, no variations, no extra listing, no shared eBay variation row. Anything else is refused, naming what blocks it.
 *
 * Every check runs again inside the writing transaction after the duplicate's row is locked FOR UPDATE: a stock writer
 * (lockProductStock, FOR NO KEY UPDATE) or an order line referencing it (FOR KEY SHARE) that got there first is waited
 * for and then seen, and refuses the merge.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { liveProductAdCount } from '../advertising/product-ad-links.service.js'
import { tombstoneSku } from './tombstone-sku.js'

export { tombstoneSku }

export class IdentityMergeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityMergeRefusal'
  }
}

type Db = Prisma.TransactionClient

export const SHELL_PRODUCT_TYPE = 'EBAY_LISTING_SHELL'

const PRODUCT_SELECT = { id: true, sku: true, parentId: true, isParent: true, productType: true, deletedAt: true } as const
type ProductRow = { id: string; sku: string; parentId: string | null; isParent: boolean; productType: string | null; deletedAt: Date | null }

async function liveProductRow(db: Db, id: string): Promise<ProductRow | null> {
  const row = await db.product.findFirst({ where: { id, deletedAt: null }, select: PRODUCT_SELECT })
  return row
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/** What on a product could be lost by deleting it, in words; empty when nothing. */
export async function mergeBlockers(db: Db, product: { id: string; sku: string }, allow: { oneListing?: boolean } = {}): Promise<string[]> {
  const [row] = await db.$queryRaw<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*) FROM "StockLevel" s WHERE s."productId" = ${product.id} AND (s.quantity <> 0 OR s.reserved <> 0))::int AS stock,
      (SELECT count(*) FROM "FbaInventoryDetail" f WHERE (f."productId" = ${product.id} OR f.sku = ${product.sku}) AND f.quantity > 0)::int AS fba,
      (SELECT count(*) FROM "OrderItem" o WHERE o."productId" = ${product.id} OR (o."productId" IS NULL AND o.sku = ${product.sku}))::int AS orders,
      (SELECT count(*) FROM "ChannelListing" l WHERE l."productId" = ${product.id})::int AS listings,
      (SELECT count(*) FROM "StockPoolLink" k WHERE (k."productId" = ${product.id} OR k."sourceProductId" = ${product.id}) AND k.status = 'active')::int AS pool,
      (SELECT count(*) FROM "CatalogLink" c WHERE (c."sourceProductId" = ${product.id} OR c."targetProductId" = ${product.id}) AND c.status = 'active')::int AS shared,
      (SELECT count(*) FROM "Product" ch WHERE ch."parentId" = ${product.id} AND ch.id <> ${product.id} AND ch."deletedAt" IS NULL)::int AS children,
      (SELECT count(*) FROM "ProductListingAlias" a WHERE a."productId" = ${product.id})::int AS aliases,
      (SELECT count(*) FROM "SharedListingMembership" m WHERE m."productId" = ${product.id})::int AS memberships,
      (SELECT count(*) FROM "ProductVariation" v WHERE v."productId" = ${product.id})::int AS variations`
  const ads = await liveProductAdCount(product, db as never)
  const blockers: string[] = []
  if (row.stock) blockers.push(`it has stock (${plural(row.stock, 'stock row')} not at 0)`)
  if (row.fba) blockers.push('it has FBA units at Amazon')
  if (row.orders) blockers.push(`${plural(row.orders, 'order line')} name it`)
  if (row.listings > (allow.oneListing ? 1 : 0)) blockers.push(`it has ${plural(row.listings, 'channel listing')} (end or adopt them first)`)
  if (row.pool) blockers.push('it is linked to shared stock')
  if (row.shared) blockers.push('it is linked to a product of another business (catalogue sharing)')
  if (ads) blockers.push(`${plural(ads, 'ad')} name it`)
  if (row.children) blockers.push(`it is the parent of ${plural(row.children, 'variation')}`)
  if (row.aliases) blockers.push('it has extra listings')
  if (row.memberships) blockers.push('a shared eBay listing sells it as a variation')
  if (row.variations) blockers.push('it has old variation rows (ProductVariation) an order can still be matched by')
  return blockers
}

// ── Plans ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ShellAdoptionPlan {
  mode: 'adopt-shell'
  shell: { id: string; sku: string }
  keeper: { id: string; sku: string }
  listing: { id: string; channel: string; marketplace: string; channelConnectionId: string | null; externalListingId: string | null; listingStatus: string }
}

export interface SafeMergePlan {
  mode: 'merge'
  duplicate: { id: string; sku: string }
  keeper: { id: string; sku: string }
  /** The duplicate's SKU aliases, moved to the product kept. */
  skuAliases: string[]
  /** The SKU alias the duplicate's own SKU becomes, or null when the kept SKU already matches it. */
  newSkuAlias: string | null
}

export type MergePlan = ShellAdoptionPlan | SafeMergePlan

/** What merging `duplicateId` into `keeperId` would do, or why it is refused. Reads only. */
export async function planMerge(db: Db, duplicateId: string, keeperId: string): Promise<MergePlan> {
  if (duplicateId === keeperId) throw new IdentityMergeRefusal('A product cannot be merged into itself.')
  const duplicate = await liveProductRow(db, duplicateId)
  const keeper = await liveProductRow(db, keeperId)
  if (!duplicate || !keeper) throw new IdentityMergeRefusal('Product not found')
  if (keeper.productType === SHELL_PRODUCT_TYPE) throw new IdentityMergeRefusal(`${keeper.sku} is an old eBay listing shell: keep the real product, not the shell.`)

  if (duplicate.productType === SHELL_PRODUCT_TYPE) {
    // An extra listing always belongs to the family's parent.
    if (keeper.parentId && keeper.parentId !== keeper.id) {
      throw new IdentityMergeRefusal(`${keeper.sku} is a variation: name its family's parent product as the one to keep.`)
    }
    const adopted = await db.productListingAlias.findFirst({ where: { adoptedFromProductId: duplicate.id }, select: { id: true } })
    if (adopted) throw new IdentityMergeRefusal(`${duplicate.sku} was already adopted as an extra listing.`)
    const listings = await db.channelListing.findMany({
      where: { productId: duplicate.id },
      select: { id: true, channel: true, marketplace: true, channelConnectionId: true, externalListingId: true, listingStatus: true },
    })
    if (listings.length !== 1) throw new IdentityMergeRefusal(`${duplicate.sku} holds ${plural(listings.length, 'listing')}; a shell is adopted when it holds exactly one.`)
    const blockers = await mergeBlockers(db, duplicate, { oneListing: true })
    if (blockers.length) throw new IdentityMergeRefusal(`${duplicate.sku} cannot be adopted: ${blockers.join('; ')}.`)
    return { mode: 'adopt-shell', shell: { id: duplicate.id, sku: duplicate.sku }, keeper: { id: keeper.id, sku: keeper.sku }, listing: listings[0] }
  }

  const blockers = await mergeBlockers(db, duplicate)
  if (blockers.length) throw new IdentityMergeRefusal(`${duplicate.sku} is not a safe duplicate to merge: ${blockers.join('; ')}. Nothing of it is moved by a merge.`)
  const skuAliases = (await db.skuAlias.findMany({ where: { productId: duplicate.id }, select: { raw: true }, orderBy: { raw: 'asc' } })).map((a) => a.raw)
  const key = duplicate.sku.trim().toLowerCase()
  let newSkuAlias: string | null = key === keeper.sku.trim().toLowerCase() ? null : duplicate.sku
  if (newSkuAlias) {
    const taken = await db.skuAlias.findFirst({ where: { alias: key }, select: { productId: true } })
    if (taken && taken.productId !== duplicate.id && taken.productId !== keeper.id) {
      throw new IdentityMergeRefusal(`The SKU alias "${duplicate.sku}" already names another product.`)
    }
    if (taken && taken.productId === keeper.id) newSkuAlias = null
  }
  return { mode: 'merge', duplicate: { id: duplicate.id, sku: duplicate.sku }, keeper: { id: keeper.id, sku: keeper.sku }, skuAliases, newSkuAlias }
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────

/** The identifiers a trashed duplicate gives up, as they were (for a person restoring it). */
export interface ReleasedIdentity {
  sku: string
  gtin: string | null
  ean: string | null
  upc: string | null
  fnsku: string | null
  amazonAsin: string | null
  parentAsin: string | null
  ebayItemId: string | null
  shopifyProductId: string | null
}

/**
 * 0(a) — trash a duplicate so that nothing finds it any more. Order ingest links a line by exact SKU (eBay, Amazon) or by
 * the old amazonAsin column, and a stock import by SKU, barcode, FNSKU or ASIN — none of them skip a deleted product.
 * So, in the same transaction, its SKU becomes a tombstone and its barcodes and old channel ids are cleared; its SKU
 * (made a SKU alias of the product kept by the caller) then leads a stock import to the product kept, and an order line
 * naming it is recorded without a product rather than on the trashed row.
 */
async function trashAndRelease(tx: Db, productId: string): Promise<ReleasedIdentity> {
  const row = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { sku: true, gtin: true, ean: true, upc: true, fnsku: true, amazonAsin: true, parentAsin: true, ebayItemId: true, shopifyProductId: true },
  })
  await tx.product.update({
    where: { id: productId },
    data: {
      sku: tombstoneSku(row.sku, productId), gtin: null, ean: null, upc: null, fnsku: null, amazonAsin: null, parentAsin: null,
      ebayItemId: null, shopifyProductId: null, deletedAt: new Date(), version: { increment: 1 },
    },
  })
  return row
}

/** Its SKU names the product kept from now on (a SKU alias), unless the kept SKU already matches it or it is taken. */
async function keepSkuAsAlias(tx: Db, keeper: { id: string; sku: string }, sku: string): Promise<string | null> {
  const key = sku.trim().toLowerCase()
  if (!key || key === keeper.sku.trim().toLowerCase()) return null
  const taken = await tx.skuAlias.findFirst({ where: { alias: key }, select: { id: true } })
  if (taken) return null
  return (await tx.skuAlias.create({ data: { productId: keeper.id, alias: key, raw: sku, source: 'MERGE' } })).id
}

/** One shell adoption, inside the caller's transaction (the old script calls this too). */
export async function adoptShellListing(tx: Db, input: {
  shellId: string
  shellSku: string
  masterId: string
  listing: { id: string; channel: string; marketplace: string; channelConnectionId: string | null }
  createdBy: string
}): Promise<{ aliasId: string; released: ReleasedIdentity; skuAliasId: string | null }> {
  const highest = await tx.productListingAlias.findFirst({
    where: { productId: input.masterId, channel: input.listing.channel, marketplace: input.listing.marketplace },
    orderBy: { position: 'desc' },
    select: { position: true },
  })
  const alias = await tx.productListingAlias.create({
    data: {
      productId: input.masterId,
      channel: input.listing.channel,
      marketplace: input.listing.marketplace,
      channelConnectionId: input.listing.channelConnectionId,
      label: input.shellSku,
      position: (highest?.position ?? 0) + 1,
      adoptedFromProductId: input.shellId,
      createdBy: input.createdBy,
    },
  })
  await tx.channelListing.update({
    where: { id: input.listing.id },
    data: { productId: input.masterId, aliasId: alias.id, aliasKey: alias.id, version: { increment: 1 } },
  })
  // SOFT delete: the shell stays recoverable and the adoption reversible — but unreachable by its old SKU and ids (0(a)).
  const released = await trashAndRelease(tx, input.shellId)
  const master = await tx.product.findUniqueOrThrow({ where: { id: input.masterId }, select: { id: true, sku: true } })
  const skuAliasId = await keepSkuAsAlias(tx, master, released.sku)
  return { aliasId: alias.id, released, skuAliasId }
}

export interface MergeOutcome {
  mode: 'adopt-shell' | 'merge'
  duplicate: { id: string; sku: string }
  keeper: { id: string; sku: string }
  aliasId?: string
  movedListingId?: string
  skuAliasesMoved?: string[]
  newSkuAliasId?: string | null
  /** What the trashed duplicate gave up (its SKU is now a tombstone; its barcodes and old channel ids are cleared). */
  released?: ReleasedIdentity
}

/**
 * Run a merge or an adoption: the duplicate's row is locked FOR UPDATE first (it waits for a stock writer or an order
 * line that got there first), then the plan is worked out again and must equal the one approved; then it writes.
 */
export async function runMerge(duplicateId: string, keeperId: string, options: { approved?: MergePlan; actor?: string | null } = {}): Promise<MergeOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ANY(${[duplicateId, keeperId]}::text[]) ORDER BY id COLLATE "C" FOR UPDATE`
    const plan = await planMerge(tx, duplicateId, keeperId)
    if (options.approved && JSON.stringify(plan) !== JSON.stringify(options.approved)) {
      throw new IdentityMergeRefusal('The products changed after this was approved. Ask again to see what it would do now.')
    }
    const createdBy = `agent:merge-duplicate-products${options.actor ? `:${options.actor}` : ''}`
    if (plan.mode === 'adopt-shell') {
      const { aliasId, released, skuAliasId } = await adoptShellListing(tx, {
        shellId: plan.shell.id, shellSku: plan.shell.sku, masterId: plan.keeper.id, listing: plan.listing, createdBy,
      })
      return { mode: plan.mode, duplicate: plan.shell, keeper: plan.keeper, aliasId, movedListingId: plan.listing.id, released, newSkuAliasId: skuAliasId }
    }
    const moved = await tx.skuAlias.findMany({ where: { productId: plan.duplicate.id }, select: { id: true } })
    if (moved.length) await tx.skuAlias.updateMany({ where: { productId: plan.duplicate.id }, data: { productId: plan.keeper.id } })
    const released = await trashAndRelease(tx, plan.duplicate.id)
    const newSkuAliasId = plan.newSkuAlias ? await keepSkuAsAlias(tx, plan.keeper, plan.newSkuAlias) : null
    return { mode: plan.mode, duplicate: plan.duplicate, keeper: plan.keeper, skuAliasesMoved: moved.map((m) => m.id), newSkuAliasId, released }
  }, { timeout: 30_000 }).then(async (outcome) => {
    // A stock import resolves SKUs from a short-lived per-business index; the trashed SKU must not linger there.
    try {
      const { invalidateResolutionIndex } = await import('../stock-import.service.js')
      invalidateResolutionIndex()
    } catch {
      // Best-effort: the index expires on its own within its TTL.
    }
    return outcome
  })
}

/** For a tool's preview: the plan, read in a read-only pass. */
export async function previewMerge(duplicateId: string, keeperId: string): Promise<MergePlan> {
  return planMerge(prisma as unknown as Db, duplicateId, keeperId)
}
