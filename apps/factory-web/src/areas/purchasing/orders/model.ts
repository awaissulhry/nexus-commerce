import type { Tone } from '@nexus/ui/primitives'
import { decimalValue, phrase, type BuyingCan, type Loaded, type Part, type Phrase } from '../../_shared/buying/model'
import type { MaterialDetail, MaterialOption, SiteOption, SupplierOption } from '../../_shared/buying/api'
import type { LiveState } from '../../_shared/buying/hooks'
import type { DocumentSendModel } from '../../_shared/document-send/model'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import type { OrderDocuments, OrderReceipt, OrderReminders, OrderRevisions, OrderRow, OrderSummary, PoLine, PoStatus, PurchaseOrder, SendCard, SendCheck, SendCheckAnswer, SendOutcome, SupplierAnswer, SupplierView } from './api'
import type { DailyDialog, SendExtra } from './daily-model'

/**
 * Purchase orders (SCR-058) and the PO studio (SCR-059) — the screens' rules, pure: the saved views (the tiles are
 * some of them), a state's pill tone and the order's journey (drafted → sent → confirmed → received), the next step
 * with the reason it is held, a leather line's specs in words, the send checks as the shared send dialog's items, the
 * supplier's answer per line, and how much of each line has come.
 */

export const STATUS_TONE: Readonly<Record<PoStatus, Tone>> = Object.freeze({
  DRAFT: 'neutral',
  SENT: 'info',
  CHANGES_PROPOSED: 'warning',
  CONFIRMED: 'success',
  DECLINED: 'danger',
  PARTLY_RECEIVED: 'info',
  RECEIVED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
})

// ---- the list ---------------------------------------------------------------------------------------------------------------

// B-W2a-69: Rows ▾ Expected this week · Late (the API's `?due=`) and Past the confirm-by (`?pastConfirmBy=true`).
export const ORDER_VIEWS = ['all', 'drafts', 'waiting', 'late', 'pastConfirmBy', 'proposed', 'confirmed', 'dueThisWeek', 'deliveryLate', 'partly', 'received', 'declined', 'cancelled'] as const
export type OrderView = (typeof ORDER_VIEWS)[number]

const VIEW_STATUS: Readonly<Partial<Record<OrderView, PoStatus>>> = Object.freeze({
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

/** The view from the address: `?view=`, or the API's own filters (`?status=SENT` from Today, `?waitingOver48h=true`). */
export function orderViewOf(params: { get(name: string): string | null } | null): OrderView {
  const view = params?.get('view') ?? ''
  if ((ORDER_VIEWS as readonly string[]).includes(view)) return view as OrderView
  if (params?.get('waitingOver48h') === 'true') return 'late'
  if (params?.get('pastConfirmBy') === 'true') return 'pastConfirmBy'
  if (params?.get('due') === 'THIS_WEEK') return 'dueThisWeek'
  if (params?.get('due') === 'LATE') return 'deliveryLate'
  const status = params?.get('status')
  const found = (Object.entries(VIEW_STATUS) as [OrderView, PoStatus][]).find(([name, value]) => value === status && name !== 'late')
  return found?.[0] ?? 'all'
}

export function orderQuery(view: OrderView, q: string, cursor: string | null = null) {
  const due = view === 'dueThisWeek' ? ('THIS_WEEK' as const) : view === 'deliveryLate' ? ('LATE' as const) : null
  return { status: VIEW_STATUS[view] ?? null, waitingOver48h: view === 'late', q, cursor, ...(due ? { due } : {}), ...(view === 'pastConfirmBy' ? { pastConfirmBy: true } : {}) }
}

/** "Where POs stand": saved views with the API's counts (null: not known, drawn '—', never 0). */
export const ORDER_TILES: readonly { id: string; view: OrderView; count: (summary: OrderSummary) => number | null }[] = Object.freeze([
  { id: 'drafts', view: 'drafts', count: (summary) => summary.drafts },
  { id: 'waiting', view: 'waiting', count: (summary) => summary.waiting },
  { id: 'late', view: 'late', count: (summary) => summary.notConfirmedAfter48h },
  { id: 'proposed', view: 'proposed', count: (summary) => summary.changesProposed },
  { id: 'declined', view: 'declined', count: (summary) => summary.declined },
  // B-W2a-69 (SCM-067): an open line expected from today to Sunday; expected before today.
  { id: 'dueThisWeek', view: 'dueThisWeek', count: (summary) => summary.dueThisWeek ?? null },
  { id: 'deliveryLate', view: 'deliveryLate', count: (summary) => summary.late ?? null },
])

/** The confirmation column in words: sent n days ago, confirmed by link by a name, changes proposed, declined. */
export function confirmationPhrase(row: Pick<OrderRow, 'status' | 'sentAt' | 'confirmedAt' | 'confirmedVia' | 'confirmedByName' | 'declinedAt'>, now: Date = new Date()): Phrase {
  switch (row.status) {
    case 'DRAFT':
      return phrase('po.confirm.notSent')
    case 'SENT': {
      const days = row.sentAt ? Math.floor((now.getTime() - Date.parse(row.sentAt)) / 86_400_000) : 0
      return days >= 1 ? phrase('po.confirm.sentDays', { count: days }) : phrase('po.confirm.sentToday')
    }
    case 'CHANGES_PROPOSED':
      return phrase('po.confirm.proposed')
    case 'DECLINED':
      return phrase('po.confirm.declined')
    case 'CANCELLED':
      return phrase('po.confirm.cancelled')
    default:
      if (!row.confirmedAt) return phrase('po.confirm.none')
      if (row.confirmedVia === 'LINK') return row.confirmedByName ? phrase('po.confirm.byLinkName', { name: row.confirmedByName }) : phrase('po.confirm.byLink')
      return phrase('po.confirm.byOffice')
  }
}

// ---- the record -------------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['lines', 'answer', 'receipts', 'documents', 'activity'] as const
export type OrderTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): OrderTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as OrderTab) : 'lines')

