import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers' // fix-portal-numbers-1
// B-OP-044 (order page N6, lines-derived): the orders a shipment carries.
import { orderRefsOfShipments } from '../../../../modules/shipping/shipments/orders-of'

/**
 * A customer's deliveries (modules/shipping/shipments; the index's ../../indexers/shipment.ts), once shipped: our number,
 * the order it ships (their PO first), the carrier's tracking numbers they were given, the day it left. Never the freight
 * cost, the internal note or the transport evidence notes. B-OS-023 (order shipments 1/1): and the numbers typed by hand they
 * were given (the shipment's and its parcels').
 */
const SHIPPED = { shippedAt: { not: null } } as const
const TRACKING = 20

export default definePartnerView({
  recordType: 'Shipment',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.shipment.findMany({
      where: { id: { in: [...ids] }, ...SHIPPED },
      select: {
        id: true,
        companyId: true,
        number: true,
        status: true,
        shippedAt: true,
        salesOrderId: true, // B-OP-044
        salesOrder: { select: { number: true, customerRef: true, customerSeq: true /* fix-portal-numbers-1 */ } },
        parcels: { where: { trackingNumber: { not: null } }, select: { trackingNumber: true }, orderBy: { seq: 'asc' }, take: TRACKING },
        // B-OS-023: the numbers typed by hand (the shipment's, its parcels').
        manualTrackingNumber: true,
      },
    })
    // B-OP-044 (order page N6): the customer's other orders it carries are matched too (all its own: the partner reads its party).
    const ordersOf = await orderRefsOfShipments(client, rows)
    // B-OS-023: the parcels' typed numbers, read by name (the customer's own shipments only: row-level security).
    const typed = rows.length === 0 ? [] : await client.parcel.findMany({ where: { shipmentId: { in: rows.map((row) => row.id) }, manualTrackingNumber: { not: null } }, select: { shipmentId: true, manualTrackingNumber: true }, orderBy: [{ shipmentId: 'asc' }, { seq: 'asc' }] })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: row.salesOrder.customerRef,
      ourRef: row.number,
      // fix-portal-numbers-1 (B-TH-303, plan §0.5): under it, its order by the customer's OWN number ("#12"); the office's SO-…
      // number is only matched (printed on the order confirmation), never shown.
      subtitle: customerRefOf('ORDER', row.salesOrder.customerSeq),
      status: row.status,
      date: row.shippedAt,
      words: [
        row.salesOrder.number,
        ...row.parcels.map((parcel) => parcel.trackingNumber),
        ...(ordersOf.get(row.id) ?? []).slice(1).flatMap((ref) => [ref.number, ref.customerRef]),
        // B-OS-023
        row.manualTrackingNumber,
        ...typed.filter((parcel) => parcel.shipmentId === row.id).slice(0, TRACKING).map((parcel) => parcel.manualTrackingNumber),
      ],
    }))
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.shipment.findMany({
        where: {
          ...SHIPPED,
          OR: [
            { number: equalsTyped(typed) },
            { salesOrder: { customerRef: holdsTyped(typed) } },
            { parcels: { some: { trackingNumber: equalsTyped(typed) } } },
            // B-OS-023: a number typed by hand (the shipment's or a parcel's).
            { manualTrackingNumber: equalsTyped(typed) },
            { parcels: { some: { manualTrackingNumber: equalsTyped(typed) } } },
            // B-OP-044: the PO of any order it carries.
            { lines: { some: { salesOrderLine: { order: { customerRef: holdsTyped(typed) } } } } },
          ],
        },
        select: { id: true },
        orderBy: { shippedAt: 'desc' },
        take,
      }),
    )
  },
})
