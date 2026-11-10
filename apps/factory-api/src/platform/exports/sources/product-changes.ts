import { PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import type { OrderRow, RequestRow } from '@nexus/factory-domain/product/changes/contracts'
import { CHANGE_KINDS, CHANGE_ROWS, changeListsOf, changeRowId, type ChangeKind, type ChangeRows } from '@nexus/factory-domain/product/changes/screens'
import type { WaitingView } from '@nexus/factory-domain/product/minutes/contracts'
import { listOrders } from '../../../modules/product/changes/orders'
import { listRequests } from '../../../modules/product/changes/requests'
import { listWaiting } from '../../../modules/product/minutes/versions'
import { defineExportSource } from '../source'

/**
 * Products › Development › Changes & versions (`/products/changes`, the list of SCR-117; B-W2b-244 on B-W2b-226's and
 * B-W2b-215's reads): change requests, change orders and the SMV changes waiting as the list shows them, through the modules'
 * own reads (product.changes.view over each record's company; the SMV changes only as far as the person reads operations,
 * product.routing.view). The address is the page's: `?rows=` (the saved rows; the tiles are four of them), `?kind=`, `?style=`,
 * `?q=`; `?view=released` is another list (no file). The columns are the list's; who raised or wrote it is said as the list
 * says it ("You" / "A colleague": no name in a list). No money.
 */

type Source = 'OFFICE' | 'FLOOR' | 'CUSTOMER' | 'SAMPLE' | 'SUPPLIER'
type Smv = WaitingView['versions'][number]
type Row =
  | { readonly kind: 'request'; readonly request: RequestRow; readonly me: string | null }
  | { readonly kind: 'order'; readonly order: OrderRow; readonly me: string | null }
  | { readonly kind: 'smv'; readonly smv: Smv; readonly me: string | null }

interface Query {
  readonly rows: ChangeRows
  readonly kind: ChangeKind | null
  readonly styleId?: string
  readonly q?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WORDS = {
  it: {
    'kind.request': 'Richiesta di modifica',
    'kind.order': 'Ordine di modifica',
    'kind.smv': 'Modifica del tempo standard',
    'request.OPEN': 'Da valutare',
    'request.IN_REVIEW': 'In valutazione',
    'request.ACCEPTED': 'Accettata',
    'request.REJECTED': 'Respinta',
    'request.DONE': 'Fatta',
    'order.DRAFT': 'Bozza',
    'order.SUBMITTED': 'In approvazione',
    'order.APPROVED': 'Approvato',
    'order.REJECTED': 'Respinto',
    'order.RELEASED': 'Rilasciato',
    'order.CANCELLED': 'Annullato',
    'smv.PROPOSED': 'In approvazione',
    'source.OFFICE': 'Ufficio',
    'source.FLOOR': 'Reparto',
    'source.CUSTOMER': 'Cliente',
    'source.SAMPLE': 'Campionatura',
    'source.SUPPLIER': 'Fornitore',
    'priority.LOW': 'Bassa',
    'priority.NORMAL': 'Normale',
    'priority.HIGH': 'Alta',
    'priority.URGENT': 'Urgente',
    'effect.NEXT_ORDER': 'Dal prossimo ordine',
    'effect.AT_ONCE': 'Subito',
    me: 'Tu',
    other: 'Un collega',
    floorUnnumbered: 'Dal reparto (senza numero)',
    of: 'di',
  },
  en: {
    'kind.request': 'Change request',
    'kind.order': 'Change order',
    'kind.smv': 'SMV change',
    'request.OPEN': 'To triage',
    'request.IN_REVIEW': 'In review',
    'request.ACCEPTED': 'Accepted',
    'request.REJECTED': 'Rejected',
    'request.DONE': 'Done',
    'order.DRAFT': 'Draft',
    'order.SUBMITTED': 'Waiting for approval',
    'order.APPROVED': 'Approved',
    'order.REJECTED': 'Rejected',
    'order.RELEASED': 'Released',
    'order.CANCELLED': 'Cancelled',
    'smv.PROPOSED': 'Waiting for approval',
    'source.OFFICE': 'Office',
    'source.FLOOR': 'Floor',
    'source.CUSTOMER': 'Customer',
    'source.SAMPLE': 'Sample round',
    'source.SUPPLIER': 'Supplier',
    'priority.LOW': 'Low',
    'priority.NORMAL': 'Normal',
    'priority.HIGH': 'High',
    'priority.URGENT': 'Urgent',
    'effect.NEXT_ORDER': 'From the next order',
    'effect.AT_ONCE': 'At once',
    me: 'You',
    other: 'A colleague',
    floorUnnumbered: 'From the floor (no number yet)',
    of: 'of',
  },
} as const

const person = (id: string | null, me: string | null, words: (code: string) => string): string | null => (id === null ? null : words(id === me ? 'me' : 'other'))
const raisedBy = (row: RequestRow, me: string | null, words: (code: string) => string): string =>
  [words(`source.${row.source as Source}`), row.party?.name ?? null, row.source === 'OFFICE' ? person(row.createdById, me, words) : null].filter(Boolean).join(' · ')

export const productChanges = defineExportSource<Query, Row>({
  listKey: 'products.changes',
  permission: PRODUCT_CHANGES_VIEW,
  query(address) {
    const rows = address.get('rows') ?? ''
    const kind = address.get('kind') ?? ''
    const style = address.get('style')
    const q = (address.get('q') ?? '').trim().slice(0, 100)
    return {
      rows: (CHANGE_ROWS as readonly string[]).includes(rows) ? (rows as ChangeRows) : 'ALL',
      kind: (CHANGE_KINDS as readonly string[]).includes(kind) ? (kind as ChangeKind) : null,
      ...(style && UUID.test(style) ? { styleId: style } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, _cursor, limit) {
    const me = caller.factoryContext && caller.factoryContext.audience === 'office' ? caller.factoryContext.actorId : null
    const lists = changeListsOf(query.rows, query.kind)
    const take = Math.min(Math.max(limit, 1), 200)
    const filters = { ...(query.styleId ? { styleId: query.styleId } : {}), ...(query.q ? { q: query.q } : {}) }
    const requests = lists.requests ? (await listRequests(caller, { ...lists.requests, ...filters, limit: take })).rows : []
    const orders = lists.orders ? (await listOrders(caller, { ...lists.orders, ...filters, limit: take })).rows : []
    const waiting = lists.smv && !query.styleId ? (await listWaiting(caller, { limit: take })).versions : []
    const q = query.q?.toLowerCase() ?? null
    const smv = waiting.filter((one) => (lists.smv === 'all' || one.mayDecide) && (q === null || `${one.operation.code} ${one.operation.name}`.toLowerCase().includes(q)))
    const rows: Row[] = [
      ...requests.map((request) => ({ kind: 'request' as const, request, me })),
      ...orders.map((order) => ({ kind: 'order' as const, order, me })),
      ...smv.map((one) => ({ kind: 'smv' as const, smv: one, me })),
    ]
    const at = (row: Row): string => (row.kind === 'request' ? row.request.createdAt : row.kind === 'order' ? row.order.createdAt : row.smv.proposal.proposedAt)
    if (query.rows !== 'TO_TRIAGE') rows.sort((a, b) => at(b).localeCompare(at(a)))
    return { rows: rows.slice(0, take), next: null }
  },
  idOf: (row) => changeRowId(row.kind, row.kind === 'request' ? row.request.id : row.kind === 'order' ? row.order.id : row.smv.proposal.id),
  columns: {
    number: {
      value: (row, words) =>
        row.kind === 'request' ? (row.request.number ?? words('floorUnnumbered')) : row.kind === 'order' ? row.order.number : `${row.smv.operation.code} v${row.smv.proposal.number}`,
    },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    title: {
      value: (row) =>
        row.kind === 'request' ? row.request.title : row.kind === 'order' ? row.order.title : `${row.smv.operation.name}: ${row.smv.operation.standardMinutes} → ${row.smv.proposal.standardMinutes}`,
    },
    styles: { value: (row) => (row.kind === 'request' ? row.request.style.code : row.kind === 'order' ? row.order.style.code : row.smv.operation.code) },
    raisedBy: {
      value: (row, words) => (row.kind === 'request' ? raisedBy(row.request, row.me, words) : row.kind === 'order' ? person(row.order.authorId, row.me, words) : person(row.smv.proposal.proposedBy.id, row.me, words)),
    },
    reason: { value: (row) => (row.kind === 'request' ? row.request.reason : row.kind === 'order' ? row.order.reason : row.smv.proposal.reason) },
    status: { value: (row, words) => (row.kind === 'request' ? words(`request.${row.request.status}`) : row.kind === 'order' ? words(`order.${row.order.status}`) : words('smv.PROPOSED')) },
    approvals: { value: (row, words) => (row.kind === 'order' && row.order.approvals.required > 0 ? `${row.order.approvals.approved} ${words('of')} ${row.order.approvals.required}` : row.kind === 'smv' ? `0 ${words('of')} 1` : null) },
    effective: {
      value: (row, words) =>
        row.kind === 'order' ? (row.order.effect === 'DATE' ? row.order.effectiveDate : words(`effect.${row.order.effect}`)) : row.kind === 'smv' ? row.smv.proposal.effectiveFrom : null,
    },
    priority: { value: (row, words) => (row.kind === 'request' ? words(`priority.${row.request.priority}`) : row.kind === 'order' ? words(`priority.${row.order.priority}`) : null) },
  },
  words: WORDS,
})
