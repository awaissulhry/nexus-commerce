import { bySubjectIn, defineIndexer, idWhere } from '../indexer'

/**
 * Change orders (modules/product/changes, B-W2b-226; product.changes.view; opens in Products › Development › Changes &
 * versions, B-W2b-244): by number (ECO-…), with its title, the style's code and name. Scope as the change orders list:
 * company only. Never a person (author, approvers). Every change re-reads it; a style renamed re-indexes its orders.
 */
export default defineIndexer({
  recordType: 'ChangeOrder',
  area: 'products',
  viewPermission: 'product.changes.view',
  on: {
    'change_order.changed': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.changeOrder.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.changeOrder.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, number: true, title: true, status: true, style: { select: { code: true, name: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.number,
      title: row.title,
      subtitle: `${row.style.code} · ${row.style.name}`,
      status: row.status,
      words: [row.style.code, row.style.name],
    }))
  },
})
