/**
 * Amazon sheet gaps (D4=B) — THE door of a LIVE Amazon listing's offer draft (`platformAttributes.amazonOfferDraft`,
 * `offer-draft.ts`): offer facts saved in Nexus that go to Amazon only when the person publishes (design-draft-and-remote §A).
 * Nothing here queues, sends or touches a live store: the price and stock jobs keep sending the live values.
 *
 *   - Live listings only (`!isStillDraftListing`): a never-published listing is written through the live doors
 *     (`amazon-offer-writes.ts`). Compare-and-set on `ChannelListing.version` ("Changed elsewhere — reloaded").
 *   - Refused by name, nothing saved: the parent, a missing `products.price.edit` (every leaf the price door writes), a
 *     wrong value (`amazonOfferLeafRefusal`, strict dates as the live doors take them), a price of 0 or one outside the
 *     product's floor or ceiling (master currency), a price outside Amazon's minimum and maximum (or min above max),
 *     an offer that ends before it starts, and FBA on a leaf that applies only to orders the seller ships.
 *   - A fulfilment leaf (handling time, restock date, always available) is one value per SKU across the Amazon EU markets:
 *     it is saved on every open EU row of the SKU on the account (`shared-inventory-targets.ts`), each against its own live
 *     value. A saved value equal to live is no change: the leaf is removed. `base` = live at save.
 *   - The field's old product-sheet key in `overrideData` (saved there, never sent) goes in the same write; one audit row
 *     per row and leaf; `listing.values_changed` (`offerDraft`) after COMMIT.
 *
 * `discardAmazonOfferDrafts` drops saved changes; `clearPromotedDraftLeaves` is Publish's: after Amazon accepted, a leaf
 * goes only while it still holds exactly the value that was sent (a newer saved value stays).
 */
import type { Prisma } from '@prisma/client'
import { assertPushAllowed, isStillDraftListing } from '@nexus/shared/push-lock'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { pricingRuleLabel, roundCents } from '@nexus/shared/listing-price'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { masterCurrency } from '../fx-rate.service.js'
import { boundsApply, priceBoundsOf, storedPriceReason, zeroPriceReason } from '../price-bounds.service.js'
import { amazonSellerBoundsRefusal } from '../amazon/offer-attributes.js'
import { liveDraftValues, readAmazonOfferFacts } from '../amazon/offer-facts.js'
import {
  AMAZON_OFFER_FIELDS, AMAZON_OFFER_LEAVES, FBA_FULFILMENT_REASON, amazonOfferKeysOf, amazonOfferLeafRefusal, type AmazonOfferField, type AmazonOfferLeaf,
} from '../amazon/offer-fields.js'
import {
  amazonOfferValuesEqual, readAmazonOfferDraft, removeAmazonOfferDraftLeaf, setAmazonOfferDraftLeaf, withAmazonOfferDraft, type AmazonOfferDraft,
  type AmazonOfferDraftValues,
} from '../amazon/offer-draft.js'
import { announceListingValues } from '../listing-values-events.js'
import { computeListingPrice, listingMarketCurrency, listingSendPrice } from './follower-price.js'
import { PRICE_PERMISSION_REASON } from './matrix-cells.js'
import { readSaleWindows, validateSaleWindow } from './sale-window.js'
import { loadSharedInventoryTargets, sharesAmazonEuInventory } from './shared-inventory-targets.js'
import { loadAmazonFbaListingIds } from './amazon-offer-cells.js'

export const PRICE_PERMISSION = 'products.price.edit'
export type OfferPermissionCheck = (permission: string) => boolean

export interface AmazonOfferDraftChange {
  listingId: string
  leaf: AmazonOfferLeaf
  /** In the draft's shape (`AmazonOfferDraftValues[leaf]`); `null` = remove it on Amazon when you publish. */
  value: unknown
  /** The listing version the caller read. */
  expectedVersion: number
}

