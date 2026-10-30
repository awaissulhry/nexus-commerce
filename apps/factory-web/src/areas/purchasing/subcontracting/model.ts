import { DUE_STATUSES, OUT_STATUSES, RECEIVING_STATUSES, WORK_ORDER_STATES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import type { Tone } from '@nexus/ui/primitives'
import type { KitState, OperationSize, OrderAction, OrderQuery, OrderRow, OrderStatus, SubcontractOrder } from './api'

/**
 * Purchasing › Subcontract orders (SCR-128 list + record, SCR-129 stock at the subcontractors; design
 * purchasing.subcontracting), the pure rules every part of the page shares: what this person may do (the permissions and
 * the cost grain), the saved views the tiles and Rows ▾ open (each the list's own filter, as the API counts it), the
 * lifecycle in the design's words, where the kit stands, why a band act is held — in this app's words from the record's
 * facts, never the API's English — and the size grid of an operation. Words are keys of the `subcontracting` catalogue.
 */

// ---- what this person may do -----------------------------------------------------------------------------------------------

export interface SubcontractCan {
  /** purchasing.view: the list, the record, the stock at the workshops. */
  view: boolean
  /** purchasing.subcontract.manage: make and change orders, issue, take back to draft, cancel, close (the buyer). */
  manage: boolean
  /** purchasing.subcontract.kit: send the kit and the pieces; take back a kit line that never left (the warehouse). */
  kit: boolean
  /** purchasing.subcontract.receive: goods back by operation and bundle, unused material back (the warehouse). */
  receive: boolean
  /** shipping.ddt.issue: the DDT for work on our behalf that travels with the kit. */
  ddtIssue: boolean
  /** shipping.ddt.cancel: annul a kit DDT (its number stays). */
  ddtCancel: boolean
  /** The cost grain (money.cost): fees and values; without it the API drops them and the columns are not drawn. */
  cost: boolean
  /** parties.view: another workshop than the routing's in New subcontract order. */
  parties: boolean
  /** workorders.view: the work order's bundles (what travels and comes back by bundle) and the work order link. */
  workOrders: boolean
  /** inventory.stock.view: where the kit's material is now (send from) and the lot links. */
  stock: boolean
  /** inventory.locations.view: the site's places (where returned material goes). */
  locations: boolean
  /** product.materials.view: a typed kit line's material. */
  materials: boolean
  /** files.read: a DDT's PDF. */
  files: boolean
  threads: boolean
}

export function subcontractCan(permissions: readonly string[]): SubcontractCan {
  const held = new Set(permissions)
  return {
    view: held.has('purchasing.view'),
    manage: held.has('purchasing.subcontract.manage'),
    kit: held.has('purchasing.subcontract.kit'),
    receive: held.has('purchasing.subcontract.receive'),
    ddtIssue: held.has('shipping.ddt.issue'),
    ddtCancel: held.has('shipping.ddt.cancel'),
    cost: held.has('money.cost'),
    parties: held.has('parties.view'),
    workOrders: held.has('workorders.view'),
    stock: held.has('inventory.stock.view'),
    locations: held.has('inventory.locations.view'),
    materials: held.has('product.materials.view'),
    files: held.has('files.read'),
    threads: held.has('threads.read'),
  }
}

/**
 * Words with their values: a key of `subcontracting` (or of the record's catalogue) and its parameters. A parameter that
 * starts with `@` is itself a key of the same catalogue (`@statusIn.DRAFT` → "a draft"), translated by `say`.
 */
export interface Words {
  key: string
  params?: Readonly<Record<string, string | number>>
}
export const words = (key: string, params?: Words['params']): Words => (params ? { key, params } : { key })

/** Words in the person's language: nested `@key` parameters translated first. */
export function say(t: (key: string, params?: Record<string, string | number>) => string, value: Words): string {
  if (!value.params) return t(value.key)
  const params: Record<string, string | number> = {}
  for (const [name, entry] of Object.entries(value.params)) params[name] = typeof entry === 'string' && entry.startsWith('@') ? t(entry.slice(1)) : entry
  return t(value.key, params)
}

// ---- the saved views (tiles and Rows ▾) ---------------------------------------------------------------------------------------

/** The list's saved views: the open orders (default), each tile's filter, a status, every order. */
export const ORDER_VIEWS = ['open', 'kit', 'workshop', 'due', 'late', 'drafts', 'back', 'closed', 'cancelled', 'all'] as const
export type OrderView = (typeof ORDER_VIEWS)[number]

/** The list's query for a view (the tiles' views use the API's own tile filters, so a tile and its list agree). */
export function orderQuery(view: OrderView, q: string, cursor?: string | null): OrderQuery {
  const base: OrderQuery = { ...(q.trim() ? { q: q.trim() } : {}), ...(cursor ? { cursor } : {}) }
  switch (view) {
    case 'kit':
      return { ...base, kitToSend: true }
    case 'workshop':
      return { ...base, atWorkshop: true }
    case 'due':
      return { ...base, dueThisWeek: true }
    case 'late':
      return { ...base, late: true }
    case 'drafts':
      return { ...base, status: 'DRAFT' }
    case 'back':
      return { ...base, status: 'RECEIVED' }
    case 'closed':
      return { ...base, status: 'CLOSED' }
    case 'cancelled':
      return { ...base, status: 'CANCELLED' }
    case 'all':
      return { ...base, open: false }
    default:
      return base
  }
}

export function viewOf(value: string | null | undefined): OrderView {
  return (ORDER_VIEWS as readonly string[]).includes(value ?? '') ? (value as OrderView) : 'open'
}

/** The view an address asks for: `?view=`, else the API's own filters (a link from Today or a list route). */
export function viewFromAddress(params: Pick<URLSearchParams, 'get'> | null | undefined): OrderView {
  if (!params) return 'open'
  const named = params.get('view')
  if (named) return viewOf(named)
  if (params.get('late') === 'true') return 'late'
  if (params.get('kitToSend') === 'true') return 'kit'
  if (params.get('atWorkshop') === 'true') return 'workshop'
  if (params.get('dueThisWeek') === 'true') return 'due'
  const byStatus: Readonly<Record<string, OrderView>> = { DRAFT: 'drafts', RECEIVED: 'back', CLOSED: 'closed', CANCELLED: 'cancelled' }
  const status = params.get('status')
  if (status && byStatus[status]) return byStatus[status]!
  if (params.get('open') === 'false') return 'all'
  return 'open'
}

/** The tiles "Outside work": each a saved filter; "Balance open" is W2b (the material balance): '—', never pressed. */
export const TILES = [
  { id: 'kit', view: 'kit', count: (counts: { kitToSend: number }) => counts.kitToSend },
  { id: 'workshop', view: 'workshop', count: (counts: { atWorkshops: number }) => counts.atWorkshops },
  { id: 'due', view: 'due', count: (counts: { dueBackThisWeek: number }) => counts.dueBackThisWeek },
  { id: 'late', view: 'late', count: (counts: { late: number }) => counts.late },
  { id: 'balance', view: null, count: () => null },
] as const satisfies readonly { id: string; view: OrderView | null; count: (counts: { kitToSend: number; atWorkshops: number; dueBackThisWeek: number; late: number }) => number | null }[]

/** What the page shows: the orders, or our stock at the workshops (SCR-129: ⋯ Stock at subcontractors). */
export type PageShow = 'orders' | 'stock'
export const showOf = (value: string | null | undefined): PageShow => (value === 'stock' ? 'stock' : 'orders')

// ---- the lifecycle -------------------------------------------------------------------------------------------------------------

/** The design's lifecycle words: Draft · Sent · In work (the kit is out) · Partly back · Back · Closed · Cancelled. */
export const STATUS_TONE: Readonly<Record<OrderStatus, Tone>> = {
  DRAFT: 'neutral',
  ISSUED: 'info',
  AT_WORKSHOP: 'warning',
  PARTLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
}

export const KIT_TONE: Readonly<Record<KitState, Tone>> = { NONE: 'neutral', TO_SEND: 'warning', PARTLY_SENT: 'warning', SENT: 'success' }

/** The journey strip: Sent → Kit out (DDT) → In work → Back → Closed (the workshop's receipt, the material balance and the invoice match come with W2b and B-W2a-62). */
export const JOURNEY = ['draft', 'sent', 'kitOut', 'back', 'closed'] as const
export function journeyIndex(order: Pick<SubcontractOrder, 'status' | 'pieces' | 'kit'>): number {
  switch (order.status) {
    case 'DRAFT':
      return 0
    case 'ISSUED':
      return 1
    case 'AT_WORKSHOP':
    case 'PARTLY_RECEIVED':
      return 2
    case 'RECEIVED':
      return 3
    case 'CLOSED':
      return 4
    default:
      return 0
  }
}

/** Something of the order is at the workshop or travels: the kit or pieces are out. */
export const somethingOut = (order: Pick<SubcontractOrder, 'kitLines' | 'operations'>): boolean =>
  order.kitLines.some((line) => line.status === 'SENT') || order.operations.some((operation) => operation.piecesSent > 0)

/** Pieces still to send per operation, and kit lines still PLANNED. */
export const piecesToSend = (order: Pick<SubcontractOrder, 'operations'>): number => order.operations.reduce((sum, operation) => sum + Math.max(0, operation.pieces - operation.piecesSent), 0)
export const plannedLines = (order: Pick<SubcontractOrder, 'kitLines'>) => order.kitLines.filter((line) => line.status === 'PLANNED')

// ---- why a band act is held (this app's words; the API's `actions` says WHETHER, the facts say WHY) ----------------------------------

const PERMISSION: Readonly<Record<OrderAction, keyof SubcontractCan>> = { issue: 'manage', reopen: 'manage', cancel: 'manage', close: 'manage', send: 'kit', receive: 'receive' }
const PERMISSION_NAME: Readonly<Record<OrderAction, string>> = {
  issue: 'purchasing.subcontract.manage',
  reopen: 'purchasing.subcontract.manage',
  cancel: 'purchasing.subcontract.manage',
  close: 'purchasing.subcontract.manage',
  send: 'purchasing.subcontract.kit',
  receive: 'purchasing.subcontract.receive',
}

/**
 * Why an act of the band is held now, or null when it may be done. The person's permission first (named), then the
 * order's state: the API answers whether (null = allowed); the words come from the facts the record shows (status,
 * operations, fees with the cost grain, dates, what is out), and a reason only the server sees (a blocked workshop, an
 * archived location) is classified from its sentence, never drawn as it is.
 */
export function actHeld(order: SubcontractOrder, act: OrderAction, can: SubcontractCan): Words | null {
  if (!can[PERMISSION[act]]) return words('held.permission', { permission: PERMISSION_NAME[act] })
  const server = order.actions[act]
  if (server === null) {
    if (act === 'send' && plannedLines(order).length === 0 && piecesToSend(order) === 0) return words('held.send.nothing')
    return null
  }
  const own = factsHeld(order, act, can)
  return own ?? classify(server, act)
}

function factsHeld(order: SubcontractOrder, act: OrderAction, can: SubcontractCan): Words | null {
  const status = `@statusIn.${order.status}`
  switch (act) {
    case 'issue': {
      if (order.status !== 'DRAFT') return words('held.issue.state', { status })
      if (order.operations.length === 0) return words('held.issue.noOperation')
      const free = can.cost ? order.operations.find((operation) => operation.pricePerPiece !== undefined && Number(operation.pricePerPiece) === 0) : undefined
      if (free) return words('held.issue.noFee', { line: free.seq, code: free.workOrderOperation.code })
      if (!order.expectedBackDate) return words('held.issue.noDate')
      if (!(WORK_ORDER_STATES as readonly string[]).includes(order.workOrder.status)) return words('held.issue.workOrder', { number: order.workOrder.number })
      return null
    }
    case 'reopen':
      if (order.status !== 'ISSUED') return words('held.reopen.state', { status })
      return somethingOut(order) ? words('held.out') : null
    case 'cancel':
      if (order.status !== 'DRAFT' && order.status !== 'ISSUED') return words('held.cancel.state', { status })
      return somethingOut(order) ? words('held.out') : null
    case 'close':
      return order.status !== 'RECEIVED' ? words('held.close.state', { status }) : null
    case 'send':
      if (!OUT_STATUSES.includes(order.status)) return words(order.status === 'DRAFT' ? 'held.send.draft' : 'held.send.state', { status })
      if (!(WORK_ORDER_STATES as readonly string[]).includes(order.workOrder.status)) return words('held.send.workOrder', { number: order.workOrder.number })
      return null
    case 'receive':
      return !RECEIVING_STATUSES.includes(order.status) ? words(order.status === 'ISSUED' || order.status === 'DRAFT' ? 'held.receive.nothingOut' : 'held.receive.state', { status }) : null
  }
}

/** A reason only the server knows, by the shape of its English sentence (never drawn as it is). */
function classify(sentence: string, act: OrderAction): Words {
  const text = sentence.toLowerCase()
  if (text.includes('workshop is not active') || text.includes('blocked')) return words('held.workshopInactive')
  if (text.includes('location is archived') || text.includes('stock location')) return words('held.locationArchived')
  if (text.includes('currency')) return words('held.currency')
  if (text.includes('fee')) return words('held.issue.noFeeHidden')
  return words('held.server', { act: `@act.${act}` })
}

// ---- dates and the size grid ---------------------------------------------------------------------------------------------------

/** Due back: late (red) when the order waits for goods and its date passed; the API's `late` already says it for a row. */
export const isDue = (status: OrderStatus): boolean => DUE_STATUSES.includes(status)

/** "Sent / back" for a row: pieces sent of ordered, back (good + defective + scrapped). */
export function piecesLine(row: Pick<OrderRow, 'pieces'>): { sent: number; ordered: number; back: number; good: number; atWorkshop: number } {
  const { ordered, sent, backGood, backDefective, scrapped, atWorkshop } = row.pieces
  return { sent, ordered, back: backGood + backDefective + scrapped, good: backGood, atWorkshop }
}

/** An operation's sizes as the DS size grid reads them: colourways as rows, sizes as columns in the order given. */
export function sizeRun(sizes: readonly OperationSize[]): { colours: { key: string; label: string; offered: string[] }[]; sizes: { key: string; label: string }[]; value: Record<string, Record<string, number>> } {
  const colourKeys: string[] = []
  const sizeKeys: string[] = []
  const value: Record<string, Record<string, number>> = {}
  const offered: Record<string, string[]> = {}
  for (const size of sizes) {
    if (!colourKeys.includes(size.colourway)) colourKeys.push(size.colourway)
    if (!sizeKeys.includes(size.size)) sizeKeys.push(size.size)
    value[size.colourway] = { ...(value[size.colourway] ?? {}), [size.size]: size.pieces }
    offered[size.colourway] = [...(offered[size.colourway] ?? []), size.size]
  }
  const order = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : 0)
  sizeKeys.sort(order)
  return { colours: colourKeys.map((key) => ({ key, label: key, offered: offered[key] ?? [] })), sizes: sizeKeys.map((key) => ({ key, label: key })), value }
}

/** "BLK 50 ×1 · BLK 52 ×2" for a short line (a list cell, a dialog's summary). */
export const sizesLine = (sizes: readonly OperationSize[]): string => sizes.map((size) => `${size.colourway} ${size.size} ×${size.pieces}`).join(' · ')
