import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Sales orders (modules/sales/orders; orders.view): by number, the customer's name and code, the customer's reference
 * ("ORD-2026-00042 · Order · Pista Racing · In production"). Scope as the order list: company and customer. Never an
 * amount. A customer renamed re-indexes its orders.
 *
 * B-TH-057 (ORD-G07): also the style codes of its lines and the label on the garment when it is the customer's own label
 * (Style.brandPartyId = the order's customer). A label of another party is never a word of the entry: the entry is scoped
 * by the order's customer, and a reader of that customer may not see whose that label is (the Brand cell's rule). An
 * amended order (its lines changed) is read again.
 */
export default defineIndexer({
  recordType: 'SalesOrder',
  area: 'sales',
  viewPermission: 'orders.view',
  on: {
    'sales_order.created': 'subject',
    'sales_order.status_changed': 'subject',
    'sales_order.amended': 'subject', // B-TH-057: its lines (and so their styles) changed
    'party.updated': bySubjectIn((tx, partyId, take) => tx.salesOrder.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.salesOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        partyId: true,
        number: true,
        customerRef: true,
        status: true,
        party: { select: { code: true, legalName: true, tradeName: true } },
        lines: { select: { style: { select: { code: true, brandPartyId: true } } }, orderBy: { seq: 'asc' } }, // B-TH-057
      },
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
      // B-TH-057 (ORD-G07): + its styles' codes; its own label is the customer's name (already a word): no other label.
      words: [row.party.code, row.party.legalName, ...new Set(row.lines.map((line) => line.style.code))],
    }))
  },
})
