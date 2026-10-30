import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Sales orders (modules/sales/orders; orders.view): by number, the customer's name and code, the customer's reference
 * ("ORD-2026-00042 · Order · Pista Racing · In production"). Scope as the order list: company and customer. Never an
 * amount. A customer renamed re-indexes its orders.
 */
export default defineIndexer({
  recordType: 'SalesOrder',
  area: 'sales',
  viewPermission: 'orders.view',
  on: {
    'sales_order.created': 'subject',
    'sales_order.status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.salesOrder.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.salesOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, partyId: true, number: true, customerRef: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.customerRef,
      status: row.status,
      words: [row.party.code, row.party.legalName],
    }))
  },
})
