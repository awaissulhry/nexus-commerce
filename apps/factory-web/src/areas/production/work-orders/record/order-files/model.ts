import type { OrderFilesGroup, WorkOrderOrderFiles } from './api'

/**
 * B-TH-265 (agreement T9): the pure part of the work order's "Order files (n)" and of its threads.
 *
 * - The band says "Order files (n)": n = the files and worksheets the reader may open, over every order of the work order. A work order
 *   that makes no order's lines (stock, a sample of no order) draws no button; one whose every order is out of the reader's reach still
 *   draws it, so the dialog can say so in words.
 * - What was left out is said as a count, never named: "2 files you cannot open", "1 measurement sheet needs the measurements right",
 *   "1 order whose files you cannot see".
 * - The docked thread is ONE thread at a time (PL1): the work order's own notes (never shareable with a customer: NOT_SHAREABLE, a
 *   'For the floor' tick on a note) or, picked beside it, one of its orders' threads (shared with that order's customer) — only an
 *   order whose thread the reader may read (the route's `thread`, threads.read over the order's company and customer).
 */

export type OrderFilesState = { readonly state: 'loading' } | { readonly state: 'ready'; readonly read: WorkOrderOrderFiles } | { readonly state: 'error'; readonly problem: string }

export interface OrderFilesModel {
  readonly files: OrderFilesState
  /** The dialog is open. */
  readonly open: boolean
  /** The file (or worksheet document) whose address is being asked. */
  readonly opening: string | null
  /** An opening refused, in words (a message key of the production catalogue). */
  readonly problem: string | null
}

export interface OrderFilesActions {
  readonly onOpen?: () => void
  readonly onClose?: () => void
  readonly onRetry?: () => void
  readonly onOpenFile?: (fileId: string, mode: 'preview' | 'download') => void
  readonly onOpenWorksheet?: (profileId: string, documentId: string) => void
  /** Show this order's thread in the dock ('workOrder': the work order's own notes). */
  readonly onThread?: (pick: ThreadPick) => void
}

export const ORDER_FILES_LOADING: OrderFilesModel = { files: { state: 'loading' }, open: false, opening: null, problem: null }

/** What the reader may open of one order: its files and its worksheets. */
export const openableOf = (group: Pick<OrderFilesGroup, 'files' | 'worksheets'>): number => group.files.length + group.worksheets.length

/** The band's count: every file and worksheet the reader may open, over every order (null while reading or after a failed read). */
export function orderFilesCount(files: OrderFilesState): number | null {
  return files.state === 'ready' ? files.read.groups.reduce((sum, group) => sum + openableOf(group), 0) : null
}

/** Whether the band draws "Order files": not for a work order of no order (nothing to say); while reading or failed, yes (it says so). */
export function hasOrderFiles(files: OrderFilesState): boolean {
  return files.state !== 'ready' || files.read.groups.length > 0 || files.read.ordersLeftOut > 0
}

/** What was left out of one order, as counted words (message keys of the production catalogue, `orderFiles.*`). */
export function leftOutOf(group: Pick<OrderFilesGroup, 'filesLeftOut' | 'measurementsLeftOut'>): readonly { readonly key: string; readonly count: number }[] {
  return [
    ...(group.filesLeftOut > 0 ? [{ key: 'orderFiles.filesLeftOut', count: group.filesLeftOut }] : []),
    ...(group.measurementsLeftOut > 0 ? [{ key: 'orderFiles.measurementsLeftOut', count: group.measurementsLeftOut }] : []),
  ]
}

/** The thread the dock shows: the work order's own notes, or one order's thread (its id). */
export type ThreadPick = 'workOrder' | string

/** One order whose thread the dock may show: its number and its customer (the order's party, the thread's only party). */
export interface OrderThreadChoice {
  readonly orderId: string
  readonly number: string
  readonly party: { readonly id: string; readonly name: string }
}

/**
 * The orders whose thread the reader may read (the route's `thread` is null otherwise), with each order's customer from the work order
 * itself (an order the work order no longer names is left out: never a thread without its party).
 */
export function threadChoices(orders: readonly { readonly id: string; readonly number: string; readonly partyId: string; readonly partyName: string }[], files: OrderFilesState): readonly OrderThreadChoice[] {
  if (files.state !== 'ready') return []
  const byId = new Map(orders.map((order) => [order.id, order]))
  return files.read.groups.flatMap((group) => {
    const order = byId.get(group.order.id)
    return group.thread && order ? [{ orderId: order.id, number: order.number, party: { id: order.partyId, name: order.partyName } }] : []
  })
}

/** The pick as the dock can show it now: an order no longer offered falls back to the work order's own notes. */
export const pickOf = (pick: ThreadPick, choices: readonly OrderThreadChoice[]): ThreadPick => (pick === 'workOrder' || choices.some((choice) => choice.orderId === pick) ? pick : 'workOrder')
