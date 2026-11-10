import type { ListRulesQuery } from '@nexus/factory-domain/product/grading/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { listRules } from '../../../modules/product/grading/library'
import { defineExportSource } from '../source'

/**
 * Products › Libraries › Sizes & measurements › Grade rules (B-W2b-240, SCR-345, `/products/sizes?view=rules`): the
 * export of the grade rules as the screen shows them (B-W2b-224's read). The address is the list's own (apps/factory-web
 * areas/products/sizes/depth model.ts depthFiltersOf): `?status=open|archived|all` (nothing: open), `?scale=<id>` and
 * `?q=`. Read through the module's listRules (product.styles.view, its companies). No money. The page's third list:
 * `products.sizes.3`.
 */

type Row = Awaited<ReturnType<typeof listRules>>['rules'][number]
type Query = Omit<ListRulesQuery, 'cursor' | 'limit'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const gradeRules = defineExportSource<Query, Row>({
  listKey: 'products.sizes.3',
  page: '/products/sizes',
  permission: PRODUCT_STYLES_VIEW,
  query(address) {
    const status = address.get('status')
    const scaleId = address.get('scale')
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return { status: status === 'archived' ? 'ARCHIVED' : status === 'all' ? 'ALL' : 'ACTIVE', ...(scaleId && UUID.test(scaleId) ? { scaleId } : {}), q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listRules(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.rules, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listRules(caller, { ...query, limit: 1 })).count
  },
  columns: {
    rule: { value: (row) => `${row.code} · ${row.name}` },
    scale: { value: (row) => row.scale.code },
    base: { value: (row) => row.baseSize },
    points: { value: (row) => row.points },
    format: { value: (row, words) => words(`format.${row.format}`) },
    specs: { value: (row) => row.specs },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  words: {
    it: { 'format.RELATIVE': 'Relativo', 'format.ABSOLUTE': 'Assoluto', 'status.ACTIVE': 'In uso', 'status.ARCHIVED': 'Archiviato' },
    en: { 'format.RELATIVE': 'Relative', 'format.ABSOLUTE': 'Absolute', 'status.ACTIVE': 'In use', 'status.ARCHIVED': 'Archived' },
  },
})
