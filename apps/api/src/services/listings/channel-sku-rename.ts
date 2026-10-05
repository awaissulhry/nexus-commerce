/**
 * S9 — a SHARED SKU rename (Product.sku OLD → NEW) keeps every channel in step (plan docs/sheet-ids-sku-rows/PLAN.md,
 * B2-per-channel-sku.md). It replaces the old refusal ("Can't change the SKU while this product is live").
 *
 * The Owner's rule (2026-10-05): the Shared scope edits `Product.sku`; a channel listing keeps what its channel holds.
 * So, in the same transaction as the rename, each listing of the product:
 *   - the channel HOLDS it (not a still-draft, the resolver's live rule): it keeps the SKU it sends today (OLD, or its
 *     own) — `channelSku` is written when it had none, and `liveChannelSku` when nothing confirmed one yet. Nothing on
 *     any channel desyncs: stock, price, orders and Delete keep naming OLD there;
 *   - a STILL-DRAFT that sends OLD today (it follows the product SKU, or an old store / its own SKU equals OLD): it
 *     follows NEW, so the next Publish lists NEW — the Owner's flow "Delete → change SKU → Publish lists NEW";
 *   - its own SKU (not OLD), or no single SKU on record: untouched.
 * The checks: NEW may not be another product's SKU (case ignored), nor a channel SKU another product's listing holds or
 * wants in this business (S2's rule, the other direction), nor clash with another rename of the same save (the same NEW
 * twice, or a SKU another renamed product's listings keep). The shared-stock guard of the database still refuses the
 * rename of a connected product; `skuRenameRefusal` turns its error into one plain sentence.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { workspaceContext, workspaceIdForQuery } from '../../lib/workspace-context.js'
import { stockPoolConnectedRefusal } from '../../lib/stock-pool-refusal.js'
import { availableRequirements } from '../identity/identity-audit.service.js'
import { CHANNEL_SKU_LISTING_SELECT, listingHoldsChannelSku, listingsThatMayHoldSkus, type ChannelSkuListingRow } from './channel-sku.js'
import { liveChannelSku, wantedChannelSku, type ChannelSkuListing } from './channel-sku.pure.js'
import { listingPlace } from './channel-sku-live-move.js'

type Db = Prisma.TransactionClient

export interface SkuRename { productId: string; from: string; to: string }

/**
 * What the rename does to one listing: `keeps` (the channel holds it; it keeps the SKU it sends), `follows` (a
 * still-draft that sent OLD; it follows NEW), `own` (a still-draft with a SKU of its own), `unclear` (no single SKU).
 */
export type SkuRenameOutcome = 'keeps' | 'follows' | 'own' | 'unclear'

export interface SkuRenameListing {
  listingId: string
  channel: string
  marketplace: string
  aliasKey: string
  version: number
  outcome: SkuRenameOutcome
  /** The SKU this listing sends after the rename; null when it has no single SKU. */
  sku: string | null
  previousChannelSku: string | null
  /** The columns the rename writes on this listing; empty = nothing to write. */
  write: { channelSku?: string; liveChannelSku?: string }
}

export interface SkuRenamePlan extends SkuRename {
  listings: SkuRenameListing[]
  /** Places where the product's variations are on Amazon or eBay with no listing of the product itself. */
  parentGaps: string[]
  /** What happens on the channels, in plain words ("Amazon · DE and eBay · IT keep OLD; drafts follow NEW."). */
  summary: string
}

/** The facts the plan reads per listing (`CHANNEL_SKU_LISTING_SELECT`). */
export type SkuRenameListingFacts = ChannelSkuListing & { id: string; marketplace: string; version: number; aliasKey: string }

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const key = (sku: string) => sku.trim().toLowerCase()

/** One listing's part of a rename OLD → NEW (pure). */
export function planListingRename(listing: SkuRenameListingFacts, from: string, to: string): SkuRenameListing {
  const base = { listingId: listing.id, channel: listing.channel, marketplace: listing.marketplace, aliasKey: listing.aliasKey ?? '',
    version: listing.version, previousChannelSku: text(listing.channelSku) }
  const before = wantedChannelSku(listing, from)
  const held = liveChannelSku(listing, from)
  if (held === null) {
    // A still-draft: never on the channel. One that sends OLD today follows NEW; its own SKU (not OLD) stays.
    if (before.sku !== from) return { ...base, outcome: before.sku === null ? 'unclear' : 'own', sku: before.sku, write: {} }
    const after = wantedChannelSku(listing, to)
    return { ...base, outcome: 'follows', sku: to, write: after.sku === to ? {} : { channelSku: to } }
  }
  // The channel holds it: it keeps sending what it sends today, and the SKU the channel holds is recorded.
  const own = text(listing.channelSku)
  const write: SkuRenameListing['write'] = {}
  if (!own && before.sku) write.channelSku = before.sku
  if (!text(listing.liveChannelSku) && held.sku) write.liveChannelSku = held.sku
  const sku = own ?? before.sku
  return { ...base, outcome: sku === null ? 'unclear' : 'keeps', sku, write }
}

