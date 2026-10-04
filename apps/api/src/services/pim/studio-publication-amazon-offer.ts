/**
 * Amazon sheet gaps (D4=B, D5=B, D7=A) — the Publish offer lane of a LIVE Amazon listing (design-draft-and-remote §A).
 *
 * Offer facts saved on the sheet wait as a draft (`platformAttributes.amazonOfferDraft`, `amazon/offer-draft.ts`) and
 * go to Amazon only here. One review line per draft leaf, its field id = the sheet column key, with three values: the
 * saved one (sent), Nexus's live one (the promotion's base) and what Amazon shows now (the review read). Amazon equal to
 * Nexus live → SEND, ticked; Amazon different → DIFFERS, unticked, with its sentence; refusals by name.
 *
 * Each selected root goes out WHOLE, from the one builder (`amazon/offer-attributes.ts`): Amazon's current root from the
 * review read is the base, the selected leaves go on top, other instances (B2B, other markets) and sub-attributes Nexus
 * does not model are kept, one `replace` per root. The stored fulfilment base has no `quantity`: the quantity is the
 * stock job's (`amazon/send-quantity.ts`), injected when the feed is sent (`withSendQuantities`). Never a fulfilment
 * root on an FBA listing, and never one rebuilt over a code Nexus did not set (Remote Fulfilment, VCS, unknown).
 *
 * `planAmazonOfferLines` and `compileAmazonOffer` are pure; `amazonOfferLines` reads what the plan needs for one product;
 * `withSendQuantities` adds the stock job's quantity at delivery.
 */
import type { StudioPublishChange, StudioPublishChangeDisplay, StudioPublishValue } from '@nexus/shared/studio-publication'
import { pricingRuleLabel } from '@nexus/shared/listing-price'
import { describeAmazonFulfilmentCode, isFbaFulfilmentCode, normaliseAmazonFulfilmentCode } from '../../lib/amazon-fulfilment-programme.js'
import type { AttributePatch } from '../amazon/mapping-payload.js'
import {
  AMAZON_OFFER_LEAVES, FBA_FULFILMENT_REASON, FULFILMENT_LEAVES, PURCHASABLE_OFFER_LEAVES, amazonOfferFieldFor, amazonOfferKeysOf,
  amazonOfferLeafRefusal, dayOf, isAmazonDate, rootOfLeaf, type AmazonOfferLeaf,
} from '../amazon/offer-fields.js'
import { liveDraftValues, readAmazonOfferFacts, reportedOfferInstance, type AmazonOfferFacts } from '../amazon/offer-facts.js'
import { amazonOfferValuesEqual, readAmazonOfferDraft } from '../amazon/offer-draft.js'
import { amazonFulfillmentAvailability, amazonPurchasableOffer, amazonSellerBoundsRefusal } from '../amazon/offer-attributes.js'
import { loadAmazonSendQuantity } from '../amazon/send-quantity.js'
import { masterCurrency } from '../fx-rate.service.js'
import { priceBoundsOf, priceBoundsRefusal, type PriceBounds } from '../price-bounds.service.js'
import prisma from '../../db.js'
import { currencyCode, listingSendPrice } from './follower-price.js'
import { readSaleWindows } from './sale-window.js'
import { loadSharedInventoryTargets } from './shared-inventory-targets.js'
import type { PublicationChangeInput } from './studio-publication-changes.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication } from './studio-publication-amazon.js'

/** The two roots this lane owns on a live listing (the content review skips them; `list_price` is a normal root line). */
export const OFFER_ROOTS: ReadonlySet<string> = new Set(['purchasable_offer', 'fulfillment_availability'])
/** A review root the content lines must skip: one of the two roots, or an offer line's field id (journal writes name them). */
export const isOfferLaneRoot = (root: string): boolean => OFFER_ROOTS.has(root) || amazonOfferFieldFor(root)?.lane === 'draft'
/** The review field of one leaf: its sheet column key (the sale's value key). */
export const offerLineField = (leaf: AmazonOfferLeaf): string => amazonOfferKeysOf(leaf)[0]

