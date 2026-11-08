import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { CUT_ORDER_KINDS, type CutOrderKind } from '@nexus/factory-domain/production/cutorders/rules'
import { CUT_ORDER_VIEWS, listCutOrders, type CutOrderView, type ListQuery } from '../../../modules/production/cutorders/read'
import { defineExportSource } from '../source'

/**
 * Production › Cutting room › Cutting, the Cut orders grid (`/production/cutting`, SCR-238; B-W2b-112): the export of the cut
 * orders as the list reads them. The address is the list's: `?view=open|planned|released|cutting|cut|cancelled|all` (nothing:
 * open), `?kind=LEATHER|FABRIC`, `?siteId=`, `?q=` (number, marker, material or a work order, at most 60 characters). Read through
 * the module's listCutOrders (production.cutting.view over its companies and sites), page by page with its cursor (200 a page).
 * No money; no person.
 *
 * Registered in ./index.ts by the screen step (B-W2b-129) together with the grid: the registry's test asks for a real Office list
 * page at its address, and the Cutting page still lists W2a's cuts until then.
 */

type Row = Awaited<ReturnType<typeof listCutOrders>>['rows'][number]

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))

export const cutOrders = defineExportSource<Omit<ListQuery, 'limit' | 'cursor'>, Row>({
  listKey: 'production.cutting',
  permission: PRODUCTION_CUTTING_VIEW,
  query(address) {
    const view = address.get('view') ?? ''
    const kind = address.get('kind') ?? ''
    const siteId = address.get('siteId') ?? ''
    const q = (address.get('q') ?? '').slice(0, 60).trim() || undefined
    return {
      view: (CUT_ORDER_VIEWS as readonly string[]).includes(view) ? (view as CutOrderView) : 'open',
      ...((CUT_ORDER_KINDS as readonly string[]).includes(kind) ? { kind: kind as CutOrderKind } : {}),
      ...(/^[0-9a-f-]{36}$/.test(siteId) ? { siteId } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listCutOrders(caller, { ...query, ...(cursor ? { cursor } : {}), limit: Math.min(limit, 200) })
    return { rows: page.rows, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    workOrders: { value: (row) => row.workOrders.map((order) => order.number).join(', ') },
    material: { value: (row) => [row.material.item.code, row.material.colour?.code].filter((part) => part).join(' ') },
    status: { value: (row, words) => words(`status.${row.status}`) },
    garments: { value: (row) => row.garments },
    plies: { value: (row) => row.plies },
    lays: { value: (row, words) => (row.kind === 'FABRIC' ? fill(words('lays.cutOf'), { cut: row.lays.cut, count: row.lays.count }) : null) },
    station: { value: (row) => row.station?.code ?? null },
    dueDate: { value: (row) => row.dueDate },
  },
  words: {
    it: {
      lang: 'it',
      'kind.LEATHER': 'Pelle',
      'kind.FABRIC': 'Tessuto',
      'status.PLANNED': 'Pianificato',
      'status.RELEASED': 'Rilasciato',
      'status.IN_PROGRESS': 'In taglio',
      'status.CUT': 'Tagliato',
      'status.RECONCILED': 'Riconciliato',
      'status.CANCELLED': 'Annullato',
      'lays.cutOf': '{cut} di {count} tagliati',
    },
    en: {
      lang: 'en',
      'kind.LEATHER': 'Leather',
      'kind.FABRIC': 'Fabric',
      'status.PLANNED': 'Planned',
      'status.RELEASED': 'Released',
      'status.IN_PROGRESS': 'Cutting',
      'status.CUT': 'Cut',
      'status.RECONCILED': 'Reconciled',
      'status.CANCELLED': 'Cancelled',
      'lays.cutOf': '{cut} of {count} cut',
    },
  },
})
