import { defineIndexer, idWhere } from '../indexer'

/**
 * Points of measure (B-W2b-224; modules/product/measures; product.styles.view as the library list; opens in Products ›
 * Sizes & measurements › Points of measure): by code and name, its names per language, its kind and zone. Scope as the
 * library: company, nullable (a tenant-wide point reaches every company). `point_of_measure.changed` re-reads it.
 */
export default defineIndexer({
  recordType: 'PointOfMeasure',
  area: 'products',
  viewPermission: 'product.styles.view',
  on: {
    'point_of_measure.changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.pointOfMeasure.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, nameI18n: true, kind: true, bodyZone: true, status: true },
    })
    return rows.map((row) => {
      const names = row.nameI18n && typeof row.nameI18n === 'object' && !Array.isArray(row.nameI18n) ? Object.values(row.nameI18n).filter((value): value is string => typeof value === 'string') : []
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: null,
        partyId: null,
        number: row.code,
        title: row.name,
        subtitle: `${row.kind === 'BODY' ? 'Body' : 'Garment'} · ${row.bodyZone.toLowerCase()}`,
        status: row.status,
        words: names,
      }
    })
  },
})
