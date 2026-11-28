import type { NewShipmentBody, ReadyCell, ReadyOrder, ShipmentDestination } from '../../../../../warehouse/shipments/api'
import { joinHeld } from '../../../../../warehouse/shipments/model'
import type { ShipRights } from '../legs/model'

/**
 * owb-ss3 step 3.1 (design plan § 7 "Shipping: three ways", § 5n; core.js SHIP_WAYS, office.js modal 'ship'; settles L3, L4, L5) — the
 * window "Ship the whole order…", pure. Three ways as big choices:
 *
 *   ALONE           Alone, in its own box — straight to the customer.
 *   TOGETHER        Together with the customer's other ready orders — the others from `GET /shipping/ready?salesOrderId=&together=1`
 *                   (only the same customer's; each with the read's verdict), ticked by default; none: "No other order is ready".
 *   OUR_WAREHOUSE   To our warehouse first — pick the warehouse (a site of kind WAREHOUSE); the customer reads "At the factory’s warehouse".
 *
 * "Make the shipment" makes a DRAFT through today's create (`POST /shipping/shipments`, every released garment of the orders on no
 * shipment, `salesOrderIds[]` ≤ 20 for "together", `destination`), never more (L4: the quick way never skips a legal step — the person
 * packs and sends in Warehouse: weights, the DDT, the holds). Doors by right: plan (shipping.plan OR shipping.manage). A way that cannot
 * be taken stays, held with its words (never hidden). The words are `ship-ways` (`ways.*`), the join reasons the Warehouse's.
 */

export const SHIP_WAYS = ['ALONE', 'TOGETHER', 'OUR_WAREHOUSE'] as const
export type ShipWay = (typeof SHIP_WAYS)[number]

/** The most orders one shipment carries from this window (the create's own limit). */
export const MAX_ORDERS = 20

export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** The catalogue: absent = `ship-ways`; `depth` = `warehouse-shipments-depth`, the Warehouse's join reasons. */
  readonly ns?: 'depth'
}

export interface WarehouseChoice {
  readonly siteId: string
  readonly name: string
  readonly city: string | null
}

export interface WayModel {
  readonly id: ShipWay
  /** The line under the way's name. */
  readonly sub: Said
  /** Why the way cannot be taken now (null: it can). */
  readonly held: Said | null
}

export interface TogetherRow {
  readonly salesOrderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly pieces: number
  /** Why this order cannot go with it (the read's verdict, the Warehouse's words); null: it may. */
  readonly held: Said | null
}

/** The released garments of an order on no shipment (what "the whole order" ships now). */
export const piecesOf = (order: Pick<ReadyOrder, 'cells'> | null | undefined): number => (order?.cells ?? []).reduce((sum, cell) => sum + Math.max(0, cell.shippable), 0)

/** The other ready orders of the customer, each with its verdict; an order with nothing to ship is not offered. */
export function togetherRowsOf(others: readonly ReadyOrder[], salesOrderId: string): TogetherRow[] {
  return others
    .filter((order) => order.salesOrderId !== salesOrderId && piecesOf(order) > 0)
    .map((order) => {
      const verdict = order.shipsWith ? joinHeld(order.shipsWith) : null
      return { salesOrderId: order.salesOrderId, number: order.number, customerRef: order.customerRef, pieces: piecesOf(order), held: verdict ? { key: verdict.key, ns: 'depth' as const } : null }
    })
}

/** The rows that may go with it (ticked by default). */
export const joinableIds = (rows: readonly TogetherRow[]): string[] => rows.filter((row) => row.held === null).map((row) => row.salesOrderId)

