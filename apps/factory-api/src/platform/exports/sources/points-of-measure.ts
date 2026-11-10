import type { ListPomsQuery } from '@nexus/factory-domain/product/measures/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { listPoms } from '../../../modules/product/measures/points'
import { defineExportSource } from '../source'

/**
 * Products › Libraries › Sizes & measurements › Points of measure (B-W2b-240, SCR-345, `/products/sizes?view=poms`): the
 * export of the POM library as the screen shows it (B-W2b-224's read). The address is the list's own (apps/factory-web
 * areas/products/sizes/depth model.ts depthFiltersOf): `?status=open|archived|all` (nothing: open), `?kind=BODY|GARMENT`
 * and `?q=`. Read through the module's listPoms (product.styles.view, its companies), which also counts the view before
 * the run. No money. The list frame's second list on the page: `products.sizes.2`.
 */

type Row = Awaited<ReturnType<typeof listPoms>>['points'][number]
type Query = Omit<ListPomsQuery, 'cursor' | 'limit'>

export const pointsOfMeasure = defineExportSource<Query, Row>({
  listKey: 'products.sizes.2',
  page: '/products/sizes',
  permission: PRODUCT_STYLES_VIEW,
  query(address) {
    const status = address.get('status')
    const kind = address.get('kind')
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return { status: status === 'archived' ? 'ARCHIVED' : status === 'all' ? 'ALL' : 'ACTIVE', ...(kind === 'BODY' || kind === 'GARMENT' ? { kind } : {}), q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listPoms(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.points, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listPoms(caller, { ...query, limit: 1 })).count
  },
  columns: {
    code: { value: (row, words) => `${row.code} · ${words(`kind.${row.kind}`)}` },
    name: { value: (row) => row.name },
    howTo: { value: (row) => row.howTo },
    uom: { value: (row) => row.uom.toLowerCase() },
    tolerance: { value: (row) => row.defaultTolerance },
    body: { value: (row) => row.bodyPoint?.code ?? null },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  words: {
    it: { 'kind.BODY': 'Corpo', 'kind.GARMENT': 'Capo', 'status.ACTIVE': 'In uso', 'status.ARCHIVED': 'Archiviato' },
    en: { 'kind.BODY': 'Body', 'kind.GARMENT': 'Garment', 'status.ACTIVE': 'In use', 'status.ARCHIVED': 'Archived' },
  },
})
