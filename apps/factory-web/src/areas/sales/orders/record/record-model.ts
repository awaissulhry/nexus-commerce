import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { VersionsAnswer } from '../../quotes/api'
import type { DepositLinkAnswer, DepositReceived, Order, OrderWorkOrder, SdiStatus, Settlement } from '../api'
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
  /** Design cases: what the panels show (the page mounts the live panels instead). */
  panelsPreview?: RecordPanelsViewModel
  /** Design cases: what a dialog holds typed. */
  draft?: { date?: string; reason?: string; lineIds?: string[]; scope?: 'order' | 'lines'; amount?: string; reference?: string; receivedOn?: string; issue?: boolean; message?: string }
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
  onRetryPart?: (part: 'workOrders' | 'settlement' | 'sdi' | 'versions') => void
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
}