export interface AmazonOfferDraftResult {
  outcome: 'applied' | 'noop' | 'refused' | 'conflict'
  reason?: string
  /** Every row written (each named listing and, for a fulfilment leaf, its EU group), at its new version. */
  written: Array<{ listingId: string; marketplace: string; version: number }>
  /** Each named listing's version after the call: the token the sheet adopts. */
  versions: Record<string, number>
  conflict?: { listingId: string; version: number }
}

export const NOT_LIVE_REASON = 'This listing has not been published to Amazon yet: its offer values are saved as they are and sent by its first Publish.'
const ONLY_AMAZON = 'Only an Amazon listing keeps offer changes for Publish'
const CLOSED = 'This market offer is closed. Restore the offer before sending changes.'
const DRAFT_KEY_PREFIX = 'amazonOfferDraft'

/** The registry entry that speaks for a leaf (the sale's three keys share one). */
export const offerFieldOfLeaf = (leaf: AmazonOfferLeaf): AmazonOfferField => AMAZON_OFFER_FIELDS.find((f) => f.leaf === leaf)!
const isLeaf = (k: string): k is AmazonOfferLeaf => (AMAZON_OFFER_LEAVES as readonly string[]).includes(k)
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v))
  return Number.isFinite(n) ? n : null
}
const PRICE_LEAVES = new Set<AmazonOfferLeaf>(['minimum_seller_allowed_price', 'maximum_seller_allowed_price', 'map_price'])
const BOUND_LEAVES = new Set<AmazonOfferLeaf>(['our_price', 'sale', 'minimum_seller_allowed_price', 'maximum_seller_allowed_price'])

/** One leaf's value in its stored shape (prices to the cent, text trimmed), or the sentence that refuses it. */
export function normaliseOfferDraftValue(leaf: AmazonOfferLeaf, value: unknown, today: string): { value: unknown } | { refusal: string } {
  let v: unknown = value === undefined ? null : typeof value === 'string' ? value.trim() : value
  if (v === '') v = null
  if (leaf === 'our_price') {
    // A price pins a number or follows its rule again; nothing (`null`) is following.
    const o = record(v)
    if (v === null || o?.follow === true) return { value: { follow: true } }
    const pin = num(o?.pin)
    if (pin === null) return { refusal: 'A price either pins a number or follows its rule again' }
    v = { pin: roundCents(pin) }
  } else if (leaf === 'sale' && v !== null) {
    const o = record(v)
    const price = num(o?.price)
    if (!o || price === null) return { refusal: 'Set the sale price first — a sale date belongs to a sale price.' }
    const window = { start: typeof o.start === 'string' && o.start.trim() ? o.start.trim() : null, end: typeof o.end === 'string' && o.end.trim() ? o.end.trim() : null }
    // The live door's own rule (`validateSaleWindow`), so a published sale is always one the price door takes.
    const problem = validateSaleWindow(roundCents(price), window)
    if (problem) return { refusal: problem }
    v = { price: roundCents(price), start: window.start, end: window.end }
  } else if (PRICE_LEAVES.has(leaf) && v !== null) {
    const n = num(v)
    if (n === null) return { refusal: 'A price is a number of zero or more' }
    v = roundCents(n)
  } else if (leaf === 'lead_time_to_ship_max_days' && v !== null) {
    v = num(v) ?? v
  } else if (leaf === 'is_inventory_available' && typeof v === 'string') {
    v = v === 'true' ? true : v === 'false' ? false : v
  } else if (leaf === 'restock_date' && typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return { refusal: 'A restock date is YYYY-MM-DD' }
  } else if (leaf === 'automated_pricing_rule_id' && typeof v === 'string' && v.length > 100) {
    return { refusal: 'An Automate Pricing rule id is at most 100 characters' }
  }
  const problem = amazonOfferLeafRefusal(leaf, v, today)
  return problem ? { refusal: problem } : { value: v }
}

