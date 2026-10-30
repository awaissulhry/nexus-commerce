import { bySubjectIn, defineIndexer, idWhere, partyName, type RecordsOf } from '../indexer'

/**
 * Purchase orders (modules/purchasing; purchasing.view): by number, the supplier's name and code, the supplier's
 * reference. Scope as the PO list: company, site and supplier. Never an amount. A receipt moves its order's status; a
 * supplier renamed re-indexes its orders.
 */
const orderOfReceipt: RecordsOf = (event) => {
  const id = (event.payload as { purchaseOrderId?: unknown } | null)?.purchaseOrderId
  return typeof id === 'string' ? [id] : []
}

export default defineIndexer({
  recordType: 'PurchaseOrder',
  area: 'purchasing',
  viewPermission: 'purchasing.view',
  on: {
    'purchase_order.created': 'subject',
    'purchase_order.updated': 'subject',
    'purchase_order.sent': 'subject',
    'purchase_order.confirmed': 'subject',
    'purchase_order.declined': 'subject',
    'purchase_order.changes_proposed': 'subject',
    'purchase_order.proposal_refused': 'subject',
    'purchase_order.cancelled': 'subject',
    'inventory.receipt_posted': orderOfReceipt,
    'inventory.receipt_reversed': orderOfReceipt,
    'party.updated': bySubjectIn((tx, partyId, take) => tx.purchaseOrder.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.purchaseOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, partyId: true, number: true, supplierRef: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.supplierRef,
      status: row.status,
      words: [row.party.code, row.party.legalName],
    }))
  },
})
