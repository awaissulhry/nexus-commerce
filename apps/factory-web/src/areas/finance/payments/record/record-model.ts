import type { OpenItem, Payment } from '../../_shared/api'
import type { LiveState } from '../../_shared/hooks'
import type { FinanceAbilities, Phrase } from '../../_shared/model'
import type { Loaded } from '../../invoices/record/record-model'

/** SCR-082 — the payment record's view model (PaymentRecordView draws it and fetches nothing). */

export const PAYMENT_TABS = ['allocation', 'bank'] as const
export type PaymentTab = (typeof PAYMENT_TABS)[number]
export const paymentTabOf = (value: string | null | undefined): PaymentTab => ((PAYMENT_TABS as readonly string[]).includes(value ?? '') ? (value as PaymentTab) : 'allocation')

export type PaymentDialog = { kind: 'place' } | { kind: 'reverse'; allocationId: string } | { kind: 'void' }

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
  /** Design cases: what a dialog holds typed. */
  draft?: { plan?: Record<string, string>; note?: string }
}

export interface PaymentRecordActions {
  onRetry?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: PaymentDialog | null) => void
  onRetryItems?: () => void
  onPlace?: (plan: Record<string, number>) => void
  onReverse?: (allocationId: string, note: string) => void
  onVoid?: (reason: string) => void
}
