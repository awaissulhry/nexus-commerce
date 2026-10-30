import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode, minorPlaces, UNIT_PRICE, type CurrencyCode } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { decimalText, roundTo } from '../../product/units/units'
import { Dec, HUNDRED, parseDecimal } from '../../tax/decimal'
import type { PriceBasis } from '../../tax/vat-summary'
import { addDays } from '../quotes/quotes'

/**
 * Customer price lists (B-W2a-19; SAL-165; design sales.pricelists, record "Price list": Prices, Customers, Versions),
 * pure. A list (factory-db pricing.prisma PriceList) is a BASE list (what a customer without a list of its own pays), a
 * customer's, a group's (a discount group: each member has it on its Party row) or a contract's, in one currency, and
 * may fall back to another list of the same currency (baseListId) for a style it does not price.
 *
 * Its versions are dated: a DRAFT is edited; activating it fixes its prices for good, from a day (today or later) to a day
 * or open. The ACTIVE versions of a list never overlap: activating ends the version in force at the new start the day
 * before it (`activationPlan`); a version that starts on or after the new start is never cut away (refused, in words).
 *
 * A price is looked up through the chain: the version (the one a quote keeps, else the one in force on the day), its
 * colourway's own entry, else its style's (every colourway), else the same in the list it falls back to (`priceFrom`).
 * One entry per style and colourway in a version (the module's rule: no unique key in the table).
 *
 * The list-level state the list screen shows: DRAFT (never activated), SCHEDULED (activated, starts later), IN_FORCE (a
 * version is in force today), EXPIRED (every active version ended), ARCHIVED.
 */

export const PRICE_LIST_KINDS = ['BASE', 'CUSTOMER', 'GROUP', 'CONTRACT'] as const
export type PriceListKind = (typeof PRICE_LIST_KINDS)[number]
export const PRICE_LIST_STATES = ['DRAFT', 'SCHEDULED', 'IN_FORCE', 'EXPIRED', 'ARCHIVED'] as const
export type PriceListState = (typeof PRICE_LIST_STATES)[number]
export const PRICE_VERSION_STATUSES = ['DRAFT', 'ACTIVE'] as const
export type PriceVersionStatus = (typeof PRICE_VERSION_STATUSES)[number]

export const PRICE_LIST_LIMITS = { code: 40, name: 200, note: 2000, entries: 2000, chain: 8 } as const
const CODE = /^[A-Z0-9][A-Z0-9._-]*$/

export interface PriceListFieldsInput {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly currency?: string | undefined
  readonly note?: string | null | undefined
}

/** The plain fields of a list, checked; the module checks what needs the table (the code is free, the base list). */
export function listFieldProblems(input: PriceListFieldsInput): Issue[] {
  const issues: Issue[] = []
  if (input.code !== undefined) {
    const code = input.code.trim().toUpperCase()
    if (code === '' || code.length > PRICE_LIST_LIMITS.code || !CODE.test(code)) issues.push({ path: 'code', message: `A code of 1 to ${PRICE_LIST_LIMITS.code} letters, digits, dots, dashes or underscores.` })
  }
  if (input.name !== undefined && (input.name.trim() === '' || input.name.trim().length > PRICE_LIST_LIMITS.name)) issues.push({ path: 'name', message: `A name of 1 to ${PRICE_LIST_LIMITS.name} characters.` })
  if (input.currency !== undefined && !isCurrencyCode(input.currency)) issues.push({ path: 'currency', message: 'An ISO 4217 currency (EUR, CHF…).' })
  if (input.note !== undefined && input.note !== null && input.note.trim().length > PRICE_LIST_LIMITS.note) issues.push({ path: 'note', message: `A note of at most ${PRICE_LIST_LIMITS.note} characters.` })
  return issues
}

export const listCodeOf = (code: string): string => code.trim().toUpperCase()

/** A version as the rules read it. */
export interface VersionFacts {
  readonly id: string
  readonly revision: number
  readonly status: PriceVersionStatus
  readonly validFrom: BusinessDate | null
  readonly validTo: BusinessDate | null
}

