import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import type { MINIMUM_ACTIONS, MINIMUM_PER } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { parsePercent } from '../../quotes/model'
import { sizeOrder } from '../../quotes/record/price-depth/model'
import type { PriceEntry, PriceListDetail, PriceRow, PriceVersion } from '../api'
import { parseListPrice, type Phrase, type PriceListAbilities } from '../model'
import type { BreakRow, DatedRow, Minimum, NewMinimumBody, PriceBreak, Surcharge, SurchargeRow, VersionRules } from './api'

/**
 * Price lists in depth on screen (B-W2b-343; design sales.pricelists record tab "Breaks & surcharges", Prices › Valid
 * from–to, SAL-166 / -167 / -170 / -178 / -180): the pure rules — which prices are dated (written through the dated
 * prices, never W2a's cell), a price's days and whether they overlap another of the same style and colourway, a break or
 * surcharge row as ONE write with both money fields, the surcharges as rows of sizes (SizeColumns), a minimum's checks.
 * Every refusal the API would give is held here before the click, in this screen's words. No fetching, no React.
 */

export const DEPTH_NS = 'sales-prices-depth'

const key = (styleId: string, colourwayId: string | null) => `${styleId}:${colourwayId ?? '*'}`

/** Why a version's breaks and surcharges cannot change (a Phrase of this catalogue), or null: a draft, the right, the price grain. */
export function rulesHeld(list: Pick<PriceListDetail, 'status' | 'draftVersionId'>, version: Pick<PriceVersion, 'status' | 'revision'> | null, can: Pick<PriceListAbilities, 'manage' | 'price'>): Phrase | null {
  if (!can.price) return { key: 'held.noPrice' }
  if (list.status === 'ARCHIVED') return { key: 'held.archived' }
  if (!can.manage) return { key: 'held.noManage' }
  if (!version) return { key: 'held.noVersion' }
  if (version.status !== 'DRAFT') return { key: list.draftVersionId ? 'held.activeHasDraft' : 'held.activeVersion', params: { revision: version.revision } }
  return null
}

// ---- dated prices (SAL-167) ----------------------------------------------------------------------------------------------

/** A price with days of its own (else it holds every day of its version). */
export const isDated = (entry: Pick<PriceEntry, 'validFrom' | 'validTo'>): boolean => entry.validFrom !== null || entry.validTo !== null

/** The style-and-colourway keys that have a dated price: every price of such a key is written through the dated prices. */
export function datedKeys(entries: readonly PriceEntry[]): Set<string> {
  return new Set(entries.filter(isDated).map((entry) => key(entry.styleId, entry.colourwayId)))
}

/** Rows to write, split: W2a's cell write (a key with no dated price) and the dated prices' write (keyed by first day). */
export function splitRows(entries: readonly PriceEntry[], rows: ReadonlyArray<{ entry: PriceEntry | null; styleId: string; colourwayId: string | null; unitPrice: string | null; validFrom?: string | null; validTo?: string | null }>): { plain: PriceRow[]; dated: DatedRow[] } {
  const dated = datedKeys(entries)
  const plain: PriceRow[] = []
  const days: DatedRow[] = []
  for (const row of rows) {
    const from = row.validFrom !== undefined ? row.validFrom : (row.entry?.validFrom ?? null)
    const to = row.validTo !== undefined ? row.validTo : (row.entry?.validTo ?? null)
    if (dated.has(key(row.styleId, row.colourwayId)) || from !== null || to !== null) days.push({ styleId: row.styleId, colourwayId: row.colourwayId, validFrom: from, validTo: to, unitPrice: row.unitPrice })
    else plain.push({ styleId: row.styleId, colourwayId: row.colourwayId, unitPrice: row.unitPrice })
  }
  return { plain, dated: days }
}

/** Two day ranges (null: open) share a day. */
const overlaps = (a: { from: string | null; to: string | null }, b: { from: string | null; to: string | null }) => (a.from ?? '0000-01-01') <= (b.to ?? '9999-12-31') && (b.from ?? '0000-01-01') <= (a.to ?? '9999-12-31')

/**
 * What stops a price's days (Phrase), or null: the last day before the first, or another price of the same style and
 * colourway holding on one of these days (an undated price holds every day: it overlaps any dated one).
 */
export function daysHeld(entries: readonly PriceEntry[], target: { styleId: string; colourwayId: string | null; validFrom: string; validTo: string; exceptId?: string | null }): Phrase | null {
  if (target.validFrom && target.validTo && target.validTo < target.validFrom) return { key: 'days.held.order' }
  const range = { from: target.validFrom || null, to: target.validTo || null }
  const other = entries.find((entry) => entry.id !== target.exceptId && entry.styleId === target.styleId && entry.colourwayId === target.colourwayId && overlaps(range, { from: entry.validFrom, to: entry.validTo }))
  if (other) return other.validFrom || other.validTo ? { key: 'days.held.overlap', params: { from: other.validFrom ?? '—', to: other.validTo ?? '—' } } : { key: 'days.held.undated' }
  return null
}

