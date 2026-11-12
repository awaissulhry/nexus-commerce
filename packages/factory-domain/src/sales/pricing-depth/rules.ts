import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode, minorPlaces, UNIT_PRICE, type CurrencyCode } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { PRODUCT_TYPES, type ProductType } from '../../product/styles/rules'
import { decimalText } from '../../product/units/units'
import { Dec, HUNDRED, parseDecimal, type Decimal } from '../../tax/decimal'
import { listPriceText } from '../pricelists/pricelists'

/**
 * Price lists in depth (B-W2b-325; SAL-166, SAL-167, SAL-178, SAL-180; design record "Price list" › Breaks & surcharges,
 * Prices › Valid from–to), pure: the rules of what a price list version holds beside its prices (factory-db
 * sales-pricing.prisma PriceBreak, SizeSurcharge, MoqRule; pricing.prisma PriceListEntry.validFrom / validTo), checked
 * before anything is written. The database checks each row on its own (…_sales_pricing_w2b_guards); what needs several
 * rows (one break per quantity, entries that never overlap, one minimum per subject) is checked here.
 *
 *   quantity breaks   a version's: of one entry (a unit price, or a discount off the entry's price) or of every entry of
 *                     the version (a discount only), from 2 pieces on; one per entry (or the version) and quantity
 *   dated prices      a version's entries of one style and colourway hold on days that never overlap (validFrom and
 *                     validTo, either open; both open: the whole version) — a season's price, an announced increase
 *   size surcharges   an amount (in the list's currency) or a percent of the unit price, per size: of a version (every
 *                     style of it, or one style) or of a style (whatever list prices it)
 *   minimums          a minimum order quantity of a style, a kind of garment or a material, per document, colourway or
 *                     line; BLOCK refuses the quote or order, WARN says it, SURCHARGE asks a small-run surcharge
 */

export const PRICING_DEPTH_LIMITS = {
  /** Rows one write may send. */
  rows: 500,
  /** The pieces a break or a minimum may name. */
  maxQuantity: 1_000_000,
  note: 500,
  /** A size code as the database takes it: 1 to 40 characters, no space. */
  size: 40,
} as const

const PCT = { precision: 7, scale: 4 } as const
const SIZE = /^\S{1,40}$/

const positivePrice = (value: string | null): boolean => {
  const parsed = value === null ? null : parseDecimal(value)
  return parsed !== null && fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale) && parsed.gt(0)
}
const pctIn = (value: string | null, max: number, maxIncluded: boolean): boolean => {
  const parsed = value === null ? null : parseDecimal(value)
  return parsed !== null && fitsDecimal(value, PCT.precision, PCT.scale) && parsed.gt(0) && (maxIncluded ? parsed.lte(max) : parsed.lt(max))
}
const wholeQuantity = (value: number): boolean => Number.isSafeInteger(value) && value >= 2 && value <= PRICING_DEPTH_LIMITS.maxQuantity

/** A size code as stored: trimmed, capitals. */
export const sizeCodeOf = (value: string): string => value.trim().toUpperCase()

/** A price, a percent or an amount as the API answers it: no trailing zeros. */
export const pctText = (value: string): string => decimalText(new Dec(value).toDecimalPlaces(PCT.scale, Dec.ROUND_HALF_UP))

/** An amount rounded to the currency's minor unit (what a percent of a price makes), as text. */
export function toMinor(value: Decimal, currency: CurrencyCode): string {
  const places = isCurrencyCode(currency) ? minorPlaces(currency) : 2
  return decimalText(value.toDecimalPlaces(places, Dec.ROUND_HALF_UP).toFixed(places))
}

// ---- quantity breaks (SAL-166) -----------------------------------------------------------------------------------------

export interface BreakInput {
  /** The entry it prices; null: every entry of the version (then a discount). */
  readonly entryId: string | null
  readonly minQuantity: number
  /** Both null: the break at this quantity is removed. */
  readonly unitPrice: string | null
  readonly discountPct: string | null
}

export const breakKey = (entryId: string | null, minQuantity: number): string => `${entryId ?? '*'}:${minQuantity}`

/**
 * A change of a version's breaks, checked: at most PRICING_DEPTH_LIMITS.rows rows, each once (entry and quantity), from
 * 2 pieces on, a unit price above 0 (6 decimals at most) or a discount above 0 and below 100 (4 decimals), exactly one —
 * or neither, to remove it; a break of every entry is a discount. `entryPrices` (entry → its unit price) refuses a unit
 * price that does not lower its entry's: a break makes more pieces cheaper, never dearer.
 */