export interface AmazonOfferLine {
  leaf: AmazonOfferLeaf
  /** The saved value Publish sends (the draft's shape). */
  value: unknown
  /** Nexus's live value at review (the draft's shape): the promotion's base. */
  base: unknown
  display: StudioPublishChangeDisplay
  /** The DIFFERS sentence (Amazon is not at Nexus's live value). */
  differs?: string
}

/** What a product's review keeps to compile its offer roots (stored with the change plan, so plain JSON). */
export interface AmazonOfferPlan {
  listingId: string
  marketplaceId: string
  currency: string
  /** The facts Publish sends: live with the draft on top. */
  facts: Pick<AmazonOfferFacts, 'values' | 'source' | 'fulfilmentCodes' | 'fbaByCode'>
  fba: boolean
  /** Amazon's roots from the review read; the fulfilment base without `quantity`. Null = Amazon has none. */
  base: { purchasable_offer: Record<string, unknown>[] | null; fulfillment_availability: Record<string, unknown>[] | null }
  /** The review's day: a restock date before it is never sent. */
  today: string
  lines: Record<string, AmazonOfferLine>
}

/** The journal's record of the offer a message carried (`request.offer`): the leaves sent, and Nexus's live value at review. */
export interface AmazonOfferJournal { leaves: Partial<Record<AmazonOfferLeaf, unknown>>; base: Partial<Record<AmazonOfferLeaf, unknown>> }

// ── Words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LABELS: Readonly<Record<AmazonOfferLeaf, string>> = {
  our_price: 'Price', sale: 'Sale price', minimum_seller_allowed_price: 'Minimum price', maximum_seller_allowed_price: 'Maximum price',
  map_price: 'MAP price', offer_start_at: 'Offer start', offer_end_at: 'Offer end', automated_pricing_rule_id: 'Automate Pricing rule',
  lead_time_to_ship_max_days: 'Handling time', restock_date: 'Restock date', is_inventory_available: 'Always available',
}
export const AUTOMATE_PRICING_WARNING = 'Automate Pricing: Amazon changes this price by your Seller Central rule, inside your minimum and maximum price. Nexus still sends its own price; the rule can change it again.'
export const ALWAYS_AVAILABLE_WARNING = 'Always available: Amazon ignores the quantity Nexus sends and keeps the offer buyable at any stock. Use it only for made-to-order items.'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const first = (v: unknown): Record<string, unknown> | null => record(Array.isArray(v) ? v[0] : null)
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'none')
const ymd = (v: string) => { const [y, m, d] = dayOf(v).split('-').map(Number); return { y, m, d } }
const day = (v: unknown, year = true) => {
  if (!isAmazonDate(v)) return 'none'
  const { y, m, d } = ymd(v)
  return year ? `${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`
}
const days = (n: unknown) => (typeof n === 'number' ? `${n} ${n === 1 ? 'day' : 'days'}` : 'none')
/** The first schedule entry of a scheduled offer sub-attribute (`our_price`, `discounted_price`, the bounds). */
const schedule = (sub: unknown) => first(first(sub)?.schedule)

/** One leaf's value (the draft's shape) in a few words: "44.90", "39.90, 10 Oct – 20 Oct", "3 days", "On". */
export function offerValueWords(leaf: AmazonOfferLeaf, value: unknown, ruleLabel = 'its pricing rule'): string {
  if (leaf === 'our_price') {
    const v = record(value)
    return v?.follow === true ? `follows ${ruleLabel}` : money(v ? v.pin : value)
  }
  if (value == null) return leaf === 'is_inventory_available' ? 'Off' : 'none'
  switch (leaf) {
    case 'sale': {
      const v = record(value) ?? {}
      const sameYear = isAmazonDate(v.start) && isAmazonDate(v.end) && ymd(v.start).y === ymd(v.end).y
      return `${money(v.price)}, ${day(v.start, !sameYear)} – ${day(v.end, !sameYear)}`
    }
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price': return money(value)
    case 'offer_start_at': case 'offer_end_at': case 'restock_date': return day(value)
    case 'lead_time_to_ship_max_days': return days(value)
    case 'is_inventory_available': return value === true ? 'On' : 'Off'
    default: return String(value)
  }
}

