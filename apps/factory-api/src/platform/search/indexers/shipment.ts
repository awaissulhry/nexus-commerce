import { defineIndexer, idWhere, partyName } from '../indexer'

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
        salesOrder: { select: { number: true, customerRef: true, party: { select: { code: true, legalName: true, tradeName: true } } } },
        parcels: { select: { trackingNumber: true }, take: 20 },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.salesOrder.party) ?? row.number,
      subtitle: row.salesOrder.number,
      status: row.status,
      words: [row.salesOrder.party.code, row.salesOrder.customerRef, ...row.parcels.map((parcel) => parcel.trackingNumber)],
    }))
  },
})