const DOOR_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, region: true, channelConnectionId: true, aliasKey: true, version: true,
  syncPaused: true, offerClosedAt: true, listingStatus: true, isPublished: true, externalListingId: true, fulfillmentMethod: true,
  price: true, priceOverride: true, followMasterPrice: true, pricingRule: true, priceAdjustmentPercent: true, salePrice: true,
  platformAttributes: true, overrideData: true,
  product: { select: { sku: true, isParent: true, basePrice: true, minPrice: true, maxPrice: true, fulfillmentMethod: true } },
} satisfies Prisma.ChannelListingSelect
type Row = Prisma.ChannelListingGetPayload<{ select: typeof DOOR_SELECT }>
type Db = Prisma.TransactionClient

class Abort extends Error {
  constructor(readonly result: AmazonOfferDraftResult) { super(result.reason ?? result.outcome) }
}
const stored = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))
const who = (l: Row) => `${l.product?.sku ?? 'This listing'} on ${l.channel} ${l.marketplace}`
const lockRows = (db: Db, ids: string[]) =>
  db.$queryRaw<Array<{ id: string; version: number }>>`SELECT id, version FROM "ChannelListing" WHERE id = ANY(${ids}::text[]) FOR UPDATE`

/** Write one row's new draft (CAS on the version it was read at), drop the leaves' old sheet keys, audit each leaf. */
async function writeDraft(db: Db, row: Row, version: number, before: AmazonOfferDraft | null, after: AmazonOfferDraft | null,
  leaves: readonly AmazonOfferLeaf[], audit: { actor: string; reason: string }): Promise<number> {
  const guarded = await db.channelListing.updateMany({
    where: { id: row.id, version },
    data: { platformAttributes: withAmazonOfferDraft(row.platformAttributes, after) as Prisma.InputJsonValue, version: { increment: 1 } },
  })
  // Held FOR UPDATE by the caller, so this cannot miss; if it ever does, the transaction must fail, not half-apply.
  if (guarded.count !== 1) throw new Error(`amazon-offer-draft: listing ${row.id} moved while locked`)
  const bag = record(row.overrideData) ?? {}
  const stale = leaves.flatMap(amazonOfferKeysOf).filter((k) => Object.prototype.hasOwnProperty.call(bag, k))
  if (stale.length) await db.$executeRaw`UPDATE "ChannelListing" SET "overrideData" = COALESCE("overrideData", '{}'::jsonb) - ${stale}::text[] WHERE id = ${row.id}`
  for (const leaf of leaves) {
    await db.channelListingOverride.create({ data: {
      channelListingId: row.id, fieldName: `${DRAFT_KEY_PREFIX}.${leaf}`, previousValue: stored(before?.leaves[leaf]?.value),
      newValue: stored(after?.leaves[leaf]?.value), reason: audit.reason, changedBy: audit.actor,
    } })
  }
  return version + 1
}

