import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Product-safety reports (modules/sales/safety-reports, B-W2b-351; sales.safety.view): by number, the serial and batch as
 * reported and the serial and batch of ours, the style's code, the customer's name and code. Scope as the reports list: company
 * and customer (a report from the public DoC page names none: every customer grant of the company). Never what happened (the
 * reporter's words), never the reporter, never anything of an injury (the database refuses a ProductSafetyInjury entry:
 * SearchEntry_not_injury). A customer renamed re-indexes its reports. (The web's RECORD_PAGES and search words for
 * ProductSafetyReport come with the screens, B-W2b-357.)
 */
export default defineIndexer({
  recordType: 'ProductSafetyReport',
  area: 'sales',
  viewPermission: 'sales.safety.view',
  on: {
    'safety_report.received': 'subject',
    'safety_report.changed': 'subject',
    'safety_report.status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.productSafetyReport.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.productSafetyReport.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, partyId: true, number: true, source: true, serial: true, garmentSerial: true, batchNumber: true, garmentBatch: true, status: true, style: { select: { code: true } }, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.style?.code ?? row.number,
      subtitle: row.garmentSerial ?? row.serial ?? row.garmentBatch ?? row.batchNumber,
      status: row.status,
      words: [row.party?.code, row.party?.legalName, row.style?.code, row.serial, row.garmentSerial, row.batchNumber, row.garmentBatch],
    }))
  },
})