/** A leaf as Amazon would hold it, to compare live, saved and Amazon's: a price is `{ pin }` of the number sent. */
function sendable(leaf: AmazonOfferLeaf, values: AmazonOfferFacts['values']): unknown {
  if (leaf === 'our_price') return values.our_price.price == null ? null : { pin: values.our_price.price }
  if (leaf === 'sale') return values.sale && values.sale.start && values.sale.end ? { ...values.sale } : null
  return (values as unknown as Record<string, unknown>)[leaf] ?? null
}

/** What Amazon shows now: the one reader over Amazon's own roots (the review read), and Amazon's sale. */
function amazonValues(remote: Record<string, unknown>, marketplaceId: string): AmazonOfferFacts['values'] {
  const values = readAmazonOfferFacts({ marketplace: marketplaceId, platformAttributes: { attributes: {
    purchasable_offer: remote.purchasable_offer, fulfillment_availability: remote.fulfillment_availability } } }, 'job').values
  const sale = schedule(reportedOfferInstance(remote.purchasable_offer, marketplaceId)?.discounted_price)
  const text = (v: unknown) => (typeof v === 'string' ? v : null)
  return { ...values, sale: typeof sale?.value_with_tax === 'number' ? { price: sale.value_with_tax, start: text(sale.start_at), end: text(sale.end_at) } : null }
}

const rootOf = (v: unknown): Record<string, unknown>[] | null =>
  Array.isArray(v) ? (v as unknown[]).map(record).filter((x): x is Record<string, unknown> => !!x).map((x) => JSON.parse(JSON.stringify(x))) : null
const withoutQuantity = (root: Record<string, unknown>[] | null) => root?.map(({ quantity: _quantity, ...entry }) => entry) ?? null
const known = (value: unknown): StudioPublishValue => ({ state: 'value', value })
const BOUNDED: readonly AmazonOfferLeaf[] = ['our_price', 'sale', 'minimum_seller_allowed_price', 'maximum_seller_allowed_price']

export interface OfferLaneInput {
  productId: string
  sku: string
  isParent: boolean
  listingId: string
  marketplaceId: string
  /** The market's currency, and the master currency the floor and ceiling are in (`boundsApply`). */
  currency: string
  masterCurrency: string
  /** Live facts (job lane) and what Publish sends (publish lane: the draft on top). */
  live: AmazonOfferFacts
  publish: AmazonOfferFacts
  /** Amazon's attributes from the review read; null = not read (`refusal` says why). */
  remote: Record<string, unknown> | null
  refusal?: string
  /** The pricing rule and adjustment the listing follows. */
  rule: { pricingRule: string | null; priceAdjustmentPercent: unknown }
  /** The product's own floor and ceiling (master currency). */
  bounds: PriceBounds
  /** The stock job's verdict for this listing (`loadAmazonSendQuantity`), read when a fulfilment leaf waits. */
  quantity: { fba: boolean; refusal: string | null } | null
  /** The Amazon EU markets a fulfilment setting reaches (IT DE FR ES); one or none outside the EU group. */
  euMarkets: string[]
  today: string
}

