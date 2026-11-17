import type { WorkOrder, WorkOrderStatus } from '../../../_shared/api'
import { percentOf, stepTotals, type Phrase } from '../../../_shared/model'
import type { Finished } from '../../daily/api'
import { FINISHABLE } from '../../daily/model'

/**
 * F-PR-05a — the work order record's band facts and Overview body, without a screen (production plan §5 "Work order record: band
 * facts; Report finished as main step; Overview tab with ONE progress table"; 06-tree A.4 O-WO-band, O-WO-progress; 09-design §2(c)).
 */

// ---- the band ------------------------------------------------------------------------------------------------------------------

/** "% done": finished ÷ pieces; "Not released yet" before the release; "—" where finished is not counted (never 0). */
export function doneFact(workOrder: Pick<WorkOrder, 'status' | 'cells' | 'pieces'>): Phrase {
  if (workOrder.status === 'DRAFT') return { key: 'progress.notFrozen' }
  const finished = stepTotals(workOrder).finished
  const percent = percentOf(finished, workOrder.pieces)
  return percent === null ? { key: 'band.doneUnknown' } : { key: 'band.done', params: { percent } }
}

/** The customer fact: its one customer (a link with parties.view), a work order made before the one-customer rule, or none. */
export type CustomerFact = { readonly kind: 'customer'; readonly id: string; readonly code: string; readonly name: string } | { readonly kind: 'mixed' } | { readonly kind: 'none' }

export function customerFactOf(workOrder: Pick<WorkOrder, 'customer' | 'mixedCustomers'>): CustomerFact {
  if (workOrder.customer) return { kind: 'customer', ...workOrder.customer }
  return workOrder.mixedCustomers ? { kind: 'mixed' } : { kind: 'none' }
}

/**
 * Report finished is the band's primary while released garments wait to go into stock (06-tree A.4: "Release → Start → Report
 * finished (moved out of the Bundles tab; primary while released garments wait) → Complete → Close"). A repair goes to no stock.
 */
export function reportFirst(workOrder: Pick<WorkOrder, 'status' | 'kind'>, finished: Pick<Finished, 'garments'> | null): boolean {
  return workOrder.kind !== 'REPAIR' && FINISHABLE.includes(workOrder.status) && (finished?.garments.canReport ?? 0) > 0
}

/** "Preview as <customer>" (⋯): held without the right, or without one customer to preview (a mixed or customer-less work order). */
export function previewHeld(fact: CustomerFact, can: boolean, busy: boolean): Phrase | null {
  if (!can) return { key: 'band.previewNoRight' }
  if (fact.kind !== 'customer') return { key: 'band.previewNoCustomer' }
  if (busy) return { key: 'held.busy' }
  return null
}

/** The portal record the preview opens: the work order's one order (its Status & progress), else the customer's portal home. */
export function previewRecord(workOrder: Pick<WorkOrder, 'orders'>): { type: 'SalesOrder'; id: string } | null {
  const ids = [...new Set(workOrder.orders.map((order) => order.id))]
  return ids.length === 1 ? { type: 'SalesOrder', id: ids[0]! } : null
}

// ---- ONE progress table (O-WO-progress: the 6-way size switch goes) --------------------------------------------------------------

export const PROGRESS_ROWS = ['quantity', 'cut', 'bundled', 'sewn', 'finished', 'balance'] as const
export type ProgressRow = (typeof PROGRESS_ROWS)[number]

export interface ProgressBlock {
  readonly colourway: string
  readonly rows: ReadonlyArray<{
    readonly step: ProgressRow
    /** Per size in the table's order: a count, null where the floor does not count the step ("—"), undefined where the colourway has no such size. */
    readonly cells: ReadonlyArray<number | null | undefined>
    /** null: the step is counted nowhere in this colourway. */
    readonly total: number | null
  }>
}

export interface ProgressTable {
  readonly sizes: readonly string[]
  readonly blocks: readonly ProgressBlock[]
  /** The whole work order per step (the last block, "Total"). */
  readonly totals: ProgressBlock['rows']
}

const stepOf = (cell: WorkOrder['cells'][number], step: ProgressRow): number | null => {
  if (step === 'quantity') return cell.quantity
  if (step === 'balance') return cell.progress.finished === null ? null : Math.max(0, cell.quantity - cell.progress.finished)
  return cell.progress[step]
}

const sumOf = (values: ReadonlyArray<number | null | undefined>): number | null => {
  const counted = values.filter((value): value is number => typeof value === 'number')
  return counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0)
}

/**
 * The work order's pieces in ONE table: per colourway the rows Ordered · Cut · In bundles · Sewn · Finished · Still to finish, the
 * columns its sizes (the style's scale order) and Total, and a Total block over every colourway. A step the floor does not count is
 * "—", never 0; a size a colourway does not have is empty. Per work order only (no person's output anywhere).
 */
export function progressTableOf(workOrder: Pick<WorkOrder, 'cells' | 'style'>): ProgressTable {
  const used = new Set(workOrder.cells.map((cell) => cell.size))
  const sizes = workOrder.style.sizes.filter((size) => used.has(size))
  for (const size of used) if (!sizes.includes(size)) sizes.push(size)
  const colourways = [...new Set(workOrder.cells.map((cell) => cell.colourwayCode))]
  const blocks = colourways.map((code): ProgressBlock => {
    const mine = workOrder.cells.filter((cell) => cell.colourwayCode === code)
    const name = mine[0]?.colourwayName ?? ''
    return {
      colourway: name ? `${code} · ${name}` : code,
      rows: PROGRESS_ROWS.map((step) => {
        const cells = sizes.map((size) => {
          const here = mine.filter((cell) => cell.size === size)
          if (here.length === 0) return undefined
          return sumOf(here.map((cell) => stepOf(cell, step)))
        })
        return { step, cells, total: sumOf(cells) }
      }),
    }
  })
  const totals = PROGRESS_ROWS.map((step) => {
    const cells = sizes.map((size) => sumOf(workOrder.cells.filter((cell) => cell.size === size).map((cell) => stepOf(cell, step))))
    return { step, cells, total: sumOf(cells) }
  })
  return { sizes, blocks, totals }
}

/** A table cell as drawn: the count, "—" where not counted, empty where the colourway has no such size. */
export const progressCell = (value: number | null | undefined): string => (value === undefined ? '' : value === null ? '—' : String(value))

/** The statuses whose Overview shows the progress table (a draft shows its sizes being edited instead). */
export const showsProgress = (status: WorkOrderStatus): boolean => status !== 'DRAFT'
