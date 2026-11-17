import type { OrderFile, OrderFilesGroup, OrderWorksheet, WorkOrderOrderFiles } from './api'

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
  /** The file whose download address is being asked (F-PR-25: Download; showing has its own state, `shown`). */
  readonly opening: string | null
  /** An opening refused, in words (a message key of the production catalogue). */
  readonly problem: string | null
  /** F-PR-25: the file shown beside the list (a PDF in the viewer, a picture as it is); null or absent: nothing picked yet. */
  readonly shown?: ShownFile | null
}

export interface OrderFilesActions {
  readonly onOpen?: () => void
  readonly onClose?: () => void
  readonly onRetry?: () => void
  /** Show this order's thread in the dock ('workOrder': the work order's own notes). */
  readonly onThread?: (pick: ThreadPick) => void
  // ---- F-PR-25: the window shows a file beside the list; Download saves it; ‹ (phone) goes back to the list ----
  readonly onShowFile?: (file: Pick<OrderFile, 'id' | 'name' | 'contentType'>) => void
  readonly onShowWorksheet?: (sheet: Pick<OrderWorksheet, 'profileId' | 'documentId'>, name: string) => void
  readonly onDownload?: (file: Pick<OrderFile, 'id' | 'name'>) => void
  readonly onBack?: () => void
  // ---- end F-PR-25
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
  /** F-PR-25: the customer's PO (the band's "Order thread" menu names it first) and the order's own company (the thread's scope). */
  readonly customerRef: string | null
  readonly companyId: string
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
    return group.thread && order ? [{ orderId: order.id, number: order.number, party: { id: order.partyId, name: order.partyName }, customerRef: group.order.customerRef, companyId: group.order.companyId }] : []
  })
}

/** The pick as the dock can show it now: an order no longer offered falls back to the work order's own notes. */
export const pickOf = (pick: ThreadPick, choices: readonly OrderThreadChoice[]): ThreadPick => (pick === 'workOrder' || choices.some((choice) => choice.orderId === pick) ? pick : 'workOrder')

// ---- F-PR-25: Order files and Order thread on the work order band (L16: the order's PDFs and its thread are the source) ----

/** The window's sections of one order (06-tree / 17-web-r2 §1.3): the order's own files, its lines' artwork, the measurements. */
export type OrderFilesSectionKey = 'order' | 'lines' | 'measurements'

export type OrderFilesEntry = { readonly kind: 'file'; readonly file: OrderFile } | { readonly kind: 'worksheet'; readonly sheet: OrderWorksheet }

export interface OrderFilesSection {
  readonly key: OrderFilesSectionKey
  /** Newest first. */
  readonly entries: readonly OrderFilesEntry[]
  /** Measurement sheets the reader may not open (no sales.measurements.view): counted on their own line, never dropped. */
  readonly locked: number
}

const entryAt = (entry: OrderFilesEntry): string => (entry.kind === 'file' ? entry.file.at : entry.sheet.createdAt)
const newestFirst = (entries: readonly OrderFilesEntry[]): OrderFilesEntry[] => [...entries].sort((a, b) => entryAt(b).localeCompare(entryAt(a)))

/**
 * One order's files as the window shows them: Order (its own files), Lines (each line's and its quote line's artwork and files),
 * Measurements (the worksheets and body data — only for the measurements right; what the reader may not open is the lock line
 * "Measurement sheet: opens with the measurements right (n)"). Each section newest first; an empty section is not drawn.
 */
export function sectionsOf(group: Pick<OrderFilesGroup, 'files' | 'worksheets' | 'measurementsLeftOut'>): readonly OrderFilesSection[] {
  const files = (pick: (file: OrderFile) => boolean): OrderFilesEntry[] => group.files.filter(pick).map((file) => ({ kind: 'file' as const, file }))
  const sections: OrderFilesSection[] = [
    { key: 'order', entries: newestFirst(files((file) => !file.bodyData && (file.from === 'ORDER' || !file.line))), locked: 0 },
    { key: 'lines', entries: newestFirst(files((file) => !file.bodyData && file.from !== 'ORDER' && !!file.line)), locked: 0 },
    { key: 'measurements', entries: newestFirst([...files((file) => file.bodyData), ...group.worksheets.map((sheet) => ({ kind: 'worksheet' as const, sheet }))]), locked: group.measurementsLeftOut },
  ]
  return sections.filter((section) => section.entries.length > 0 || section.locked > 0)
}

/** What the window does with a file: a PDF in the viewer, a picture as it is, anything else Download only. */
export type FileLook = 'pdf' | 'picture' | 'other'

export function lookOf(contentType: string): FileLook {
  const type = contentType.toLowerCase().split(';')[0]!.trim()
  if (type === 'application/pdf') return 'pdf'
  if (/^image\/(png|jpe?g|webp|gif|avif)$/.test(type)) return 'picture'
  return 'other'
}

/** The file beside the list: being read, shown (a PDF's bytes or a picture's address; null: no preview, Download), or refused. */
export type ShownFile =
  | { readonly id: string; readonly name: string; readonly look: FileLook; readonly state: 'loading' }
  | { readonly id: string; readonly name: string; readonly look: FileLook; readonly state: 'ready'; readonly src: Uint8Array | string | null }
  | { readonly id: string; readonly name: string; readonly look: FileLook; readonly state: 'error'; readonly problem: string }

/** The "Order thread" button: none (no order thread the reader may read), one button, or a menu of the orders (their PO first). */
export type OrderThreadDoor = { readonly kind: 'none' } | { readonly kind: 'one'; readonly choice: OrderThreadChoice } | { readonly kind: 'menu'; readonly choices: readonly OrderThreadChoice[] }

export function orderThreadDoor(choices: readonly OrderThreadChoice[]): OrderThreadDoor {
  if (choices.length === 0) return { kind: 'none' }
  if (choices.length === 1) return { kind: 'one', choice: choices[0]! }
  return { kind: 'menu', choices }
}

/** An order as people name it: the customer's PO first (what the customer calls it), then our number. */
export const orderNameOf = (order: { readonly number: string; readonly customerRef: string | null }): { readonly po: string | null; readonly number: string } => ({ po: order.customerRef?.trim() ? order.customerRef.trim() : null, number: order.number })
// ---- end F-PR-25