export function breakProblems(rows: readonly BreakInput[], entryPrices: ReadonlyMap<string, string>): Issue[] {
  const issues: Issue[] = []
  if (rows.length === 0 || rows.length > PRICING_DEPTH_LIMITS.rows) issues.push({ path: 'breaks', message: `1 to ${PRICING_DEPTH_LIMITS.rows} breaks at a time.` })
  const seen = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const at = `breaks/${index}`
    if (!wholeQuantity(row.minQuantity)) issues.push({ path: `${at}/minQuantity`, message: `A break applies from 2 to ${PRICING_DEPTH_LIMITS.maxQuantity} pieces.` })
    const key = breakKey(row.entryId, row.minQuantity)
    if (seen.has(key)) issues.push({ path: at, message: 'The same price and quantity twice: one break each.' })
    seen.add(key)
    if (row.unitPrice === null && row.discountPct === null) continue
    if (row.unitPrice !== null && row.discountPct !== null) {
      issues.push({ path: at, message: 'A break gives a unit price or a discount, not both.' })
      continue
    }
    if (row.entryId === null && row.unitPrice !== null) {
      issues.push({ path: `${at}/unitPrice`, message: 'A break for every price of the version gives a discount, not one unit price.' })
      continue
    }
    if (row.unitPrice !== null) {
      if (!positivePrice(row.unitPrice)) issues.push({ path: `${at}/unitPrice`, message: 'A unit price above 0, with at most 6 decimals.' })
      else {
        const entryPrice = row.entryId === null ? undefined : entryPrices.get(row.entryId)
        if (entryPrice !== undefined && !new Dec(row.unitPrice).lt(new Dec(entryPrice))) issues.push({ path: `${at}/unitPrice`, message: `A break lowers the price: below ${listPriceText(entryPrice)}.` })
      }
    }
    if (row.discountPct !== null && !pctIn(row.discountPct, 100, false)) issues.push({ path: `${at}/discountPct`, message: 'A discount above 0 and below 100 percent, with at most 4 decimals.' })
  }
  return issues
}

/** A break as the rules read it. */
export interface BreakRow {
  readonly id: string
  readonly entryId: string | null
  readonly minQuantity: number
  readonly unitPrice: string | null
  readonly discountPct: string | null
}

export interface AppliedBreak {
  readonly breakId: string
  /** The entry's own break (true) or the version's for every entry. */
  readonly ownBreak: boolean
  readonly minQuantity: number
  /** The unit price from the break: its own, or the entry's price less the discount (to the minor unit). */
  readonly unitPrice: string
  readonly discountPct: string | null
}

const priceAfter = (row: BreakRow, listPrice: string, currency: CurrencyCode): string =>
  row.unitPrice !== null ? listPriceText(row.unitPrice) : toMinor(new Dec(listPrice).times(HUNDRED.minus(new Dec(row.discountPct!))).dividedBy(HUNDRED), currency)

const deepest = (rows: readonly BreakRow[], quantity: number): BreakRow | null => rows.filter((row) => row.minQuantity <= quantity).sort((a, b) => b.minQuantity - a.minQuantity)[0] ?? null

/**
 * The break a quantity of an entry takes (SAL-166): of the entry's own breaks the one with the most pieces reached, and
 * of the version's breaks for every entry the same; of the two the lower price (the entry's own on a tie), so more
 * pieces never cost more. A break that does not lower the price is no break (null).
 */
export function breakFor(breaks: readonly BreakRow[], entryId: string, listPrice: string, quantity: number, currency: CurrencyCode): AppliedBreak | null {
  const own = deepest(breaks.filter((row) => row.entryId === entryId), quantity)
  const every = deepest(breaks.filter((row) => row.entryId === null), quantity)
  const options = [own, every].flatMap((row) => (row ? [{ row, price: priceAfter(row, listPrice, currency) }] : []))
  const best = options.sort((a, b) => new Dec(a.price).comparedTo(new Dec(b.price)))[0]
  if (!best || !new Dec(best.price).lt(new Dec(listPrice))) return null
  return { breakId: best.row.id, ownBreak: best.row.entryId !== null, minQuantity: best.row.minQuantity, unitPrice: best.price, discountPct: best.row.discountPct === null ? null : pctText(best.row.discountPct) }
}

// ---- dated prices (SAL-167) ----------------------------------------------------------------------------------------------