/** The journey under the title: drafted → sent → confirmed → received (Stepper's current index; a closed order is past the end). */
export function journeyIndex(status: PoStatus): number {
  switch (status) {
    case 'DRAFT':
      return 0
    case 'SENT':
    case 'CHANGES_PROPOSED':
    case 'DECLINED':
      return 1
    case 'CONFIRMED':
      return 2
    case 'PARTLY_RECEIVED':
      return 3
    case 'RECEIVED':
    case 'CLOSED':
      return 4
    case 'CANCELLED':
      return 0
  }
}

export type NextStep = { kind: 'send' | 'review' | 'newLink' | 'receive' | null; held: Phrase | null }

/** The band's primary by state, held with its reason. */
export function nextStep(order: PurchaseOrder, can: Pick<BuyingCan, 'poSend' | 'receive'>): NextStep {
  switch (order.status) {
    case 'DRAFT': {
      if (!can.poSend) return { kind: 'send', held: phrase('held.noSend') }
      const blocking = order.send?.checks.find((check) => check.severity === 'BLOCKS')
      return { kind: 'send', held: blocking ? phrase(`po.check.${blocking.code}`) : null }
    }
    case 'CHANGES_PROPOSED':
      return { kind: 'review', held: can.poSend ? null : phrase('held.noSend') }
    case 'SENT':
    case 'DECLINED':
      return { kind: 'newLink', held: can.poSend ? null : phrase('held.noSend') }
    case 'CONFIRMED':
    case 'PARTLY_RECEIVED':
      return { kind: 'receive', held: can.receive ? null : phrase('held.noReceive') }
    default:
      return { kind: null, held: null }
  }
}

/**
 * Why cancelling is held: never once goods came (closed, never cancelled: close the rest short) or while the supplier's
 * proposal waits; sent ones need the send right. W2a (B-W2a-52): a confirmed order may be cancelled — the dialog says a
 * contract ends and the supplier is told.
 */
export function cancelHeld(order: Pick<PurchaseOrder, 'status'>, can: Pick<BuyingCan, 'poManage' | 'poSend'>): Phrase | null {
  if (!can.poManage) return phrase('held.noManage')
  if (order.status === 'PARTLY_RECEIVED' || order.status === 'RECEIVED' || order.status === 'CLOSED') return phrase('po.cancelHeld.received')
  if (order.status === 'CHANGES_PROPOSED') return phrase('po.cancelHeld.proposed')
  if (order.status === 'CANCELLED') return phrase('po.cancelHeld.cancelled')
  if (order.status !== 'DRAFT' && !can.poSend) return phrase('held.noSend')
  return null
}

