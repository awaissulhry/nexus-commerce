import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Invoices, deposit invoices and credit notes (modules/invoicing; invoices.view; opens in Finance › Invoices): by number
 * (a draft has none yet), the customer's name and code, the order's number. Scope as the invoice list: company and the
 * buyer. Never an amount. A deleted draft leaves the index; a customer renamed re-indexes its invoices.
 */
export default defineIndexer({
  recordType: 'Invoice',
  area: 'finance',
  viewPermission: 'invoices.view',
  on: {
    'invoice.draft_saved': 'subject',
    'invoice.draft_deleted': 'subject',
    'invoice.issued': 'subject',
    'invoice.sdi_status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.invoice.findMany({ where: { buyerPartyId: partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.invoice.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, buyerPartyId: true, number: true, docType: true, status: true, buyer: { select: { code: true, legalName: true, tradeName: true } }, salesOrder: { select: { number: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.buyerPartyId,
      number: row.number,
      title: partyName(row.buyer) ?? row.number ?? row.docType,
      subtitle: row.salesOrder?.number ?? null,
      status: row.status,
      words: [row.buyer.code, row.buyer.legalName, row.docType],
    }))
  },
})