/**
 * The write that gives a price new days: the same first day updates it; another first day removes the old row (its own
 * breaks go with it: said before the click) and writes the new one, in ONE write.
 */
export function daysRows(entry: PriceEntry, validFrom: string, validTo: string, unitPrice: string): DatedRow[] {
  const from = validFrom || null
  const to = validTo || null
  if (from === entry.validFrom) return [{ styleId: entry.styleId, colourwayId: entry.colourwayId, validFrom: from, validTo: to, unitPrice }]
  return [
    { styleId: entry.styleId, colourwayId: entry.colourwayId, validFrom: entry.validFrom, validTo: entry.validTo, unitPrice: null },
    { styleId: entry.styleId, colourwayId: entry.colourwayId, validFrom: from, validTo: to, unitPrice },
  ]
}

// ---- quantity breaks (SAL-166) -------------------------------------------------------------------------------------------

export interface BreakDraft {
  /** '' = every price of the version (a discount). */
  entryId: string
  minQuantity: string
  /** PRICE: a unit price; PCT: a discount percent. */
  kind: 'PRICE' | 'PCT'
  value: string
}

export const emptyBreak = (): BreakDraft => ({ entryId: '', minQuantity: '', kind: 'PCT', value: '' })

const wholeQuantity = (text: string): number | null => (/^\d{1,7}$/.test(text.trim()) && Number(text) >= 2 && Number(text) <= 1_000_000 ? Number(text) : null)

/** A typed discount (above 0, below 100, at most 4 places), or null. */
export function parseDiscount(text: string): string | null {
  const parsed = parsePercent(text)
  return parsed !== null && Number(parsed) > 0 && Number(parsed) < 100 ? parsed : null
}

/** What stops Add a break (Phrase, the first), checked as the API will. */
export function breakHeld(draft: BreakDraft, rules: Pick<VersionRules, 'breaks'>, entries: readonly PriceEntry[]): Phrase | null {
  const quantity = wholeQuantity(draft.minQuantity)
  if (quantity === null) return { key: 'breaks.held.quantity' }
  if (draft.entryId === '' && draft.kind === 'PRICE') return { key: 'breaks.held.everyPct' }
  if (rules.breaks.some((row) => (row.entryId ?? '') === draft.entryId && row.minQuantity === quantity)) return { key: 'breaks.held.twice', params: { count: quantity } }
  if (draft.kind === 'PCT') return parseDiscount(draft.value) === null ? { key: 'breaks.held.pct' } : null
  const price = parseListPrice(draft.value)
  if (price === null) return { key: 'breaks.held.price' }
  const entry = entries.find((row) => row.id === draft.entryId)
  if (entry?.unitPrice !== undefined && !(Number(price) < Number(entry.unitPrice))) return { key: 'breaks.held.lower', params: { price: entry.unitPrice } }
  return null
}

/** Add a break as ONE row (both money fields). */
export function breakRowOf(draft: BreakDraft): BreakRow {
  const price = draft.kind === 'PRICE' ? parseListPrice(draft.value) : null
  const pct = draft.kind === 'PCT' ? parseDiscount(draft.value) : null
  return { entryId: draft.entryId || null, minQuantity: Number(draft.minQuantity), unitPrice: price, discountPct: pct }
}

/** A break's cell typed: the row with the new figure in its own field (the other null); '' removes the break. */
export function breakCellRow(row: PriceBreak, field: 'unitPrice' | 'discountPct', text: string): BreakRow | Phrase {
  const trimmed = text.trim()
  if (trimmed === '') return { entryId: row.entryId, minQuantity: row.minQuantity, unitPrice: null, discountPct: null }
  if (field === 'unitPrice') {
    if (row.entryId === null) return { key: 'breaks.held.everyPct' }
    const price = parseListPrice(trimmed)
    if (price === null) return { key: 'breaks.held.price' }
    if (row.entry?.unitPrice !== undefined && !(Number(price) < Number(row.entry.unitPrice))) return { key: 'breaks.held.lower', params: { price: row.entry.unitPrice } }
    return { entryId: row.entryId, minQuantity: row.minQuantity, unitPrice: price, discountPct: null }
  }
  const pct = parseDiscount(trimmed)
  if (pct === null) return { key: 'breaks.held.pct' }
  return { entryId: row.entryId, minQuantity: row.minQuantity, unitPrice: null, discountPct: pct }
}