const covers = (version: VersionFacts, day: BusinessDate): boolean => version.status === 'ACTIVE' && version.validFrom !== null && version.validFrom <= day && (version.validTo === null || version.validTo >= day)

/** The ACTIVE version in force on a day (at most one: they never overlap), or null. */
export const inForceOn = <Version extends VersionFacts>(versions: readonly Version[], day: BusinessDate): Version | null => versions.find((version) => covers(version, day)) ?? null

/** The next ACTIVE version that starts after `day`, or null. */
export function nextStartAfter<Version extends VersionFacts>(versions: readonly Version[], day: BusinessDate): Version | null {
  const later = versions.filter((version) => version.status === 'ACTIVE' && version.validFrom !== null && version.validFrom > day)
  return later.sort((a, b) => (a.validFrom! < b.validFrom! ? -1 : 1))[0] ?? null
}

/** The list-level state on a day (see the module comment). */
export function listStateOf(status: 'ACTIVE' | 'ARCHIVED', versions: readonly VersionFacts[], day: BusinessDate): PriceListState {
  if (status === 'ARCHIVED') return 'ARCHIVED'
  if (inForceOn(versions, day)) return 'IN_FORCE'
  if (nextStartAfter(versions, day)) return 'SCHEDULED'
  return versions.some((version) => version.status === 'ACTIVE') ? 'EXPIRED' : 'DRAFT'
}

/** The tiles of the list screen: a list in force that ends within `days`, one that starts within `days`. */
export function listTiles(versions: readonly VersionFacts[], day: BusinessDate, days = 30): { startsSoon: boolean; endsSoon: boolean } {
  const horizon = addDays(day, days)
  const current = inForceOn(versions, day)
  const next = nextStartAfter(versions, day)
  return { startsSoon: next !== null && next.validFrom! <= horizon, endsSoon: current !== null && current.validTo !== null && current.validTo <= horizon }
}

/** A draft's planned validity (or an active one's end), checked. */
export function validityProblems(validFrom: BusinessDate | null, validTo: BusinessDate | null): Issue[] {
  const issues: Issue[] = []
  if (validFrom !== null && !isBusinessDate(validFrom)) issues.push({ path: 'validFrom', message: 'A calendar day written YYYY-MM-DD.' })
  if (validTo !== null && !isBusinessDate(validTo)) issues.push({ path: 'validTo', message: 'A calendar day written YYYY-MM-DD.' })
  if (issues.length === 0 && validFrom !== null && validTo !== null && validTo < validFrom) issues.push({ path: 'validTo', message: 'The last day is on or after the first.' })
  return issues
}

export interface ActivationPlan {
  /** The ACTIVE version in force at the new start, ended the day before it; null: none to end. */
  readonly end: { readonly id: string; readonly revision: number; readonly validTo: BusinessDate } | null
}

/**
 * How a DRAFT version goes live from `validFrom` (today or later) to `validTo` (or open): the version in force at the
 * new start ends the day before (the one command activates it after that, so the active versions never overlap). A
 * version that starts on or after the new start would have to be cut away: refused, with what to do instead.
 */
export function activationPlan(versions: readonly VersionFacts[], draftId: string, validFrom: BusinessDate, validTo: BusinessDate | null, today: BusinessDate): { ok: true; plan: ActivationPlan } | { ok: false; issues: Issue[] } {
  const draft = versions.find((version) => version.id === draftId)
  if (!draft || draft.status !== 'DRAFT') return { ok: false, issues: [{ path: 'version', message: 'Only a draft version is activated; an active one keeps its prices.' }] }
  const issues = validityProblems(validFrom, validTo)
  if (issues.length > 0) return { ok: false, issues }
  if (validFrom < today) return { ok: false, issues: [{ path: 'validFrom', message: `A version is activated from today (${today}) or a later day, never back in time: quotes already priced keep their version.` }] }
  let end: ActivationPlan['end'] = null
  for (const version of versions) {
    if (version.status !== 'ACTIVE' || version.validFrom === null) continue
    const overlaps = version.validFrom <= (validTo ?? '9999-12-31') && (version.validTo ?? '9999-12-31') >= validFrom
    if (!overlaps) continue
    if (version.validFrom >= validFrom) {
      return { ok: false, issues: [{ path: 'validFrom', message: `Version ${version.revision} is active from ${version.validFrom}: start this one later, or end it before ${version.validFrom} and start this one after it.` }] }
    }
    end = { id: version.id, revision: version.revision, validTo: addDays(validFrom, -1) }
  }
  return { ok: true, plan: { end } }
}