const joined = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
const places = (listings: SkuRenameListing[]) => joined([...new Set(listings.map(listingPlace))])

/** The plan's sentence: which listings keep OLD, which drafts follow NEW, which keep a SKU of their own. */
export function skuRenameSummary(plan: Pick<SkuRenamePlan, 'from' | 'to' | 'listings' | 'parentGaps'>): string {
  const keepOld = plan.listings.filter(l => l.outcome === 'keeps' && l.sku === plan.from)
  const keepOwn = plan.listings.filter(l => (l.outcome === 'keeps' || l.outcome === 'own') && l.sku !== plan.from)
  const follows = plan.listings.filter(l => l.outcome === 'follows')
  const unclear = plan.listings.filter(l => l.outcome === 'unclear')
  const drafts = follows.length === 1 ? `the draft follows ${plan.to}` : `drafts follow ${plan.to}`
  const parts: string[] = []
  if (keepOld.length) {
    const kept = `${places(keepOld)} ${new Set(keepOld.map(listingPlace)).size === 1 ? 'keeps' : 'keep'} ${plan.from}`
    parts.push(follows.length ? `${kept}; ${drafts}.` : `${kept}.`)
  } else if (follows.length) parts.push(`No channel holds ${plan.from}: ${drafts}.`)
  for (const listing of keepOwn) parts.push(`${listingPlace(listing)} keeps its own SKU ${listing.sku}.`)
  if (unclear.length) parts.push(`${places(unclear)}: no single SKU on record, left as ${unclear.length === 1 ? 'it is' : 'they are'}.`)
  parts.push(...plan.parentGaps)
  return parts.join(' ')
}

/** Is the alias SKU column there? Old schemas (and a few tests) have none; then the alias store is not read. */
async function aliasSkuColumn(db: Db): Promise<boolean> {
  return (await availableRequirements(db)).has('listing-alias-sku')
}

const selectFor = (aliasSku: boolean) => (aliasSku ? CHANNEL_SKU_LISTING_SELECT
  : { ...CHANNEL_SKU_LISTING_SELECT, alias: { select: { productId: true } } }) as typeof CHANNEL_SKU_LISTING_SELECT

/**
 * The plan of each rename (pure rules over one read of the products' listings), with its sentence. A rename to the same
 * SKU plans nothing. Parent gaps: a renamed parent whose variations are on Amazon or eBay where the parent itself has no
 * listing — nothing there can keep OLD, and those channels name the parent SKU (Amazon's parent SKU, eBay's item label).
 */
export async function planSkuRenames(db: Db, renames: SkuRename[]): Promise<SkuRenamePlan[]> {
  const real = renames.filter(r => r.from !== r.to)
  if (!real.length) return []
  const ids = [...new Set(real.map(r => r.productId))]
  const rows = await db.channelListing.findMany({ where: { productId: { in: ids } }, select: selectFor(await aliasSkuColumn(db)),
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { aliasKey: 'asc' }, { id: 'asc' }] }) as ChannelSkuListingRow[]
  const children = await db.channelListing.findMany({
    where: { channel: { in: ['AMAZON', 'EBAY'] }, product: { parentId: { in: ids }, deletedAt: null } },
    select: { channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, listingStatus: true, isPublished: true, externalListingId: true, product: { select: { parentId: true } } },
  })
  const coordinate = (row: { channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string | null }) =>
    JSON.stringify([row.channel, row.marketplace, row.channelConnectionId, row.aliasKey ?? ''])
  return real.map(rename => {
    const own = rows.filter(row => row.productId === rename.productId)
    const listings = own.map(row => planListingRename(row as unknown as SkuRenameListingFacts, rename.from, rename.to))
    const mine = new Set(own.map(coordinate))
    const gaps = new Map<string, string>()
    for (const child of children) {
      if (child.product?.parentId !== rename.productId || isStillDraftListing(child) || mine.has(coordinate(child))) continue
      gaps.set(coordinate(child), `${listingPlace(child)} lists the variations of ${rename.from} with no listing of ${rename.from} itself, so nothing there keeps ${rename.from}: a Publish there names ${rename.to} as their parent.`)
    }
    const plan = { ...rename, listings, parentGaps: [...gaps.values()] }
    return { ...plan, summary: skuRenameSummary(plan) }
  })
}

