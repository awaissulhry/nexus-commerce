import type { LiveState } from '../../../_shared/buying/hooks'
import type { OrderRow, OutsideOperations, TileCounts, WorkOrderChoice, WorkshopOption, WorkshopStock } from '../api'
import { words, type OrderView, type PageShow, type SubcontractCan, type Words } from '../model'

/**
 * The view models of Purchasing › Subcontract orders' page (SCR-128 the orders, SCR-129 the stock at the workshops) and
 * of its "New subcontract order" dialog, and the dialog's pure rules: which operations it may send and how many pieces,
 * which workshop the order goes to, whether "Create draft" is held and why, and the body it creates.
 */

export interface Rows<T> {
  /** null while the first read runs. */
  items: T[] | null
  more: boolean
  /** A failed read (a key of `subcontracting`), never drawn as empty. */
  problem: string | null
}

export interface SubcontractingModel {
  prefix: string
  can: SubcontractCan
  show: PageShow
  view: OrderView
  q: string
  rows: Rows<OrderRow>
  /** The tiles; null while unknown (each tile then draws '—', never 0). */
  counts: TileCounts | null
  countsProblem?: string | null
  stock: { value: WorkshopStock | null; problem: string | null }
  /** The stock view's workshop filter (a party id) and search. */
  stockWorkshop: string | null
  stockQ: string
  asOf: string | null
  live: LiveState
  updates: number
  notice: { tone: 'success' | 'danger' | 'info'; words: Words } | null
  newOrder: NewOrderDraft | null
  timeZone: string
  /** Design cases: "now", the selection, the focused row, the slow-load note, the keys panel. */
  now?: string
  selected?: readonly string[]
  focusRow?: number
  slow?: boolean
  helpOpen?: boolean
}

