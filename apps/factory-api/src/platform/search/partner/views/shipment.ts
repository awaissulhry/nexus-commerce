import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'
import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers' // fix-portal-numbers-1

/**
 * A customer's deliveries (modules/shipping/shipments; the index's ../../indexers/shipment.ts), once shipped: our number,
 * the order it ships (their PO first), the carrier's tracking numbers they were given, the day it left. Never the freight
 * cost, the internal note or the transport evidence notes.
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
        salesOrder: { select: { number: true, customerRef: true, customerSeq: true /* fix-portal-numbers-1 */ } },
        parcels: { where: { trackingNumber: { not: null } }, select: { trackingNumber: true }, orderBy: { seq: 'asc' }, take: TRACKING },
      },
    })
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
      words: [row.salesOrder.number, ...row.parcels.map((parcel) => parcel.trackingNumber)],
    }))
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.shipment.findMany({
        where: { ...SHIPPED, OR: [{ number: equalsTyped(typed) }, { salesOrder: { customerRef: holdsTyped(typed) } }, { parcels: { some: { trackingNumber: equalsTyped(typed) } } }] },
        select: { id: true },
        orderBy: { shippedAt: 'desc' },
        take,
      }),
    )
  },
})
