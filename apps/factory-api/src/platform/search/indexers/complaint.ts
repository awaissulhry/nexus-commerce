import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Customer complaints (modules/quality/complaints; quality.complaints.view; opens in Quality › Problems › Complaints): by
 * number, the customer's name and code, the customer's reference, the garment's serial and batch number as reported. Scope
 * as the complaints list: company and customer (no site). Never the customer's words of what happened, never an amount.
 * A customer renamed re-indexes its complaints.
 */
export default defineIndexer({
  recordType: 'Complaint',
  area: 'quality',
  viewPermission: 'quality.complaints.view',
  on: {
    'complaint.received': 'subject',
    'complaint.changed': 'subject',
    'complaint.triaged': 'subject',
    'complaint.status_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.complaint.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.complaint.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, partyId: true, number: true, customerRef: true, serial: true, batchNumber: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.customerRef ?? row.serial,
      status: row.status,
      words: [row.party.code, row.party.legalName, row.serial, row.batchNumber],
    }))
  },
})
