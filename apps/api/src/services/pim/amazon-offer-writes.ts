/**
 * Amazon sheet gaps (D4=B) — where a product sheet edit of an Amazon offer column goes (`isAmazonOfferDraftKey`). Their
 * channel stores are the LIVE stores, so a generic write would change what the jobs send at once; it never happens:
 *
 *   - a LIVE listing → the offer draft door (`amazon-offer-draft.service.ts`): saved in Nexus, sent on Publish;
 *   - a still-draft (never published) listing → the live doors, exactly as the Matrix writes them: `writeChannelPrices` for
 *     the price, the sale and the offer settings (minimum / maximum / MAP price, offer window, Automate Pricing rule),
 *     `setAmazonFulfilmentSettings` for handling time, restock date and always available.
 *
 * One row's three sale columns are ONE sale write (merged with the sale the row shows; a date without a sale price, or a
 * sale without both dates, is refused by name). A price typed on a listing that follows its rule pins it; reset follows
 * the rule again. On a live listing a reset discards that column's saved change. `products.price.edit` holds every leaf
 * the price door writes, on both lanes (the Matrix holds its price cells the same way), and a parent writes nothing.
 */
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { MATRIX_COPY } from '@nexus/shared/matrix-contract'
import { roundCents } from '@nexus/shared/listing-price'
import prisma from '../../db.js'
import { liveDraftValues, readAmazonOfferFacts, type AmazonOfferFacts } from '../amazon/offer-facts.js'
import { amazonOfferFieldFor, rootOfLeaf, type AmazonOfferLeaf } from '../amazon/offer-fields.js'
import { setAmazonFulfilmentSettings, type AmazonFulfilmentSettings } from './amazon-fulfilment-settings.service.js'
import { writeChannelPrices, type AmazonOfferWrite, type PriceWriteTarget } from './channel-price-write.service.js'
import { PRICE_PERMISSION, offerFieldOfLeaf, saveAmazonOfferDrafts, type AmazonOfferDraftChange, type OfferPermissionCheck } from './amazon-offer-draft.service.js'
import { PRICE_PERMISSION_REASON } from './matrix-cells.js'
import { readSaleWindows, validateSaleWindow } from './sale-window.js'

export interface AmazonOfferEdit {
  listingId: string
  /** The sheet column key, with or without `attr_`. */
  key: string
  value: unknown
  reset?: boolean
  /** The listing version the caller read. */
  expectedVersion: number
}

export interface AmazonOfferWriteOutcome {
  listingId: string
  /** `draft` = saved for Publish; `live` = written through the live doors (a still-draft listing). */
  lane: 'draft' | 'live'
  outcome: 'applied' | 'noop' | 'refused' | 'conflict'
  reason?: string
  /** The listing's version now (on a conflict: the version it holds). */
  version: number
  notSent?: string
}

export const SALE_DATE_WITHOUT_PRICE = 'Set the sale price first — a sale date belongs to a sale price.'
export const ONE_VALUE = 'One value per cell — Amazon takes a single value here.'
const NOT_A_NUMBER = 'A price is a number of zero or more'

type SaleValue = { price: number; start: string | null; end: string | null }
type SaleParts = { value?: number | null; start?: string | null; end?: string | null }

/**
 * PURE — the sale one row's sale columns make together: the parts edited, laid over the sale the row shows (`current`).
 * `null` = no sale. A date with no sale price, or a sale price without both dates, is refused with its sentence.
 */
export function mergeSaleEdit(current: { price: number; start: string | null; end: string | null } | null, parts: SaleParts): { sale: SaleValue | null } | { refusal: string } {
  const price = 'value' in parts ? parts.value ?? null : current?.price ?? null
  if (price === null) {
    // Clearing the sale price removes the sale; a date typed without one has nothing to belong to.
    if ((parts.start ?? null) !== null || (parts.end ?? null) !== null) return { refusal: SALE_DATE_WITHOUT_PRICE }
    return { sale: null }
  }
  const start = 'start' in parts ? parts.start ?? null : current?.start ?? null
  const end = 'end' in parts ? parts.end ?? null : current?.end ?? null
  const problem = validateSaleWindow(roundCents(price), { start, end })
  return problem ? { refusal: problem } : { sale: { price: roundCents(price), start, end } }
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
/** A number typed in a cell (a decimal comma too); `null` for an empty cell, `NaN` for text. */
const typedNumber = (v: unknown): number | null => {
  if (blank(v)) return null
  if (typeof v === 'number') return v
  const s = String(v).trim()
  return Number(s.includes('.') || !s.includes(',') ? s : s.replace(',', '.'))
}
const typedText = (v: unknown): string | null => (blank(v) ? null : String(v).trim())
const typedBoolean = (v: unknown): unknown => (blank(v) ? null : v === 'true' ? true : v === 'false' ? false : v)
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, version: true, listingStatus: true, isPublished: true, externalListingId: true,
  price: true, priceOverride: true, followMasterPrice: true, salePrice: true, platformAttributes: true,
  product: { select: { isParent: true } },
} as const