/** Save offer changes of live Amazon listings for Publish: all of them, or — refused or conflicting — none. */
export async function saveAmazonOfferDrafts(input: {
  changes: AmazonOfferDraftChange[]
  actor: string
  permissions: OfferPermissionCheck
  /** The audit sentence prefix. */
  reason?: string
  tx?: Prisma.TransactionClient
}): Promise<AmazonOfferDraftResult> {
  const empty = (over: Partial<AmazonOfferDraftResult>): AmazonOfferDraftResult => ({ outcome: 'refused', written: [], versions: {}, ...over })
  const conflict = (listingId: string, version: number) =>
    new Abort(empty({ outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, conflict: { listingId, version } }))
  const refuse = (reason: string) => new Abort(empty({ reason }))
  if (!input.changes?.length) return empty({ outcome: 'noop' })
  const today = new Date().toISOString().slice(0, 10)
  const at = new Date().toISOString()
  const audit = { actor: input.actor, reason: input.reason ?? 'Product sheet: saved for Publish' }

  const run = <T,>(work: (tx: Db) => Promise<T>): Promise<T> => (input.tx ? work(input.tx) : prisma.$transaction(work))
  let result: AmazonOfferDraftResult
  try {
    result = await run(async (db) => {
      const namedIds = [...new Set(input.changes.map((c) => c.listingId))]
      const named = await db.channelListing.findMany({ where: { id: { in: namedIds } }, select: DOOR_SELECT })
      const rows = new Map(named.map((r) => [r.id, r]))
      // The version each row must still hold when it is locked: the caller's for a named row, the group's read for a sibling.
      const versions = new Map<string, number>()
      const plan = new Map<string, Array<{ leaf: AmazonOfferLeaf; value: unknown }>>()
      const groups = new Map<string, string[]>()
      for (const c of input.changes) {
        if (!isLeaf(c.leaf)) throw refuse(`${String(c.leaf)} is not an Amazon offer field`)
        const l = rows.get(c.listingId)
        if (!l) throw conflict(c.listingId, 0)
        if (l.channel !== 'AMAZON') throw refuse(ONLY_AMAZON)
        if (typeof c.expectedVersion !== 'number' || c.expectedVersion !== l.version) throw conflict(l.id, l.version)
        if (isStillDraftListing(l)) throw refuse(NOT_LIVE_REASON)
        const field = offerFieldOfLeaf(c.leaf)
        if (l.product?.isParent) throw refuse(field.parentReason)
        if (field.writeService === 'writeChannelPrices' && !input.permissions(PRICE_PERMISSION)) throw refuse(PRICE_PERMISSION_REASON)
        const checked = normaliseOfferDraftValue(c.leaf, c.value, today)
        if ('refusal' in checked) throw refuse(checked.refusal)
        versions.set(l.id, c.expectedVersion)
        // One value per SKU across the Amazon EU markets: every open EU row of the SKU on the account.
        let targets = groups.get(l.id) ?? [l.id]
        if (field.euShared && !groups.has(l.id)) {
          const picked = await loadSharedInventoryTargets(db, { ...l, marketplace: String(l.marketplace), version: c.expectedVersion })
          if ('conflict' in picked) throw conflict(l.id, picked.conflict)
          if (picked.targets.length === 0) throw refuse(assertPushAllowed(l)?.sentence ?? CLOSED)
          const missing = picked.targets.map((t) => t.id).filter((id) => !rows.has(id))
          if (missing.length) for (const r of await db.channelListing.findMany({ where: { id: { in: missing } }, select: DOOR_SELECT })) rows.set(r.id, r)
          for (const t of picked.targets) if (!versions.has(t.id)) versions.set(t.id, t.version)
          targets = picked.targets.map((t) => t.id)
          groups.set(l.id, targets)
        }
        for (const id of field.euShared ? targets : [l.id]) plan.set(id, [...(plan.get(id) ?? []), { leaf: c.leaf, value: checked.value }])
      }

      // FBA: handling time, restock date and always available apply only to orders the seller ships — any FBA row, nothing.
      const fbmOnly = [...plan].filter(([, ws]) => ws.some((w) => !offerFieldOfLeaf(w.leaf).fbaApplies)).map(([id]) => rows.get(id)!).filter(Boolean)
      if (fbmOnly.length && (await loadAmazonFbaListingIds(db, fbmOnly)).size > 0) throw refuse(FBA_FULFILMENT_REASON)

      // Every row FOR UPDATE, its version checked BEFORE the first write: a conflict writes nothing, inside a caller's
      // transaction too.
      const ids = [...plan.keys()]
      const locked = new Map((await lockRows(db, ids)).map((x) => [x.id, Number(x.version)]))
      for (const id of ids) if (locked.get(id) !== versions.get(id)) throw conflict(id, locked.get(id) ?? 0)

      const [windows, currencies] = await Promise.all([
        readSaleWindows(db as never, ids),
        db.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { channel: true, code: true, currency: true } }),
      ])
      const master = masterCurrency()
      // Pass 1 — every row's new draft and every check, before the first write.
      const changed: Array<{ row: Row; before: AmazonOfferDraft | null; draft: AmazonOfferDraft | null; touched: AmazonOfferLeaf[] }> = []
      for (const id of ids) {
        const row = rows.get(id)!
        const saleWindow = windows.get(id) ?? null
        const live = liveDraftValues(readAmazonOfferFacts({ ...row, saleWindow }, 'job'))
        const before = readAmazonOfferDraft(row.platformAttributes)
        let draft = before
        const touched: AmazonOfferLeaf[] = []
        for (const w of plan.get(id)!) {
          const existing = draft?.leaves[w.leaf]
          // The same saved value again, or live's own value with nothing saved: no change.
          if (existing ? amazonOfferValuesEqual(w.leaf, existing.value, w.value) : amazonOfferValuesEqual(w.leaf, w.value, live[w.leaf])) continue
          draft = setAmazonOfferDraftLeaf(draft, w.leaf, { value: w.value as never, live: live[w.leaf] as never, at, by: input.actor })
          touched.push(w.leaf)
        }
        if (touched.length === 0) continue
        // The market's own offer, as Publish would send it after this change: price, floor/ceiling, Amazon's bounds.
        if (namedIds.includes(id)) checkOffer(row, draft, touched, { saleWindow, currencies, master })
        changed.push({ row, before, draft, touched })
      }
      // Pass 2 — the writes.
      const written: AmazonOfferDraftResult['written'] = []
      const out: Record<string, number> = {}
      for (const { row, before, draft, touched } of changed) {
        const version = await writeDraft(db, row, versions.get(row.id)!, before, draft, touched, {
          actor: input.actor,
          reason: `${audit.reason}: ${touched.map((leaf) => (draft?.leaves[leaf] ? `${leaf} saved` : `${leaf} saved change removed (equals live)`)).join(' · ')}`,
        })
        written.push({ listingId: row.id, marketplace: String(row.marketplace), version })
        if (namedIds.includes(row.id)) out[row.id] = version
      }
      for (const id of namedIds) out[id] ??= versions.get(id)!
      return { outcome: written.length ? 'applied' : 'noop', written, versions: out }
    })
  } catch (error) {
    if (error instanceof Abort) return error.result
    throw error
  }
  if (result.written.length) announceListingValues(result.written.map((w) => w.listingId), ['offerDraft'], 'offer-draft')
  logger.info('amazon-offer-draft: saved', { actor: input.actor, outcome: result.outcome, written: result.written.length })
  return result

  /** The cross-leaf checks of the offer Publish would send for this market; throws the refusal. */
  function checkOffer(row: Row, draft: AmazonOfferDraft | null, touched: readonly AmazonOfferLeaf[],
    ctx: { saleWindow: { start: string | null; end: string | null } | null; currencies: Array<{ channel: string; code: string; currency: string | null }>; master: string }) {
    const marketCurrency = listingMarketCurrency(row, ctx.currencies as never)
    const boundsSpeak = boundsApply(marketCurrency, ctx.master)
    const bounds = priceBoundsOf(row.product ?? {})
    const price = record(draft?.leaves.our_price?.value) as AmazonOfferDraftValues['our_price'] | null
    if (touched.includes('our_price') && price && 'pin' in price) {
      const zero = zeroPriceReason(price.pin)
      if (zero) throw refuse(`${who(row)} was not pinned: ${zero}. Nothing was changed.`)
      const outside = boundsSpeak ? storedPriceReason(price.pin, bounds) : null
      if (outside) throw refuse(`${who(row)} cannot be pinned at ${price.pin.toFixed(2)}: ${outside}. Change the price, or the floor or ceiling on the product. Nothing was changed.`)
    }
    let followPrice: number | null | undefined
    if (price && 'follow' in price) {
      followPrice = listingSendPrice({ ...row, followMasterPrice: true, priceOverride: null }, { masterPrice: row.product?.basePrice, marketCurrency, masterCurrency: ctx.master }).price
      const base = num(row.product?.basePrice)
      const next = boundsSpeak && base != null ? computeListingPrice(base, row.pricingRule as never, true, row.priceAdjustmentPercent as never) : null
      const outside = touched.includes('our_price') && next != null ? storedPriceReason(next, bounds) : null
      if (outside) throw refuse(`${who(row)} would follow ${pricingRuleLabel(row.pricingRule, row.priceAdjustmentPercent as never)} at ${next!.toFixed(2)}, but ${outside}. Change the rule, or the floor or ceiling on the product. Nothing was changed.`)
    }
    const publish = readAmazonOfferFacts({ ...row, platformAttributes: withAmazonOfferDraft(row.platformAttributes, draft), saleWindow: ctx.saleWindow }, 'publish', { followPrice })
    const v = publish.values
    if (touched.some((leaf) => BOUND_LEAVES.has(leaf))) {
      const sale = v.sale && v.sale.start && v.sale.end ? v.sale.price : null
      const outside = amazonSellerBoundsRefusal({ price: v.our_price.price, salePrice: sale, min: v.minimum_seller_allowed_price, max: v.maximum_seller_allowed_price })
      if (outside) throw refuse(`${who(row)}: ${outside} Nothing was changed.`)
    }
    if ((touched.includes('offer_start_at') || touched.includes('offer_end_at')) && v.offer_start_at && v.offer_end_at && Date.parse(v.offer_end_at) < Date.parse(v.offer_start_at)) {
      throw refuse(`${who(row)}: the offer ends on or after the day it starts. Nothing was changed.`)
    }
  }
}