/** One SKU another product's listing holds or sends as its channel SKU (`channelSkuHoldings`), with its sentence. */
export interface ChannelSkuHolding {
  /** The SKU asked about, as it was given. */
  sku: string
  productId: string
  productSku: string
  place: string
  /** "X is the SKU of P on Amazon · DE. One SKU names one product: choose another SKU." */
  sentence: string
}

/**
 * S9 — which of `skus` a listing of ANOTHER product holds or sends as its channel SKU in this business (its own SKU, the
 * SKU the channel confirmed, or an old store: offers, flat-file copy, Shopify's stored SKU, an extra listing's SKU), case
 * and surrounding spaces ignored. One answer per asked SKU that is taken, in the order asked. `exceptProductIds`: the
 * products whose own listings may hold it (a product renamed in this save). Products in the trash and other businesses
 * are never read. The rule a SHARED rename and every product create share: one SKU names one product.
 */
export async function channelSkuHoldings(db: Db, skus: ReadonlyArray<string>, options: { exceptProductIds?: ReadonlyArray<string> } = {}): Promise<ChannelSkuHolding[]> {
  const asked = [...new Set(skus.filter(sku => typeof sku === 'string' && sku.trim()).map(sku => sku.trim()))]
  if (!asked.length) return []
  // No business to read in, with business profiles on: the scoped client refuses every model read there before this one
  // (a context-free test fixture is the only caller that gets here), so there is nothing this check could read.
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1' && !workspaceContext()) return []
  const except = new Set(options.exceptProductIds ?? [])
  const aliasSku = await aliasSkuColumn(db)
  const holders = (await listingsThatMayHoldSkus(db, { skus: asked, ignoreCase: true, aliasSku })).filter(holder => !except.has(holder.productId))
  if (!holders.length) return []
  const rows = await db.channelListing.findMany({ where: { id: { in: [...new Set(holders.map(h => h.listingId))] } }, select: selectFor(aliasSku), orderBy: { id: 'asc' } }) as ChannelSkuListingRow[]
  return asked.flatMap(sku => {
    const holder = rows.find(row => listingHoldsChannelSku(row, sku))
    if (!holder) return []
    const productSku = holder.product?.sku ?? 'another product'
    const place = listingPlace(holder)
    return [{ sku, productId: holder.productId, productSku, place, sentence: `${sku} is the SKU of ${productSku} on ${place}. One SKU names one product: choose another SKU.` }]
  })
}

/**
 * S9 — a product create's check (the wizard, Claude's create-product, the sheet's New product, the catalog routes, a
 * variation generator, an import): the sentence for the first of `skus` another product's listing holds or sends as its
 * channel SKU, or null. Reads with the caller's transaction when given.
 */
export async function channelSkuCreateRefusal(skus: ReadonlyArray<string>, db: Db = prisma as unknown as Db): Promise<string | null> {
  return (await channelSkuHoldings(db, skus))[0]?.sentence ?? null
}

/** The SKUs a planned product's listings send after its rename, other than its new product SKU. */
const keptBy = (plan: SkuRenamePlan) => plan.listings.filter(l => (l.outcome === 'keeps' || l.outcome === 'own') && l.sku)

/**
 * Why each rename may not take its new SKU (one sentence per refused rename), case and surrounding spaces ignored: the
 * same NEW twice in this save; a SKU another renamed product of this save keeps on a listing; another product's SKU in
 * this business; a channel SKU another product's listing holds or wants (any account of this business). The product's
 * own listings may hold it. Other businesses are never read (row-level security and an explicit business filter).
 */
