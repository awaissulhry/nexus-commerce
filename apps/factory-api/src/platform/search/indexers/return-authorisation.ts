import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Customer returns (RMA; modules/sales/returns; sales.returns.view; opens in Sales › Returns & repairs): by number, the
 * customer's name and code, the customer's own reference, the sales order the goods were sold on. Scope as the returns
 * list: company, site and customer. Never an amount (no credit value). A customer renamed re-indexes its returns.
 */
export default defineIndexer({
  recordType: 'ReturnAuthorisation',
  area: 'sales',
  viewPermission: 'sales.returns.view',
  on: {
    'return.authorised': 'subject',
    'return.changed': 'subject',
    'return.status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.returnAuthorisation.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.returnAuthorisation.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, partyId: true, number: true, customerRef: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } }, salesOrder: { select: { number: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.customerRef ?? row.salesOrder?.number ?? null,
      status: row.status,
      words: [row.party.code, row.party.legalName, row.salesOrder?.number],
    }))
  },
})