export interface DatedEntry {
  readonly id: string
  readonly styleId: string
  readonly colourwayId: string | null
  readonly validFrom: BusinessDate | null
  readonly validTo: BusinessDate | null
}

/** An entry holds on a day: from its first day (or the version's start) to its last (or the version's end). */
export const holdsOn = (entry: Pick<DatedEntry, 'validFrom' | 'validTo'>, day: BusinessDate): boolean => (entry.validFrom === null || entry.validFrom <= day) && (entry.validTo === null || entry.validTo >= day)

const LAST_DAY = '9999-12-31'
const FIRST_DAY = '0001-01-01'
const overlaps = (a: Pick<DatedEntry, 'validFrom' | 'validTo'>, b: Pick<DatedEntry, 'validFrom' | 'validTo'>): boolean => (a.validFrom ?? FIRST_DAY) <= (b.validTo ?? LAST_DAY) && (b.validFrom ?? FIRST_DAY) <= (a.validTo ?? LAST_DAY)

/** A dated price's days, checked: calendar days, the last on or after the first. */
export function daysProblems(validFrom: BusinessDate | null, validTo: BusinessDate | null, at = ''): Issue[] {
  const path = (field: string) => (at === '' ? field : `${at}/${field}`)
  const issues: Issue[] = []
  if (validFrom !== null && !isBusinessDate(validFrom)) issues.push({ path: path('validFrom'), message: 'A calendar day written YYYY-MM-DD.' })
  if (validTo !== null && !isBusinessDate(validTo)) issues.push({ path: path('validTo'), message: 'A calendar day written YYYY-MM-DD.' })
  if (issues.length === 0 && validFrom !== null && validTo !== null && validTo < validFrom) issues.push({ path: path('validTo'), message: 'The last day is on or after the first.' })
  return issues
}

/**
 * The entries of one version that overlap (SAL-167: "several entries of one style and colourway do not overlap"), as
 * pairs, the earlier first. `labelOf` names a style and colourway in the words.
 */
export function overlapProblems(entries: readonly DatedEntry[], labelOf: (entry: DatedEntry) => string): Issue[] {
  const groups = new Map<string, DatedEntry[]>()
  for (const entry of entries) {
    const key = `${entry.styleId}:${entry.colourwayId ?? '*'}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const issues: Issue[] = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => ((a.validFrom ?? FIRST_DAY) < (b.validFrom ?? FIRST_DAY) ? -1 : (a.validFrom ?? FIRST_DAY) > (b.validFrom ?? FIRST_DAY) ? 1 : a.id < b.id ? -1 : 1))
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const [a, b] = [sorted[i]!, sorted[j]!]
        if (!overlaps(a, b)) continue
        issues.push({ path: 'prices', message: `${labelOf(a)} has two prices on the same days (${daysText(a)} and ${daysText(b)}): the days of one style's prices never overlap.` })
      }
    }
  }
  return issues
}

/** The days of a dated price in words: "from 2027-02-01", "to 2027-01-31", "2027-02-01 to 2027-06-30", "every day". */
export function daysText(entry: Pick<DatedEntry, 'validFrom' | 'validTo'>): string {
  if (entry.validFrom === null && entry.validTo === null) return 'every day of the version'
  if (entry.validFrom === null) return `to ${entry.validTo}`
  if (entry.validTo === null) return `from ${entry.validFrom}`
  return `${entry.validFrom} to ${entry.validTo}`
}

// ---- size surcharges (SAL-180) -------------------------------------------------------------------------------------------

export interface SurchargeInput {
  /** The style (a version's for one style, or the style's own); null: every style of the version. */
  readonly styleId: string | null
  readonly size: string
  /** Both null: the surcharge of this size is removed. */
  readonly amount: string | null
  readonly pct: string | null
  /** The style's own amount's currency (a version's is its list's). */
  readonly currency?: string | null | undefined
}

export const surchargeKey = (styleId: string | null, size: string): string => `${styleId ?? '*'}:${sizeCodeOf(size)}`

/**
 * A change of size surcharges, checked: at most PRICING_DEPTH_LIMITS.rows rows, each style and size once, a size code (1
 * to 40 characters, no space), an amount above 0 (6 decimals at most) or a percent above 0 and at most 100 (4 decimals),
 * exactly one — or neither, to remove it. A style's own amount names its currency (`ownStyle`).
 */
