/**
 * Amazon Business (step 5) — the business price editor's rules, PURE: what the B2B price pop-up starts from, how its
 * fields read, what Amazon would refuse (held Save), what only deserves a word (a warning), and the sentences of a save.
 *
 * The refusals and warnings are `@nexus/shared/business-price`'s, the same rules the server's door applies — so the
 * pop-up holds Save on exactly what the door would refuse, and the door still decides. Every number the cell already
 * shows (the normal price the push sends, the listing's minimum and maximum price) is the server's (`BusinessCell`).
 */
import { roundCents } from '@nexus/shared/listing-price'
import {
  BUSINESS_TIER_MIN_QTY,
  BUSINESS_TIERS_MAX,
  businessPriceOf,
  businessPriceProblems,
  businessPriceWarnings,
  businessTierPrices,
  type BusinessPriceSetting,
  type BusinessTierType,
} from '@nexus/shared/business-price'
import { matrixBusinessSettingOfCell, matrixMoney, matrixNumberText, matrixPercent } from '@/design-system/grid'

import type { BusinessCell } from './contract'

/** The price rule the pop-up edits: a percent below the price, an exact price, or no business price. */
export type BusinessMode = 'percent' | 'exact' | 'none'

/** One quantity discount as typed. `key` keeps a row's identity while rows are added and removed. */
export interface TierDraft { key: string; minQty: string; value: string }

export interface BusinessDraft {
  mode: BusinessMode
  percent: string
  exact: string
  tierType: BusinessTierType
  /** `[]` = no quantity discounts. */
  tiers: TierDraft[]
}

export const BUSINESS_DIALOG_COPY = {
  rule: 'Business price',
  percent: '% below the price',
  exact: 'Exact price',
  none: 'None',
  noneLine: 'Business buyers see the normal price. Nexus removes the business price from Amazon.',
  tiers: 'Quantity discounts',
  tierPercent: '% off',
  tierFixed: 'Price per unit',
  fromQty: 'From (units)',
  discount: 'Discount',
  unitPrice: 'Price per unit',
  pays: 'Buyer pays',
  add: 'Add quantity discount',
  max: `Amazon takes up to ${BUSINESS_TIERS_MAX} quantity discounts.`,
  remove: 'Remove this discount',
  noTiers: 'No quantity discounts.',
  fixedNeedsExact: 'A price per unit goes with an exact business price.',
} as const

/** The suggestions a new quantity discount starts from (the Owner's earlier pick: 2 / 5 / 10 units → 3 / 5 / 8 %). */
const SUGGESTED_QTY = [2, 5, 10, 25, 50] as const
const SUGGESTED_PERCENT = [3, 5, 8, 10, 12] as const
/** A new business price starts 5 % below the price (Claude's advice, 2026-10-12). */
export const BUSINESS_DEFAULT_PERCENT = 5

let tierSeq = 0
const tierKey = (): string => `t${++tierSeq}`
/** A quantity discount row as typed, with its own key. */
export const tierDraft = (minQty: string, value: string): TierDraft => ({ key: tierKey(), minQty, value })

const numText = (v: number | null | undefined): string => (v == null ? '' : String(v))

/** What Nexus keeps for this listing now, in the door's own shape; `null` = no business price. The engine's one rule. */
export const businessSettingOf = (b: BusinessCell): BusinessPriceSetting | null => matrixBusinessSettingOfCell(b)

/**
 * The fields the pop-up opens with — the setting Nexus keeps, else a default for every choice: Amazon's own business
 * price when it shows one Nexus never kept (Save then keeps it in Nexus), else 5 % below the price.
 */
export function businessDraftOf(b: BusinessCell): BusinessDraft {
  const tiers = b.rule != null && b.tiers ? b.tiers.levels.map((l) => ({ key: tierKey(), minQty: String(l.minQty), value: String(l.value) })) : []
  const tierType: BusinessTierType = b.rule != null && b.tiers ? b.tiers.type : 'percent'
  if (b.rule === 'FIXED') return { mode: 'exact', percent: String(BUSINESS_DEFAULT_PERCENT), exact: numText(b.exact), tierType, tiers }
  if (b.rule === 'PERCENT_OFF') return { mode: 'percent', percent: numText(b.percent), exact: '', tierType, tiers }
  if (b.reported) return { mode: 'exact', percent: String(BUSINESS_DEFAULT_PERCENT), exact: numText(b.reported.price), tierType, tiers }
  return { mode: 'percent', percent: String(BUSINESS_DEFAULT_PERCENT), exact: '', tierType, tiers }
}

/** A number as typed: `5`, `5,5`, `5.5 %`, `€32.95`; `undefined` when it is no number (or reads two ways). */
function typedNumber(text: string): number | undefined {
  const t = text.trim().replace(/\s*%$/, '')
  if (t === '') return undefined
  return matrixNumberText(t)
}

/**
 * A new quantity discount: the next suggested quantity above the last one, and the next suggested discount (a percent,
 * or — for a price per unit — that percent below the business price, to the cent; none when there is no one price, as in
 * the bulk Edit, where each listing has its own).
 */
export function nextTier(draft: { tierType: BusinessTierType; tiers: readonly TierDraft[] }, businessPrice: number | null): TierDraft {
  const i = draft.tiers.length
  const lastQty = typedNumber(draft.tiers[i - 1]?.minQty ?? '') ?? 0
  const qty = SUGGESTED_QTY.find((q) => q > lastQty) ?? lastQty + 10
  const percent = SUGGESTED_PERCENT[Math.min(i, SUGGESTED_PERCENT.length - 1)]!
  const value = draft.tierType === 'percent' ? String(percent) : businessPrice != null ? String(roundCents(businessPrice * (1 - percent / 100))) : ''
  return { key: tierKey(), minQty: String(qty), value }
}

