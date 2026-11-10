import { defineIndexer, idWhere } from '../indexer'

/**
 * Library colours (B-W2b-247; modules/product/colours; product.styles.view as the colour library; opens on Products ›
 * Colours & artwork): by code and name, its it/en names, its Pantone / RAL / NCS reference, family and hex (`9005`,
 * `18-1662`, `#1A1A1A` find it). Scope as the library: company, nullable (a colour of every company reaches every
 * company). colour.changed re-reads it.
 */
export default defineIndexer({
  recordType: 'Colour',
  area: 'products',
  viewPermission: 'product.styles.view',
  on: { 'colour.changed': 'subject' },
  async read(tx, filter, take) {
    const rows = await tx.colour.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, nameI18n: true, system: true, reference: true, family: true, hex: true, status: true },
    })
    return rows.map((row) => {
      const names = row.nameI18n && typeof row.nameI18n === 'object' && !Array.isArray(row.nameI18n) ? Object.values(row.nameI18n as Record<string, unknown>).filter((name): name is string => typeof name === 'string') : []
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: null,
        partyId: null,
        number: row.code,
        title: row.name,
        subtitle: [row.reference, row.hex].filter(Boolean).join(' · ') || null,
        status: row.status,
        words: [...names, row.reference, row.family, row.hex, row.system],
      }
    })
  },
})
