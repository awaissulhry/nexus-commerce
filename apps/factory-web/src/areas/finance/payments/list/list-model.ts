import type { CustomerRow, OpenItem, Payment, PaymentRow } from '../../_shared/api'
import type { LiveState, StepUpState } from '../../_shared/hooks'
import type { FinanceAbilities, Phrase } from '../../_shared/model'
import type { OpenRefunds, Refund, ToRefund } from '../refunds/api'
import type { RefundAbilities, RefundDraft, RefundMove, RefundRows, RefundTarget } from '../refunds/model'
import type { RefundDialogModel } from '../refunds/view/RefundDialogs'
import type { RefundsListModel } from '../refunds/view/RefundsList'

/** SCR-082 — the payments page's view model (PaymentsListView draws it and fetches nothing). */

/** B-W2a-80: `refunds` (design "Rows ▾: … Refunds") shows the refunds and what is to refund in place of the payments. */
export const PAYMENT_ROWS_VIEWS = ['all', 'received', 'voided', 'refunds'] as const
export type PaymentRowsView = (typeof PAYMENT_ROWS_VIEWS)[number]

/** The customer a payment is recorded for, in the company it is recorded in. */
export interface PickedCustomer {
  id: string
  name: string
  companyId: string
}

/** "Record a payment": who paid (step 1), then where it goes (step 2), then what was recorded. */
export interface RecordDialogState {
  kind: 'record'
  step: 1 | 2
  customer: PickedCustomer | null
  /** Opened from an invoice ("Record payment"): that invoice is chosen in step 2. */
  invoiceId: string | null
}

export interface RecordedPayment {
  payment: Payment
  /** A deposit paid in full with its TD02 issued now (or not: why). */
  depositInvoice: { required: boolean; number: string | null; filesPending: boolean } | null
}

export interface PaymentsListModel {
  /** `/w/<company>`. */
  prefix: string
  can: FinanceAbilities
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  /** The company a new payment is recorded in (the address's). */
  companyId: string | null
  rows: PaymentRowsView
  list: { items: PaymentRow[] | null; more: boolean; problem: string | null }
  /** Money in this month and what is not placed yet, from the latest 200 payments; null while unread or failed. */
  tiles: { monthCount: number; monthAmount: number | null; notPlacedCount: number; notPlacedAmount: number | null; capped: boolean } | null
  asOf: string | null
  live: LiveState
  updates: number
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  dialog: RecordDialogState | null
  /** B-W2a-80: who may refund; the tile "Refunds to make"; the refunds rows (`?rows=refunds&refunds=`); the Refund dialog and a refund's move. */
  refundCan?: RefundAbilities
  openRefunds?: OpenRefunds | null
  refunds?: RefundsListModel | null
  refundDialog?: RefundDialogModel | null
  refundMove?: { refund: Refund; move: RefundMove; busy: boolean; problem: Phrase | null; start?: { reference?: string; reason?: string } } | null
  /** Step 1's customer search. */
  customers: { q: string; items: CustomerRow[] | null; problem: string | null }
  /** Step 2's open items of the chosen customer, oldest first. */
  items: { value: OpenItem[] | null; problem: string | null }
  recorded: RecordedPayment | null
  busy: boolean
  dialogProblem: Phrase | null
  stepUp: StepUpState
  /** Design cases: the starting selection, the keys panel, what the dialog holds typed. */
  selected?: string[]
  helpOpen?: boolean
  draft?: { amount?: string; receivedOn?: string; reference?: string; plan?: Record<string, string>; issue?: boolean }
}

export interface RecordInput {
  customer: PickedCustomer
  amount: number
  receivedOn: string
  reference: string
  note: string
  /** Minor units by open item id. */
  plan: Record<string, number>
  /** One deposit request paid in full: issue its TD02 now. */
  issueDepositInvoice: boolean
}

export interface PaymentsListActions {
  onRows?: (rows: PaymentRowsView) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onDialog?: (dialog: RecordDialogState | null) => void
  onSearchCustomers?: (q: string) => void
  onPickCustomer?: (customer: PickedCustomer) => void
  onRetryItems?: () => void
  onRecord?: (input: RecordInput) => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  /** B-W2a-80: the refunds. */
  onRefundRows?: (rows: RefundRows) => void
  onRefundMore?: () => void
  onRetryRefunds?: () => void
  onOpenRefund?: (note: ToRefund | null) => void
  onRecordRefund?: (target: RefundTarget, draft: RefundDraft) => void
  onCloseRefund?: () => void
  onMoveRefund?: (refund: Refund, move: RefundMove) => void
  onDoMove?: (input: { paidOn: string; reference: string; reason: string }) => void
  onCloseMove?: () => void
  onExportRefunds?: (ids: string[]) => void
}
