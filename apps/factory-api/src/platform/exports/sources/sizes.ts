import type { ListScalesQuery } from '@nexus/factory-domain/product/sizes/contracts'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { listScales } from '../../../modules/product/styles/scales'
import { defineExportSource } from '../source'

/**
 * Products › Libraries › Sizes & measurements (SCR-049, `/products/sizes`): the export of the size scales as the screen
 * shows them. The address is the list's own (apps/factory-web areas/products/sizes SizesPage filtersOf + model.ts
 * viewQuery): `?view=open|archived|all` (nothing: open = the active scales) and `?q=`. Read through the module's
 * listScales (product.styles.view, its companies), which also counts the view before the run. The sizes column writes
 * every active size code in order (the screen shortens a long scale to "44 46 48 … 64"). No money.
 */

type Row = Awaited<ReturnType<typeof listScales>>['scales'][number]
type Query = Omit<ListScalesQuery, 'cursor' | 'limit'>

export const sizes = defineExportSource<Query, Row>({
  listKey: 'products.sizes',
  permission: PRODUCT_STYLES_VIEW,
  query(address) {
    const view = address.get('view')
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return { status: view === 'archived' ? 'ARCHIVED' : view === 'all' ? 'ALL' : 'ACTIVE', q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listScales(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.scales, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listScales(caller, { ...query, limit: 1 })).count
  },
  columns: {
    code: { value: (row) => `${row.code} · ${row.name}` },
    sizes: { value: (row) => (row.codes.length > 0 ? row.codes.join(' ') : null) },
    styles: { value: (row) => row.styleCount },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  words: {
    it: { 'status.ACTIVE': 'Attivo', 'status.ARCHIVED': 'Archiviato' },
    en: { 'status.ACTIVE': 'Active', 'status.ARCHIVED': 'Archived' },
  },
})
