import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Subcontract orders (modules/purchasing/subcontracting; purchasing.view; opens in Purchasing › Subcontract orders): by
 * number, the workshop's name and code, the work order's number and batch, the style's code and name, the workshop's
 * stock location. Scope as the subcontract list: company, site and workshop. NEVER its amount. Every move of the order
 * (made, changed, issued, kit sent and returned, received, closed, reopened, cancelled) re-reads it; a workshop or a style
 * renamed re-indexes its orders.
 */
export default defineIndexer({
  recordType: 'SubcontractOrder',
  area: 'purchasing',
  viewPermission: 'purchasing.view',
  on: {
    'subcontract_order.created': 'subject',
    'subcontract_order.updated': 'subject',
    'subcontract_order.issued': 'subject',
    'subcontract_order.kit_sent': 'subject',
    'subcontract_order.kit_returned': 'subject',
    'subcontract_order.received': 'subject',
    'subcontract_order.closed': 'subject',
    'subcontract_order.reopened': 'subject',
    'subcontract_order.cancelled': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.subcontractOrder.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
    'style.updated': bySubjectIn((tx, styleId, take) => tx.subcontractOrder.findMany({ where: { workOrder: { styleId } }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.subcontractOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        partyId: true,
        number: true,
        status: true,
        party: { select: { code: true, legalName: true, tradeName: true } },
        location: { select: { code: true } },
        workOrder: { select: { number: true, batchNumber: true, style: { select: { code: true, name: true } } } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.workOrder.number,
      status: row.status,
      words: [row.party.code, row.party.legalName, row.workOrder.batchNumber, row.workOrder.style.code, row.workOrder.style.name, row.location.code],
    }))
  },
})