/** The rows again after they are locked, in the order given (named rows first). */
async function rereadInOrder(db: Db, ids: string[]): Promise<Row[]> {
  const rows = new Map((await db.channelListing.findMany({ where: { id: { in: ids } }, select: DOOR_SELECT })).map((r) => [r.id, r]))
  return ids.map((id) => rows.get(id)).filter((r): r is Row => !!r)
}

/** The rows a leaf removal lands on: the named rows, and — for an EU-shared leaf — every open EU row of the SKU. */
async function removalRows(db: Db, named: Row[], leaves: (row: Row) => AmazonOfferLeaf[]): Promise<Map<string, { row: Row; leaves: Set<AmazonOfferLeaf> }>> {
  const out = new Map<string, { row: Row; leaves: Set<AmazonOfferLeaf> }>()
  const add = (row: Row, ls: AmazonOfferLeaf[]) => {
    const hit = out.get(row.id) ?? { row, leaves: new Set<AmazonOfferLeaf>() }
    for (const leaf of ls) hit.leaves.add(leaf)
    out.set(row.id, hit)
  }
  for (const row of named) {
    const ls = leaves(row)
    add(row, ls)
    const shared = ls.filter((leaf) => offerFieldOfLeaf(leaf).euShared)
    if (!shared.length || !sharesAmazonEuInventory({ ...row, marketplace: String(row.marketplace) })) continue
    const picked = await loadSharedInventoryTargets(db, { ...row, marketplace: String(row.marketplace) }, { primary: 'always' })
    if ('conflict' in picked) continue
    const others = picked.targets.map((t) => t.id).filter((id) => id !== row.id)
    if (others.length) for (const r of await db.channelListing.findMany({ where: { id: { in: others } }, select: DOOR_SELECT })) add(r, shared)
  }
  return out
}