export const isDraft = (order: Pick<PurchaseOrder, 'status'>) => order.status === 'DRAFT'

/** How much of a line has come, from 0 to 1 (null when nothing is expected). */
export function receivedShare(line: PoLine): number | null {
  const expected = decimalValue(line.baseQuantity)
  const received = decimalValue(line.receivedBaseQuantity) ?? 0
  if (!expected || expected <= 0) return null
  return Math.min(1, received / expected)
}

/** A leather line's specs, one phrase each: grade, thickness, one dye batch, tolerance, chromium VI test. */
export function leatherSpecs(line: PoLine): Phrase[] {
  const specs: Phrase[] = []
  if (line.item.kind !== 'LEATHER') return line.requiresCrViTest ? [phrase('po.spec.crVi')] : []
  if (line.grade) specs.push(phrase('po.spec.grade', { grade: line.grade }))
  if (line.thicknessMinMm || line.thicknessMaxMm) {
    specs.push(line.thicknessMinMm && line.thicknessMaxMm && line.thicknessMinMm !== line.thicknessMaxMm ? phrase('po.spec.thicknessRange', { min: line.thicknessMinMm, max: line.thicknessMaxMm }) : phrase('po.spec.thickness', { mm: line.thicknessMinMm ?? line.thicknessMaxMm ?? '' }))
  }
  if (line.oneDyeBatch) specs.push(phrase('po.spec.oneDyeBatch'))
  if (line.areaTolerancePct) specs.push(phrase('po.spec.tolerance', { pct: line.areaTolerancePct }))
  if (line.requiresCrViTest) specs.push(phrase('po.spec.crVi'))
  return specs
}

/** The send checks as the shared send dialog's items: each in words, with its Fix link to the tab that fixes it. */
export function sendItems(checks: readonly SendCheck[], words: (key: string) => string, recordHref: string): DocumentSendModel['checks'] {
  const fixOf = (code: SendCheck['code']): { label: string; href: string } | null => {
    if (['NO_LINES', 'LINE_NOT_PRICED', 'NEED_DATE_PAST', 'BELOW_MINIMUM', 'NOT_A_MULTIPLE', 'LATE_FOR_LEAD_TIME'].includes(code)) return { label: words('po.fix.lines'), href: `${recordHref}?tab=lines` }
    if (['REQUESTED_DATE_PAST', 'NO_CONTACT', 'CONTACT_NOT_ORDERS', 'NO_CONTACT_EMAIL'].includes(code)) return { label: words('po.fix.details'), href: `${recordHref}?tab=lines&edit=details` }
    return null
  }
  const items = checks.map((check, index) => ({ id: `${check.code}-${index}`, state: check.severity === 'BLOCKS' ? ('blocks' as const) : ('warning' as const), label: words(`po.check.${check.code}`), fix: fixOf(check.code) }))
  const passing = ['supplierActive', 'linesPriced', 'datesFuture'].map((id) => ({ id: `pass-${id}`, state: 'passes' as const, label: words(`po.check.pass.${id}`), fix: null }))
  const failedCodes = new Set(checks.map((check) => check.code))
  const shownPasses = passing.filter((item) => {
    if (item.id === 'pass-supplierActive') return !failedCodes.has('SUPPLIER_NOT_ACTIVE') && !failedCodes.has('NOT_A_SUPPLIER')
    if (item.id === 'pass-linesPriced') return !failedCodes.has('LINE_NOT_PRICED') && !failedCodes.has('NO_LINES')
    return !failedCodes.has('NEED_DATE_PAST') && !failedCodes.has('REQUESTED_DATE_PAST')
  })
  return { status: 'ready', items: [...items, ...shownPasses] }
}

/** What the send dialog shows while its checks are read (send-check), failed, or there. */
export type SendCheckState = { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; value: SendCheckAnswer }

