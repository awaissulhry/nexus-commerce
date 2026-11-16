import type { Grains } from '../../model'
import type { VersionRecord, VersionRow } from '../versions/api'
import { typedAmount, type CostSheetAbilities, type Phrase } from '../versions/model'

/**
 * Lines typed on a draft version (B-W2b-GB02, G054; B-W2b-430 gap 1; FIN-012; design products.styles › Cost › Cost sheet
 * "Commissions (W2b)"), pure: the typed lines of the version in view (an agent's commission, a royalty, a payment fee, or a
 * figure the components do not know), what the Add dialog holds while the person types, why it waits, the body of POST
 * /costing/cost-sheets/:id/typed-lines and how a line is made in words. A commission in percent is a share of the version's
 * target price (it follows the price); every figure needs the cost grain. Words: the `cost-sheets` catalogue (`typed.*`).
 */

/** The categories a person types a line in (the API's TYPED_CATEGORIES): never leather or labour (BOM and routing). */
export const TYPED_CATEGORIES = ['COMMISSION', 'MATERIAL', 'PACKAGING', 'SUBCONTRACT', 'FREIGHT', 'DUTY', 'OVERHEAD'] as const
export type TypedCategory = (typeof TYPED_CATEGORIES)[number]

export type TypedLine = VersionRecord['lines'][number]

/** The typed lines of a version, in their places. */
export const typedLinesOf = (record: Pick<VersionRecord, 'lines'>): TypedLine[] => record.lines.filter((line) => line.source === 'TYPED').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

/** What the Add dialog holds. `mode`: a commission in percent of the target price, or an amount (quantity × cost of one). */
export interface TypedDraft {
  readonly category: TypedCategory
  readonly mode: 'percent' | 'amount'
  readonly label: string
  /** '' = every size. */
  readonly size: string
  readonly pct: string
  readonly quantity: string
  readonly unitCost: string
  readonly note: string
}

export const typedDraft = (given: Partial<TypedDraft> = {}): TypedDraft => ({ category: 'COMMISSION', mode: 'percent', label: '', size: '', pct: '', quantity: '1', unitCost: '', note: '', ...given })

/** A percent above 0 and at most 100 (4 decimals), as the API takes it, or null. */
export function typedPct(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(value)) return null
  const number = Number(value)
  return number > 0 && number <= 100 ? value : null
}

/** A quantity above 0 with at most 4 decimals, or null. */
export function typedQuantity(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(value)) return null
  return Number(value) > 0 ? value : null
}

/** Only a commission is typed in percent; another category is always an amount. */
export const modeOf = (draft: Pick<TypedDraft, 'category' | 'mode'>): 'percent' | 'amount' => (draft.category === 'COMMISSION' ? draft.mode : 'amount')

export type TypedField = 'label' | 'pct' | 'quantity' | 'unitCost' | 'note'

/** The dialog's problems by field (message keys). */
export function typedProblems(draft: TypedDraft): Partial<Record<TypedField, string>> {
  const problems: Partial<Record<TypedField, string>> = {}
  const label = draft.label.trim()
  if (label === '') problems.label = 'typed.problem.label'
  else if (label.length > 200 || /[\r\n]/.test(label)) problems.label = 'typed.problem.labelLong'
  if (modeOf(draft) === 'percent') {
    if (typedPct(draft.pct) === null) problems.pct = 'typed.problem.pct'
  } else {
    if (typedQuantity(draft.quantity) === null) problems.quantity = 'typed.problem.quantity'
    if (typedAmount(draft.unitCost) === null) problems.unitCost = 'typed.problem.unitCost'
  }
  if (draft.note.trim().length > 1000) problems.note = 'typed.problem.note'
  return problems
}

/** The body of POST …/typed-lines (the row's version as read). */
export function typedBody(draft: TypedDraft, version: number) {
  const percent = modeOf(draft) === 'percent'
  return {
    version,
    category: draft.category,
    label: draft.label.trim(),
    ...(draft.size ? { size: draft.size } : {}),
    ...(percent ? { pct: typedPct(draft.pct)! } : { quantity: typedQuantity(draft.quantity)!, unitCost: typedAmount(draft.unitCost)! }),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Why "Type a line" waits, or null: a draft, the right to keep sheets, the cost grain (every figure is a cost). */
export function typedHeld(can: CostSheetAbilities, grains: Grains, row: VersionRow | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!row) return phrase('verHeld.reading')
  if (row.state !== 'DRAFT') return phrase('verHeld.locked')
  if (!grains.cost) return phrase('typed.held.noCostGrain')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why the percent of a commission waits, or null: it is a share of the target price, which the version must have. */
export function percentHeld(row: Pick<VersionRow, 'targetPrice'> | null, grains: Grains): Phrase | null {
  if (!grains.price) return phrase('typed.held.noPriceGrain')
  if (!row || row.targetPrice === null || row.targetPrice === undefined) return phrase('typed.held.noTarget')
  return null
}

/** The figures the dialog shows before the write: a percent line's cost from the target price, an amount line's quantity × cost. */
export function typedPreview(draft: TypedDraft, targetPrice: string | null | undefined): string | null {
  if (modeOf(draft) === 'percent') {
    const pct = typedPct(draft.pct)
    if (pct === null || targetPrice === null || targetPrice === undefined) return null
    return ((Number(targetPrice) * Number(pct)) / 100).toFixed(6)
  }
  const quantity = typedQuantity(draft.quantity)
  const unit = typedAmount(draft.unitCost)
  return quantity === null || unit === null ? null : (Number(quantity) * Number(unit)).toFixed(6)
}

/** How a typed line is made, in words: a percent of the target price, or quantity × cost of one (only quantities without the grain). */
export function typedHow(line: Pick<TypedLine, 'pct' | 'quantity' | 'unitCost' | 'cost'>, money: (value: string | null | undefined) => string | null, number: (value: string) => string): Phrase {
  if (line.pct !== null && line.pct !== undefined) {
    const cost = money(line.cost)
    return phrase(cost ? 'typed.how.percent' : 'typed.how.percentNoGrain', { pct: number(line.pct), amount: cost ?? '' })
  }
  const unit = money(line.unitCost)
  const cost = money(line.cost)
  return unit && cost ? phrase('typed.how.amount', { quantity: number(line.quantity), unit, amount: cost }) : phrase('typed.how.quantityOnly', { quantity: number(line.quantity) })
}

/** Why removing a typed line waits, or null. */
export function removeTypedHeld(can: CostSheetAbilities, row: VersionRow | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!row || row.state !== 'DRAFT') return phrase('verHeld.locked')
  if (busy) return phrase('verHeld.busy')
  return null
}
