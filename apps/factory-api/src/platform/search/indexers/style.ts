import { defineIndexer, idWhere } from '../indexer'

/**
 * Styles (modules/product/styles; product.styles.view): by code and name, the season and the brand's name. Scope as the
 * style library: its company (null: every company).
 */
export default defineIndexer({
  recordType: 'Style',
  area: 'products',
  viewPermission: 'product.styles.view',
  on: { 'style.created': 'subject', 'style.updated': 'subject', 'style.status_changed': 'subject', 'style.duplicated': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.style.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, season: true, status: true, brandParty: { select: { code: true, legalName: true, tradeName: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.code,
      title: row.name,
      subtitle: [row.season, row.brandParty ? (row.brandParty.tradeName?.trim() || row.brandParty.legalName) : null].filter(Boolean).join(' · ') || null,
      status: row.status,
      words: row.brandParty ? [row.brandParty.code] : [],
    }))
  },
})
