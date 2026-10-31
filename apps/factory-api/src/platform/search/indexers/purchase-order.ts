import { bySubjectIn, defineIndexer, idWhere, partyName, type RecordsOf } from '../indexer'

/**
 * Purchase orders (modules/purchasing; purchasing.view): by number, the supplier's name and code, the supplier's
 * reference. Scope as the PO list: company, site and supplier. Never an amount. A receipt moves its order's status, and so
 * do a revision, cancelled and closed-short lines (B-W2a-69); the five changes after the send (B-W2a-52) all refresh it
 * (B-W2b-23); a supplier renamed re-indexes its orders.
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
    // B-W2a-69: the changes after the send (B-W2a-52) move the order's state: a revision makes it a draft again, cancelled or
    // closed-short lines may complete it, a moved confirm-by keeps the entry current.
    'purchase_order.revision_started': 'subject',
    'purchase_order.lines_cancelled': 'subject',
    'purchase_order.lines_closed_short': 'subject',
    'purchase_order.confirm_by_moved': 'subject',
    // B-W2b-23 (the fifth of B-W2a-52's change events): a reminder moves nothing the entry shows, so its re-read writes
    // nothing; followed so every change after the send refreshes the entry, as the plan asks.
    'purchase_order.reminder_sent': 'subject',
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