/** PURE — the review lines of one live listing's offer draft, and what compiling them needs. */
export function planAmazonOfferLines(input: OfferLaneInput): { inputs: PublicationChangeInput[]; plan: AmazonOfferPlan | null } {
  const draft = input.publish.draft
  const leaves = AMAZON_OFFER_LEAVES.filter((leaf) => draft?.leaves[leaf])
  if (!draft || !leaves.length) return { inputs: [], plan: null }
  const ruleLabel = pricingRuleLabel(input.rule.pricingRule, input.rule.priceAdjustmentPercent as never)
  const words = (leaf: AmazonOfferLeaf, value: unknown) => offerValueWords(leaf, value, ruleLabel)
  const live = liveDraftValues(input.live)
  const amazon = input.remote ? amazonValues(input.remote, input.marketplaceId) : null
  // Without Amazon's roots the replace could not keep what Amazon holds: nothing can be sent.
  const readRefusal = input.refusal ?? (input.remote ? undefined : 'Amazon could not be read, so its offer cannot be kept whole.')
  const base = {
    purchasable_offer: input.remote ? rootOf(input.remote.purchasable_offer) : null,
    fulfillment_availability: input.remote ? withoutQuantity(rootOf(input.remote.fulfillment_availability)) : null,
  }
  const fba = input.quantity?.fba === true
  const values = input.publish.values

  // Root verdicts. An offer root with no price would clear Amazon's price. A fulfilment root is never built over FBA or
  // over a code Nexus did not set, and goes with the stock job's quantity (none → nothing can go with it).
  const offerLeaves = leaves.filter((l) => rootOfLeaf(l) === 'purchasable_offer')
  const noPrice = offerLeaves.length && input.remote && !amazonPurchasableOffer({ marketplaceId: input.marketplaceId, currency: input.currency,
    facts: input.publish, base: base.purchasable_offer ?? undefined, leaves: offerLeaves })
    ? 'Amazon shows no price for this offer, so its settings cannot be sent without one. Save a price on the sheet and publish them together.' : null
  const codes = [...input.publish.fulfilmentCodes, ...(base.fulfillment_availability ?? []).map((e) => normaliseAmazonFulfilmentCode(e.fulfillment_channel_code))].filter(Boolean)
  const kept = codes.map(describeAmazonFulfilmentCode).find((p) => p.readOnlyReason)
  // FBA: the caller's verdict, the guard's code test on the stored copies (D9 = A), or Amazon's current root from the review read.
  const liveFba = (base.fulfillment_availability ?? []).some((e) => isFbaFulfilmentCode(normaliseAmazonFulfilmentCode(e.fulfillment_channel_code)))
  const fulfilmentRefusal = kept?.readOnlyReason ?? (fba || input.publish.fbaByCode || liveFba ? FBA_FULFILMENT_REASON : input.quantity?.refusal ?? null)
  // The price Amazon would get: the product's floor and ceiling (master currency only), and Amazon's own bounds.
  const price = values.our_price.price
  const floor = price == null ? null : priceBoundsRefusal({ price, bounds: input.bounds, channel: 'Amazon', sku: input.sku, currency: input.currency, masterCurrency: input.masterCurrency })
  const sellerBounds = amazonSellerBoundsRefusal({ price, salePrice: sendable('sale', values) ? values.sale!.price : null,
    min: values.minimum_seller_allowed_price, max: values.maximum_seller_allowed_price, sku: input.sku })
  const euWords = input.euMarkets.length > 1 ? ` — all EU markets (${input.euMarkets.join(' ')}); sent with the current quantity` : ' — sent with the current quantity'
  const priceWords = (v: AmazonOfferFacts['values']) => v.our_price.mode === 'follow' && v.our_price.price != null
    ? `${money(v.our_price.price)} (follows ${ruleLabel})` : money(v.our_price.price)

  const inputs: PublicationChangeInput[] = []
  const lines: Record<string, AmazonOfferLine> = {}
  for (const leaf of leaves) {
    const field = offerLineField(leaf)
    const entry = draft.leaves[leaf]!
    const value = entry.value ?? null
    const fulfilment = rootOfLeaf(leaf) === 'fulfillment_availability'
    const ours = sendable(leaf, values), nexus = sendable(leaf, input.live.values), theirs = amazon ? sendable(leaf, amazon) : null
    const refusal = [readRefusal, input.isParent ? amazonOfferFieldFor(field)?.parentReason : null, amazonOfferLeafRefusal(leaf, value, input.today),
      fulfilment ? fulfilmentRefusal : noPrice, leaf === 'our_price' ? floor : null, BOUNDED.includes(leaf) ? sellerBounds : null].find((r): r is string => !!r)

    let label: string
    if (leaf === 'our_price') {
      const mode = record(value)?.follow === true ? ` — follows ${ruleLabel} again`
        : input.live.values.our_price.mode === 'follow' ? ` — pins this price (now follows ${ruleLabel})` : ''
      label = `Price · ${money(input.live.values.our_price.price)} → ${money(price)}${mode}`
    } else if (leaf === 'lead_time_to_ship_max_days') {
      label = `${LABELS[leaf]} · ${typeof live[leaf] === 'number' ? live[leaf] : 'none'} → ${days(value)}${euWords}`
    } else label = `${LABELS[leaf]} · ${words(leaf, live[leaf])} → ${words(leaf, value)}${fulfilment ? euWords : ''}`

    const notes: string[] = []
    if (!amazonOfferValuesEqual(leaf, entry.base, live[leaf])) notes.push(`Live changed since you saved: ${words(leaf, entry.base)} → ${words(leaf, live[leaf])}. Publish sends your saved value.`)
    if (leaf === 'automated_pricing_rule_id' && value != null) notes.push(AUTOMATE_PRICING_WARNING)
    if (leaf === 'is_inventory_available' && value === true) notes.push(ALWAYS_AVAILABLE_WARNING)
    const display: StudioPublishChangeDisplay = {
      current: leaf === 'our_price' ? priceWords(values) : words(leaf, value),
      lastAccepted: leaf === 'our_price' ? priceWords(input.live.values) : words(leaf, live[leaf]),
      channel: !amazon ? `Unknown — ${readRefusal}` : leaf === 'our_price' ? money(amazon.our_price.price) : words(leaf, theirs),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    }
    const differs = amazon && !amazonOfferValuesEqual(leaf, theirs, nexus)
      ? `Amazon shows ${display.channel}, not Nexus's live ${leaf === 'our_price' ? money(input.live.values.our_price.price) : display.lastAccepted} — a ${fulfilment ? 'stock' : 'price'} push may still be on its way, or it was changed in Seller Central.`
      : undefined
    lines[field] = { leaf, value, base: live[leaf] ?? null, display, ...(differs ? { differs } : {}) }
    inputs.push({ productId: input.productId, sku: input.sku, field, label, current: known(value), lastAccepted: known(live[leaf] ?? null),
      channel: amazon ? known(theirs) : { state: 'unknown', reason: readRefusal! },
      ...(amazon ? { currentMatchesChannel: amazonOfferValuesEqual(leaf, ours, theirs), acceptedMatchesChannel: amazonOfferValuesEqual(leaf, nexus, theirs) } : {}),
      ...(refusal ? { refusal } : {}) })
  }
  return { inputs, plan: { listingId: input.listingId, marketplaceId: input.marketplaceId, currency: input.currency,
    facts: { values, source: input.publish.source, fulfilmentCodes: input.publish.fulfilmentCodes, fbaByCode: input.publish.fbaByCode }, fba, base, today: input.today, lines } }
}

