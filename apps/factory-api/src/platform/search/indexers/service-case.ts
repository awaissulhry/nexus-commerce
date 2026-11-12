import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Warranty and service cases (modules/sales/service, B-W2b-345; sales.service.view; opens in Sales › After-sales › Warranty &
 * service): by number, the customer's name and code, the garment's serial and batch as reported and the serial and batch of
 * ours. Scope as the cases list: company and customer (a case without a customer reaches every customer grant). Never the
 * customer's words of what is wrong, never an amount, never a product-safety injury (those are not service cases).
 * A customer renamed re-indexes its cases. (The web's RECORD_PAGES and search words for ServiceCase come with the screens,
 * B-W2b-353.)
 */
export default defineIndexer({
  recordType: 'ServiceCase',
  area: 'sales',
  viewPermission: 'sales.service.view',
  on: {
    'service_case.opened': 'subject',
    'service_case.changed': 'subject',
    'service_case.status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.serviceCase.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.serviceCase.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, partyId: true, number: true, kind: true, serial: true, garmentSerial: true, batchNumber: true, garmentBatch: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.garmentSerial ?? row.serial ?? row.garmentBatch ?? row.batchNumber,
      status: row.status,
      words: [row.party?.code, row.party?.legalName, row.serial, row.garmentSerial, row.batchNumber, row.garmentBatch, row.kind],
    }))
  },
})
