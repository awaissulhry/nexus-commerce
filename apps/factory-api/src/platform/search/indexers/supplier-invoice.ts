import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Supplier invoices (modules/payables; payables.view; opens in Finance › Supplier invoices): by the supplier's invoice
 * number, the supplier's name and code, the SDI identifier and file name, the payment reference, the invoice it credits.
 * Scope as the payables list: company and supplier (no site). NEVER an amount (net, VAT, gross, withholding, stamp duty).
 * Received (by hand or from SDI), changed, matched, approved and its approval withdrawn, disputed, reopened, voided, paid,
 * its claim settled and a difference accepted re-read it; a supplier renamed re-indexes its invoices.
 */
export default defineIndexer({
  recordType: 'SupplierInvoice',
  area: 'finance',
  viewPermission: 'payables.view',
  on: {
    'supplier_invoice.received': 'subject',
    'supplier_invoice.changed': 'subject',
    'supplier_invoice.matched': 'subject',
    'supplier_invoice.approved': 'subject',
    'supplier_invoice.approval_withdrawn': 'subject',
    'supplier_invoice.disputed': 'subject',
    'supplier_invoice.reopened': 'subject',
    'supplier_invoice.voided': 'subject',
    'supplier_invoice.paid': 'subject',
    'supplier_invoice.claim_settled': 'subject',
    'supplier_invoice.difference_accepted': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.supplierInvoice.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.supplierInvoice.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        partyId: true,
        number: true,
        sdiIdentifier: true,
        sdiFileName: true,
        paymentRef: true,
        status: true,
        party: { select: { code: true, legalName: true, tradeName: true } },
        creditOf: { select: { number: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      // A credit note names the invoice it credits; an invoice from SDI its identifier.
      subtitle: row.creditOf?.number ?? row.sdiIdentifier,
      status: row.status,
      words: [row.party.code, row.party.legalName, row.sdiFileName, row.paymentRef],
    }))
  },
})