export async function skuRenameClashes(db: Db, plans: SkuRenamePlan[]): Promise<Array<{ productId: string; error: string }>> {
  const out: Array<{ productId: string; error: string }> = []
  const refused = (productId: string) => out.some(o => o.productId === productId)
  plans.forEach((plan, index) => {
    const twin = plans.slice(0, index).find(other => key(other.to) === key(plan.to))
    if (twin) {
      out.push({ productId: plan.productId, error: `${plan.to} is given to two products in this save (${twin.from} and ${plan.from}). One SKU names one product: choose another SKU for one of them.` })
      return
    }
    for (const other of plans) {
      if (other === plan) continue
      const kept = keptBy(other).find(l => key(l.sku!) === key(plan.to))
      if (kept) {
        out.push({ productId: plan.productId, error: `${plan.to} stays the SKU of ${other.to} on ${listingPlace(kept)} after its rename in this save. One SKU names one product: choose another SKU.` })
        return
      }
    }
  })
  const open = plans.filter(plan => !refused(plan.productId))
  if (!open.length) return out
  const renamed = [...new Set(plans.map(plan => plan.productId))]
  const products = await db.$queryRaw<Array<{ id: string; sku: string }>>`
    SELECT p.id, p.sku FROM "Product" p
    WHERE p."workspaceId" = ${workspaceIdForQuery()} AND p."deletedAt" IS NULL
      AND lower(btrim(p.sku)) = ANY(${open.map(plan => key(plan.to))}::text[]) AND NOT (p.id = ANY(${renamed}::text[]))
    ORDER BY p.sku`
  for (const plan of open) {
    const other = products.find(product => key(product.sku) === key(plan.to))
    if (other) out.push({ productId: plan.productId, error: `SKU "${plan.to}" is already used by another product (${other.sku}). One SKU names one product: choose another SKU.` })
  }
  const left = open.filter(plan => !refused(plan.productId))
  if (!left.length) return out
  const held = await channelSkuHoldings(db, left.map(plan => plan.to), { exceptProductIds: renamed })
  for (const plan of left) {
    const holding = held.find(h => h.sku === plan.to.trim())
    if (holding) out.push({ productId: plan.productId, error: holding.sentence })
  }
  return out
}

/** A listing moved between the plan's read and its write: the caller answers 409 (reload, try again). */
export class SkuRenameConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkuRenameConflict'
  }
}

/**
 * Writes the plan's listing columns, each guarded on the version the plan read. A written `channelSku` bumps the
 * listing's version and leaves a `ChannelListingOverride` history row (as `setChannelSku` does); a recorded
 * `liveChannelSku` alone is a system record (no bump, as `confirmLiveChannelSku`). The caller renames the product in
 * the same transaction (savepoint).
 */
export async function applySkuRenamePlan(db: Db, plan: SkuRenamePlan, actorId: string | null): Promise<void> {
  for (const listing of plan.listings) {
    const { channelSku, liveChannelSku: live } = listing.write
    if (channelSku === undefined && live === undefined) continue
    const written = await db.channelListing.updateMany({
      where: { id: listing.listingId, version: listing.version },
      data: { ...(channelSku !== undefined ? { channelSku, version: { increment: 1 } } : {}), ...(live !== undefined ? { liveChannelSku: live } : {}) },
    })
    if (written.count !== 1) throw new SkuRenameConflict(`${listingPlace(listing)} of ${plan.from} changed while its SKU was being renamed. Reload and try again.`)
    if (channelSku !== undefined) {
      await db.channelListingOverride.create({ data: { channelListingId: listing.listingId, fieldName: 'channelSku', previousValue: listing.previousChannelSku,
        newValue: channelSku, changedBy: actorId,
        reason: listing.outcome === 'keeps' ? `Keeps ${channelSku}: the product SKU was renamed ${plan.from} → ${plan.to}` : `Follows the product SKU ${plan.to}` } })
    }
  }
}

/**
 * The shared-stock guard's refusal of a rename (stock-pool.sql, `nexus_stock_pool_product_guard`) as one plain sentence
 * that names what to do; null for any other error. The guard's own sentence says "change it"; for a SKU it says rename.
 */
export function skuRenameRefusal(error: unknown): string | null {
  const sentence = stockPoolConnectedRefusal(error)
  if (!sentence) return null
  const borrows = /^(.+?) sells from the stock of (.+?)\. Disconnect it first \(Matrix, Stock source\), then change it\.$/.exec(sentence)
  if (borrows) return `${borrows[1]} sells from the stock of ${borrows[2]}, and the SKU is what connects them: disconnect it first (Matrix, Stock source), then rename it.`
  const lends = /^(.+?) shares its stock with (.+?)\. Disconnect it there first, then change it\.$/.exec(sentence)
  if (lends) return `${lends[1]} shares its stock with ${lends[2]}, and the SKU is what connects them: disconnect it in ${lends[2]} first, then rename it.`
  return sentence
}