export const isPhrase = (value: unknown): value is Phrase => typeof value === 'object' && value !== null && 'key' in value

/** The breaks in reading order: every price first, then by style, colourway, first day, then quantity. */
export function sortedBreaks(breaks: readonly PriceBreak[]): PriceBreak[] {
  const label = (row: PriceBreak) => (row.entry ? `1${row.entry.style.code}:${row.entry.colourway?.code ?? ''}:${row.entry.validFrom ?? ''}` : '0')
  return [...breaks].sort((a, b) => label(a).localeCompare(label(b)) || a.minQuantity - b.minQuantity)
}

// ---- size surcharges (SAL-180): rows of sizes ----------------------------------------------------------------------------

export interface SurchargeGridRow {
  /** `version:*:amount`, `version:<styleId>:pct`, `style:<styleId>:amount` … */
  id: string
  scope: 'VERSION' | 'STYLE'
  styleId: string | null
  style: { code: string; name: string } | null
  kind: 'amount' | 'pct'
  values: Record<string, string | null>
}

/** The sizes the surcharges name, in scale order (the grid's columns). */
export function surchargeSizes(rules: Pick<VersionRules, 'sizeSurcharges' | 'styleSurcharges'>, extra: readonly string[] = []): string[] {
  return sizeOrder([...rules.sizeSurcharges.map((row) => row.size), ...rules.styleSurcharges.map((row) => row.size), ...extra].map((size) => size.trim().toUpperCase()).filter(Boolean))
}

/**
 * The surcharges as rows of sizes: the version's for every style (always, an amount row and a percent row), the version's
 * for each style that has any, then each style's own (read here, kept on the style): a size is an amount or a percent.
 */
export function surchargeGrid(rules: Pick<VersionRules, 'sizeSurcharges' | 'styleSurcharges'>): SurchargeGridRow[] {
  const rows: SurchargeGridRow[] = []
  const add = (scope: 'VERSION' | 'STYLE', styleId: string | null, style: SurchargeGridRow['style'], list: readonly Surcharge[]) => {
    for (const kind of ['amount', 'pct'] as const) {
      const values: Record<string, string | null> = {}
      for (const row of list) values[row.size] = (kind === 'amount' ? row.amount : row.pct) ?? null
      if (scope === 'STYLE' && Object.values(values).every((value) => value === null)) continue
      rows.push({ id: `${scope.toLowerCase()}:${styleId ?? '*'}:${kind}`, scope, styleId, style, kind, values })
    }
  }
  add('VERSION', null, null, rules.sizeSurcharges.filter((row) => row.styleId === null))
  const versionStyles = [...new Map(rules.sizeSurcharges.filter((row) => row.styleId !== null).map((row) => [row.styleId!, row.style])).entries()].sort((a, b) => (a[1]?.code ?? '').localeCompare(b[1]?.code ?? ''))
  for (const [styleId, style] of versionStyles) add('VERSION', styleId, style, rules.sizeSurcharges.filter((row) => row.styleId === styleId))
  const ownStyles = [...new Map(rules.styleSurcharges.filter((row) => row.styleId !== null).map((row) => [row.styleId!, row.style])).entries()].sort((a, b) => (a[1]?.code ?? '').localeCompare(b[1]?.code ?? ''))
  for (const [styleId, style] of ownStyles) add('STYLE', styleId, style, rules.styleSurcharges.filter((row) => row.styleId === styleId))
  return rows
}

/** A surcharge cell typed (a decimal from SizeColumns, or null to clear): ONE row with both fields; the other kind's figure of that size is replaced. */
export function surchargeCellRow(row: Pick<SurchargeGridRow, 'styleId' | 'kind'>, size: string, value: string | null): SurchargeRow | Phrase {
  if (value === null) return { styleId: row.styleId, size, amount: null, pct: null }
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return { key: row.kind === 'amount' ? 'surcharges.held.amount' : 'surcharges.held.pct' }
  if (row.kind === 'pct' && number > 100) return { key: 'surcharges.held.pct' }
  return { styleId: row.styleId, size, amount: row.kind === 'amount' ? value : null, pct: row.kind === 'pct' ? value : null }
}

export interface SurchargeDraft {
  /** '' = every style of the version. */
  styleId: string
  /** Sizes typed, comma or space apart ("54, 56"). */
  sizes: string
  kind: 'amount' | 'pct'
  value: string
}

export const emptySurcharge = (): SurchargeDraft => ({ styleId: '', sizes: '', kind: 'amount', value: '' })

/** The size codes typed, as stored (capitals, no spaces), each once. */
export const sizesTyped = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((size) => size.trim().toUpperCase()).filter(Boolean))]