/**
 * PURE — one listing's edits as leaf values (the draft's shapes): the sale's parts merged, a price pin or follow, a reset
 * resolved (a live listing's reset discards its saved change: the live value is saved, which removes it).
 */
export function offerLeafValues(edits: ReadonlyArray<Pick<AmazonOfferEdit, 'key' | 'value' | 'reset'>>, lane: 'draft' | 'live', facts: { show: AmazonOfferFacts; live: AmazonOfferFacts }):
  { values: Map<AmazonOfferLeaf, unknown> } | { refusal: string } {
  const values = new Map<AmazonOfferLeaf, unknown>()
  const live = liveDraftValues(facts.live)
  const saved = facts.show.draft?.leaves ?? {}
  const parts: SaleParts = {}
  let saleReset = false
  for (const raw of edits) {
    const field = amazonOfferFieldFor(raw.key)
    if (!field?.leaf || field.lane !== 'draft') return { refusal: `${raw.key} is not an Amazon offer field` }
    // A list column (Amazon's schedule) carries one value: its one item; an empty list clears it.
    if (Array.isArray(raw.value) && raw.value.length > 1) return { refusal: ONE_VALUE }
    const edit = Array.isArray(raw.value) ? { ...raw, value: raw.value[0] ?? null } : raw
    const leaf = field.leaf
    if (leaf === 'sale') {
      if (edit.reset) { saleReset = true; continue }
      if (field.part === 'value') {
        const n = typedNumber(edit.value)
        if (n !== null && (!Number.isFinite(n) || n < 0)) return { refusal: 'A sale price is zero or more' }
        parts.value = n
      } else parts[field.part === 'start' ? 'start' : 'end'] = typedText(edit.value)
      continue
    }
    if (edit.reset) {
      // A live listing: discard the saved change (saving live removes it); a pinned price with none follows its rule again.
      if (lane === 'draft' && saved[leaf]) values.set(leaf, live[leaf])
      else if (leaf === 'our_price') values.set(leaf, { follow: true })
      else if (lane === 'live') values.set(leaf, null)
      continue
    }
    if (leaf === 'our_price') {
      const n = typedNumber(edit.value)
      if (n !== null && !Number.isFinite(n)) return { refusal: NOT_A_NUMBER }
      // A typed price pins it (on a listing that follows its rule too); an emptied price follows the rule again.
      values.set(leaf, n === null ? { follow: true } : { pin: roundCents(n) })
    } else if (leaf === 'minimum_seller_allowed_price' || leaf === 'maximum_seller_allowed_price' || leaf === 'map_price') {
      const n = typedNumber(edit.value)
      if (n !== null && !Number.isFinite(n)) return { refusal: NOT_A_NUMBER }
      values.set(leaf, n === null ? null : roundCents(n))
    } else if (leaf === 'lead_time_to_ship_max_days') {
      const n = typedNumber(edit.value)
      values.set(leaf, n === null ? null : Number.isFinite(n) ? n : edit.value)
    } else if (leaf === 'is_inventory_available') values.set(leaf, typedBoolean(edit.value))
    else values.set(leaf, typedText(edit.value))
  }
  if (saleReset && Object.keys(parts).length === 0) {
    if (lane === 'draft' && saved.sale) values.set('sale', live.sale)
    else if (lane === 'live') values.set('sale', null)
  } else if (Object.keys(parts).length) {
    // The sale the row shows: the saved one over live on a live listing, live on a still-draft.
    const merged = mergeSaleEdit(facts.show.values.sale, parts)
    if ('refusal' in merged) return { refusal: merged.refusal }
    values.set('sale', merged.sale)
  }
  return { values }
}

