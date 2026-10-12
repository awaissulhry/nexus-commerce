/**
 * Amazon Business step 4 — the ONE Amazon business offer patch of a listing (PURE). What Nexus keeps
 * (`@nexus/shared/business-price`) against what Amazon holds now (the live `purchasable_offer` instances), as the patch
 * that changes only the business (audience `B2B`) instance of this market:
 *
 *   - Amazon holds one and it differs → `merge` with its selectors, `our_price` and `quantity_discount_plan` (`null`
 *     deletes the plan — https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer). The normal offer is not in
 *     the request.
 *   - Amazon holds none → `replace` with the whole root plus the new instance — Amazon's own example adds a B2B offer this
 *     way (manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases), and Amazon validated this shape on
 *     2026-10-12 (VALIDATION_PREVIEW, status VALID). The root is NOT Amazon's copy as read: it is THE offer builder's
 *     (`amazonPurchasableOffer`) — Nexus's own normal offer (price, sale, the leaves Nexus holds) laid over Amazon's live
 *     root, every other instance kept — so a read Amazon has not caught up with yet can never put an old normal price back.
 *   - Nexus keeps none (a person removed it) and Amazon holds one → `delete` with its selectors (the whole business offer).
 *   - Equal, or nothing on either side → nothing to send.
 */
import { businessTierPrices, readBusinessTiers, type BusinessPriceSetting, type BusinessTiers } from '@nexus/shared/business-price'

type Instance = Record<string, any>

/** The queue row kind the Amazon push sends a business offer for (`syncToAmazon`). */
export const BUSINESS_PRICE_SYNC_TYPE = 'BUSINESS_PRICE_UPDATE'

const decimal = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(typeof v === 'object' ? String(v) : v)
  return Number.isFinite(n) ? n : null
}
/** The setting a stored listing row holds (`ChannelListing.business*`), or `null` when Nexus keeps no business offer there. */
export function storedBusinessSetting(row: { businessPriceRule?: string | null; businessPricePercent?: unknown; businessPrice?: unknown; businessTiers?: unknown }): BusinessPriceSetting | null {
  if (row.businessPriceRule !== 'PERCENT_OFF' && row.businessPriceRule !== 'FIXED') return null
  return { rule: row.businessPriceRule, percent: decimal(row.businessPricePercent), price: decimal(row.businessPrice), tiers: readBusinessTiers(row.businessTiers) }
}
export type AmazonBusinessOfferPlan =
  | { kind: 'none' }
  | { kind: 'merge' | 'replace' | 'delete'; value: Instance[] }
  | { kind: 'refused'; reason: string }

const record = (v: unknown): Instance | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Instance : null)
const first = (v: unknown): Instance | null => (Array.isArray(v) ? record(v[0]) : null)
/** An instance of this market: its own `marketplace_id`, or none (a single-market answer), as the offer builder reads it. */
const ofMarket = (i: Instance | null | undefined, marketplaceId: string) => i != null && (i.marketplace_id == null || i.marketplace_id === marketplaceId)
const audienceOf = (i: Instance) => String(i.audience ?? 'ALL').toUpperCase()

/** The business instance Nexus sends: VAT-inclusive price, the market's currency, the tiers as Amazon names them. */
export function amazonBusinessElement(input: { marketplaceId: string; currency: string; price: number; tiers: BusinessTiers | null }): Instance {
  return {
    marketplace_id: input.marketplaceId,
    currency: input.currency,
    audience: 'B2B',
    our_price: [{ schedule: [{ value_with_tax: input.price }] }],
    quantity_discount_plan: input.tiers
      ? [{ schedule: [{ discount_type: input.tiers.type, levels: input.tiers.levels.map((l) => ({ lower_bound: l.minQty, value: l.value })) }] }]
      : null,
  }
}

