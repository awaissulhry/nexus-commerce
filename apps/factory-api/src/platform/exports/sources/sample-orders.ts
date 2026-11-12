import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { KIND_WORDS } from '@nexus/factory-domain/sales/samples/rules'
import { listSampleOrders, type ListSampleOrdersQuery } from '../../../modules/purchasing/sample-orders/list'
import { defineExportSource } from '../source'

/**
 * Purchasing › Sourcing & claims › RFQs & sourcing (`/purchasing/sourcing`, the "Sample and development orders" grid of SCR-222;
 * B-W2b-347): the sample orders as the list shows them, through the module's own listSampleOrders (purchasing.view over each
 * order's company, site and supplier; newest first). The address is the page's: `?rows=open|all`, `?status=`, `?q=`. The
 * columns are the list's (number, supplier, project, items, status, value); the value is the cost grain: absent without it.
 */

type Row = Awaited<ReturnType<typeof listSampleOrders>>['orders'][number]

const STATUSES = new Set<string>(PURCHASE_ORDER_STATUSES)

const STATUS_WORDS = {
  it: { DRAFT: 'Bozza', PENDING_APPROVAL: 'In attesa di approvazione', SENT: 'Inviato', CHANGES_PROPOSED: 'Modifiche proposte', CONFIRMED: 'Confermato', DECLINED: 'Rifiutato', PARTLY_RECEIVED: 'Ricevuto in parte', RECEIVED: 'Ricevuto', CLOSED: 'Chiuso', CANCELLED: 'Annullato' },
  en: { DRAFT: 'Draft', PENDING_APPROVAL: 'Waiting for a yes', SENT: 'Sent', CHANGES_PROPOSED: 'Changes proposed', CONFIRMED: 'Confirmed', DECLINED: 'Declined', PARTLY_RECEIVED: 'Partly received', RECEIVED: 'Received', CLOSED: 'Closed', CANCELLED: 'Cancelled' },
} as const
const kindWords = (language: 'it' | 'en') => Object.fromEntries(Object.entries(KIND_WORDS).map(([kind, words]) => [kind, words[language]]))
const prefixed = (prefix: string, words: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(words).map(([code, text]) => [`${prefix}.${code}`, text]))

export const sampleOrders = defineExportSource<Omit<ListSampleOrdersQuery, 'cursor' | 'limit'>, Row>({
  listKey: 'purchasing.sourcing',
  permission: PURCHASING_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 60) || undefined
    const status = address.get('status')
    return { rows: address.get('rows') === 'all' ? 'ALL' : 'OPEN', ...(status && STATUSES.has(status) ? { status: status as PurchaseOrderStatus } : {}), q }
  },
  async read(caller, query, cursor, limit) {
    const page = await listSampleOrders(caller, { ...query, cursor: cursor ?? undefined, limit: Math.min(limit, 200) })
    return { rows: page.orders, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    supplier: { value: (row) => row.supplierName },
    project: { value: (row, words) => [row.style ? `${row.style.code} ${row.style.name}` : '', row.round ? `${row.round.number} (${words(`round.${row.round.kind}`)} ${row.round.roundNo})` : ''].filter(Boolean).join(' · ') || null },
    items: { value: (row) => row.items.map((item) => `${item.code} ${item.description ?? item.name}`).join('; ') || null },
    lines: { value: (row) => row.lineCount },
    status: { value: (row, words) => words(`status.${row.status}`) },
    value: { grain: 'cost', value: (row) => ({ minor: Number(row.netAmount), currency: row.currency }) },
  },
  words: {
    it: { ...prefixed('status', STATUS_WORDS.it), ...prefixed('round', kindWords('it')) },
    en: { ...prefixed('status', STATUS_WORDS.en), ...prefixed('round', kindWords('en')) },
  },
})