export interface SubcontractingActions {
  onShow?: (show: PageShow) => void
  onView?: (view: OrderView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onRetryStock?: () => void
  onShowUpdates?: () => void
  onExport?: (ids: string[]) => void
  onExportStock?: (keys: string[]) => void
  onStockWorkshop?: (partyId: string | null) => void
  onStockSearch?: (q: string) => void
  onOpen?: (id: string) => void
  onDismissNotice?: () => void
  onNew?: (open: boolean) => void
  newOrder?: NewOrderActions
}

// ---- New subcontract order ---------------------------------------------------------------------------------------------------

export interface PickedOperation {
  operationId: string
  pieces: string
}

export interface NewOrderDraft {
  query: string
  /** null while the search runs. */
  workOrders: WorkOrderChoice[] | null
  workOrdersProblem: string | null
  workOrder: WorkOrderChoice | null
  /** The picked work order's outside operations; null while read. */
  outside: OutsideOperations | null
  outsideProblem: string | null
  picked: PickedOperation[]
  /** The workshop chosen by hand (another than the routing's); null: the routing's. */
  workshop: { id: string; code: string; name: string } | null
  /** "Another workshop…" open, with its search. */
  otherOpen: boolean
  otherQuery: string
  others: WorkshopOption[] | null
  returnDate: string
  planKit: boolean
  note: string
  busy: boolean
  problem: Words | null
}

export interface NewOrderActions {
  onQuery?: (q: string) => void
  onWorkOrder?: (choice: WorkOrderChoice | null) => void
  onToggle?: (operationId: string, on: boolean) => void
  onPieces?: (operationId: string, pieces: string) => void
  onWorkshop?: (workshop: { id: string; code: string; name: string } | null) => void
  onOther?: (open: boolean) => void
  onOtherQuery?: (q: string) => void
  onReturnDate?: (day: string) => void
  onPlanKit?: (on: boolean) => void
  onNote?: (note: string) => void
  onCreate?: () => void
}

export const NO_NEW_ORDER: NewOrderDraft = Object.freeze({
  query: '',
  workOrders: null,
  workOrdersProblem: null,
  workOrder: null,
  outside: null,
  outsideProblem: null,
  picked: [],
  workshop: null,
  otherOpen: false,
  otherQuery: '',
  others: null,
  returnDate: '',
  planKit: true,
  note: '',
  busy: false,
  problem: null,
}) as NewOrderDraft

/** The pieces of an operation still free for a new order: the work order's garments less those on live orders. */
export function freePieces(outside: OutsideOperations, operationId: string): { garments: number; left: number } {
  const garments = outside.cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const operation = outside.operations.find((entry) => entry.id === operationId)
  return { garments, left: Math.max(0, garments - (operation?.ordered ?? 0)) }
}

/** What the dialog picks by default: every outside operation of the routing with pieces still free, all of them. */
export function defaultPicks(outside: OutsideOperations): PickedOperation[] {
  return outside.operations.filter((operation) => operation.outside && freePieces(outside, operation.id).left > 0).map((operation) => ({ operationId: operation.id, pieces: String(freePieces(outside, operation.id).left) }))
}

/** The workshop the order goes to: the one chosen by hand, else the first picked operation's routing workshop. */
export function workshopOf(draft: NewOrderDraft): { id: string; code: string; name: string } | null {
  if (draft.workshop) return draft.workshop
  const outside = draft.outside
  if (!outside) return null
  // In routing order, as the API reads the operations it is sent.
  const operations = outside.operations.filter((entry) => draft.picked.some((pick) => pick.operationId === entry.id)).sort((a, b) => a.seq - b.seq)
  for (const operation of operations) if (operation.outside?.workshop) return operation.outside.workshop
  return null
}

/** The routing's workshop has a stock location on the work order's site (a hand-picked one is checked at the create). */
export function locationOf(draft: NewOrderDraft): { known: boolean; location: { id: string; code: string; name: string } | null } {
  const workshop = workshopOf(draft)
  if (!workshop || !draft.outside) return { known: false, location: null }
  const entry = draft.outside.workshops.find((row) => row.id === workshop.id)
  if (!entry) return { known: false, location: null }
  return { known: true, location: entry.locations[0] ?? null }
}

/** Why "Create draft" is held, or null. */
export function newOrderHeld(draft: NewOrderDraft, can: SubcontractCan): Words | null {
  if (!can.manage) return words('held.permission', { permission: 'purchasing.subcontract.manage' })
  if (draft.busy) return words('held.busy')
  if (!draft.workOrder) return words('new.held.workOrder')
  if (!draft.outside) return words('held.loading')
  if (draft.picked.length === 0) return words('new.held.operations')
  for (const pick of draft.picked) {
    const pieces = Number(pick.pieces)
    const { left } = freePieces(draft.outside, pick.operationId)
    if (!Number.isInteger(pieces) || pieces < 1 || pieces > left) return words('new.held.pieces')
  }
  const workshop = workshopOf(draft)
  if (!workshop) return words('new.held.workshop')
  const place = locationOf(draft)
  if (place.known && !place.location) return words('new.noLocation', { workshop: workshop.name })
  return null
}

/** The create body: the operations in routing order, pieces only when not every garment, the workshop when chosen. */
export function newOrderBody(draft: NewOrderDraft) {
  const outside = draft.outside!
  const garments = outside.cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const order = (id: string) => outside.operations.find((entry) => entry.id === id)?.seq ?? 0
  const workshop = workshopOf(draft)
  return {
    workOrderId: outside.workOrder.id,
    ...(draft.workshop ? { partyId: draft.workshop.id } : workshop ? { partyId: workshop.id } : {}),
    ...(draft.returnDate ? { expectedBackDate: draft.returnDate } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    operations: [...draft.picked].sort((a, b) => order(a.operationId) - order(b.operationId)).map((pick) => ({ workOrderOperationId: pick.operationId, ...(Number(pick.pieces) !== garments ? { pieces: Number(pick.pieces) } : {}) })),
    planKit: draft.planKit,
  }
}

/** A refused create in this app's words (by its path), else null (the caller falls back to the kind). */
export function newOrderRefusal(paths: readonly string[], kind: string, message: string, workshopName: string): Words | null {
  if (paths.some((path) => /operations[./]\d+[./](pieces|sizes)/.test(path))) return words('new.refused.pieces')
  if (paths.some((path) => path.includes('partyId'))) return words('new.refused.workshop')
  if (paths.some((path) => path.includes('locationId'))) return words('new.refused.location', { workshop: workshopName })
  if (paths.some((path) => path.includes('workOrderId'))) return words('new.refused.workOrder')
  if (kind === 'conflict') {
    // A 409 carries no path: its sentence says which (never drawn as it is).
    if (/stock location/i.test(message)) return words('new.refused.location', { workshop: workshopName })
    if (/released or running/i.test(message)) return words('new.refused.workOrder')
  }
  return null
}