/** The business instance Amazon holds for this market, or null. */
export function liveBusinessInstance(live: readonly Instance[], marketplaceId: string): Instance | null {
  return live.find((i) => ofMarket(i, marketplaceId) && audienceOf(i) === 'B2B') ?? null
}
/** The normal (audience ALL) instance Amazon holds for this market, or null. */
export function liveNormalInstance(live: readonly Instance[], marketplaceId: string): Instance | null {
  return live.find((i) => ofMarket(i, marketplaceId) && audienceOf(i) === 'ALL') ?? null
}

/** Price and plan only, in one comparable shape (Amazon may add fields Nexus does not send). */
export function comparable(instance: Instance | null) {
  if (!instance) return null
  const price = first(first(instance.our_price)?.schedule)
  const plan = first(first(instance.quantity_discount_plan)?.schedule)
  return JSON.stringify({
    price: price?.value_with_tax ?? price?.value ?? null,
    plan: plan ? { type: plan.discount_type ?? null, levels: Array.isArray(plan.levels) ? plan.levels.map((l: Instance) => [l?.lower_bound, l?.value]) : [] } : null,
  })
}

export function amazonBusinessOfferPlan(input: {
  wanted: Instance | null
  live: readonly Instance[]
  marketplaceId: string
  /**
   * The whole root THE offer builder makes for this push (Nexus's normal offer over Amazon's live root, every other
   * instance kept) — the base of a first business offer's replace. `null` = the builder makes none (no price).
   */
  normalRoot: readonly Instance[] | null
}): AmazonBusinessOfferPlan {
  const held = liveBusinessInstance(input.live, input.marketplaceId)
  if (!input.wanted) {
    if (!held) return { kind: 'none' }
    if (!held.currency) return { kind: 'refused', reason: 'Amazon\'s business offer names no currency, so Nexus cannot name it to remove it. Nothing was sent.' }
    return { kind: 'delete', value: [{ marketplace_id: input.marketplaceId, currency: held.currency, audience: 'B2B' }] }
  }
  if (held) {
    if (held.currency && held.currency !== input.wanted.currency) {
      return { kind: 'refused', reason: `Amazon holds this business offer in ${held.currency}, not ${input.wanted.currency}, so nothing was sent.` }
    }
    if (comparable(held) === comparable(input.wanted)) return { kind: 'none' }
    // A plan Amazon holds and Nexus does not: `null` deletes it. No plan on either side: the key stays out.
    const { quantity_discount_plan: plan, ...rest } = input.wanted
    return { kind: 'merge', value: [plan === null && !held.quantity_discount_plan ? rest : input.wanted] }
  }
  const normal = liveNormalInstance(input.live, input.marketplaceId)
  if (!normal || !input.normalRoot?.some((i) => ofMarket(i, input.marketplaceId) && audienceOf(i) === 'ALL')) {
    return { kind: 'refused', reason: 'Amazon holds no normal offer for this listing in this market, and a business price needs one, so nothing was sent.' }
  }
  if (normal.currency && normal.currency !== input.wanted.currency) {
    return { kind: 'refused', reason: `Amazon holds the normal offer in ${normal.currency}, not ${input.wanted.currency}, so no business offer was sent.` }
  }
  const { quantity_discount_plan: plan, ...rest } = input.wanted
  const others = input.normalRoot.filter((i) => !(ofMarket(i, input.marketplaceId) && audienceOf(i) === 'B2B'))
  return { kind: 'replace', value: [...others, plan === null ? rest : input.wanted] }
}

/** Do two business instances agree on price and plan? */
export const sameBusinessOffer = (a: Instance | null, b: Instance | null) => comparable(a) === comparable(b)

/** The tier prices a send would put on Amazon, for the job's own message. */
export function businessSendLine(price: number, tiers: BusinessTiers | null, currency: string): string {
  const base = `${currency} ${price.toFixed(2)}`
  if (!tiers) return base
  return `${base} · ${businessTierPrices(price, tiers).map((p, i) => `${tiers.levels[i]!.minQty}+ ${p.toFixed(2)}`).join(', ')}`
}
