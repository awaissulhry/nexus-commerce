import { askedLines, SHIP_TOGETHER_MAX, type AskedLine, type ShippingAbilities } from '../../../../warehouse/shipments/model'
import type { NewShipmentModel } from '../../../../warehouse/shipments/list/list-model'
import type { OrderRow } from '../../api'
import { oneCustomerHeld, type Phrase } from './model'

/**
 * F-CW-301 (customer Work tab plan §4; 10-design §4, §5, §6 W1; 13-backend §5, §8; lead settle S8) — "Ship N together…" on the ONE
 * Orders sheet (the bar's first act) and "Create shipment…" on a row: Warehouse's own New shipment window, mounted here a third time
 * (never copied). The sheet's own part is pure and small: when the act is held BEFORE the click, and the words it adds over the
 * window — which ticked orders it runs on and which not (with why), the cap, "wants it all in one delivery", a draft that exists.
 * Sales has no shipping right (S23): for them the act is not drawn (sheet/bar.ts).
 */

/** The ticked rows as these rules read them. */
export type ShipRow = Pick<OrderRow, 'id' | 'number' | 'customerRef' | 'partyId' | 'partyName' | 'status' | 'units' | 'shippedUnits' | 'production'>

/** The states in which an order can have garments released and not shipped: being made, ready, partly shipped. */
export const SHIP_STATES: readonly OrderRow['status'][] = Object.freeze(['IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])
/** An order with nothing to ship by its state alone (not started, all shipped, closed, cancelled). */
const isOver = (row: Pick<OrderRow, 'status'>): boolean => !SHIP_STATES.includes(row.status)

/**
 * What the row says is ready now (released, on no shipment yet): the server's count when the production part was read; null: not
 * known here (the window's own read says it).
 */
export const readyNowOf = (row: Pick<OrderRow, 'production'>): number | null => (typeof row.production?.readyNow === 'number' ? row.production.readyNow : null)

/**
 * Why "Ship N together…" is held before the click, or null: orders of more than one customer (or another customer's on a customer's
 * page), more than the shipment's cap, or — only when every ticked row KNOWS it — nothing ready now on any of them. Unknown counts
 * never hold: the window reads what can ship and says it.
 */
export function shipHeld(rows: readonly ShipRow[], locked: string | null): Phrase | null {
  if (rows.length === 0) return null
  const one = oneCustomerHeld(rows, locked)
  if (one) return one
  if (rows.length > SHIP_TOGETHER_MAX) return { key: 'ship.cap', params: { max: SHIP_TOGETHER_MAX } }
  // cw fx5 (walk W-28): by the FACT first — an order that knows it has garments ready counts whatever its status says (a confirmed
  // order with a released garment ships); the status decides only where the count is not known.
  if (rows.every((row) => nothingReady(row))) return { key: 'ship.nothing', params: { count: rows.length } }
  return null
}

/** Nothing of the order can ship now: it knows 0 ready, or — the count not read — its state alone says so. */
const nothingReady = (row: Pick<OrderRow, 'status' | 'production'>): boolean => {
  const ready = readyNowOf(row)
  return ready === null ? isOver(row) : ready === 0
}

/** The states after which nothing waits to ship: all left, or the order ended. */
const SHIP_ENDED: readonly OrderRow['status'][] = Object.freeze(['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'])

/**
 * A row offers "Create shipment…" by the fact, not the status alone (walk W-28): whenever it knows garments are ready now (a
 * confirmed order with a released garment ships), in a state where garments can wait to ship, and on any order that stands at a
 * stage of the floor and has not ended — there it is held with words while none is ready. Never on an order with nothing ready
 * and no stage (before production), never once all left.
 */
export const shipRowOffered = (row: Pick<OrderRow, 'status' | 'production'>): boolean =>
  (readyNowOf(row) ?? 0) > 0 || !isOver(row) || (!!row.production?.stage && !SHIP_ENDED.includes(row.status))

/** …held, with the order page's own words, when the row knows nothing is ready now. */
export const shipRowHeld = (row: Pick<OrderRow, 'production'>): boolean => readyNowOf(row) === 0

/** The order the window is made for first: a ticked row that knows it has garments ready, else the first ticked. */
export function shipFirstOf(rows: readonly ShipRow[]): string | null {
  return (rows.find((row) => (readyNowOf(row) ?? 0) > 0) ?? rows.find((row) => !isOver(row)) ?? rows[0])?.id ?? null
}

// ---- the words over the window -----------------------------------------------------------------------------------------------------

/** The window's summary: how many ticked orders it runs on, and the ones it does not, each with why. */
export interface ShipSummary {
  readonly runs: number
  readonly notOn: readonly AskedLine[]
  /** Every ticked order. */
  readonly asked: number
}

/** "Runs on 4 · Not on 2: why is beside each" — null while the window still reads, or when it was not opened from ticked orders. */
export function shipSummaryOf(open: Pick<NewShipmentModel, 'orders' | 'salesOrderId' | 'others' | 'asked'>): ShipSummary | null {
  if (!open.asked || open.orders === null) return null
  const lines = askedLines(open)
  return { runs: lines.filter((line) => line.on).length, notOn: lines.filter((line) => !line.on), asked: lines.length }
}

/** An order whose customer wants it all in one delivery, and what this shipment would carry of it. */
export interface CompleteWarning {
  readonly id: string
  /** The garments this shipment would carry of it: the typed ones at step 2, what it can ship now at step 1. */
  readonly carried: number
  /** The pieces the order still owes (ordered − shipped). */
  readonly owed: number
}

/**
 * "<Customer> wants <order> all in one delivery. This shipment would carry 24 of its 244 pieces." — for each order ON the shipment
 * whose delivery terms say ship complete (`complete`: the orders' own read, by id; an order not read yet warns nothing) while the
 * shipment would carry fewer pieces than the order still owes.
 */
export function completeWarnings(
  open: Pick<NewShipmentModel, 'orders' | 'salesOrderId' | 'others' | 'quantities' | 'step'>,
  rows: readonly Pick<OrderRow, 'id' | 'units' | 'shippedUnits'>[],
  complete: Readonly<Record<string, boolean>>,
): CompleteWarning[] {
  const on = [open.salesOrderId, ...(open.others ?? [])].filter((id): id is string => !!id)
  return on.flatMap((id) => {
    if (!complete[id]) return []
    const order = (open.orders ?? []).find((entry) => entry.salesOrderId === id)
    const row = rows.find((entry) => entry.id === id)
    if (!order || !row) return []
    const carried = order.cells.reduce((sum, cell) => sum + (open.step === 2 ? Math.min(open.quantities[cell.workOrderSizeId] ?? 0, cell.shippable) : cell.shippable), 0)
    const owed = Math.max(0, row.units - row.shippedUnits)
    return carried < owed ? [{ id, carried, owed }] : []
  })
}

/** The one notice after Create: the draft's number and door, and the orders it carries (each a door to its thread). */
export interface ShipNotice {
  readonly shipmentId: string
  readonly number: string
  readonly orders: ReadonlyArray<{ readonly id: string; readonly number: string }>
  readonly customer: string | null
}

/** The sheet's mount of the window, as its container holds it (use-ship-together.ts) and the view draws it (view/ShipTogether.tsx). */
export interface ShipTogetherModel {
  readonly can: ShippingAbilities
  /** Warehouse's window, as its own hook holds it (null: closed). */
  readonly window: NewShipmentModel | null
  /** The orders on the shipment whose customer wants them all in one delivery (by id; an order not read yet is absent). */
  readonly complete: Readonly<Record<string, boolean>>
  /** A DRAFT of the customer that exists already — a door; joining several orders to it is a later job. */
  readonly draft: { readonly shipmentId: string; readonly number: string } | null
  /** The one notice after Create. */
  readonly notice: ShipNotice | null
}
