import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Catalogue orders (B-TH-040; threads plan TH-3, G16, L2-G04; modules/sales/portal-ordering; orders.view, as the office's
 * GET /sales/order-requests): a customer's order request once SENT (a draft is the customer's work in progress: never in the
 * index), by its number, the customer's name and code and the customer's purchase-order number. It opens in its record panels
 * (its thread, where the office and the customer discuss it). Scope as the office's request list: company and customer. Never a
 * price (the lines' prices stay in the record). Sent, decided and withdrawn re-read it; a customer renamed re-indexes its
 * requests. The portal's partner view of the same record (../partner/views/portal-order-request.ts) is found through this entry.
 */
export default defineIndexer({
  recordType: 'PortalOrderRequest',
  area: 'sales',
  viewPermission: 'orders.view',
  on: {
    'portal_order_request.sent': 'subject',
    'portal_order_request.accepted': 'subject',
    'portal_order_request.refused': 'subject',
    'portal_order_request.withdrawn': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.portalOrderRequest.findMany({ where: { partyId, status: { not: 'DRAFT' } }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.portalOrderRequest.findMany({
      where: { ...idWhere(filter), status: { not: 'DRAFT' } },
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
      title: partyName(row.party) ?? row.number ?? 'Catalogue order',
      subtitle: 'Catalogue order',
      status: row.status,
      words: [row.customerRef, row.party.code, row.party.legalName],
    }))
  },
})