export function surchargeProblems(rows: readonly SurchargeInput[], ownStyle: boolean): Issue[] {
  const issues: Issue[] = []
  if (rows.length === 0 || rows.length > PRICING_DEPTH_LIMITS.rows) issues.push({ path: 'surcharges', message: `1 to ${PRICING_DEPTH_LIMITS.rows} surcharges at a time.` })
  const seen = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const at = `surcharges/${index}`
    if (!SIZE.test(sizeCodeOf(row.size))) issues.push({ path: `${at}/size`, message: 'A size code of 1 to 40 characters, without spaces.' })
    const key = surchargeKey(row.styleId, row.size)
    if (seen.has(key)) issues.push({ path: at, message: 'The same size twice: one surcharge each.' })
    seen.add(key)
    if (row.amount === null && row.pct === null) continue
    if (row.amount !== null && row.pct !== null) {
      issues.push({ path: at, message: 'A surcharge is an amount or a percent, not both.' })
      continue
    }
    if (row.amount !== null && !positivePrice(row.amount)) issues.push({ path: `${at}/amount`, message: 'An amount above 0, with at most 6 decimals.' })
    if (row.pct !== null && !pctIn(row.pct, 100, true)) issues.push({ path: `${at}/pct`, message: 'A percent above 0 and at most 100, with at most 4 decimals.' })
    if (ownStyle && row.amount !== null && !isCurrencyCode(row.currency ?? null)) issues.push({ path: `${at}/currency`, message: "An amount names its currency (ISO 4217: EUR, CHF…)." })
  }
  return issues
}

/** A surcharge as the rules read it. */
export interface SurchargeRow {
  readonly id: string
  readonly versionId: string | null
  readonly styleId: string | null
  readonly size: string
  readonly amount: string | null
  readonly currency: string | null
  readonly pct: string | null
}

export const SURCHARGE_SCOPES = ['VERSION_STYLE', 'VERSION', 'STYLE'] as const
export type SurchargeScope = (typeof SURCHARGE_SCOPES)[number]

export interface AppliedSurcharge {
  readonly surchargeId: string
  readonly size: string
  /** Where it comes from: the version for this style, the version for every style, the style's own. */
  readonly scope: SurchargeScope
  /** What it adds to the unit price of a piece of that size (to the minor unit for a percent). */
  readonly amount: string
  readonly pct: string | null
}

/**
 * The surcharge of a size (SAL-180), the most particular first: the version's for this style, else the version's for
 * every style, else the style's own (an amount only in the document's currency). The list's word over the style's: the
 * style's own surcharge is the default a list may replace. Null: none.
 */
export function surchargeFor(rows: readonly SurchargeRow[], target: { readonly versionId: string | null; readonly styleId: string; readonly size: string; readonly unitPrice: string; readonly currency: CurrencyCode }): AppliedSurcharge | null {
  const size = sizeCodeOf(target.size)
  const ofSize = rows.filter((row) => sizeCodeOf(row.size) === size)
  const versionStyle = target.versionId === null ? undefined : ofSize.find((row) => row.versionId === target.versionId && row.styleId === target.styleId)
  const version = target.versionId === null ? undefined : ofSize.find((row) => row.versionId === target.versionId && row.styleId === null)
  const own = ofSize.find((row) => row.versionId === null && row.styleId === target.styleId && (row.pct !== null || row.currency === target.currency))
  const found = versionStyle ? { row: versionStyle, scope: 'VERSION_STYLE' as const } : version ? { row: version, scope: 'VERSION' as const } : own ? { row: own, scope: 'STYLE' as const } : null
  if (!found) return null
  const amount = found.row.amount !== null ? listPriceText(found.row.amount) : toMinor(new Dec(target.unitPrice).times(new Dec(found.row.pct!)).dividedBy(HUNDRED), target.currency)
  if (!new Dec(amount).gt(0)) return null
  return { surchargeId: found.row.id, size, scope: found.scope, amount, pct: found.row.pct === null ? null : pctText(found.row.pct) }
}

// ---- minimum order quantities (SAL-178) ----------------------------------------------------------------------------------

export const MINIMUM_PER = ['ORDER', 'COLOURWAY', 'LINE'] as const
export type MinimumPer = (typeof MINIMUM_PER)[number]
export const MINIMUM_ACTIONS = ['BLOCK', 'WARN', 'SURCHARGE'] as const
export type MinimumAction = (typeof MINIMUM_ACTIONS)[number]
export const MINIMUM_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'REACTIVATED', 'DELETED'] as const
export type MinimumChange = (typeof MINIMUM_CHANGES)[number]