/** Route product sheet edits of Amazon offer columns: a live listing's to its offer draft, a still-draft's to the live doors. */
export async function writeAmazonOfferEdits(input: {
  edits: AmazonOfferEdit[]
  actor: string
  permissions: OfferPermissionCheck
  reason?: string
}): Promise<{ results: AmazonOfferWriteOutcome[] }> {
  const results: AmazonOfferWriteOutcome[] = []
  if (!input.edits.length) return { results }
  const reason = input.reason ?? 'Product sheet'
  const ids = [...new Set(input.edits.map((e) => e.listingId))]
  const [listings, windows] = await Promise.all([
    prisma.channelListing.findMany({ where: { id: { in: ids } }, select: LISTING_SELECT }),
    readSaleWindows(prisma as never, ids),
  ])
  const byId = new Map(listings.map((l) => [l.id, l]))
  const drafts: AmazonOfferDraftChange[] = []
  const draftListings: Array<{ id: string; version: number }> = []

  for (const id of ids) {
    const edits = input.edits.filter((e) => e.listingId === id)
    const l = byId.get(id)
    const expectedVersion = edits[0].expectedVersion
    if (!l) { results.push({ listingId: id, lane: 'draft', outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: 0 }); continue }
    const lane: 'draft' | 'live' = isStillDraftListing(l) ? 'live' : 'draft'
    const refuse = (why: string) => results.push({ listingId: id, lane, outcome: 'refused', reason: why, version: l.version })
    if (l.channel !== 'AMAZON') { refuse('Only an Amazon listing has these offer fields'); continue }
    if (expectedVersion !== l.version) { results.push({ listingId: id, lane, outcome: 'conflict', reason: MATRIX_COPY.changedElsewhere, version: l.version }); continue }
    const saleWindow = windows.get(id) ?? null
    const facts = {
      show: readAmazonOfferFacts({ ...l, saleWindow }, lane === 'draft' ? 'publish' : 'job'),
      live: readAmazonOfferFacts({ ...l, saleWindow }, 'job'),
    }
    const leafValues = offerLeafValues(edits, lane, facts)
    if ('refusal' in leafValues) { refuse(leafValues.refusal); continue }
    const leaves = [...leafValues.values.keys()]
    const parentHold = l.product?.isParent && leaves.length ? offerFieldOfLeaf(leaves[0]).parentReason : undefined
    if (parentHold) { refuse(parentHold); continue }
    if (leaves.some((leaf) => offerFieldOfLeaf(leaf).writeService === 'writeChannelPrices') && !input.permissions(PRICE_PERMISSION)) { refuse(PRICE_PERMISSION_REASON); continue }
    if (leaves.length === 0) { results.push({ listingId: id, lane, outcome: 'noop', version: l.version }); continue }

    if (lane === 'draft') {
      for (const [leaf, value] of leafValues.values) drafts.push({ listingId: id, leaf, value, expectedVersion })
      draftListings.push({ id, version: l.version })
      continue
    }
    results.push(await writeLiveDoors(l.id, expectedVersion, leafValues.values, { actor: input.actor, reason }))
  }

  if (drafts.length) {
    // One call for every live listing: all of them saved, or — refused or conflicting — none.
    const saved = await saveAmazonOfferDrafts({ changes: drafts, actor: input.actor, permissions: input.permissions, reason: `${reason}: saved for Publish` })
    for (const d of draftListings) {
      if (saved.outcome === 'refused' || saved.outcome === 'conflict') {
        const mine = saved.conflict?.listingId === d.id
        results.push({ listingId: d.id, lane: 'draft', outcome: saved.outcome, reason: saved.reason, version: mine ? saved.conflict!.version : d.version })
        continue
      }
      const version = saved.versions[d.id] ?? d.version
      results.push({ listingId: d.id, lane: 'draft', outcome: version !== d.version ? 'applied' : 'noop', version })
    }
  }
  return { results }
}