/**
 * Discard saved offer changes (the sheet's "Discard saved changes…"): the named leaves, or every leaf, of each listing. A
 * fulfilment leaf is discarded on every open EU row of the SKU too (it was saved on all of them).
 */
export async function discardAmazonOfferDrafts(input: {
  listingIds: string[]
  leaves?: AmazonOfferLeaf[]
  actor: string
  reason?: string
  tx?: Prisma.TransactionClient
}): Promise<{ discarded: Array<{ listingId: string; leaves: AmazonOfferLeaf[]; version: number }> }> {
  const ids = [...new Set(input.listingIds)]
  if (!ids.length) return { discarded: [] }
  const only = input.leaves?.filter(isLeaf)
  const run = <T,>(work: (tx: Db) => Promise<T>): Promise<T> => (input.tx ? work(input.tx) : prisma.$transaction(work))
  const discarded = await run(async (db) => {
    const named = await db.channelListing.findMany({ where: { id: { in: ids }, channel: 'AMAZON' }, select: DOOR_SELECT })
    const planned = await removalRows(db, named, (row) => {
      const draft = readAmazonOfferDraft(row.platformAttributes)
      return only ?? (Object.keys(draft?.leaves ?? {}) as AmazonOfferLeaf[])
    })
    if (planned.size === 0) return []
    await lockRows(db, [...planned.keys()])
    const fresh = await rereadInOrder(db, [...planned.keys()])
    const done: Array<{ listingId: string; leaves: AmazonOfferLeaf[]; version: number }> = []
    for (const row of fresh) {
      const before = readAmazonOfferDraft(row.platformAttributes)
      const leaves = [...planned.get(row.id)!.leaves].filter((leaf) => before?.leaves[leaf])
      if (!leaves.length) continue
      const after = leaves.reduce<AmazonOfferDraft | null>((d, leaf) => removeAmazonOfferDraftLeaf(d, leaf), before)
      const version = await writeDraft(db, row, row.version, before, after, leaves, { actor: input.actor, reason: `${input.reason ?? 'Product sheet'}: saved change discarded` })
      done.push({ listingId: row.id, leaves, version })
    }
    return done
  })
  if (discarded.length) announceListingValues(discarded.map((d) => d.listingId), ['offerDraft'], 'offer-draft')
  return { discarded }
}

