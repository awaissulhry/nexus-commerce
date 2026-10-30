import { defineIndexer, idWhere, partyName } from '../indexer'

/**
 * Materials and trims (the Item model; modules/product/materials; product.materials.view): by code and name, the
 * supplier's article code and the default supplier's name. Scope as the material library: its company (null: every
 * company). Never its standard cost.
 */
export default defineIndexer({
  recordType: 'Item',
  area: 'products',
  viewPermission: 'product.materials.view',
  on: { 'material.created': 'subject', 'material.updated': 'subject', 'material.status_changed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.item.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, supplierArticleCode: true, status: true, defaultSupplier: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.code,
      title: row.name,
      subtitle: partyName(row.defaultSupplier),
      status: row.status,
      words: [row.supplierArticleCode, row.defaultSupplier?.code],
    }))
  },
})