/** The three ways, each with its line and why it waits. */
export function waysOf(input: { readonly rows: readonly TogetherRow[]; readonly warehouses: readonly WarehouseChoice[] | null }): WayModel[] {
  const joinable = joinableIds(input.rows).length
  return [
    { id: 'ALONE', sub: { key: 'ways.alone.sub' }, held: null },
    { id: 'TOGETHER', sub: joinable > 0 ? { key: 'ways.together.sub', params: { count: joinable } } : { key: 'ways.together.none' }, held: joinable > 0 ? null : { key: 'ways.together.none' } },
    {
      id: 'OUR_WAREHOUSE',
      sub: { key: 'ways.warehouse.sub' },
      // Not read yet: it may still be taken (the pick waits); read and none: the company has no warehouse of its own.
      held: input.warehouses !== null && input.warehouses.length === 0 ? { key: 'ways.warehouse.none' } : null,
    },
  ]
}

export interface WaysChoice {
  readonly way: ShipWay | null
  /** TOGETHER: the other orders ticked. */
  readonly ticked: readonly string[]
  /** OUR_WAREHOUSE: the warehouse chosen. */
  readonly siteId: string | null
}

/** Why "Make the shipment" waits (null: it may go). The reader's right first, then what the order has, then the choice. */
export function makeHeld(input: { readonly rights: Pick<ShipRights, 'plan'>; readonly order: ReadyOrder | null; readonly ways: readonly WayModel[]; readonly choice: WaysChoice; readonly busy: boolean }): Said | null {
  if (!input.rights.plan) return { key: 'ways.held.noRight' }
  if (piecesOf(input.order) === 0) return { key: 'ways.held.nothing' }
  const { way, ticked, siteId } = input.choice
  if (way === null) return { key: 'ways.held.pick' }
  const chosen = input.ways.find((entry) => entry.id === way)
  if (chosen?.held) return chosen.held
  if (way === 'TOGETHER' && ticked.length === 0) return { key: 'ways.held.tick' }
  if (way === 'TOGETHER' && ticked.length + 1 > MAX_ORDERS) return { key: 'ways.held.tooMany', params: { max: MAX_ORDERS } }
  if (way === 'OUR_WAREHOUSE' && !siteId) return { key: 'ways.held.warehouse' }
  if (input.busy) return { key: 'ways.held.busy' }
  return null
}

/** Every released garment of the order on no shipment, as the create's lines. */
export const linesOf = (cells: readonly Pick<ReadyCell, 'workOrderSizeId' | 'shippable'>[]): { workOrderSizeId: string; quantity: number }[] =>
  cells.flatMap((cell) => (cell.shippable > 0 ? [{ workOrderSizeId: cell.workOrderSizeId, quantity: cell.shippable }] : []))

/**
 * The body sent per way (today's create + `destination`): ALONE — this order to the customer; TOGETHER — this order and the ticked ones
 * (`salesOrderIds`, this one first, ≤ 20) to the customer; OUR_WAREHOUSE — this order to the chosen warehouse.
 */
export function shipBodyOf(input: { readonly order: ReadyOrder; readonly others: readonly ReadyOrder[]; readonly choice: WaysChoice }): NewShipmentBody {
  const { order, choice } = input
  const destination: ShipmentDestination = choice.way === 'OUR_WAREHOUSE' && choice.siteId ? { kind: 'OUR_WAREHOUSE', siteId: choice.siteId } : { kind: 'CUSTOMER' }
  if (choice.way === 'TOGETHER') {
    const mates = choice.ticked.flatMap((id) => input.others.filter((other) => other.salesOrderId === id && other.salesOrderId !== order.salesOrderId)).slice(0, MAX_ORDERS - 1)
    return {
      salesOrderId: order.salesOrderId,
      salesOrderIds: [order.salesOrderId, ...mates.map((mate) => mate.salesOrderId)],
      destination,
      lines: [...linesOf(order.cells), ...mates.flatMap((mate) => linesOf(mate.cells))],
    }
  }
  return { salesOrderId: order.salesOrderId, destination, lines: linesOf(order.cells) }
}

/** The warehouse chosen for the person: the only one, else none (the person picks). */
export const defaultSiteOf = (warehouses: readonly WarehouseChoice[] | null): string | null => (warehouses && warehouses.length === 1 ? warehouses[0]!.siteId : null)