/** An ACTIVE version's new last day: on or after its first and today's day before (prices already quoted stay). */
export function endProblems(version: VersionFacts, validTo: BusinessDate | null, today: BusinessDate, versions: readonly VersionFacts[]): Issue[] {
  if (version.status !== 'ACTIVE') return [{ path: 'validTo', message: 'Only an active version is ended; a draft has its planned days.' }]
  if (validTo === null) {
    const later = versions.find((other) => other.id !== version.id && other.status === 'ACTIVE' && other.validFrom !== null && other.validFrom > version.validFrom!)
    return later ? [{ path: 'validTo', message: `Version ${later.revision} starts on ${later.validFrom}: this one stays ended before it.` }] : []
  }
  const issues = validityProblems(version.validFrom, validTo)
  if (issues.length > 0) return issues
  if (validTo < addDays(today, -1)) return [{ path: 'validTo', message: `An active version ends yesterday (${addDays(today, -1)}) at the earliest: what was in force stays as it was.` }]
  const clash = versions.find((other) => other.id !== version.id && other.status === 'ACTIVE' && other.validFrom !== null && other.validFrom > version.validFrom! && other.validFrom <= validTo)
  return clash ? [{ path: 'validTo', message: `Version ${clash.revision} starts on ${clash.validFrom}: end this one before it.` }] : []
}

// ---- prices -----------------------------------------------------------------------------------------------------------

const PRICE_ROUND = { scale: UNIT_PRICE.scale, rounding: 'HALF_UP' } as const

/** A price as stored and shown: 6 places at most, no trailing zeros. */
export const listPriceText = (value: string): string => decimalText(roundTo(value, PRICE_ROUND))

export interface EntryInput {
  readonly styleId: string
  readonly colourwayId: string | null
  /** The net unit price, above 0; null removes the row. */
  readonly unitPrice: string | null
}

/** A change of a draft's prices, checked: a price above 0 with at most 6 places, one row per style and colourway. */
export function entryProblems(entries: readonly EntryInput[]): Issue[] {
  const issues: Issue[] = []
  if (entries.length === 0 || entries.length > PRICE_LIST_LIMITS.entries) issues.push({ path: 'entries', message: `1 to ${PRICE_LIST_LIMITS.entries} prices at a time.` })
  const seen = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const key = entryKey(entry.styleId, entry.colourwayId)
    if (seen.has(key)) issues.push({ path: `entries/${index}`, message: 'The same style and colourway twice: one price each.' })
    seen.add(key)
    if (entry.unitPrice === null) continue
    const value = parseDecimal(entry.unitPrice)
    if (value === null || !fitsDecimal(entry.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale) || value.lte(0)) issues.push({ path: `entries/${index}/unitPrice`, message: 'A net unit price above 0, with at most 6 decimals.' })
  }
  return issues
}

/** The key of one price row in a version. */
export const entryKey = (styleId: string, colourwayId: string | null): string => `${styleId}:${colourwayId ?? '*'}`

/** "Raise by %" (design pricelist.prices): the price × (1 + percent ÷ 100), rounded to the currency's minor unit. */
export function raiseByPct(price: string, pct: string, currency: CurrencyCode): string {
  const value = new Dec(price).times(HUNDRED.plus(new Dec(pct))).dividedBy(HUNDRED)
  return decimalText(value.toDecimalPlaces(minorPlaces(currency), Dec.ROUND_HALF_UP).toFixed(minorPlaces(currency)))
}

/** A price raise's percent, checked: above -100, at most 4 places. */
export function raiseProblems(pct: string): Issue[] {
  const value = parseDecimal(pct)
  return value === null || !fitsDecimal(pct, 9, 4) || value.lte(-100) ? [{ path: 'pct', message: 'A percent above -100 with at most 4 decimals (5 raises by 5%, -3 lowers by 3%).' }] : []
}

