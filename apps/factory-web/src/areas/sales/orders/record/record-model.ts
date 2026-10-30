import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { StyleDetail, StyleRow, VersionsAnswer } from '../../quotes/api'
import type { AmendmentsAnswer, AmendPreview, CancelCheck, CloseLinesAnswer, CopyAnswer, DepositLinkAnswer, DepositReceived, Order, OrderWorkOrder, Schedule, SdiStatus, Settlement } from '../api'
import type { DraftLine } from '../daily-model'
import type { LiveState, StepUpState } from '../hooks'
import type { OrderAbilities, Phrase, RecordTab, SizeLayer } from '../model'

/** SCR-039 — the order studio's view model (OrderRecordView draws it and fetches nothing). */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** One part a tab reads (null value while it loads; a problem when the read failed: never drawn as empty). */
export interface Part<T> {
  value: T | null
  problem: string | null
}

export const PART_LOADING = { value: null, problem: null } as const

export type RecordDialog =
  | { kind: 'promise' }
  | { kind: 'ready' }
  | { kind: 'close' }
  | { kind: 'depositLink'; requestId: string }
  | { kind: 'depositPayment'; requestId: string }
  | { kind: 'sdiSend'; invoiceId: string }
  // B-W2a-50 (the order every day)
  | { kind: 'amendReview' }
  | { kind: 'closeLines' }
  | { kind: 'reopenLines' }
  | { kind: 'cancel' }
  | { kind: 'copyQuote' }
  | { kind: 'compare'; amendmentId: string }

/** "Add a style" in the lines editor: type a style, pick its colours, Add (their rows open in its grid). */
export interface ComposerState {
  query: string
  /** null: not searched yet (or a search is on its way when `searching`). */
  results: StyleRow[] | null
  searching: boolean
  problem: string | null
  chosen: StyleDetail | null
  picked: string[]
}

export const COMPOSER_EMPTY: ComposerState = Object.freeze({ query: '', results: null, searching: false, problem: null, chosen: null, picked: [] }) as ComposerState

/** "Amend order" (design order.lines.cards: the lines become an amendment draft until Review → Apply). */
export interface AmendState {
  /** The number the amendment will get ("Amendment 2 — not applied"). */
  revision: number
  lines: DraftLine[]
  customerRef: string
  requestedDate: string
  /** Each style of the draft as read (sizes, colourways, offered sizes): undefined while read, null when it failed. */
  styles: Record<string, StyleDetail | null | undefined>
  composer: ComposerState
  /** The review dialog's read of the API's preview. */
  review: { phase: 'reading' | 'ready' | 'failed'; preview: AmendPreview | null; problem: Phrase | null } | null
}

export interface OrderRecordModel {
  prefix: string
  can: OrderAbilities
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  tab: RecordTab
  order: Loaded<Order>
  /** The work orders of its lines with their floor progress (workorders.view); null without the right. */
  workOrders: Part<OrderWorkOrder[]> | null
  /** Where the money stands (invoices.view); null without the right. */
  settlement: Part<Settlement> | null
  /** Each issued invoice's SDI state (invoices.view), by invoice id; null without the right. */
  sdi: Record<string, Part<SdiStatus>> | null
  /** The quote's versions with the acceptance evidence (quotes.view); null without the right or without a quote. */
  versions: Part<VersionsAnswer> | null
  live: LiveState
  dockOpen: boolean
  /** Someone changed the order while a dialog holds typed work: "Changed at 10:42 · Reload". */
  changed: { at: string } | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  busy: boolean
  dialog: RecordDialog | null
  /** A refused write while its dialog is open: said inside the dialog (what was typed stays). */
  dialogProblem: Phrase | null
  /** The bank-details page just sent (the dialog shows to whom and until when). */
  sentLink: DepositLinkAnswer | null
  /** The payment just recorded (the dialog shows what followed: PAID, the TD02). */
  recorded: DepositReceived | null
  stepUp: StepUpState
  sizeLayer: SizeLayer
  // ---- B-W2a-50 ----------------------------------------------------------------------------------------------------------
  /** The Lines tab as an amendment draft; null: read-only. */
  amend: AmendState | null
  /** The payment schedule (Invoices & payments): null until read. */
  schedule: Part<Schedule> | null
  /** The Changes tab's amendments: null until read. */
  amendments: Part<AmendmentsAnswer> | null
  /** Styles the Changes tab names that the order no longer holds (their codes). */
  changeStyles: Record<string, StyleDetail | null | undefined>
  /** The cancel dialog's impact check: null until read. */
  cancelCheck: Part<CancelCheck> | null
  /** Close remaining lines just ran: what it closed, what work orders still make. */
  closedLines: CloseLinesAnswer | null
  /** Copy as new quote just ran: the new quote and what it left out. */
  copied: CopyAnswer | null
  /** Design cases: what the panels show (the page mounts the live panels instead). */
  panelsPreview?: RecordPanelsViewModel
  /** Design cases: what a dialog holds typed. */
  draft?: { date?: string; reason?: string; lineIds?: string[]; scope?: 'order' | 'lines'; amount?: string; reference?: string; receivedOn?: string; issue?: boolean; message?: string; typed?: string }
}

export interface PaymentInput {
  amount: number
  receivedOn: string
  reference: string
  note: string
  issue: boolean
}

export interface OrderRecordActions {
  onRetry?: () => void
  onRetryPart?: (part: 'workOrders' | 'settlement' | 'sdi' | 'versions' | 'schedule' | 'amendments' | 'cancelCheck') => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onPromise?: (input: { date: string; reason: string; lineIds: string[] | null }) => void
  onReady?: (reason: string) => void
  onClose?: (reason: string | null) => void
  onSendLink?: (requestId: string, message: string) => void
  onRecordPayment?: (requestId: string, input: PaymentInput) => void
  onSendSdi?: (invoiceId: string) => void
  onSizeLayer?: (layer: SizeLayer) => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  // ---- B-W2a-50 ----------------------------------------------------------------------------------------------------------
  onAmendStart?: () => void
  onAmendDiscard?: () => void
  onAmendCells?: (styleId: string, next: Record<string, Record<string, number>>) => void
  onAmendPrice?: (key: string, text: string) => void
  onAmendHeader?: (field: 'customerRef' | 'requestedDate', value: string) => void
  onAmendReview?: () => void
  onAmendApply?: (reason: string) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
  onCloseLines?: (lineIds: string[], reason: string) => void
  onReopenLines?: (lineIds: string[], reason: string) => void
  onCancelOrder?: (reason: string, typed: string) => void
  onCopyAsQuote?: () => void
}

/** The lines editor's own actions (the amendment and the typed New order share it). */
export interface EditorActions {
  onCells?: (styleId: string, next: Record<string, Record<string, number>>) => void
  onPrice?: (key: string, text: string) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
}