export interface MinimumInput {
  readonly styleId?: string | null | undefined
  readonly productType?: ProductType | null | undefined
  readonly itemId?: string | null | undefined
  readonly minQuantity: number
  readonly per: MinimumPer
  readonly action: MinimumAction
  readonly surchargeAmount?: string | null | undefined
  readonly currency?: string | null | undefined
  readonly surchargePct?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A minimum's fields, checked (`subject`: false for an edit, whose subject is fixed). */
export function minimumProblems(input: MinimumInput, subject = true): Issue[] {
  const issues: Issue[] = []
  if (subject) {
    const named = [input.styleId, input.productType, input.itemId].filter((value) => value !== null && value !== undefined).length
    if (named !== 1) issues.push({ path: 'styleId', message: 'A minimum is about one style, one kind of garment or one material: exactly one.' })
    if (input.productType !== null && input.productType !== undefined && !(PRODUCT_TYPES as readonly string[]).includes(input.productType)) issues.push({ path: 'productType', message: `One of ${PRODUCT_TYPES.join(', ')}.` })
  }
  if (!wholeQuantity(input.minQuantity)) issues.push({ path: 'minQuantity', message: `A minimum of 2 to ${PRICING_DEPTH_LIMITS.maxQuantity} pieces.` })
  if (!(MINIMUM_PER as readonly string[]).includes(input.per)) issues.push({ path: 'per', message: `Counted per ${MINIMUM_PER.join(', ')}.` })
  const amount = input.surchargeAmount ?? null
  const pct = input.surchargePct ?? null
  if (input.action === 'SURCHARGE') {
    if ((amount === null) === (pct === null)) issues.push({ path: 'surchargeAmount', message: 'A small-run surcharge is an amount per piece or a percent of the unit price: exactly one.' })
    else if (amount !== null) {
      if (!positivePrice(amount)) issues.push({ path: 'surchargeAmount', message: 'An amount above 0, with at most 6 decimals.' })
      if (!isCurrencyCode(input.currency ?? null)) issues.push({ path: 'currency', message: 'An amount names its currency (ISO 4217: EUR, CHF…).' })
    } else if (!pctIn(pct, 100, true)) issues.push({ path: 'surchargePct', message: 'A percent above 0 and at most 100, with at most 4 decimals.' })
  } else if (amount !== null || pct !== null || (input.currency ?? null) !== null) {
    issues.push({ path: 'surchargeAmount', message: 'Only a SURCHARGE minimum asks a small-run surcharge.' })
  }
  const note = input.note?.trim() ?? ''
  if (note.length > PRICING_DEPTH_LIMITS.note) issues.push({ path: 'note', message: `A note of at most ${PRICING_DEPTH_LIMITS.note} characters.` })
  return issues
}

/** A minimum as the rules read it. */
export interface MinimumRule {
  readonly id: string
  readonly companyId: string | null
  readonly priceListId: string | null
  readonly styleId: string | null
  readonly productType: ProductType | null
  readonly itemId: string | null
  readonly minQuantity: number
  readonly per: MinimumPer
  readonly action: MinimumAction
  readonly surchargeAmount: string | null
  readonly currency: string | null
  readonly surchargePct: string | null
  readonly note: string | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

/** One goods line of a quote or order, as a minimum counts it. */
export interface MinimumLine {
  readonly id: string | null
  readonly seq: number
  readonly styleId: string
  readonly colourwayId: string
  /** The style's kind of garment. */
  readonly productType: ProductType | null
  /** The materials it uses: its style revision's BOM, and leather chosen as an option. */
  readonly itemIds: readonly string[]
  /** Pieces. */
  readonly quantity: number
  /** "SEED-JKT-01 BLK": for the words. */
  readonly label: string
}

export interface MinimumDocument {
  readonly kind: 'QUOTE' | 'ORDER'
  readonly companyId: string
  /** The price list that prices it (the customer's): a minimum of another list does not bind it. */
  readonly priceListId: string | null
  readonly lines: readonly MinimumLine[]
}

export interface MinimumFinding {
  readonly ruleId: string
  readonly action: MinimumAction
  readonly per: MinimumPer
  readonly minQuantity: number
  /** The pieces counted (of the document, the colourway or the line). */
  readonly quantity: number
  readonly lineIds: readonly string[]
  readonly seqs: readonly number[]
  readonly colourwayId: string | null
  /** In words, without an amount (the small-run surcharge is in `surcharge`, price grain). */
  readonly message: string
  readonly surcharge: { readonly amount: string | null; readonly currency: string | null; readonly pct: string | null } | null
}

/** The rules that bind a document: active, of its company or every company, for its price list or every list. */
export const bindingRules = (rules: readonly MinimumRule[], document: Pick<MinimumDocument, 'companyId' | 'priceListId'>): MinimumRule[] =>
  rules.filter((rule) => rule.status === 'ACTIVE' && (rule.companyId === null || rule.companyId === document.companyId) && (rule.priceListId === null || rule.priceListId === document.priceListId))

const matches = (rule: MinimumRule, line: MinimumLine): boolean =>
  rule.styleId !== null ? line.styleId === rule.styleId : rule.productType !== null ? line.productType === rule.productType : rule.itemId !== null && line.itemIds.includes(rule.itemId)

const ACTION_WORDS: Readonly<Record<MinimumAction, (document: string) => string>> = {
  BLOCK: (document) => `The ${document} cannot go out below it.`,
  WARN: () => 'It can go out, below the minimum.',
  SURCHARGE: () => 'Below it a small-run surcharge per piece applies.',
}

/**
 * What the minimums say of a document (SAL-178): for every rule that binds it and every group it counts (the document,
 * a colourway, a line) holding fewer pieces of the subject than the minimum, one finding with its words. A subject the
 * document does not hold is no finding: a minimum binds what is ordered. `subjectOf` names the rule's subject ("SEED-JKT-01",
 * "jackets", "material PEL-001").
 */
export function minimumFindings(rules: readonly MinimumRule[], document: MinimumDocument, subjectOf: (rule: MinimumRule) => string): MinimumFinding[] {
  const findings: MinimumFinding[] = []
  const documentWord = document.kind === 'QUOTE' ? 'quote' : 'order'
  for (const rule of bindingRules(rules, document)) {
    const lines = document.lines.filter((line) => line.quantity > 0 && matches(rule, line))
    if (lines.length === 0) continue
    const groups: { readonly lines: MinimumLine[]; readonly where: string; readonly colourwayId: string | null }[] = []
    if (rule.per === 'ORDER') groups.push({ lines, where: `on this ${documentWord}`, colourwayId: null })
    else if (rule.per === 'LINE') for (const line of lines) groups.push({ lines: [line], where: `on line ${line.seq} (${line.label})`, colourwayId: line.colourwayId })
    else {
      const byColourway = new Map<string, MinimumLine[]>()
      for (const line of lines) byColourway.set(line.colourwayId, [...(byColourway.get(line.colourwayId) ?? []), line])
      for (const [colourwayId, group] of byColourway) groups.push({ lines: group, where: `in ${group[0]!.label}`, colourwayId })
    }
    const perWord = rule.per === 'ORDER' ? `per ${documentWord}` : rule.per === 'LINE' ? 'per line' : 'per colourway'
    for (const group of groups) {
      const quantity = group.lines.reduce((sum, line) => sum + line.quantity, 0)
      if (quantity >= rule.minQuantity) continue
      const note = rule.note?.trim() ? ` ${rule.note.trim()}` : ''
      findings.push({
        ruleId: rule.id,
        action: rule.action,
        per: rule.per,
        minQuantity: rule.minQuantity,
        quantity,
        lineIds: group.lines.flatMap((line) => (line.id ? [line.id] : [])),
        seqs: group.lines.map((line) => line.seq),
        colourwayId: group.colourwayId,
        message: `${subjectOf(rule)}: ${quantity} ${quantity === 1 ? 'piece' : 'pieces'} ${group.where}; the minimum is ${rule.minQuantity} ${perWord}. ${ACTION_WORDS[rule.action](documentWord)}${note}`,
        surcharge: rule.action === 'SURCHARGE' ? { amount: rule.surchargeAmount === null ? null : listPriceText(rule.surchargeAmount), currency: rule.currency, pct: rule.surchargePct === null ? null : pctText(rule.surchargePct) } : null,
      })
    }
  }
  return findings
}

/** A kind of garment in words, plural ("jackets"), for a minimum's subject. */
export const PRODUCT_TYPE_WORDS: Readonly<Record<ProductType, string>> = { JACKET: 'jackets', TROUSERS: 'trousers', SUIT: 'suits', GLOVES: 'gloves', VEST: 'vests', OTHER: 'other garments' }
