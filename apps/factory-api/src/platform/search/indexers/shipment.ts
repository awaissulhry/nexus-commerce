import { defineIndexer, idWhere, partyName } from '../indexer'
// B-OP-044 (order page N6, lines-derived): the orders a shipment carries.
import { orderRefsOfShipments } from '../../../modules/shipping/shipments/orders-of'

/**
 * Shipments (modules/shipping/shipments; shipping.view; opens in Warehouse › Shipments): by number, the order's number,
 * the customer's name and code, the carrier's tracking number. Scope as the shipments list: company, site and customer.
 */
export default defineIndexer({
  recordType: 'Shipment',
  area: 'warehouse',
  viewPermission: 'shipping.view',
  on: { 'shipment.created': 'subject', 'shipment.status_changed': 'subject', 'shipment.labels_bought': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.shipment.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        partyId: true,
        number: true,
        status: true,
        salesOrderId: true, // B-OP-044
        salesOrder: { select: { number: true, customerRef: true, party: { select: { code: true, legalName: true, tradeName: true } } } },
        parcels: { select: { trackingNumber: true }, take: 20 },
      },
    })
    // B-OP-044 (order page N6): a shared shipment is found by every order it carries (its number and PO; one customer).
    const ordersOf = await orderRefsOfShipments(client, rows)
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.salesOrder.party) ?? row.number,
      subtitle: row.salesOrder.number,
      status: row.status,
      words: [row.salesOrder.party.code, row.salesOrder.customerRef, ...row.parcels.map((parcel) => parcel.trackingNumber), ...(ordersOf.get(row.id) ?? []).slice(1).flatMap((ref) => [ref.number, ref.customerRef])],
    }))
  },
})
