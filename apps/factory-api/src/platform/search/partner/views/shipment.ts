import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

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
        salesOrder: { select: { number: true, customerRef: true } },
        parcels: { where: { trackingNumber: { not: null } }, select: { trackingNumber: true }, orderBy: { seq: 'asc' }, take: TRACKING },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: row.salesOrder.customerRef,
      ourRef: row.number,
      subtitle: row.salesOrder.number,
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
