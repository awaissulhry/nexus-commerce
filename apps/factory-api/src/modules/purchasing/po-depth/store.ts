import type { Prisma } from '@nexus/factory-db'
import type { DepthCheck } from '@nexus/factory-domain/purchasing/po-depth/codes'
import { currencyChecks, takesRate } from '@nexus/factory-domain/purchasing/po-depth/currency'
// B-W2b-389 (CY1:01): the day's rate of the rates table.
import { businessDate } from '@nexus/factory-domain/core/time'
import type { DayRate } from '@nexus/factory-domain/money/currency/rates'
import { serverClock } from '../../../core/time'
import { dayRate } from '../../../platform/currency/service'
import { scheduleChecks } from '@nexus/factory-domain/purchasing/po-depth/schedule'
import { shipToChecks, workshopPlaceOf, type ShipToAddress, type ShipToParty, type ShipToPlace } from '@nexus/factory-domain/purchasing/po-depth/ship-to'
import type { PartyRole, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { dayOf, quantityText, type ItemRow, type LineRow, type OrderRow, type Reader } from '../store'

/**
 * Purchase orders in depth (B-W2b-296): the reads of an order's delivery schedule, its rate at order and value in the
 * company's currency, and where it is delivered (factory-db buying-depth.prisma PurchaseOrderLineDelivery; supply.prisma
 * PurchaseOrder.rateAtOrder, companyNetAmount, shipTo*). A reader takes a command's transaction or a scoped client: row-level
 * security decides what it finds. The order's record (views.ts readFacts) reads them through readDepthFacts, so the send's
 * checks (and the PDF) see them.
 */

export const DELIVERY_COLUMNS = {
  id: true,
  purchaseOrderLineId: true,
  seq: true,
  quantity: true,
  baseQuantity: true,
  needDate: true,
  confirmedDate: true,
  note: true,
  version: true,
} as const satisfies Prisma.PurchaseOrderLineDeliverySelect
export type DeliveryRow = Prisma.PurchaseOrderLineDeliveryGetPayload<{ select: typeof DELIVERY_COLUMNS }>

export const DEPTH_ORDER_COLUMNS = { id: true, companyId: true, siteId: true, partyId: true, currency: true, rateAtOrder: true, companyNetAmount: true, shipToPartyId: true, shipToAddressId: true, shipToLocationId: true } as const satisfies Prisma.PurchaseOrderSelect
export type DepthOrderRow = Prisma.PurchaseOrderGetPayload<{ select: typeof DEPTH_ORDER_COLUMNS }>

const ADDRESS_COLUMNS = { id: true, partyId: true, kinds: true, status: true, approvalStatus: true, isDefaultShipTo: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true, deliveryNotes: true } as const satisfies Prisma.PartyAddressSelect
export type ShipToAddressRow = Prisma.PartyAddressGetPayload<{ select: typeof ADDRESS_COLUMNS }>
const PLACE_COLUMNS = { id: true, partyId: true, siteId: true, kind: true, status: true, code: true, name: true } as const satisfies Prisma.LocationSelect
export type ShipToPlaceRow = Prisma.LocationGetPayload<{ select: typeof PLACE_COLUMNS }>

export interface ShipToFacts {
  readonly party: ShipToParty & { readonly code: string }
  readonly address: ShipToAddressRow | null
  readonly place: ShipToPlaceRow | null
  /** The party has an active workshop place on the order's site (named on the order or not). */
  readonly hasPlace: boolean
}

export interface DepthFacts {
  readonly order: DepthOrderRow
  readonly companyCurrency: string
  /** B-W2b-389 (CY1:01): an order in another currency with no rate typed: the day's rate the send takes, or null. */
  readonly dayRate: DayRate | null
  /** Each line's deliveries by day (an empty list: one delivery on the line's need date). */
  readonly deliveries: ReadonlyMap<string, readonly DeliveryRow[]>
  readonly shipTo: ShipToFacts | null
}

/** The deliveries of these lines, by line, in their order. */
export async function readDeliveries(db: Reader, lineIds: readonly string[]): Promise<Map<string, DeliveryRow[]>> {
  const rows = lineIds.length === 0 ? [] : await db.purchaseOrderLineDelivery.findMany({ where: { purchaseOrderLineId: { in: [...lineIds] } }, select: DELIVERY_COLUMNS, orderBy: [{ purchaseOrderLineId: 'asc' }, { seq: 'asc' }] })
  const byLine = new Map<string, DeliveryRow[]>()
  for (const row of rows) byLine.set(row.purchaseOrderLineId, [...(byLine.get(row.purchaseOrderLineId) ?? []), row])
  return byLine
}

/** The third party an order ships to, its address, its workshop place (named, or its only one on the site). */
export async function readShipTo(db: Reader, order: Pick<DepthOrderRow, 'siteId' | 'shipToPartyId' | 'shipToAddressId' | 'shipToLocationId'>): Promise<ShipToFacts | null> {
  if (!order.shipToPartyId) return null
  const party = await db.party.findUnique({ where: { id: order.shipToPartyId }, select: { id: true, code: true, legalName: true, roles: true, status: true } })
  if (!party) return null
  const address = order.shipToAddressId ? await db.partyAddress.findUnique({ where: { id: order.shipToAddressId }, select: ADDRESS_COLUMNS }) : null
  const places = await db.location.findMany({ where: { partyId: party.id, siteId: order.siteId, kind: 'SUBCONTRACTOR' }, select: PLACE_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const place = order.shipToLocationId ? (places.find((row) => row.id === order.shipToLocationId) ?? null) : null
  return {
    party: { id: party.id, code: party.code, name: party.legalName, roles: party.roles as PartyRole[], status: party.status as PartyStatus },
    address,
    place,
    hasPlace: places.some((row) => workshopPlaceOf(row, party.id, order.siteId)),
  }
}

/** Everything of this step an order's record and its send read, in one scope. */
export async function readDepthFacts(db: Reader, order: Pick<OrderRow, 'id' | 'companyId'>, lines: readonly Pick<LineRow, 'id'>[]): Promise<DepthFacts> {
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, select: DEPTH_ORDER_COLUMNS })
  const company = await db.company.findUniqueOrThrow({ where: { id: order.companyId }, select: { currency: true } })
  // B-W2b-389 (CY1:01): no rate typed on an order in another currency → the day's rate of the table (the send keeps it).
  const today = businessDate(serverClock.now())
  const rate = row.rateAtOrder === null && takesRate(row.currency, company.currency) ? await dayRate(db, company.currency, row.currency, today) : null
  return { order: row, companyCurrency: company.currency, dayRate: rate, deliveries: await readDeliveries(db, lines.map((line) => line.id)), shipTo: await readShipTo(db, row) }
}

const asAddress = (row: ShipToAddressRow): ShipToAddress => ({ id: row.id, partyId: row.partyId, kinds: row.kinds, status: row.status, approvalStatus: row.approvalStatus, isDefaultShipTo: row.isDefaultShipTo })
export const asPlace = (row: ShipToPlaceRow): ShipToPlace => ({ id: row.id, partyId: row.partyId, siteId: row.siteId, kind: row.kind, status: row.status })
export { asAddress }

/**
 * What this step adds to a send's checks (views.ts checksOf): the schedules of the live lines, the rate at order, the
 * ship-to. `lines` are the lines the send checks (a cancelled one is not sent).
 */
export function depthChecks(depth: DepthFacts, lines: readonly LineRow[], items: ReadonlyMap<string, Pick<ItemRow, 'code'>>, today: string): DepthCheck[] {
  const schedules = lines.map((line) => ({
    seq: line.seq,
    itemCode: items.get(line.itemId)?.code ?? '',
    quantity: quantityText(line.quantity),
    baseQuantity: quantityText(line.baseQuantity),
    needDate: dayOf(line.needDate)!,
    deliveries: (depth.deliveries.get(line.id) ?? []).map((delivery) => ({ seq: delivery.seq, quantity: quantityText(delivery.quantity), baseQuantity: quantityText(delivery.baseQuantity), needDate: dayOf(delivery.needDate)! })),
  }))
  const shipTo = depth.shipTo ? { party: depth.shipTo.party, address: depth.shipTo.address ? asAddress(depth.shipTo.address) : null, hasPlace: depth.shipTo.place !== null || !depth.shipTo.party.roles.includes('SUBCONTRACTOR') } : null
  return [
    ...scheduleChecks(schedules, today),
    // B-W2b-389 (CY1:01): the day's rate counts as the rate at order (the send keeps it); a typed rate stays the override.
    ...currencyChecks({ currency: depth.order.currency, rateAtOrder: depth.order.rateAtOrder === null ? (depth.dayRate?.rate ?? null) : depth.order.rateAtOrder.toString() }, depth.companyCurrency),
    ...shipToChecks(shipTo, depth.order.partyId),
  ]
}

/** The order's delivery address as its PDF prints it when it ships to a third party ("Deliver to"), or null. */
export function shipToPrintOf(depth: DepthFacts | undefined): { name: string; line1: string; line2: string | null; postalCode: string; city: string; province: string | null; country: string } | null {
  const address = depth?.shipTo?.address
  if (!depth?.shipTo || !address) return null
  return { name: address.name ? `${depth.shipTo.party.name} — ${address.name}` : depth.shipTo.party.name, line1: address.line1, line2: address.line2, postalCode: address.postalCode, city: address.city, province: address.province, country: address.country }
}

/** Whether the order takes a rate at order (its currency is not its company's). */
export const orderTakesRate = (depth: Pick<DepthFacts, 'order' | 'companyCurrency'>): boolean => takesRate(depth.order.currency, depth.companyCurrency)
