import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { listOrders, type ListOrdersQuery } from '../../../modules/purchasing/orders'
import { defineExportSource } from '../source'

/**
 * Purchasing › Purchase orders (SCR-058, `/purchasing/orders`): the export of the list as the screen shows it. The
 * address is the list's own (apps/factory-web areas/purchasing/orders model.ts orderViewOf): `?view=drafts|waiting|
 * late|proposed|confirmed|partly|received|declined|cancelled|all`, or the API's own `?status=…` and
 * `?waitingOver48h=true` (Home › Today's links), and `?q=`; nothing: every order. Read through the module's listOrders
 * (purchasing.view, its companies, sites and suppliers). The value is the cost grain: absent from the file without it.
 */

type Row = Awaited<ReturnType<typeof listOrders>>['orders'][number] & { readonly siteCode: string | null }
type Status = NonNullable<ListOrdersQuery['status']>

const VIEW_STATUS: Readonly<Record<string, Status>> = Object.freeze({
  drafts: 'DRAFT',
  waiting: 'SENT',
  late: 'SENT',
  proposed: 'CHANGES_PROPOSED',
  confirmed: 'CONFIRMED',
  partly: 'PARTLY_RECEIVED',
  received: 'RECEIVED',
  declined: 'DECLINED',
  cancelled: 'CANCELLED',
})
const STATUSES = new Set<string>(Object.values(VIEW_STATUS))

export const purchaseOrders = defineExportSource<Omit<ListOrdersQuery, 'cursor' | 'limit'>, Row>({
  listKey: 'purchasing.orders',
  permission: PURCHASING_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 60) || undefined
    const view = address.get('view') ?? ''
    if (view === 'late' || (view === '' && address.get('waitingOver48h') === 'true')) return { status: 'SENT', waitingOver48h: true, q }
    if (Object.hasOwn(VIEW_STATUS, view)) return { status: VIEW_STATUS[view], q }
    const status = address.get('status')
    if (view === '' && status && STATUSES.has(status)) return { status: status as Status, q }
    return { q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listOrders(caller, { ...query, cursor: cursor ?? undefined, limit })
    const siteIds = [...new Set(page.orders.map((row) => row.siteId))]
    const sites = new Map(siteIds.length === 0 ? [] : (await caller.withClient((client) => client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true } }))).map((site) => [site.id, site.code]))
    return { rows: page.orders.map((row) => ({ ...row, siteCode: sites.get(row.siteId) ?? null })), next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    supplier: { value: (row) => row.supplierName },
    status: { value: (row, words) => words(`status.${row.status}`) },
    confirmation: { value: (row) => (row.confirmedAt ? { at: row.confirmedAt } : row.declinedAt ? { at: row.declinedAt } : row.sentAt ? { at: row.sentAt } : null) },
    dates: { value: (row) => (row.earliestNeedDate ? { day: row.earliestNeedDate } : null) },
    lines: { value: (row) => row.lineCount },
    value: { grain: 'cost', value: (row) => ({ minor: Number(row.netAmount), currency: row.currency }) },
    site: { value: (row) => row.siteCode },
  },
  words: {
    it: {
      'status.DRAFT': 'Bozza',
      'status.SENT': 'Inviato',
      'status.CHANGES_PROPOSED': 'Modifiche proposte',
      'status.CONFIRMED': 'Confermato',
      'status.DECLINED': 'Rifiutato',
      'status.PARTLY_RECEIVED': 'Ricevuto in parte',
      'status.RECEIVED': 'Ricevuto',
      'status.CLOSED': 'Chiuso',
      'status.CANCELLED': 'Annullato',
    },
    en: {
      'status.DRAFT': 'Draft',
      'status.SENT': 'Sent',
      'status.CHANGES_PROPOSED': 'Changes proposed',
      'status.CONFIRMED': 'Confirmed',
      'status.DECLINED': 'Declined',
      'status.PARTLY_RECEIVED': 'Partly received',
      'status.RECEIVED': 'Received',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
    },
  },
})