export interface BusinessParsed {
  /** The setting the fields say; `null` = no business price. Undefined while a field is no number. */
  setting: BusinessPriceSetting | null | undefined
  /** A field that is no number, by field: `percent` · `exact` · `<tier key>:minQty` · `<tier key>:value`. */
  fieldProblems: Map<string, string>
  /** What Amazon would refuse (Save is held): the shared rules, as the door applies them. */
  problems: string[]
  /** Saved, but worth a word: the shared warnings (a sale below the business price, a price Amazon hides). */
  warnings: string[]
  /** The business price the setting gives now; null when it cannot be known. */
  price: number | null
  /** Each tier's unit price now, in row order; null when it cannot be known. */
  unitPrices: Array<number | null>
}

/** Reads the fields, and checks them against Amazon's rules with the listing's own numbers. */
export function parseBusinessDraft(draft: BusinessDraft, b: BusinessCell, salePrice: number | null): BusinessParsed {
  const fieldProblems = new Map<string, string>()
  const none: BusinessParsed = { setting: undefined, fieldProblems, problems: [], warnings: [], price: null, unitPrices: draft.tiers.map(() => null) }
  if (draft.mode === 'none') return { ...none, setting: null, unitPrices: [] }

  const percent = draft.mode === 'percent' ? typedNumber(draft.percent) : null
  const exact = draft.mode === 'exact' ? typedNumber(draft.exact) : null
  if (percent === undefined) fieldProblems.set('percent', 'Write a percent, for example 5.')
  if (exact === undefined) fieldProblems.set('exact', 'Write a price, for example 32.95.')
  const levels = draft.tiers.map((t) => {
    const minQty = typedNumber(t.minQty)
    const value = typedNumber(t.value)
    if (minQty === undefined) fieldProblems.set(`${t.key}:minQty`, `Write a number of units, ${BUSINESS_TIER_MIN_QTY} or more.`)
    if (value === undefined) fieldProblems.set(`${t.key}:value`, draft.tierType === 'percent' ? 'Write a percent, for example 3.' : 'Write a price, for example 30.')
    return { minQty: minQty ?? NaN, value: value ?? NaN }
  })
  if (fieldProblems.size > 0) return none

  const setting: BusinessPriceSetting = {
    rule: draft.mode === 'percent' ? 'PERCENT_OFF' : 'FIXED',
    percent: draft.mode === 'percent' ? (percent as number) : null,
    price: draft.mode === 'exact' ? (exact as number) : null,
    tiers: levels.length ? { type: draft.tierType, levels } : null,
  }
  const problems = businessPriceProblems({ setting, normalPrice: b.normalPrice, minPrice: b.minPrice, maxPrice: b.maxPrice, currency: b.currency })
  const warnings = businessPriceWarnings({ setting, normalPrice: b.normalPrice, salePrice, currency: b.currency })
  const price = businessPriceOf(setting, b.normalPrice)
  const unitPrices = setting.tiers && price != null ? businessTierPrices(price, setting.tiers) : levels.map(() => null)
  return { setting, fieldProblems, problems, warnings, price, unitPrices }
}

const sameSetting = (a: BusinessPriceSetting | null, b: BusinessPriceSetting | null): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Why Save is held, or `null` when it may save. A field problem and an Amazon refusal are said where they are. */
export function businessSaveHeld(parsed: BusinessParsed, b: BusinessCell): string | null {
  if (parsed.setting === undefined) return 'Fix the marked field first'
  if (parsed.problems.length) return 'Amazon would refuse this'
  if (sameSetting(parsed.setting, businessSettingOf(b))) return 'Nothing to change'
  return null
}

/** The Save button's word: Remove when the setting goes away. */
export const businessSaveLabel = (parsed: BusinessParsed): string => (parsed.setting === null ? 'Remove' : 'Save')

/** `€99.75 (5% below €105.00)` · `€32.95` · `5% below the price` · `No business price` — one setting in words. */
export function businessSettingText(setting: BusinessPriceSetting | null, normalPrice: number | null, currency: string): string {
  if (!setting) return 'No business price'
  const money = (v: number | null) => matrixMoney(v, currency)
  const price = businessPriceOf(setting, normalPrice)
  let text: string
  if (setting.rule === 'FIXED') text = money(setting.price)
  else if (!setting.percent) text = price != null ? `${money(price)} (the price itself)` : 'the price itself'
  else text = price != null && normalPrice != null ? `${money(price)} (${matrixPercent(setting.percent)} below ${money(normalPrice)})` : `${matrixPercent(setting.percent)} below the price`
  const n = setting.tiers?.levels.length ?? 0
  return n ? `${text} · ${n} quantity discount${n === 1 ? '' : 's'}` : text
}

/** The toast after a save: what was set, where, and that Nexus sends it. */
export function businessSavedSentence(sku: string, where: string, setting: BusinessPriceSetting | null, b: BusinessCell): string {
  if (!setting) return `Business price removed · ${sku} · ${where}. Nexus removes it from Amazon.`
  return `Business price · ${sku} · ${where}: ${businessSettingText(setting, b.normalPrice, b.currency)}. ${b.held ?? 'Nexus sends it to Amazon.'}`
}

/**
 * The setting an Undo writes back, or `null` when there is none to offer: a listing whose business price was set
 * outside Nexus has no setting Nexus could put back — an Undo would remove Amazon's own price instead.
 */
export function businessUndoOf(b: BusinessCell): { setting: BusinessPriceSetting | null } | null {
  if (b.rule == null && b.reported) return null
  return { setting: businessSettingOf(b) }
}
