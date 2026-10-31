import { defineIndexer, idWhere } from '../indexer'

/**
 * Operations of the routing library (modules/product/operations; product.routing.view; opens in Products › Operations):
 * by code, name (and its names in other languages), the machine type and the skill it needs. Scope as the operations
 * list: company, nullable (a library operation of no company reaches every company). Never a figure (its minutes).
 * Made (on its page or from a sheet), edited and archived or restored re-read it.
 */
const namesOf = (value: unknown): string[] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => (value as Record<string, unknown>)[key])
        .filter((name): name is string => typeof name === 'string')
    : []

export default defineIndexer({
  recordType: 'Operation',
  area: 'products',
  viewPermission: 'product.routing.view',
  on: {
    'operation.created': 'subject',
    'operation.updated': 'subject',
    'operation.status_changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.operation.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, code: true, name: true, nameI18n: true, machineType: true, skill: true, status: true },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: null,
      partyId: null,
      number: row.code,
      title: row.name,
      subtitle: row.machineType,
      status: row.status,
      words: [...namesOf(row.nameI18n), row.skill],
    }))
  },
})
