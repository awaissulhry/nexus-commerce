import type { Issue } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { amountText } from '../../invoicing/invoices'
import type { WriteOffKind, WriteOffRefusal } from '../write-offs/write-offs'
import type { ItemKind } from './match'

/**
 * Accepting a match of money in (B-W2b-393; FIN-132, FIN-119), pure: how the line's money is placed on the items it pays
 * and what difference is left. The items in the order given (oldest first, the matcher's order) each take what is open on
 * them, unless the person typed an amount (a split); what the line has left after them stays on the payment (the
 * customer's credit balance) — an OVERPAYMENT; what it could not cover is left open on the items — an UNDERPAYMENT when
 * it is ONE invoice (the last one placed) and nothing else is short. Either may be written off when it is within the
 * company's tolerance and the person asks (write-offs).
 */

export interface LineItem {
  readonly kind: ItemKind
  readonly id: string
  /** What is still open on it. */
  readonly open: MinorUnits
  /** The amount the person typed for it (a split); absent: what fits. */
  readonly amount?: MinorUnits | undefined
  /** The item in words for messages ("invoice FT-2026-00001"). */
  readonly label: string
  /** Where it came from in the request, for its issues. */
  readonly path: string
}

export interface LinePlan {
  readonly allocations: readonly { readonly kind: ItemKind; readonly id: string; readonly amount: MinorUnits }[]
  /** What the line keeps after the items: the payment's unplaced part. */
  readonly leftover: MinorUnits
  /** The items left short (open after the plan, above 0). */
  readonly short: readonly { readonly kind: ItemKind; readonly id: string; readonly amount: MinorUnits }[]
  readonly issues: readonly Issue[]
}

/** Places a line's amount on its items (see above). An item with nothing open, or a typed amount past a cap, is an issue. */
export function planLine(amount: MinorUnits, items: readonly LineItem[], currency: string): LinePlan {
  let left = amount
  const issues: Issue[] = []
  const allocations: { kind: ItemKind; id: string; amount: MinorUnits }[] = []
  const short: { kind: ItemKind; id: string; amount: MinorUnits }[] = []
  for (const item of items) {
    if (item.open <= 0) {
      issues.push({ path: item.path, message: `The ${item.label} has nothing left to pay.` })
      continue
    }
    let take: number
    if (item.amount !== undefined) {
      if (!Number.isSafeInteger(item.amount) || item.amount <= 0) {
        issues.push({ path: `${item.path}/amount`, message: 'An amount above 0, in minor units (cents).' })
        continue
      }
      if (item.amount > item.open) {
        issues.push({ path: `${item.path}/amount`, message: `The ${item.label} is open for ${amountText(item.open, currency)} only; place at most that.` })
        continue
      }
      if (item.amount > left) {
        issues.push({ path: `${item.path}/amount`, message: `The line has ${amountText(left, currency)} left to place; place at most that.` })
        continue
      }
      take = item.amount
    } else take = Math.min(item.open, left)
    if (take > 0) {
      allocations.push({ kind: item.kind, id: item.id, amount: take })
      left -= take
    }
    if (item.open - take > 0) short.push({ kind: item.kind, id: item.id, amount: item.open - take })
  }
  return { allocations, leftover: left, short, issues }
}

export interface LineDifference {
  readonly kind: WriteOffKind | null
  readonly amount: MinorUnits
  /** UNDERPAYMENT: the invoice left short. */
  readonly invoiceId: string | null
  /** Why it cannot be written off as it stands (null: it can, or there is no difference). */
  readonly refusal: WriteOffRefusal | null
}

/** The difference a plan leaves, and whether it may be written off against the tolerance. */
export function differenceOf(plan: Pick<LinePlan, 'allocations' | 'leftover' | 'short'>, tolerance: MinorUnits | null): LineDifference {
  if (plan.leftover > 0) {
    // Money left over while items stay short: the person placed less on purpose (a split); the leftover is the difference.
    return { kind: 'OVERPAYMENT', amount: plan.leftover, invoiceId: null, refusal: tolerance === null ? 'NO_TOLERANCE' : plan.leftover > tolerance ? 'OVER_TOLERANCE' : null }
  }
  if (plan.short.length === 0) return { kind: null, amount: 0, invoiceId: null, refusal: null }
  const total = plan.short.reduce((sum, item) => sum + item.amount, 0)
  if (plan.short.length > 1) return { kind: 'UNDERPAYMENT', amount: total, invoiceId: null, refusal: 'SHORT_ON_SEVERAL' }
  const [only] = plan.short
  if (only!.kind === 'DEPOSIT_REQUEST') return { kind: 'UNDERPAYMENT', amount: total, invoiceId: null, refusal: 'SHORT_ON_DEPOSIT' }
  // An UNDERPAYMENT closes what an allocation left open: an invoice the line placed nothing on is not short-paid, unpaid.
  if (!plan.allocations.some((allocation) => allocation.id === only!.id)) return { kind: 'UNDERPAYMENT', amount: total, invoiceId: null, refusal: 'NOT_AN_INVOICE_ALLOCATION' }
  return { kind: 'UNDERPAYMENT', amount: total, invoiceId: only!.id, refusal: tolerance === null ? 'NO_TOLERANCE' : total > tolerance ? 'OVER_TOLERANCE' : null }
}