/** The margin of a net price at a unit cost, percent of the price (4 places), or null without a cost or a price. */
export function marginPctOf(netPrice: string, unitCost: string | null): string | null {
  if (unitCost === null) return null
  const price = new Dec(netPrice)
  if (price.lte(0)) return null
  return decimalText(price.minus(new Dec(unitCost)).dividedBy(price).times(HUNDRED).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4))
}

/**
 * A list's net price on a quote's price basis: a consumer's quote is priced VAT included (GROSS, Codice del Consumo art.
 * 49), so the net list price takes the line's VAT rate; NET as it is.
 */
export function listPriceOnBasis(netPrice: string, basis: PriceBasis, vatRatePct: string | null): string {
  if (basis === 'NET' || vatRatePct === null) return listPriceText(netPrice)
  return listPriceText(new Dec(netPrice).times(HUNDRED.plus(new Dec(vatRatePct))).dividedBy(HUNDRED).toFixed(UNIT_PRICE.scale))
}

/** One level of a price chain: a list's version and its prices. */
export interface ChainLevel {
  readonly listId: string
  readonly versionId: string | null
  readonly entries: readonly { readonly styleId: string; readonly colourwayId: string | null; readonly unitPrice: string }[]
}

export interface ListPrice {
  /** The net unit price. */
  readonly unitPrice: string
  readonly listId: string
  readonly versionId: string
  /** The colourway's own price (true), or the style's for every colourway. */
  readonly colourwayPrice: boolean
  /** 0: the first list of the chain; 1: the list it falls back to … */
  readonly depth: number
}

/** The price of a style in a colourway through the chain (see the module comment); null: no list prices it. */
export function priceFrom(chain: readonly ChainLevel[], styleId: string, colourwayId: string): ListPrice | null {
  for (const [depth, level] of chain.entries()) {
    if (level.versionId === null) continue
    const own = level.entries.find((entry) => entry.styleId === styleId && entry.colourwayId === colourwayId)
    const style = own ?? level.entries.find((entry) => entry.styleId === styleId && entry.colourwayId === null)
    if (style) return { unitPrice: listPriceText(style.unitPrice), listId: level.listId, versionId: level.versionId, colourwayPrice: own !== undefined, depth }
  }
  return null
}

export const ENTRY_CHANGES = ['ADDED', 'REMOVED', 'CHANGED', 'SAME'] as const
export type EntryChange = (typeof ENTRY_CHANGES)[number]

export interface ComparedEntry {
  readonly styleId: string
  readonly colourwayId: string | null
  readonly before: string | null
  readonly after: string | null
  readonly change: EntryChange
  /** after ÷ before − 1, percent (2 places), when both are known. */
  readonly changePct: string | null
}

/** Two versions' prices row by row (design pricelist.versions "Compare two versions", "Changed rows"). */
export function compareEntries(before: readonly EntryInput[], after: readonly EntryInput[]): ComparedEntry[] {
  const keys = new Map<string, { styleId: string; colourwayId: string | null }>()
  for (const entry of [...before, ...after]) keys.set(entryKey(entry.styleId, entry.colourwayId), { styleId: entry.styleId, colourwayId: entry.colourwayId })
  const priceIn = (entries: readonly EntryInput[], key: string) => entries.find((entry) => entryKey(entry.styleId, entry.colourwayId) === key)?.unitPrice ?? null
  return [...keys.entries()].map(([key, row]) => {
    const was = priceIn(before, key)
    const now = priceIn(after, key)
    const change: EntryChange = was === null ? 'ADDED' : now === null ? 'REMOVED' : new Dec(was).eq(new Dec(now)) ? 'SAME' : 'CHANGED'
    const changePct = was !== null && now !== null && new Dec(was).gt(0) ? decimalText(new Dec(now).dividedBy(new Dec(was)).minus(1).times(HUNDRED).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2)) : null
    return { ...row, before: was === null ? null : listPriceText(was), after: now === null ? null : listPriceText(now), change, changePct }
  })
}

/** How many rows differ (design "Changed rows"). */
export const changedRows = (rows: readonly ComparedEntry[]): number => rows.filter((row) => row.change !== 'SAME').length