/** A still-draft listing: the price door for the price, sale and offer settings (ONE write), then the fulfilment door. */
async function writeLiveDoors(listingId: string, expectedVersion: number, values: Map<AmazonOfferLeaf, unknown>, audit: { actor: string; reason: string }): Promise<AmazonOfferWriteOutcome> {
  let version = expectedVersion
  let applied = false
  const notSent: string[] = []
  const offer: AmazonOfferWrite = {}
  const target: Record<string, unknown> = { listingId, expectedVersion }
  const settings: AmazonFulfilmentSettings = {}
  for (const [leaf, value] of values) {
    if (rootOfLeaf(leaf) === 'fulfillment_availability') { (settings as Record<string, unknown>)[leaf] = value; continue }
    if (leaf === 'our_price') target.price = record(value)?.follow === true ? null : record(value)?.pin ?? null
    else if (leaf === 'sale') {
      const sale = record(value)
      target.sale = sale ? { value: sale.price, start: sale.start ?? null, end: sale.end ?? null } : { value: null, start: null, end: null }
    } else (offer as Record<string, unknown>)[leaf] = value
  }
  if (Object.keys(offer).length) target.offer = offer
  if (Object.keys(target).length > 2) {
    const written = await writeChannelPrices({ targets: [target as unknown as PriceWriteTarget], actor: audit.actor, source: 'MANUAL_OVERRIDE', reason: audit.reason })
    const r = written.results[0]
    if (!r || r.outcome === 'refused' || r.outcome === 'conflict') return { listingId, lane: 'live', outcome: r?.outcome ?? 'refused', reason: r?.reason, version: r?.version ?? version }
    if (r.outcome === 'applied') { applied = true; version = r.version }
    if (r.notSent) notSent.push(r.notSent)
  }
  if (Object.keys(settings).length) {
    const written = await setAmazonFulfilmentSettings({ targets: [{ listingId, expectedVersion: version }], settings, actor: audit.actor, reason: audit.reason })
    if (written.outcome === 'refused' || written.outcome === 'conflict') {
      return { listingId, lane: 'live', outcome: written.outcome, reason: written.reason, version: written.conflict?.version ?? version }
    }
    const mine = written.written.find((w) => w.listingId === listingId)
    if (mine) { applied = true; version = mine.version }
    if (written.notSent) notSent.push(written.notSent)
  }
  return { listingId, lane: 'live', outcome: applied ? 'applied' : 'noop', version, ...(notSent.length ? { notSent: notSent.join(' ') } : {}) }
}

/** A product sheet change of one offer column, as the bulk writer holds it. */
export interface SheetOfferChange { productId: string; field: string; value: unknown; reset?: boolean }

/**
 * The bulk writer's hook: each change on each Amazon context's listing (the coordinate's own row: product, market,
 * account, alias), the version the caller read — or the one a door already moved it to in this request.
 */
export async function writeSheetOfferChanges(input: {
  changes: SheetOfferChange[]
  contexts: ReadonlyArray<{ marketplace: string; channelConnectionId: string | null; aliasKey: string }>
  expectedVersion: number
  versionOf?: (listingId: string) => number | undefined
  actor: string
  permissions: OfferPermissionCheck
}): Promise<{ results: Array<AmazonOfferWriteOutcome & { change: SheetOfferChange }> }> {
  const destinations = input.changes.flatMap((change) => input.contexts.map((ctx) => ({ change, ...ctx })))
  if (!destinations.length) return { results: [] }
  const listings = await prisma.channelListing.findMany({ where: { OR: destinations.map((d) => ({
    productId: d.change.productId, channel: 'AMAZON', marketplace: d.marketplace, channelConnectionId: d.channelConnectionId, aliasKey: d.aliasKey,
  })) }, select: { id: true, productId: true, marketplace: true, channelConnectionId: true, aliasKey: true } })
  const results: Array<AmazonOfferWriteOutcome & { change: SheetOfferChange }> = []
  const edits: Array<AmazonOfferEdit & { change: SheetOfferChange }> = []
  for (const d of destinations) {
    const l = listings.find((x) => x.productId === d.change.productId && x.marketplace === d.marketplace && x.channelConnectionId === d.channelConnectionId && x.aliasKey === d.aliasKey)
    // Only a non-primary alias can get here (the bulk writer's draft step starts every missing primary listing).
    if (!l) {
      results.push({ change: d.change, listingId: '', lane: 'live', outcome: 'refused', version: 0,
        reason: `This listing alias has no Amazon listing on ${d.marketplace} for this product. An edit never creates an alias listing, so this offer value cannot be set here.` })
      continue
    }
    edits.push({ change: d.change, listingId: l.id, key: d.change.field, value: d.change.value, reset: d.change.reset, expectedVersion: input.versionOf?.(l.id) ?? input.expectedVersion })
  }
  if (results.length) return { results }
  const written = await writeAmazonOfferEdits({ edits, actor: input.actor, permissions: input.permissions })
  for (const e of edits) {
    const outcome = written.results.find((r) => r.listingId === e.listingId)!
    results.push({ ...outcome, change: e.change })
  }
  return { results }
}

/** Is this sheet change an Amazon offer draft column (never the generic channel write)? */
export const isAmazonOfferSheetField = (field: string): boolean => field.startsWith('attr_') && amazonOfferFieldFor(field)?.lane === 'draft'
/** The sentence when an offer column change comes without the listing version. */
export const OFFER_VERSION_REQUIRED = 'Amazon offer edits require the listing expectedVersion. Edit each listing with the version you read.'
