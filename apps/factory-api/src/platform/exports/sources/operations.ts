import type { ListOperationsQuery } from '@nexus/factory-domain/product/routing/contracts'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { listOperations } from '../../../modules/product/operations/operations'
import { defineExportSource } from '../source'

/**
 * Products › Libraries › Operations (SCR-049, `/products/operations`): the export of the operation library as the
 * screen shows it. The address is the list's own (apps/factory-web areas/products/operations OperationsPage filtersOf +
 * model.ts listQuery): `?view=open|unused|differs|archived|all` (nothing: open = the active operations), `?kind=` (a
 * department) and `?q=`. Read through the module's listOperations (product.routing.view, its companies), which also
 * counts the view before the run. No money (standard minutes are time per garment, not a person's figure).
 *
 * "Full file for re-import (XLSX)": the operation importer's layout (product.operations, key: the code).
 */

type Row = Awaited<ReturnType<typeof listOperations>>['operations'][number]
type Query = Omit<ListOperationsQuery, 'cursor' | 'limit'>
type Kind = (typeof WORK_CENTRE_KINDS)[number]

const isKind = (value: string | null): value is Kind => value !== null && (WORK_CENTRE_KINDS as readonly string[]).includes(value)

/** The view's own filters (web model.ts viewQuery). */
function viewFilters(view: string): Partial<Query> & Pick<Query, 'status'> {
  switch (view) {
    case 'unused':
      return { status: 'ACTIVE', usage: 'UNUSED' }
    case 'differs':
      return { status: 'ACTIVE', usage: 'DIFFERS' }
    case 'archived':
      return { status: 'ARCHIVED' }
    case 'all':
      return { status: 'ALL' }
    default:
      return { status: 'ACTIVE' }
  }
}

const with_ = (template: string, name: string, value: string): string => template.replace(`{${name}}`, value)

export const operations = defineExportSource<Query, Row>({
  listKey: 'products.operations',
  permission: PRODUCT_ROUTING_VIEW,
  query(address) {
    const kind = address.get('kind')
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    return { ...viewFilters(address.get('view') ?? 'open'), kind: isKind(kind) ? [kind] : undefined, q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listOperations(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.operations, next: page.nextCursor }
  },
  async count(caller, query) {
    return (await listOperations(caller, { ...query, limit: 1 })).count
  },
  columns: {
    code: {
      value: (row, words) => {
        const lang = words('lang') === 'en' ? 'en' : 'it'
        return `${row.code} · ${row.nameI18n?.[lang] ?? row.name}`
      },
    },
    kind: { value: (row, words) => words(`department.${row.workCentreKind}`) },
    machine: { value: (row, words) => `${row.machineType ?? '—'} · ${row.skill ? with_(words('list.skill'), 'skill', row.skill) : words('list.noSkill')}` },
    smv: { value: (row) => ({ decimal: row.standardMinutes }) },
    used: { value: (row) => row.usedIn },
    status: { value: (row, words) => words(`status.${row.status}`) },
  },
  reimport: { importer: 'product.operations', key: (row) => ({ code: row.code }) },
  words: {
    it: {
      lang: 'it',
      'department.CUTTING': 'Taglio',
      'department.SEWING': 'Cucitura',
      'department.ASSEMBLY': 'Montaggio',
      'department.FINISHING': 'Rifinitura',
      'department.INSPECTION': 'Controllo',
      'department.PACKING': 'Imballaggio',
      'department.SUBCONTRACT': 'Terzisti',
      'list.skill': 'competenza: {skill}',
      'list.noSkill': 'Nessuna competenza indicata',
      'status.ACTIVE': 'Attivo',
      'status.ARCHIVED': 'Archiviato',
    },
    en: {
      lang: 'en',
      'department.CUTTING': 'Cutting',
      'department.SEWING': 'Sewing',
      'department.ASSEMBLY': 'Assembly',
      'department.FINISHING': 'Finishing',
      'department.INSPECTION': 'Inspection',
      'department.PACKING': 'Packing',
      'department.SUBCONTRACT': 'Subcontract',
      'list.skill': 'skill: {skill}',
      'list.noSkill': 'No skill given',
      'status.ACTIVE': 'Active',
      'status.ARCHIVED': 'Archived',
    },
  },
})
