/**
 * Amazon Business step 4 — the ONE Amazon business offer patch of a listing (PURE). What Nexus keeps
 * (`@nexus/shared/business-price`) against what Amazon holds now (the live `purchasable_offer` instances), as the patch
 * that changes only the business (audience `B2B`) instance of this market:
 *
 *   - Amazon holds one and it differs → `merge` with its selectors, `our_price` and `quantity_discount_plan` (`null`
 *     deletes the plan — https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer). The normal offer is not in
 *     the request.
 *   - Amazon holds none → `replace` with EVERY live instance verbatim plus the new one. Amazon documents no merge that
 *     creates an instance; this exact shape was Amazon-validated on 2026-10-12 (VALIDATION_PREVIEW, status VALID).
 *   - Nexus keeps none any more and Amazon holds one → `delete` with its selectors (the whole business offer).
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
/** The setting a stored listing row holds (`ChannelListing.business*`), or `null` when Nexus manages no business offer there. */
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
  return live.find((i) => i?.audience === 'B2B' && i?.marketplace_id === marketplaceId) ?? null
}

/** Price and plan only, in one comparable shape (Amazon may add fields Nexus does not send). */
function comparable(instance: Instance | null) {
  if (!instance) return null
  const price = first(first(instance.our_price)?.schedule)
  const plan = first(first(instance.quantity_discount_plan)?.schedule)
  return JSON.stringify({
    price: price?.value_with_tax ?? price?.value ?? null,
    plan: plan ? { type: plan.discount_type ?? null, levels: Array.isArray(plan.levels) ? plan.levels.map((l: Instance) => [l?.lower_bound, l?.value]) : [] } : null,
  })
}

export function amazonBusinessOfferPlan(input: { wanted: Instance | null; live: readonly Instance[]; marketplaceId: string }): AmazonBusinessOfferPlan {
  const held = liveBusinessInstance(input.live, input.marketplaceId)
  if (!input.wanted) {
    return held ? { kind: 'delete', value: [{ marketplace_id: held.marketplace_id, currency: held.currency, audience: 'B2B' }] } : { kind: 'none' }
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
  if (!input.live.some((i) => i?.marketplace_id === input.marketplaceId && (i?.audience ?? 'ALL') === 'ALL')) {
    return { kind: 'refused', reason: 'Amazon holds no normal offer for this listing in this market, and a business price needs one, so nothing was sent.' }
  }
  const { quantity_discount_plan: plan, ...rest } = input.wanted
  return { kind: 'replace', value: [...input.live, plan === null ? rest : input.wanted] }
}

/** The tier prices a send would put on Amazon, for the job's own message. */
export function businessSendLine(price: number, tiers: BusinessTiers | null, currency: string): string {
  const base = `${currency} ${price.toFixed(2)}`
  if (!tiers) return base
  return `${base} · ${businessTierPrices(price, tiers).map((p, i) => `${tiers.levels[i]!.minQty}+ ${p.toFixed(2)}`).join(', ')}`
}
