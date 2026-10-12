/**
 * Amazon Business (B2B) — the business price and quantity tiers of ONE Amazon listing (one SKU in one market).
 * PURE: the API's door and, later, the Matrix screen read the same rules.
 *
 * Stored on `ChannelListing` (`businessPriceRule`, `businessPricePercent`, `businessPrice`, `businessTiers`); no rule = no
 * business offer (a removal reaches Amazon too):
 *   - PERCENT_OFF — the normal send price − X %, rounded to the cent. It follows every normal price change and is never
 *     taken from the sale price. 0 % = the normal price (quantity discounts only).
 *   - FIXED — an exact price.
 *   - tiers — Amazon's `quantity_discount_plan`: 1 to 5 levels, `percent` (off the business price) or `fixed` (a unit
 *     price at that quantity). Fixed tiers go with an exact business price only: a percent business price moves with the
 *     normal price, and a fixed tier would soon stop being cheaper than it.
 *
 * The rules are Amazon's, from the seller-scoped product type schema (read 2026-10-12) and help pages G201995470,
 * G201824530 and G201812760 (~/nexus-archive/2026-10-12-amazon-business-b2b/A-amazon-rules.md). Nexus refuses only
 * what Amazon would refuse or hide anyway; the rest saves, with a warning when Amazon's answer is not documented.
 */
import { roundCents } from './listing-price.js'

export type BusinessPriceRuleName = 'PERCENT_OFF' | 'FIXED'
export type BusinessTierType = 'percent' | 'fixed'
export interface BusinessTierLevel { minQty: number; value: number }
export interface BusinessTiers { type: BusinessTierType; levels: BusinessTierLevel[] }

/** What Nexus keeps for one listing. `null` (no setting) = no business offer there. */
export interface BusinessPriceSetting {
  rule: BusinessPriceRuleName
  /** PERCENT_OFF only: 0–99, two decimals. */
  percent: number | null
  /** FIXED only: the exact price (market currency, VAT included like the normal price). */
  price: number | null
  tiers: BusinessTiers | null
}

export const BUSINESS_TIERS_MAX = 5
export const BUSINESS_TIER_MIN_QTY = 2
export const BUSINESS_PERCENT_MAX = 99

const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const twoDecimals = (v: number) => roundCents(v) === v

/** The business price this listing sends, or `null` when it cannot be known (a percent of a listing with no normal price). */
export function businessPriceOf(setting: BusinessPriceSetting, normalPrice: number | null): number | null {
  if (setting.rule === 'FIXED') return isMoney(setting.price) ? setting.price : null
  if (!isMoney(setting.percent) || !isMoney(normalPrice) || normalPrice <= 0) return null
  return roundCents(normalPrice * (1 - setting.percent / 100))
}

/** Each tier's unit price: a percent off the business price, or the fixed price as given. */
export function businessTierPrices(businessPrice: number, tiers: BusinessTiers): number[] {
  return tiers.levels.map((l) => (tiers.type === 'percent' ? roundCents(businessPrice * (1 - l.value / 100)) : l.value))
}

/** The stored `businessTiers` JSON, read tolerantly: `null` when it is absent or not a tiers object. */
export function readBusinessTiers(raw: unknown): BusinessTiers | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { type, levels } = raw as { type?: unknown; levels?: unknown }
  if ((type !== 'percent' && type !== 'fixed') || !Array.isArray(levels)) return null
  return {
    type,
    levels: levels.flatMap((l) => {
      const { minQty, value } = (l ?? {}) as { minQty?: unknown; value?: unknown }
      return typeof minQty === 'number' && typeof value === 'number' ? [{ minQty, value }] : []
    }),
  }
}

/** The tiers' own shape, without prices: count, quantities, percent range, order. */
function tierShapeProblems(tiers: BusinessTiers): string[] {
  if (tiers.type !== 'percent' && tiers.type !== 'fixed') return ['Quantity discounts are a percent or a fixed price per unit.']
  const levels = Array.isArray(tiers.levels) ? tiers.levels : []
  if (levels.length < 1 || levels.length > BUSINESS_TIERS_MAX) return [`Amazon takes 1 to ${BUSINESS_TIERS_MAX} quantity discounts; this has ${levels.length}.`]
  const out: string[] = []
  levels.forEach((l, i) => {
    if (!Number.isInteger(l.minQty) || l.minQty < BUSINESS_TIER_MIN_QTY) out.push(`Discount ${i + 1}: the quantity must be a whole number of at least ${BUSINESS_TIER_MIN_QTY}.`)
    if (i > 0 && !(l.minQty > levels[i - 1]!.minQty)) out.push(`Discount ${i + 1}: each quantity must be higher than the one before.`)
    if (tiers.type === 'percent') {
      if (!isMoney(l.value) || l.value < 0.01 || l.value > BUSINESS_PERCENT_MAX || !twoDecimals(l.value)) out.push(`Discount ${i + 1}: a percent from 0.01 to ${BUSINESS_PERCENT_MAX}, at most two decimals.`)
      else if (i > 0 && !(l.value > levels[i - 1]!.value)) out.push(`Discount ${i + 1}: each percent must be bigger than the one before.`)
    } else {
      if (!isMoney(l.value) || l.value <= 0 || !twoDecimals(l.value)) out.push(`Discount ${i + 1}: a price above 0, at most two decimals.`)
      else if (i > 0 && !(l.value < levels[i - 1]!.value)) out.push(`Discount ${i + 1}: each price must be lower than the one before.`)
    }
  })
  return out
}