/** The shared send dialog's model (SCR-037) for a purchase order: the host's words, the checks, the confirm link. */
export function sendModelOf(
  input: {
    order: PurchaseOrder
    check: SendCheckState
    fields: DocumentSendModel['fields']
    sending: boolean
    problem: string | null
    result: DocumentSendModel['result']
    canSend: boolean
    recordHref: string
    timeZone: string
    /** The PDF as it would leave (the preview route, with the cost grain), its new-tab address, or why it is not shown. */
    preview: { src: DocumentSendModel['preview']['src']; openHref: string | null; problem: string | null }
  },
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): DocumentSendModel {
  const { order, check } = input
  const ready = check.status === 'ready' ? check.value : null
  return {
    title: t('po.send.title', { number: order.number, supplier: order.supplier.name }),
    documentLabel: t('po.send.document', { number: ready?.documentNumber ?? order.documentNumber }),
    recipient: ready?.recipient ? { name: ready.recipient.name, email: ready.recipient.email } : order.contact ? { name: order.contact.name, email: order.contact.email } : null,
    language: ready?.language ?? 'it',
    how: { kind: 'acceptLink', until: ready?.linkExpiresAt ?? null },
    freezeNote: t('po.send.freeze', { number: order.documentNumber }),
    recipientCan: [t('po.send.can.confirm'), t('po.send.can.propose'), t('po.send.can.decline'), t('po.send.can.noAccount')],
    fields: input.fields,
    checks: ready ? sendItems(ready.checks, t, input.recordHref) : check.status === 'error' ? { status: 'error', problem: check.problem } : { status: 'loading' },
    preview: { ...input.preview, fileName: `${order.documentNumber}.pdf` },
    sending: input.sending,
    problem: input.problem,
    result: input.result,
    canSend: input.canSend,
    timeZone: input.timeZone,
  }
}

// ---- the page models --------------------------------------------------------------------------------------------------------

export interface NewOrderModel {
  query: string
  suppliers: SupplierOption[] | null
  suppliersProblem: string | null
  supplier: SupplierOption | null
  siteId: string | null
  requestedDate: string
  busy: boolean
  problem: Phrase | null
}

export const NO_NEW_ORDER: NewOrderModel = Object.freeze({ query: '', suppliers: null, suppliersProblem: null, supplier: null, siteId: null, requestedDate: '', busy: false, problem: null }) as NewOrderModel

export interface OrdersListModel {
  prefix: string
  can: BuyingCan
  view: OrderView
  q: string
  rows: { items: OrderRow[] | null; more: boolean; problem: string | null }
  summary: OrderSummary | null
  sites: SiteOption[]
  asOf: string | null
  live: LiveState
  updates: number
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase } | null
  newOrder: NewOrderModel | null
  /** B-W2a-69: Send n (one card per supplier) while it is open. */
  sendMany?: SendManyModel | null
  /** Design cases. */
  selected?: readonly string[]
  focusRow?: number
  helpOpen?: boolean
  timeZone?: string
  now?: string
}

export interface OrdersListActions {
  onView?: (view: OrderView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onExport?: (ids: string[]) => void
  onOpen?: (id: string) => void
  onNew?: (open: boolean) => void
  onDismissNotice?: () => void
  /** B-W2a-69: Send n — open with these orders, or close (null). */
  onSendMany?: (orderIds: string[] | null) => void
  sendMany?: {
    onConfirmBy?: (orderId: string, confirmBy: string) => void
    onMessage?: (message: string) => void
    onSend?: () => void
    onRetry?: () => void
  }
  newOrder?: {
    onQuery?: (q: string) => void
    onSupplier?: (supplier: SupplierOption | null) => void
    onSite?: (siteId: string) => void
    onRequestedDate?: (day: string) => void
    onCreate?: () => void
  }
}

/** A line being added or changed (the line dialog). */
export interface LineDraft {
  lineId: string | null
  materialQuery: string
  materials: MaterialOption[] | null
  material: MaterialDetail | null
  materialProblem: string | null
  itemColourId: string
  quantity: string
  uom: string
  unitPrice: string
  needDate: string
  grade: string
  thicknessMinMm: string
  thicknessMaxMm: string
  oneDyeBatch: boolean
  areaTolerancePct: string
  supplierArticleCode: string
  supplierColourCode: string
  note: string
}

export interface DetailsDraft {
  requestedDate: string
  incoterms: string
  paymentTerms: string
  note: string
  internalNote: string
}

/** Send n (B-W2a-69): the cards read by send-checks, the confirm-by chosen per order, one message, the outcomes after. */
export interface SendManyModel {
  orderIds: string[]
  cards: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; value: SendCard[] }
  confirmBy: Readonly<Record<string, string>>
  message: string
  sending: boolean
  outcomes: SendOutcome[] | null
  problem: Phrase | null
}

