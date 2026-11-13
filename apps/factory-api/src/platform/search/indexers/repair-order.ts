import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Repairs and alterations (modules/sales/repairs; sales.repairs.view; opens in Sales › Returns & repairs): by number, the
 * customer's name and code, the garment's serial as read from its label, the customer's DDT number. Scope as the repairs
 * list: company, site and customer. Never an amount, never the technician. A customer renamed re-indexes its repairs.
 * B-W2b-383 (XF8:06, B-W2b-342's gap): also by the serial of our garment (`garmentSerial`, the repair history of a garment),
 * set by a request from the portal or a claim link (`repair.created`) or the office's change (`repair.changed`).
 */
export default defineIndexer({
  recordType: 'RepairOrder',
  area: 'sales',
  viewPermission: 'sales.repairs.view',
  on: {
    'repair.created': 'subject',
    'repair.changed': 'subject',
    'repair.stage_changed': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.repairOrder.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.repairOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, partyId: true, number: true, serial: true, garmentSerial: true, inboundDdtNumber: true, stage: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.serial ?? row.garmentSerial,
      status: row.stage,
      words: [row.party.code, row.party.legalName, row.inboundDdtNumber, row.garmentSerial],
    }))
  },
})
