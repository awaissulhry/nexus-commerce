import { sizeOrder } from '@nexus/factory-domain/insights/sales-reports/rules'
import type { WorkOrderOwn } from '../overview/api'

/**
 * F-PT-105 (order PRODUCTION tab, 10-design §4 "Detail", D2, D9) — a work order's centred window, without a screen: THIS order's
 * pieces per size (Ordered · Cut · Sewn · Checked — its cells only, never another order's), the outside workshops with their issue and
 * back days, and the small "Priority and rush…" dialog (the same PATCH as before, one write for both).
 *
 * A step the server does not send yet (sewn and checked per cell: B-PT-002) is left out, never drawn as 0; a cell whose step is not
 * counted at its site is "—" (null).
 */

export const SIZE_STEPS = ['ordered', 'cut', 'sewn', 'checked'] as const
export type SizeStep = (typeof SIZE_STEPS)[number]

export interface SizeTable {
  readonly sizes: readonly string[]
  readonly rows: readonly { readonly step: SizeStep; readonly values: readonly (number | null)[]; readonly total: number | null }[]
}

type Cell = NonNullable<WorkOrderOwn['cells']>[number]

const sum = (values: readonly (number | null)[]): number | null => (values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0))

/** The cells of this order per size (in wearing order — fx5 #14: 50 · 52 · 54, never as they came; several lines of one size are summed); null: no cells read (an older read). */
export function sizeTableOf(cells: readonly Cell[] | undefined): SizeTable | null {
  if (!cells || cells.length === 0) return null
  const sizes: string[] = []
  const bySize = new Map<string, Cell[]>()
  for (const cell of cells) {
    if (!bySize.has(cell.size)) {
      bySize.set(cell.size, [])
      sizes.push(cell.size)
    }
    bySize.get(cell.size)!.push(cell)
  }
  sizes.sort(sizeOrder)
  const valueOf = (step: SizeStep, size: string): number | null => {
    const group = bySize.get(size) ?? []
    if (step === 'ordered') return group.reduce((total, cell) => total + cell.quantity, 0)
    return sum(group.map((cell) => (step === 'cut' ? cell.cut : step === 'sewn' ? (cell.sewn ?? null) : (cell.checked ?? null))))
  }
  // Sewn and checked are drawn only once the server sends them (B-PT-002): absent on every cell → the row is left out.
  const sent = (step: SizeStep) => step === 'ordered' || step === 'cut' || cells.some((cell) => (step === 'sewn' ? cell.sewn !== undefined : cell.checked !== undefined))
  const rows = SIZE_STEPS.filter(sent).map((step) => {
    const values = sizes.map((size) => valueOf(step, size))
    return { step, values, total: sum(values) }
  })
  return { sizes, rows }
}

/** The outside workshops of a work order with the days the server sends (B-PT-001: issued, expected back); a name alone before. */
export function workshopsOf(row: Pick<WorkOrderOwn, 'workshops'>): readonly { readonly name: string; readonly since: string | null; readonly back: string | null }[] {
  return row.workshops.map((shop) => ({ name: shop.name, since: shop.since ?? null, back: shop.expectedBack ?? null }))
}

// ---- Priority and rush… (D9: the same PATCH as the row's in-place fields were, one write for both) ----------------------------

/** The API's priority range (the PATCH takes -1000…1000, whole numbers). */
export const PRIORITY_MIN = -1000
export const PRIORITY_MAX = 1000

export interface PriorityRushDraft {
  readonly priority: string
  readonly rush: boolean
}

/** Why "Save" waits, or null: a whole number in the range, something changed, no write running. */
export function priorityRushHeld(draft: PriorityRushDraft, current: { readonly priority: number; readonly rush: boolean }, busy: boolean): { readonly key: string; readonly params?: Record<string, number> } | null {
  const text = draft.priority.trim()
  const value = Number(text)
  if (text === '' || !Number.isInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) return { key: 'productionTab.priority.problem', params: { min: PRIORITY_MIN, max: PRIORITY_MAX } }
  if (value === current.priority && draft.rush === current.rush) return { key: 'productionTab.priority.same' }
  if (busy) return { key: 'held.busy' }
  return null
}

/** The body the dialog sends (only what changed; the version is the acts hook's). */
export function priorityRushBodyOf(draft: PriorityRushDraft, current: { readonly priority: number; readonly rush: boolean }): { priority?: number; rush?: boolean } {
  const value = Number(draft.priority.trim())
  return { ...(value !== current.priority ? { priority: value } : {}), ...(draft.rush !== current.rush ? { rush: draft.rush } : {}) }
}
