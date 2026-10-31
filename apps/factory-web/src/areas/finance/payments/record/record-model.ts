import type { OpenItem, Payment } from '../../_shared/api'
import type { LiveState } from '../../_shared/hooks'
import type { FinanceAbilities, Phrase } from '../../_shared/model'
import type { Loaded, Part } from '../../invoices/record/record-model'
import type { Refund } from '../refunds/api'
import type { RefundAbilities, RefundDraft, RefundMove, RefundTarget } from '../refunds/model'

/** SCR-082 — the payment record's view model (PaymentRecordView draws it and fetches nothing). */

export const PAYMENT_TABS = ['allocation', 'bank'] as const
export type PaymentTab = (typeof PAYMENT_TABS)[number]
export const paymentTabOf = (value: string | null | undefined): PaymentTab => ((PAYMENT_TABS as readonly string[]).includes(value ?? '') ? (value as PaymentTab) : 'allocation')

export type PaymentDialog =
  | { kind: 'place' }
  | { kind: 'reverse'; allocationId: string }
  | { kind: 'void' }
  /** B-W2a-80: refund the payment's credit balance (what is not placed); a move of one of its refunds. */
  | { kind: 'refund' }
  | { kind: 'refundMove'; refund: Refund; move: RefundMove }

export interface PaymentRecordModel {
  prefix: string
  can: FinanceAbilities
  today: string
  tab: PaymentTab
  payment: Loaded<Payment>
  /** "Place the rest": the customer's open items (read when the dialog opens). */
  items: { value: OpenItem[] | null; problem: string | null }
  live: LiveState
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  busy: boolean
  dialog: PaymentDialog | null
  dialogProblem: Phrase | null
  /** B-W2a-80: who may refund; the customer's credit balance in the payment's currency (read with the open items); its refunds. */
  refundCan?: RefundAbilities
  creditBalance?: number | null
  refunds?: Part<Refund[]> | null
  /** Design cases: what a dialog holds typed. */
  draft?: { plan?: Record<string, string>; note?: string; refund?: Partial<RefundDraft> }
}

export interface PaymentRecordActions {
  onRetry?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: PaymentDialog | null) => void
  onRetryItems?: () => void
  onPlace?: (plan: Record<string, number>) => void
  onReverse?: (allocationId: string, note: string) => void
  onVoid?: (reason: string) => void
  /** B-W2a-80: a refund of the credit balance; a move of one of its refunds. */
  onRefund?: (target: RefundTarget, draft: RefundDraft) => void
  onRefundMove?: (refund: Refund, move: RefundMove, input: { paidOn: string; reference: string; reason: string }) => void
  onRetryRefunds?: () => void
}
