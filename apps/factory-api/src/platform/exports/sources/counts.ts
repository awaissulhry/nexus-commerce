import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import { listCounts, type ListQuery } from '../../../modules/inventory/counts/reads'
import { defineExportSource } from '../source'

/**
 * Warehouse › Counts (SCR-132, `/warehouse/counts`): the export of the list as the screen shows it. The address is the
 * list's own (apps/factory-web areas/warehouse/counts model.ts addressOf / viewQuery): `?view=open|drafts|counting|
 * waiting|toApply|yearEnd|applied|signedOff|cancelled|all` (nothing: the open counts), `?site=`, `?q=`. "Waiting for
 * approval" and "To apply" are the API's own views (B-W2b-15: `view=waitingApproval|toApply`, filtered as the tiles count
 * them), as the screen asks for them. Read through the module's listCounts (inventory.counts.view, its companies and
 * sites), a page at a time. The differences column writes
 * how many lines differ; their value (the cost grain) is not part of the file (the screen shows it under the count).
 */

type Row = Awaited<ReturnType<typeof listCounts>>['counts'][number]
type View = 'open' | 'drafts' | 'counting' | 'waiting' | 'toApply' | 'yearEnd' | 'applied' | 'signedOff' | 'cancelled' | 'all'
type Query = Omit<ListQuery, 'cursor' | 'limit'>

const VIEWS: readonly View[] = ['open', 'drafts', 'counting', 'waiting', 'toApply', 'yearEnd', 'applied', 'signedOff', 'cancelled', 'all']
/** A saved row → the API's own filter (web model.ts viewQuery). */
const FILTER: Readonly<Record<View, Omit<ListQuery, 'cursor' | 'limit' | 'q' | 'siteId'>>> = {
  open: { open: 'true' },
  drafts: { status: 'DRAFT' },
  counting: { status: 'COUNTING' },
  waiting: { view: 'waitingApproval' },
  toApply: { view: 'toApply' },
  yearEnd: { kind: 'YEAR_END', open: 'true' },
  applied: { status: 'APPLIED' },
  signedOff: { status: 'SIGNED_OFF' },
  cancelled: { status: 'CANCELLED' },
  all: {},
}

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
const dayOf = (at: string | null): { day: string } | null => (at ? { day: businessDate(new Date(at)) } : null)

/** What the count counts, in words (the screen's scope: a place and what is under it, a material, a lot, a kind, or the site). */
function scopeText(row: Row, words: (code: string) => string): string {
  const parts: string[] = []
  if (row.scope.location) parts.push(fill(words('scope.location'), { code: row.scope.location.code, name: row.scope.location.name }))
  if (row.scope.item) parts.push(fill(words('scope.item'), { code: row.scope.item.code, name: row.scope.item.name }))
  if (row.scope.lot) parts.push(fill(words('scope.lot'), { code: row.scope.lot.code }))
  if (row.scope.itemKind) parts.push(words(`itemKind.${row.scope.itemKind}`))
  return parts.length > 0 ? parts.join(' · ') : words('scope.site')
}

export const counts = defineExportSource<Query, Row>({
  listKey: 'warehouse.counts',
  permission: INVENTORY_COUNTS_VIEW,
  query(address) {
    const asked = address.get('view') ?? ''
    const view: View = (VIEWS as readonly string[]).includes(asked) ? (asked as View) : 'open'
    const siteId = address.get('site') || undefined
    if (siteId && !isUuid(siteId)) throw new ValidationError('Not a site.', [{ path: 'query/site', message: 'A site id.' }])
    const q = address.get('q')?.trim().slice(0, 80) || undefined
    return { ...FILTER[view], siteId, q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listCounts(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.counts, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    scope: { value: (row, words) => scopeText(row, words) },
    status: { value: (row, words) => words(`status.${row.status}`) },
    lines: { value: (row, words) => (row.status === 'DRAFT' ? null : fill(words('list.lines'), { counted: row.lines.counted, all: row.lines.all })) },
    diffs: { value: (row) => (row.status === 'DRAFT' ? null : row.lines.differing) },
    started: { value: (row) => dayOf(row.startedAt) },
    applied: { value: (row) => dayOf(row.appliedAt) },
  },
  words: {
    it: {
      'kind.CYCLE': 'Inventario a rotazione',
      'kind.YEAR_END': 'Inventario di fine anno',
      'status.DRAFT': 'Bozza',
      'status.COUNTING': 'In conteggio',
      'status.SUBMITTED': 'Inviato',
      'status.APPROVED': 'Approvato',
      'status.APPLIED': 'Applicato',
      'status.SIGNED_OFF': 'Firmato',
      'status.CANCELLED': 'Annullato',
      'itemKind.LEATHER': 'Pelle',
      'itemKind.TEXTILE': 'Tessuto',
      'itemKind.LINING': 'Fodera',
      'itemKind.MEMBRANE': 'Membrana',
      'itemKind.PADDING': 'Imbottitura',
      'itemKind.THREAD': 'Filo',
      'itemKind.TRIM': 'Accessorio',
      'itemKind.HARDWARE': 'Minuteria',
      'itemKind.PROTECTOR': 'Protezione',
      'itemKind.LABEL': 'Etichetta',
      'itemKind.PACKAGING': 'Imballo',
      'itemKind.COMPONENT': 'Componente',
      'itemKind.FINISHED': 'Capi finiti',
      'scope.site': 'Tutto lo stabilimento',
      'scope.location': '{code} · {name} e sottoposte',
      'scope.item': '{code} · {name}',
      'scope.lot': 'Lotto {code}',
      'list.lines': '{counted} di {all}',
    },
    en: {
      'kind.CYCLE': 'Cycle count',
      'kind.YEAR_END': 'Year-end inventory',
      'status.DRAFT': 'Draft',
      'status.COUNTING': 'Counting',
      'status.SUBMITTED': 'Submitted',
      'status.APPROVED': 'Approved',
      'status.APPLIED': 'Applied',
      'status.SIGNED_OFF': 'Signed off',
      'status.CANCELLED': 'Cancelled',
      'itemKind.LEATHER': 'Leather',
      'itemKind.TEXTILE': 'Textile',
      'itemKind.LINING': 'Lining',
      'itemKind.MEMBRANE': 'Membrane',
      'itemKind.PADDING': 'Padding',
      'itemKind.THREAD': 'Thread',
      'itemKind.TRIM': 'Trim',
      'itemKind.HARDWARE': 'Hardware',
      'itemKind.PROTECTOR': 'Protector',
      'itemKind.LABEL': 'Label',
      'itemKind.PACKAGING': 'Packaging',
      'itemKind.COMPONENT': 'Component',
      'itemKind.FINISHED': 'Finished garments',
      'scope.site': 'The whole site',
      'scope.location': '{code} · {name} and under it',
      'scope.item': '{code} · {name}',
      'scope.lot': 'Lot {code}',
      'list.lines': '{counted} of {all}',
    },
  },
})