export type OrderDialog =
  | { kind: 'send' }
  | { kind: 'newLink'; message: string }
  | DailyDialog
  | { kind: 'line'; draft: LineDraft }
  | { kind: 'removeLines'; lineIds: string[] }
  | { kind: 'details'; draft: DetailsDraft }
  | { kind: 'review' }
  | { kind: 'accept'; message: string }
  | { kind: 'refuse'; note: string }
  | { kind: 'supplierView'; view: Loaded<SupplierView> }

export interface OrderRecordModel {
  prefix: string
  can: BuyingCan
  tab: OrderTab
  order: Loaded<PurchaseOrder>
  answer: Part<SupplierAnswer>
  receipts: Part<OrderReceipt[]> | null
  documents: Part<OrderDocuments>
  /** B-W2a-69: every revision with its diff and answer, the draft's changes so far; the reminders and the confirm-by. */
  revisions: Part<OrderRevisions>
  reminders: Part<OrderReminders>
  /** The send dialog's own PO fields (confirm-by, a later revision's change note) while it is open. */
  sendExtra?: SendExtra | null
  /** What send-check said of this send: the default confirm-by and a later revision's changes (the supplier's words). */
  sendFacts?: { confirmBy: string | null; changes: string[] | null } | null
  /** Now (design cases: a fixed instant), for the confirm-by's "passed". */
  now?: string
  /** The send dialog's model while it is open (built by the container from send-check and the person's fields). */
  send: DocumentSendModel | null
  /** A draft's sample PDF for a new tab (the preview route; only with the cost grain), else null. */
  previewHref?: string | null
  live: LiveState
  dockOpen: boolean
  changed: { at: string } | null
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase } | null
  busy: boolean
  dialog: OrderDialog | null
  dialogProblem: Phrase | null
  panelsPreview?: RecordPanelsViewModel
  /** Design cases. */
  selected?: readonly string[]
  timeZone?: string
  today?: string
}

export interface OrderRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDock?: () => void
  onDialog?: (dialog: OrderDialog | null) => void
  onDismissNotice?: () => void
  onSend?: {
    onField?: (field: 'cc' | 'subject' | 'message', value: string) => void
    onSend?: () => void
    onRetryChecks?: () => void
    onNewLink?: () => void
  }
  onNewLink?: () => void
  onAccept?: () => void
  onRefuse?: () => void
  onSaveDetails?: () => void
  onDetails?: (draft: DetailsDraft) => void
  line?: {
    onChange?: (draft: LineDraft) => void
    onMaterialQuery?: (q: string) => void
    onMaterial?: (id: string | null) => void
    onSave?: () => void
  }
  onRemoveLines?: () => void
  onEditLine?: (lineId: string) => void
  onAddLine?: () => void
  onSupplierView?: () => void
  onDownload?: (fileId: string) => void
  onRetryPart?: (part: 'answer' | 'receipts' | 'documents' | 'revisions' | 'reminders') => void
  /** B-W2a-69: the changes after the send. */
  daily?: {
    onSendExtra?: (extra: SendExtra) => void
    onChange?: () => void
    onCounter?: () => void
    /** Open the cancel dialog (reads the reach first). */
    onCancelOrder?: () => void
    onConfirmCancel?: () => void
    /** Open cancel lines / close short for these lines (reads the reach first). */
    onEndLines?: (action: 'CANCEL_LINES' | 'CLOSE_SHORT', lineIds: string[]) => void
    onConfirmEnd?: () => void
    onConfirmBy?: () => void
    onRemind?: () => void
    onOpenRevision?: (fileId: string) => void
  }
}
