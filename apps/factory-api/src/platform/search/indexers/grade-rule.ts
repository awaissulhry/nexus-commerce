import { defineIndexer, idWhere } from '../indexer'

/**
 * Grade rules (B-W2b-224; modules/product/grading; product.styles.view as the library list; opens in Products › Sizes &
 * measurements › Grade rules): by code and name, with its size scale's code and its base size. Scope as the library:
 * company, nullable. `grade_rule.changed` re-reads it.
 */
export default defineIndexer({
  recordType: 'GradeRule',
  area: 'products',
  viewPermission: 'product.styles.view',
  on: {
    'grade_rule.changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.gradeRule.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, baseSize: true, status: true, sizeScale: { select: { code: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.code,
      title: row.name,
      subtitle: `${row.sizeScale.code} · base ${row.baseSize}`,
      status: row.status,
      words: [row.sizeScale.code],
    }))
  },
})
