import { WORK_ORDER_STATUSES, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { isRelativeDay } from '@nexus/factory-domain/views/quick/relative'
import { listWorkOrders, type ListQuery } from '../../../modules/production/work-orders/work-orders'
import { defineExportSource, /* B-PR-09: shared by the walled lists */ partyTerm } from '../source'

/**
 * Production › Work orders (SCR-069, `/production/work-orders`): the export of the list as the screen shows it. The
 * address is the list's own (apps/factory-web areas/production/_shared model.ts viewFromAddress): `?view=open|late|
 * DRAFT|…|all`, or the API's own `?late=true` / `?status=…`, `?q=` and the quick filter `?due=<relative day>` (B-W2b-13);
 * nothing: the open ones. Read through the
 * module's listWorkOrders (workorders.view, its companies and sites). Totals per work order only: no person, no money.
 * B-PR-03 (the brand wall): the list's own wall (its customers too) and its customer filter (`?party=`, or the API's own
 * `partyId`, as Sales › Orders' file reads it); a malformed one is refused, never dropped (a file of every customer for one
 * customer's list). The customer cell names the work order's one customer, and each order with its customer PO.
 */

type Row = Awaited<ReturnType<typeof listWorkOrders>>['workOrders'][number]

const isStatus = (value: string | null): value is WorkOrderStatus => value !== null && (WORK_ORDER_STATUSES as readonly string[]).includes(value)

// ── B-PR-03 ──
// The address's customer (`party`, else the API's `partyId`): ../source partyTerm (B-PR-09 moved it there for every walled list).

/** The customer cell: the work order's customer, then each order with its customer PO ("SO-0001 (PO-42)"). */
function customerText(row: Row): string | null {
  const orders = row.orders.map((order) => `${order.number}${order.customerRef ? ` (${order.customerRef})` : ''}`).join(', ')
  const customer = row.customer?.name ?? [...new Set(row.orders.map((order) => order.partyName))].join(', ')
  return [customer, orders].filter((part) => part !== '').join(' · ') || null
}
// ── end B-PR-03 ──

export const workOrders = defineExportSource<Omit<ListQuery, 'cursor' | 'limit'>, Row>({
  listKey: 'production.work-orders',
  permission: WORKORDERS_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    // B-W2b-13 (PLT-167): the quick filter's relative day, as the list reads it.
    const dueWord = address.get('due')
    const due = isRelativeDay(dueWord) ? dueWord : undefined
    // B-W2b-51 (MES-009): the rush quick filter, as the list reads it.
    const rushWord = address.get('rush')
    const rush = rushWord === 'true' ? true : rushWord === 'false' ? false : undefined
    const partyId = partyTerm(address) // B-PR-03
    const view = address.get('view') ?? (address.get('late') === 'true' ? 'late' : (address.get('status') ?? 'open'))
    if (view === 'late') return { late: true, q, due, rush, partyId }
    if (view === 'all') return { q, due, rush, partyId }
    if (isStatus(view)) return { status: view, q, due, rush, partyId }
    return { open: true, q, due, rush, partyId }
  },
  async read(caller, query, cursor, limit) {
    const page = await listWorkOrders(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.workOrders, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    status: { value: (row, words) => words(`status.${row.status}`) },
    style: { value: (row) => `${row.styleCode} · ${row.styleName}${row.revision !== null ? ` r${row.revision}` : ''}` },
    customer: { value: (row) => customerText(row) }, // B-PR-03
    pieces: { value: (row) => row.pieces },
    progress: { value: (row) => row.progress?.finished ?? null },
    due: { value: (row) => (row.dueDate ? { day: row.dueDate } : null) },
    priority: { value: (row) => row.priority },
    // B-W2b-51: the rush flag.
    rush: { value: (row, words) => (row.rush ? words('rush') : null) },
    site: { value: (row) => row.siteCode },
  },
  words: {
    it: {
      'status.DRAFT': 'Bozza',
      'status.RELEASED': 'Rilasciato',
      'status.IN_PROGRESS': 'In lavorazione',
      'status.COMPLETED': 'Completato',
      'status.CLOSED': 'Chiuso',
      'status.CANCELLED': 'Annullato',
      'status.ON_HOLD': 'In sospeso',
      rush: 'Urgente',
    },
    en: {
      'status.DRAFT': 'Draft',
      'status.RELEASED': 'Released',
      'status.IN_PROGRESS': 'In progress',
      'status.COMPLETED': 'Completed',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
      'status.ON_HOLD': 'On hold',
      rush: 'Rush',
    },
  },
})