/**
 * One product's offer lines in the review (a live listing only; nothing is read for a listing with no draft): the
 * listing's sale window, the rule price a "follow again" draft sends, and — when a fulfilment setting waits — the stock
 * job's verdict and the EU markets it reaches. Keeps the plan on `product.offer` for the compile.
 */
export async function amazonOfferLines(facts: PublicationFacts, product: { productId: string; sku: string; offer?: AmazonOfferPlan },
  read: { marketplaceId: string; remote: Record<string, unknown> | null; refusal?: string }): Promise<PublicationChangeInput[]> {
  const listing = facts.listings.find((l) => l.productId === product.productId)
  const owner = facts.products.find((p) => p.id === product.productId)
  if (!listing || !owner || !readAmazonOfferDraft(listing.platformAttributes)) return []
  const saleWindow = (await readSaleWindows(prisma as never, [listing.id])).get(listing.id) ?? null
  const followPrice = listingSendPrice({ ...listing, followMasterPrice: true, priceOverride: null }, { masterPrice: owner.basePrice, marketCurrency: currencyCode(facts.destination.currency) }).price
  const live = readAmazonOfferFacts({ ...listing, saleWindow }, 'job')
  const publish = readAmazonOfferFacts({ ...listing, saleWindow }, 'publish', { followPrice })
  const fulfilment = FULFILMENT_LEAVES.some((leaf) => publish.draft?.leaves[leaf])
  const sent = fulfilment ? await loadAmazonSendQuantity(prisma as never, { listingId: listing.id }) : null
  const group = fulfilment ? await loadSharedInventoryTargets(prisma, { id: listing.id, productId: listing.productId, channel: listing.channel,
    marketplace: listing.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey, version: listing.version }) : null
  const planned = planAmazonOfferLines({ productId: product.productId, sku: product.sku, isParent: owner.isParent === true, listingId: listing.id,
    marketplaceId: read.marketplaceId, currency: String(facts.destination.currency ?? ''), masterCurrency: masterCurrency(), live, publish,
    remote: read.remote, refusal: read.refusal, rule: { pricingRule: listing.pricingRule, priceAdjustmentPercent: listing.priceAdjustmentPercent },
    bounds: priceBoundsOf(owner), quantity: sent && { fba: sent.fba, refusal: sent.refusal },
    euMarkets: group && 'targets' in group ? group.targets.map((t) => t.marketplace) : [listing.marketplace], today: new Date().toISOString().slice(0, 10) })
  if (planned.plan) product.offer = planned.plan
  return planned.inputs
}