/** What stops Add a surcharge (Phrase), or null. */
export function surchargeHeld(draft: SurchargeDraft): Phrase | null {
  const sizes = sizesTyped(draft.sizes)
  if (sizes.length === 0) return { key: 'surcharges.held.sizes' }
  if (sizes.some((size) => size.length > 40)) return { key: 'surcharges.held.size' }
  if (draft.kind === 'amount') return parseListPrice(draft.value) === null ? { key: 'surcharges.held.amount' } : null
  const pct = parsePercent(draft.value)
  return pct === null || Number(pct) <= 0 ? { key: 'surcharges.held.pct' } : null
}

export function surchargeRowsOf(draft: SurchargeDraft): SurchargeRow[] {
  const amount = draft.kind === 'amount' ? parseListPrice(draft.value) : null
  const pct = draft.kind === 'pct' ? parsePercent(draft.value) : null
  return sizesTyped(draft.sizes).map((size) => ({ styleId: draft.styleId || null, size, amount, pct }))
}

// ---- minimums (SAL-178) --------------------------------------------------------------------------------------------------

export interface MinimumDraft {
  subject: 'STYLE' | 'PRODUCT_TYPE' | 'MATERIAL'
  styleId: string
  productType: string
  itemId: string
  minQuantity: string
  per: (typeof MINIMUM_PER)[number]
  action: (typeof MINIMUM_ACTIONS)[number]
  /** SURCHARGE: an amount per piece or a percent of the unit price. */
  surchargeKind: 'amount' | 'pct'
  surcharge: string
  note: string
}

export const emptyMinimum = (): MinimumDraft => ({ subject: 'STYLE', styleId: '', productType: '', itemId: '', minQuantity: '', per: 'LINE', action: 'WARN', surchargeKind: 'amount', surcharge: '', note: '' })

/** What stops New minimum (Phrase), checked as the API will (one ACTIVE rule per subject and count is the API's). */
export function minimumHeld(draft: MinimumDraft, minimums: readonly Minimum[]): Phrase | null {
  if (draft.subject === 'STYLE' && !draft.styleId) return { key: 'minimums.held.style' }
  if (draft.subject === 'PRODUCT_TYPE' && !(PRODUCT_TYPES as readonly string[]).includes(draft.productType)) return { key: 'minimums.held.type' }
  if (draft.subject === 'MATERIAL' && !draft.itemId) return { key: 'minimums.held.item' }
  const quantity = wholeQuantity(draft.minQuantity)
  if (quantity === null) return { key: 'minimums.held.quantity' }
  if (draft.action === 'SURCHARGE') {
    if (draft.surchargeKind === 'amount' && parseListPrice(draft.surcharge) === null) return { key: 'minimums.held.amount' }
    if (draft.surchargeKind === 'pct' && (parsePercent(draft.surcharge) === null || Number(parsePercent(draft.surcharge)) <= 0)) return { key: 'minimums.held.pct' }
  }
  if (draft.note.trim().length > 500) return { key: 'minimums.held.note' }
  const twin = minimums.find((rule) => rule.status === 'ACTIVE' && rule.subject === draft.subject && rule.per === draft.per && (draft.subject === 'STYLE' ? rule.styleId === draft.styleId : draft.subject === 'PRODUCT_TYPE' ? rule.productType === draft.productType : rule.itemId === draft.itemId))
  if (twin) return { key: 'minimums.held.twin' }
  return null
}

export function minimumBody(draft: MinimumDraft, list: { id: string; companyId: string | null; currency: string }): NewMinimumBody {
  const surcharge = draft.action === 'SURCHARGE'
  return {
    companyId: list.companyId,
    priceListId: list.id,
    ...(draft.subject === 'STYLE' ? { styleId: draft.styleId } : draft.subject === 'PRODUCT_TYPE' ? { productType: draft.productType as NewMinimumBody['productType'] } : { itemId: draft.itemId }),
    minQuantity: Number(draft.minQuantity),
    per: draft.per,
    action: draft.action,
    surchargeAmount: surcharge && draft.surchargeKind === 'amount' ? parseListPrice(draft.surcharge) : null,
    currency: surcharge && draft.surchargeKind === 'amount' ? list.currency : null,
    surchargePct: surcharge && draft.surchargeKind === 'pct' ? parsePercent(draft.surcharge) : null,
    note: draft.note.trim() || null,
  }
}

/** The minimums Archive N / Reactivate N reach (the ACTIVE ones, the ARCHIVED ones). */
export const movableMinimums = (minimums: readonly Minimum[], ids: readonly string[], move: 'archive' | 'reactivate'): Minimum[] => minimums.filter((rule) => ids.includes(rule.id) && rule.status === (move === 'archive' ? 'ACTIVE' : 'ARCHIVED'))
