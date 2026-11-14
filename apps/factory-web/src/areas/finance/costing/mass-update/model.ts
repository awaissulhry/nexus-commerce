import { isApiError, issuePath } from '../../../../lib/api/errors'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { MassChange, MassPreviewView, MaterialRow } from './api'

/**
 * Finance › Costing › Mass cost update (B-W2b-430; design finance.costing pop:mass "New material price; cost sheets
 * affected; effect on margins of open orders and price lists", "Approve update"), pure: who may look (costing.view and the
 * cost grain: the preview is all costs) and who may apply (costing.massUpdate.apply, then a fresh code), the new prices typed,
 * why each step waits, the refusals in words from their codes, the money written in the person's language (a decimal
 * string, or an order line's minor units). Words: `cost-sheets` (`mass.*`).
 */

export const MASS_NS = 'cost-sheets'

export interface MassAbilities {
  /** The preview: costing.view with the cost grain. */
  preview: boolean
  /** The apply: costing.massUpdate.apply (a fresh code is asked). */
  apply: boolean
  /** Find a material to price. */
  materials: boolean
  margin: boolean
  price: boolean
}

export function massAbilitiesOf(permissions: readonly string[]): MassAbilities {
  const held = new Set(permissions)
  return {
    preview: held.has('costing.view') && held.has('money.cost'),
    apply: held.has('costing.massUpdate.apply'),
    materials: held.has('product.materials.view'),
    margin: held.has('money.margin'),
    price: held.has('money.price'),
  }
}

/** One material and the new price typed for it. */
export interface PriceRow {
  readonly itemId: string
  readonly code: string
  readonly name: string
  readonly baseUom: string
  readonly currency: string
  readonly priceNow: string | null
  /** As typed ("12,50"). */
  readonly newPrice: string
}

export const MASS_MAX_CHANGES = 50

export function priceRowOf(material: MaterialRow): PriceRow {
  return { itemId: material.id, code: material.code, name: material.name, baseUom: material.baseUom, currency: material.currency, priceNow: material.standardCost ?? null, newPrice: '' }
}

/** A typed price as the API takes it (above 0, at most 6 decimals), or null. */
export function typedPrice(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(value)) return null
  return Number(value) > 0 ? value : null
}

/** A row's problem (a message key), or null. */
export function rowProblem(row: PriceRow): string | null {
  if (row.newPrice.trim() === '') return 'mass.problem.empty'
  const price = typedPrice(row.newPrice)
  if (price === null) return 'mass.problem.price'
  if (row.priceNow !== null && Number(row.priceNow) === Number(price)) return 'mass.problem.same'
  return null
}

export function changesOf(rows: readonly PriceRow[]): MassChange[] {
  return rows.map((row) => ({ itemId: row.itemId, newPrice: typedPrice(row.newPrice) ?? row.newPrice }))
}

/** Why "Show the effect" waits, or null (a message key with its values). */
export function previewHeld(can: MassAbilities, rows: readonly PriceRow[], busy: boolean): { key: string; params?: Record<string, string | number> } | null {
  if (!can.preview) return { key: 'mass.held.noGrain' }
  if (rows.length === 0) return { key: 'mass.held.noRows' }
  if (rows.length > MASS_MAX_CHANGES) return { key: 'mass.held.tooMany', params: { max: MASS_MAX_CHANGES } }
  const wrong = rows.find((row) => rowProblem(row) !== null)
  if (wrong) return { key: 'mass.held.row', params: { code: wrong.code } }
  if (busy) return { key: 'mass.held.busy' }
  return null
}

/** Why "Approve update" waits, or null. */
export function applyHeld(can: MassAbilities, preview: MassPreviewView | null, leaveOut: boolean, busy: boolean): { key: string; params?: Record<string, string | number> } | null {
  if (!can.apply) return { key: 'mass.held.noApply' }
  if (!preview) return { key: 'mass.held.noPreview' }
  if (preview.counts.series === 0 && preview.withoutSheet.length === 0) return { key: 'mass.held.nothing' }
  if (preview.counts.incomplete > 0 && !leaveOut) return { key: 'mass.held.incomplete', params: { count: preview.counts.incomplete } }
  if (busy) return { key: 'mass.held.busy' }
  return null
}

export const MASS_REFUSALS = ['STALE', 'TOO_MANY', 'NOTHING_AFFECTED', 'NOTHING_CHANGES', 'NOT_RECOMPUTED', 'NO_RIGHT'] as const

/** The code of a 409 `refusal/<CODE>`, or null. */
export function massRefusal(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
    if (match && (MASS_REFUSALS as readonly string[]).includes(match[1]!)) return match[1]!
  }
  return null
}

/** A refused preview or apply in words: its refusal, else the kind (no right, a fresh code wanted, the network …). */
export function massProblem(error: unknown): string {
  const code = massRefusal(error)
  if (code) return `massRefusal.${code}`
  if (!isApiError(error)) return 'mass.problem.unavailable'
  if (error.kind === 'forbidden') return 'mass.problem.forbidden'
  if (error.kind === 'step_up') return 'mass.problem.stepUp'
  if (error.kind === 'invalid') return 'mass.problem.invalid'
  if (error.kind === 'conflict') return 'mass.problem.moved'
  return 'mass.problem.unavailable'
}

/** A decimal amount ("12.500000") in the person's language and the currency. */
export function decimalMoney(value: string | null | undefined, currency: string, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const small = Math.abs(number) < 1 && number !== 0
  return formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: small ? 4 : 2 })
}

/** A sheet's cost without its currency (the preview names none for a series: the series' company's currency). */
export function plainMoney(value: string | null | undefined, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return formatNumber(number, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** An order line's amount in minor units. */
export function minorMoney(value: number | null | undefined, currency: string, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  return formatNumber(value / 100, locale, { style: 'currency', currency })
}

/** A percent ("28.45" → "28,5 %"); signed for a move. */
export function percent(value: string | null | undefined, locale: Locale, signed = false): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const text = `${formatNumber(Math.abs(number), locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 })} %`
  if (number < 0) return `−${text}`
  return signed && number > 0 ? `+${text}` : text
}

/** The series a created draft belongs to (the apply answers its key; the preview named its style). */
export function styleOfKey(preview: MassPreviewView | null, key: string): { id: string; code: string } | null {
  const series = preview?.series.find((entry) => entry.key === key)
  return series ? { id: series.style.id, code: series.style.code } : null
}

/** A live change that may move the preview: a price, a version, a price list or an order line. */
export const massTouched = (change: { type: string }): boolean =>
  change.type === 'material.standard_cost_changed' || change.type === 'cost_sheet.version_changed' || change.type === 'cost_sheet.approved' || change.type === 'mass_update.applied'
