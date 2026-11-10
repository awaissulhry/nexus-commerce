import { bySubjectIn, defineIndexer, idWhere } from '../indexer'

/**
 * Change requests (modules/product/changes, B-W2b-226; product.changes.view; opens in Products › Development › Changes &
 * versions, B-W2b-244): by number, with its title, the style's code and name. Scope as the requests list: company only
 * (site and party stay null: the list does not scope by them). A floor request nobody took up yet has no number: its title
 * finds it. Never a person (a floor request names no worker; the office author is not indexed). Raised and every change
 * re-read it; a style renamed re-indexes its requests.
 */
export default defineIndexer({
  recordType: 'ChangeRequest',
  area: 'products',
  viewPermission: 'product.changes.view',
  on: {
    'change_request.raised': 'subject',
    'change_request.changed': 'subject',
    'style.updated': bySubjectIn((tx, styleId, take) => tx.changeRequest.findMany({ where: { styleId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.changeRequest.findMany({
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
