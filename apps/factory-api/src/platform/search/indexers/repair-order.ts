import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Repairs and alterations (modules/sales/repairs; sales.repairs.view; opens in Sales › Returns & repairs): by number, the
 * customer's name and code, the garment's serial as read from its label, the customer's DDT number. Scope as the repairs
 * list: company, site and customer. Never an amount, never the technician. A customer renamed re-indexes its repairs.
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
      select: { id: true, companyId: true, siteId: true, partyId: true, number: true, serial: true, inboundDdtNumber: true, stage: true, party: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.serial,
      status: row.stage,
      words: [row.party.code, row.party.legalName, row.inboundDdtNumber],
    }))
  },
})