/**
 * Every reason Amazon would refuse (or hide) this setting; `[]` = it can be saved. `normalPrice` is the listing's normal
 * send price; `minPrice` / `maxPrice` are its Amazon minimum and maximum seller-allowed prices, when set.
 */
export function businessPriceProblems(input: {
  setting: BusinessPriceSetting
  normalPrice: number | null
  minPrice?: number | null
  maxPrice?: number | null
  currency?: string | null
}): string[] {
  const { setting } = input
  const cur = input.currency ? `${input.currency} ` : ''
  const money = (v: number) => `${cur}${v.toFixed(2)}`
  const out: string[] = []
  if (setting.rule === 'PERCENT_OFF') {
    if (!isMoney(setting.percent) || setting.percent < 0 || setting.percent > BUSINESS_PERCENT_MAX || !twoDecimals(setting.percent)) {
      out.push(`The business discount must be a percent from 0 to ${BUSINESS_PERCENT_MAX}, at most two decimals.`)
    }
  } else if (!isMoney(setting.price) || setting.price <= 0 || !twoDecimals(setting.price)) {
    out.push('The business price must be above 0, at most two decimals.')
  }
  if (!isMoney(input.normalPrice) || input.normalPrice <= 0) {
    out.push('This listing has no normal price, and Amazon needs one before a business price.')
  }
  if (setting.tiers) out.push(...tierShapeProblems(setting.tiers))
  if (setting.rule === 'PERCENT_OFF' && setting.tiers?.type === 'fixed') {
    out.push('Fixed quantity prices go with an exact business price: a percent business price moves with the normal price. Use percent discounts, or an exact business price.')
  }
  if (out.length) return out

  const normal = input.normalPrice as number
  const business = businessPriceOf(setting, normal) as number
  if (business > normal) out.push(`The business price ${money(business)} is above the normal price ${money(normal)}: Amazon would not show it to business buyers.`)
  if (isMoney(input.minPrice) && business < input.minPrice) out.push(`The business price ${money(business)} is below this listing's minimum price ${money(input.minPrice)}: Amazon refuses it.`)
  if (isMoney(input.maxPrice) && business > input.maxPrice) out.push(`The business price ${money(business)} is above this listing's maximum price ${money(input.maxPrice)}: Amazon refuses it.`)
  if (setting.tiers) {
    const prices = businessTierPrices(business, setting.tiers)
    if (setting.tiers.type === 'fixed' && !(prices[0]! < business)) out.push(`Discount 1: ${money(prices[0]!)} must be lower than the business price ${money(business)}.`)
    const lowest = Math.min(...prices)
    if (lowest < 0.01) out.push(`A quantity discount reaches ${money(lowest)}: every price must be above 0.`)
    else if (isMoney(input.minPrice) && lowest < input.minPrice) out.push(`A quantity discount reaches ${money(lowest)}, below this listing's minimum price ${money(input.minPrice)}: Amazon refuses it.`)
  }
  return out
}

/**
 * What saves but deserves a word: a Nexus sale below the business price (Amazon does not document what business buyers
 * then see), and — once the normal price has moved — a FIXED price or a fixed tier Amazon now hides.
 */
export function businessPriceWarnings(input: {
  setting: BusinessPriceSetting
  normalPrice: number | null
  salePrice?: number | null
  currency?: string | null
}): string[] {
  const cur = input.currency ? `${input.currency} ` : ''
  const money = (v: number) => `${cur}${v.toFixed(2)}`
  const business = businessPriceOf(input.setting, input.normalPrice)
  if (business == null) return []
  const out: string[] = []
  if (isMoney(input.normalPrice) && business > input.normalPrice) out.push(`Hidden by Amazon: the business price ${money(business)} is above the normal price ${money(input.normalPrice)}.`)
  if (input.setting.tiers?.type === 'fixed') {
    const prices = businessTierPrices(business, input.setting.tiers)
    if (!(prices[0]! < business)) out.push(`Hidden by Amazon: discount 1 (${money(prices[0]!)}) is not lower than the business price ${money(business)}.`)
  }
  if (isMoney(input.salePrice) && input.salePrice < business) out.push(`The sale price ${money(input.salePrice)} is lower than the business price ${money(business)}; Amazon does not say which one business buyers then see.`)
  return out
}
