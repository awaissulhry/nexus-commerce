import type { Issue } from '../core/errors'
import type { MinorUnits } from '../core/money'
import { amountText } from '../invoicing/invoices'

/**
 * Payments received (B-W1-28; FIN-121, FIN-122; Q12; plan A1 §2.4 G Payment, PaymentAllocation), pure: the bank
 * reference that makes a transfer count once, what a payment can still pay, and how much of it goes to each target.
 *
 * W1: a bank transfer typed by the office (one Payment per transfer, its bank reference unique in the company). A
 * payment is allocated to deposit requests (before any invoice exists) and to issued TD01/TD24 invoices; a TD02 is paid
 * through its deposit request, a TD04 is not paid. An allocation never passes what the payment has left, nor what the
 * target is still open for: a payment larger than what it pays keeps the rest unallocated (on account, FIN-122). A
 * wrong allocation is taken back by a reversal row (append-only ledger); a payment typed by mistake is VOIDED once its
 * allocations add up to 0. The …_money_guards triggers hold every rule for every login, under the locks payment, then
 * target.
 */

export const PAYMENT_STATUSES = ['RECEIVED', 'VOIDED'] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]
export const PAYMENT_METHODS = ['BANK_TRANSFER'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export const ALLOCATION_TARGETS = ['DEPOSIT_REQUEST', 'INVOICE'] as const
export type AllocationTarget = (typeof ALLOCATION_TARGETS)[number]

/** At most this many allocations in one request. */
export const MAX_ALLOCATIONS_PER_REQUEST = 50
export const MAX_REFERENCE = 140

/**
 * The bank's reference of a transfer (CRO / TRN) in one form, so the same transfer typed twice is found: no spaces,
 * capital letters. Null when nothing is left.
 */
export function normaliseBankReference(value: string | null | undefined): string | null {
  const compact = (value ?? '').replace(/\s+/g, '').toUpperCase()
  return compact === '' ? null : compact
}

export function bankReferenceProblem(value: string | null | undefined): string | null {
  const reference = normaliseBankReference(value)
  if (reference === null) return 'The bank reference (CRO or TRN) of the transfer is required: it makes sure a payment is never counted twice.'
  if (reference.length > MAX_REFERENCE) return `A bank reference has at most ${MAX_REFERENCE} characters.`
  if (!/^[A-Z0-9/._:-]+$/.test(reference)) return 'A bank reference holds letters, digits and / . _ : - only.'
  return null
}

/** What a target is still open for: a deposit request's amount less its allocations; an invoice's gross less credits and allocations. */
export const openOnDeposit = (amount: MinorUnits, allocated: MinorUnits): MinorUnits => Math.max(0, amount - allocated)
export const openOnInvoice = (gross: MinorUnits, credited: MinorUnits, allocated: MinorUnits): MinorUnits => Math.max(0, gross - credited - allocated)

export interface AllocationAsk {
  readonly target: AllocationTarget
  readonly targetId: string
  /** What the target is still open for, read under its lock. */
  readonly open: MinorUnits
  /** The amount asked; absent: as much as fits (the oldest first is the caller's order). */
  readonly amount?: MinorUnits | undefined
  /** Where the ask came from in the request, for its issues (`body/allocations/0`). */
  readonly path: string
  /** The target in words, for messages ("deposit request of SO-0001"). */
  readonly label: string
}

export interface AllocationPlan {
  readonly allocations: readonly { readonly target: AllocationTarget; readonly targetId: string; readonly amount: MinorUnits }[]
  /** What the payment keeps unallocated after the plan. */
  readonly left: MinorUnits
  readonly issues: readonly Issue[]
}

/**
 * Splits what a payment has left over the asks, in their order: an ask with an amount takes exactly that (refused when
 * it passes what is left or what the target is open for), an ask without one takes as much as fits (the cap: what the
 * target is open for, what the payment has left). A target with nothing open, or a payment with nothing left, is an
 * issue. The rest stays unallocated.
 */
export function planAllocations(unallocated: MinorUnits, asks: readonly AllocationAsk[], currency: string): AllocationPlan {
  let left = unallocated
  const issues: Issue[] = []
  const allocations: { target: AllocationTarget; targetId: string; amount: MinorUnits }[] = []
  for (const ask of asks) {
    if (ask.amount !== undefined) {
      if (!Number.isSafeInteger(ask.amount) || ask.amount <= 0) {
        issues.push({ path: `${ask.path}/amount`, message: 'An allocation is above 0.' })
        continue
      }
      if (ask.amount > ask.open) {
        issues.push({ path: `${ask.path}/amount`, message: `The ${ask.label} is open for ${amountText(ask.open, currency)} only; allocate at most that.` })
        continue
      }
      if (ask.amount > left) {
        issues.push({ path: `${ask.path}/amount`, message: `The payment has ${amountText(left, currency)} left to allocate; allocate at most that.` })
        continue
      }
      allocations.push({ target: ask.target, targetId: ask.targetId, amount: ask.amount })
      left -= ask.amount
      continue
    }
    if (ask.open <= 0) {
      issues.push({ path: ask.path, message: `The ${ask.label} has nothing left to pay.` })
      continue
    }
    if (left <= 0) {
      issues.push({ path: ask.path, message: 'The payment has nothing left to allocate.' })
      continue
    }
    const amount = Math.min(ask.open, left)
    allocations.push({ target: ask.target, targetId: ask.targetId, amount })
    left -= amount
  }
  return { allocations, left, issues }
}

/** Why a payment cannot be voided now (empty: it can). */
export function voidProblems(payment: { readonly status: PaymentStatus; readonly allocated: MinorUnits }): string[] {
  if (payment.status === 'VOIDED') return ['The payment is voided already.']
  if (payment.allocated !== 0) return ['The payment still pays something: reverse its allocations first, then void it.']
  return []
}