/**
 * Publish's step after Amazon accepted a listing's offer: remove each sent leaf from the draft ONLY while the draft still
 * holds exactly the value that was sent — a value saved again after the send is newer, and stays. A fulfilment leaf goes
 * from every open EU row of the SKU that holds the same value. `removed` / `kept` speak for the named listing; a leaf with
 * nothing saved is in neither.
 */
export async function clearPromotedDraftLeaves(
  input: { listingId: string; sent: Partial<Record<AmazonOfferLeaf, unknown>> },
  opts?: { tx?: Prisma.TransactionClient },
): Promise<{ removed: AmazonOfferLeaf[]; kept: AmazonOfferLeaf[] }> {
  const sentLeaves = Object.keys(input.sent ?? {}).filter(isLeaf)
  if (!sentLeaves.length) return { removed: [], kept: [] }
  const run = <T,>(work: (tx: Db) => Promise<T>): Promise<T> => (opts?.tx ? work(opts.tx) : prisma.$transaction(work))
  const sameAsSent = (row: Row, leaf: AmazonOfferLeaf) => {
    const entry = readAmazonOfferDraft(row.platformAttributes)?.leaves[leaf]
    return !!entry && amazonOfferValuesEqual(leaf, entry.value, input.sent[leaf])
  }
  const outcome = await run(async (db) => {
    const named = await db.channelListing.findMany({ where: { id: input.listingId }, select: DOOR_SELECT })
    if (!named.length) return { removed: [], kept: [], written: [] as string[] }
    const planned = await removalRows(db, named, () => sentLeaves)
    await lockRows(db, [...planned.keys()])
    const fresh = await rereadInOrder(db, [...planned.keys()])
    const removed: AmazonOfferLeaf[] = []
    const kept: AmazonOfferLeaf[] = []
    const written: string[] = []
    for (const row of fresh) {
      const before = readAmazonOfferDraft(row.platformAttributes)
      const leaves = [...planned.get(row.id)!.leaves].filter((leaf) => before?.leaves[leaf])
      const going = leaves.filter((leaf) => sameAsSent(row, leaf))
      if (row.id === input.listingId) { removed.push(...going); kept.push(...leaves.filter((leaf) => !going.includes(leaf))) }
      if (!going.length) continue
      const after = going.reduce<AmazonOfferDraft | null>((d, leaf) => removeAmazonOfferDraftLeaf(d, leaf), before)
      await writeDraft(db, row, row.version, before, after, going, { actor: 'system:publish', reason: 'Publish: Amazon accepted the saved value' })
      written.push(row.id)
    }
    return { removed, kept, written }
  })
  if (outcome.written.length) announceListingValues(outcome.written, ['offerDraft'], 'offer-draft')
  return { removed: outcome.removed, kept: outcome.kept }
}