/** The plan's words on its reviewed changes: the three values, and the DIFFERS sentence. Other changes are untouched. */
export function withOfferDisplay(changes: StudioPublishChange[], products: ReadonlyArray<{ productId: string; offer?: AmazonOfferPlan }>): StudioPublishChange[] {
  return changes.map((change) => {
    const line = products.find((p) => p.productId === change.productId)?.offer?.lines[change.field]
    if (!line) return change
    return { ...change, display: line.display, ...(change.status === 'DIFFERS' && change.selectable && line.differs ? { reason: line.differs } : {}) }
  })
}

/** The price, sale, minimum and maximum a built offer instance carries (what Amazon holds after the replace). */
function sentBounds(root: Record<string, unknown>[], marketplaceId: string) {
  const instance = reportedOfferInstance(root, marketplaceId)
  const amount = (sub: unknown) => { const v = schedule(sub)?.value_with_tax; return typeof v === 'number' ? v : null }
  return { price: amount(instance?.our_price), salePrice: amount(instance?.discounted_price),
    min: amount(instance?.minimum_seller_allowed_price), max: amount(instance?.maximum_seller_allowed_price) }
}

/**
 * PURE — the selected offer lines as whole-root patches (one `replace` per root) and the journal's record. Throws, by
 * name, what cannot be sent: a root the builder will not build, a price outside Amazon's bounds after the replace.
 */
