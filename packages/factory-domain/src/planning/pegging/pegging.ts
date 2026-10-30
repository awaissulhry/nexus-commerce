import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import type { MaterialPegging } from '../mrp/net'

/**
 * Pegging (B-W2a-22; PLN-071 "pegging across many orders"; design planning.mrp "For orders: pegging tree up to the
 * customer order or MTM unit"), pure: the rows a run writes (RequirementPegging, append-only, one row per demand part ×
 * supply) and the tree a screen draws from them.
 *
 *   demand   ORDER_LINE  an order line in one size (a made-to-measure unit: the line) with no work order yet
 *            WORK_ORDER  an open work order's pieces, with the order line (and size) they make
 *   supply   RESERVATION stock reserved for that work order or order line
 *            STOCK       free usable stock at the site
 *            PURCHASE_ORDER an open purchase order line due on or before the demand's day (its date)
 *            PLANNED     the requirement's planned order: the firm planned order (its date) or the suggestion (the
 *                        requirement's need date)
 *
 * A demand's rows add up to what it still needs (its quantity less what was issued to its work order): its share of
 * the requirement's gross quantity. Issued material is never pegged (it left stock). Safety stock and reorder rules are
 * not planned by the run in W2a (the buyer's queue keeps the reorder rows live, B-W2a-10): SAFETY_STOCK and REORDER are
 * never written here.
 */

export const PEGGING_DEMAND_KINDS = ['ORDER_LINE', 'WORK_ORDER', 'SAFETY_STOCK', 'REORDER'] as const
export type PeggingDemandKind = (typeof PEGGING_DEMAND_KINDS)[number]
export const PEGGING_SUPPLY_KINDS = ['STOCK', 'RESERVATION', 'PURCHASE_ORDER', 'PLANNED'] as const
export type PeggingSupplyKind = (typeof PEGGING_SUPPLY_KINDS)[number]

/** One row to write (the API adds ids, the run, the requirement and the creation). */
export interface PegRow {
  readonly seq: number
  readonly demandKind: PeggingDemandKind
  readonly salesOrderLineId: string | null
  readonly partyId: string | null
  readonly size: string | null
  readonly workOrderId: string | null
  readonly demandDate: BusinessDate
  readonly quantity: string
  readonly supplyKind: PeggingSupplyKind
  readonly reservationId: string | null
  readonly purchaseOrderLineId: string | null
  readonly supplyDate: BusinessDate | null
}

const SUPPLY_ORDER: Readonly<Record<PeggingSupplyKind, number>> = { RESERVATION: 0, STOCK: 1, PURCHASE_ORDER: 2, PLANNED: 3 }

/**
 * The rows of one requirement: per part (by the netting's day order), its supplies (reservation, stock, purchase lines,
 * the planned order). A part whose order line has no party (a stored line always has one) is pegged to its work order
 * only, or not at all: the DB's shape rule names an order line with its party.
 */
export function peggingRowsOf(netting: Pick<MaterialPegging, 'coverage'>, needDate: BusinessDate): PegRow[] {
  const rows: PegRow[] = []
  for (const coverage of netting.coverage) {
    const { part } = coverage
    const line = part.partyId ? { salesOrderLineId: part.orderLineId, partyId: part.partyId, size: part.size } : { salesOrderLineId: null, partyId: null, size: null }
    if (part.workOrderId === null && line.salesOrderLineId === null) continue
    const demand = { demandKind: (part.workOrderId ? 'WORK_ORDER' : 'ORDER_LINE') as PeggingDemandKind, ...line, workOrderId: part.workOrderId, demandDate: coverage.day }
    const supplies = coverage.supplies
      .filter((supply) => supply.kind !== 'ISSUED' && decimalOf(supply.quantity).gt(0))
      .map((supply) => {
        const kind: PeggingSupplyKind = supply.kind === 'FIRM' || supply.kind === 'PLANNED' ? 'PLANNED' : (supply.kind as PeggingSupplyKind)
        return {
          supplyKind: kind,
          quantity: decimalOf(supply.quantity).toFixed(QUANTITY_SCALE),
          reservationId: supply.reservationId ?? null,
          purchaseOrderLineId: supply.purchaseOrderLineId ?? null,
          supplyDate: kind === 'PURCHASE_ORDER' ? (supply.date ?? null) : kind === 'PLANNED' ? (supply.kind === 'FIRM' ? (supply.date ?? needDate) : needDate) : null,
        }
      })
      .sort((a, b) => SUPPLY_ORDER[a.supplyKind] - SUPPLY_ORDER[b.supplyKind])
    for (const supply of supplies) rows.push({ seq: rows.length + 1, ...demand, ...supply })
  }
  return rows
}

// ---- the tree -----------------------------------------------------------------------------------------------------------

/** A stored row, as the tree reads it (names come with it). */
export interface StoredPeg {
  readonly requirementId: string
  readonly seq: number
  readonly demandKind: PeggingDemandKind
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly workOrderId: string | null
  readonly demandDate: BusinessDate
  readonly quantity: string
  readonly supplyKind: PeggingSupplyKind
  readonly reservationId: string | null
  readonly purchaseOrderLineId: string | null
  readonly supplyDate: BusinessDate | null
}

export interface PegDemandNode<Row extends StoredPeg> {
  /** `<requirementId>|<order line or ->|<size or ->|<work order or ->`. */
  readonly key: string
  readonly requirementId: string
  readonly demandKind: PeggingDemandKind
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly workOrderId: string | null
  readonly demandDate: BusinessDate
  /** What the demand still needs (the sum of its supplies). */
  readonly quantity: string
  /** Of it, planned (not covered by stock, a reservation or a purchase order line). */
  readonly planned: string
  readonly supplies: readonly Row[]
}

/** Rows grouped by demand (order line × size × work order), in the stored order. */
export function peggingTreeOf<Row extends StoredPeg>(rows: readonly Row[]): PegDemandNode<Row>[] {
  const nodes = new Map<string, { node: Omit<PegDemandNode<Row>, 'quantity' | 'planned' | 'supplies'>; supplies: Row[] }>()
  const sorted = [...rows].sort((a, b) => (a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : a.seq - b.seq))
  for (const row of sorted) {
    const key = [row.requirementId, row.salesOrderLineId ?? '-', row.size ?? '-', row.workOrderId ?? '-'].join('|')
    const entry = nodes.get(key) ?? {
      node: { key, requirementId: row.requirementId, demandKind: row.demandKind, salesOrderLineId: row.salesOrderLineId, size: row.size, workOrderId: row.workOrderId, demandDate: row.demandDate },
      supplies: [],
    }
    entry.supplies.push(row)
    nodes.set(key, entry)
  }
  return [...nodes.values()].map(({ node, supplies }) => ({
    ...node,
    quantity: supplies.reduce((sum, row) => sum.plus(decimalOf(row.quantity)), decimalOf('0')).toFixed(QUANTITY_SCALE),
    planned: supplies.filter((row) => row.supplyKind === 'PLANNED').reduce((sum, row) => sum.plus(decimalOf(row.quantity)), decimalOf('0')).toFixed(QUANTITY_SCALE),
    supplies,
  }))
}
