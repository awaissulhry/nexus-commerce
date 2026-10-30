import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Quotes (modules/sales/quotes; quotes.view): by number, the customer's name and code, the customer's reference. Scope
 * as the quote list: company and customer. A customer renamed re-indexes its quotes.
 */
export default defineIndexer({
  recordType: 'Quote',
  area: 'sales',
  viewPermission: 'quotes.view',
  on: {
    'quote.created': 'subject',
    'quote.updated': 'subject',
    'quote.sent': 'subject',
    'quote.accepted': 'subject',
    'quote.declined': 'subject',
    'quote.cancelled': 'subject',
    'quote.revised': 'subject',
    'quote.reopened': 'subject',
    'quote.approval_requested': 'subject',
    'quote.approval_decided': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.quote.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.quote.findMany({
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