export function compileAmazonOffer(plan: AmazonOfferPlan, fields: readonly string[], sku: string): { patches: AttributePatch[]; offer: AmazonOfferJournal } {
  const chosen = fields.map((field) => {
    const line = plan.lines[field]
    if (!line) throw new Error(`${field}: no reviewed Amazon offer line exists.`)
    return line
  })
  const leaves = chosen.map((line) => line.leaf)
  const patches: AttributePatch[] = []
  const offerLeaves = PURCHASABLE_OFFER_LEAVES.filter((l) => leaves.includes(l))
  if (offerLeaves.length) {
    const root = amazonPurchasableOffer({ marketplaceId: plan.marketplaceId, currency: plan.currency, facts: plan.facts, base: plan.base.purchasable_offer ?? undefined, leaves: offerLeaves })
    if (!root) throw new Error(`${sku}: select the price with its offer settings — Amazon shows no price for this offer.`)
    const refusal = amazonSellerBoundsRefusal({ ...sentBounds(root, plan.marketplaceId), sku })
    if (refusal) throw new Error(refusal)
    patches.push({ op: 'replace', path: '/attributes/purchasable_offer', value: root })
  }
  const fulfilmentLeaves = FULFILMENT_LEAVES.filter((l) => leaves.includes(l))
  if (fulfilmentLeaves.length) {
    const root = amazonFulfillmentAvailability({ facts: plan.facts, fba: plan.fba, live: true, base: plan.base.fulfillment_availability ?? undefined, leaves: fulfilmentLeaves, today: plan.today })
    if (!root) throw new Error(`${sku}: ${FBA_FULFILMENT_REASON}`)
    patches.push({ op: 'replace', path: '/attributes/fulfillment_availability', value: root })
  }
  return { patches, offer: {
    leaves: Object.fromEntries(chosen.map((line) => [line.leaf, line.value])),
    base: Object.fromEntries(chosen.map((line) => [line.leaf, line.base])),
  } }
}

/**
 * At delivery — a reviewed fulfilment root goes with the stock job's quantity at the moment it is sent
 * (`loadAmazonSendQuantity`), never a number frozen into the review (the stored base has none). A merchant entry with no
 * quantity gets it; none to send (FBA now, a refusal) → nothing is sent (`notSent`). Runs before the journal records the
 * request and before the FBA boundary (both inside `sendAmazonPublication`), so both see exactly what goes out.
 */
export async function withSendQuantities(plan: AmazonPublication, destination: { marketplace: string; accountId: string; aliasKey: string }): Promise<AmazonPublication> {
  const merchant = (entry: unknown) => {
    const e = record(entry)
    return !!e && Object.keys(e).length > 0 && e.quantity == null && ['', 'DEFAULT', 'MFN'].includes(normaliseAmazonFulfilmentCode(e.fulfillment_channel_code))
  }
  const isRoot = (p: AttributePatch | undefined) => p?.op === 'replace' && p.path === '/attributes/fulfillment_availability'
  const messages: AmazonPublication['feed']['messages'] = []
  for (const message of plan.feed.messages) {
    const roots = [record(message.attributes)?.fulfillment_availability, ...(message.patches ?? []).filter(isRoot).map((p) => p.value)]
    if (!roots.some((root) => Array.isArray(root) && root.some(merchant))) { messages.push(message); continue }
    const productId = plan.products.find((p) => p.sku === message.sku)?.productId
    const listing = productId ? await prisma.channelListing.findFirst({ where: { productId, channel: 'AMAZON', marketplace: destination.marketplace,
      channelConnectionId: destination.accountId, aliasKey: destination.aliasKey }, select: { id: true } }) : null
    const sent = listing ? await loadAmazonSendQuantity(prisma as never, { listingId: listing.id }) : null
    if (sent?.quantity == null) throw Object.assign(new Error(`${message.sku}: ${sent?.fba ? FBA_FULFILMENT_REASON : sent?.refusal ?? 'its listing was not found, so no quantity was worked out.'}`), { notSent: true })
    const withQuantity = (root: unknown) => (Array.isArray(root) ? root.map((entry) => (merchant(entry) ? { ...record(entry), quantity: sent.quantity } : entry)) : root)
    messages.push({ ...message,
      ...(message.attributes?.fulfillment_availability ? { attributes: { ...message.attributes, fulfillment_availability: withQuantity(message.attributes.fulfillment_availability) } } : {}),
      ...(message.patches ? { patches: message.patches.map((p) => (isRoot(p) ? { ...p, value: withQuantity(p.value) } : p)) } : {}) })
  }
  return { ...plan, feed: { ...plan.feed, messages } }
}
