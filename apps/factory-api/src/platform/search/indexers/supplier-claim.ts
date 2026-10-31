import { bySubjectIn, defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Returns and claims to suppliers (modules/purchasing/claims; purchasing.view; opens in Purchasing › Returns & claims): by
 * number, the supplier's name and code, the purchase order and the receipt the goods came with. Scope as the claims list:
 * company, site and supplier. Never an amount (no credit asked). A supplier renamed re-indexes its claims.
 */
export default defineIndexer({
  recordType: 'SupplierClaim',
  area: 'purchasing',
  viewPermission: 'purchasing.view',
  on: {
    'supplier_claim.created': 'subject',
    'supplier_claim.updated': 'subject',
    'supplier_claim.sent': 'subject',
    'supplier_claim.answered': 'subject',
    'supplier_claim.closed': 'subject',
    'supplier_claim.cancelled': 'subject',
    'party.updated': bySubjectIn((tx, partyId, take) => tx.supplierClaim.findMany({ where: { partyId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.supplierClaim.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, partyId: true, number: true, status: true, party: { select: { code: true, legalName: true, tradeName: true } }, purchaseOrder: { select: { number: true } }, goodsReceipt: { select: { number: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      number: row.number,
      title: partyName(row.party) ?? row.number,
      subtitle: row.purchaseOrder?.number ?? row.goodsReceipt?.number ?? null,
      status: row.status,
      words: [row.party.code, row.party.legalName, row.goodsReceipt?.number],
    }))
  },
})
