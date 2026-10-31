import { defineIndexer, idWhere } from '../indexer'

/**
 * Size scales (modules/product/styles, scales.ts; product.styles.view as the scales list; opens in Products › Sizes): by
 * code and name, and the sizes it holds (their codes and labels: `52` finds the scales with a 52). Scope as the scales
 * list: company, nullable (a library scale of no company reaches every company). Made and changed (its sizes too) re-read
 * it.
 */
const SIZES = 60

export default defineIndexer({
  recordType: 'SizeScale',
  area: 'products',
  viewPermission: 'product.styles.view',
  on: {
    'size_scale.created': 'subject',
    'size_scale.changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.sizeScale.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, status: true, sizes: { select: { code: true, label: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], take: SIZES } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.code,
      title: row.name,
      subtitle: row.sizes.length > 0 ? `${row.sizes[0]!.code}–${row.sizes[row.sizes.length - 1]!.code}` : null,
      status: row.status,
      words: row.sizes.flatMap((size) => [size.code, size.label]),
    }))
  },
})
