import type { BusinessDate } from '../../core/time'
import type { MilestoneKind, MilestoneStatus } from './schedule'

/**
 * An order's money plan (order money tab, B-OM-004; 13-backend §1, §3): its payment steps and the deposit requests behind them,
 * read as ONE plan, pure.
 *
 *   coverage      an ON_DELIVERY / ON_INVOICE step has no request: it falls due with the goods' invoice. The money paid on
 *                 the order's goods invoices (less refunds, plus the small differences written off on them) is given out to
 *                 those OPEN steps in seq order; a step covered in full reads "Paid with the invoices" (`settledBy`
 *                 INVOICES). Derived, never written: the database's step stays OPEN.
 *   overdue       the OPEN steps whose due day passed (the business day, Europe/Rome), less what is paid on them so far
 *                 (their request's payments) and what the invoices cover.
 *   by hand       every hand change of the plan writes ONE audit row `orders.planByHand` on the SalesOrder (PR S2) whose
 *                 `after` names the act, the steps and the requests it touched, and each request it replaced: the read
 *                 tags those steps and requests "Set by hand" from the newest row naming them (no column).
 *   undo          whether a payment on a deposit request may be undone here (reversed, and voided when it then pays
 *                 nothing): held in words (EN/IT) by the request's or the payment's state; no door without the rights.
 */

export interface Words {
  readonly en: string
  readonly it: string
}

// ---- by hand ---------------------------------------------------------------------------------------------------------------

/** The audit action of every hand change of an order's money plan (written by PR S2's POST …/money-plan). */
export const PLAN_BY_HAND_ACTION = 'orders.planByHand'

/** The hand acts on an order's money plan (PR S2; 13-backend §3). */
export const MONEY_PLAN_ACTS = ['REPLACE_DEPOSIT', 'MOVE_DUE', 'ASK_AGAIN', 'ADD_STEP', 'CHANGE_STEP', 'REMOVE_STEP', 'RENAME_STEP', 'UNDO_OPEN', 'CHANGE_TERMS', 'ACCEPT_SHORT'] as const
export type MoneyPlanAct = (typeof MONEY_PLAN_ACTS)[number]

/** What a planByHand audit row names (its `after`): the act, the steps and requests it touched, each request it replaced. */
export interface PlanByHandMark {
  readonly act: MoneyPlanAct
  readonly milestoneIds: readonly string[]
  readonly depositRequestIds: readonly string[]
  /** A request made in place of another (REPLACE_DEPOSIT, ASK_AGAIN, a changed advance): `from` → `to`. */
  readonly replacements: readonly { readonly from: string; readonly to: string }[]
  /** ACCEPT_SHORT: why the short part was accepted. */
  readonly why: string | null
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/** A planByHand audit row's `after` read back; null when it is not one (an unknown act, not an object). */
export function planByHandMarkOf(after: unknown): PlanByHandMark | null {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return null
  const row = after as Record<string, unknown>
  const act = row.act
  if (typeof act !== 'string' || !(MONEY_PLAN_ACTS as readonly string[]).includes(act)) return null
  const replacements = Array.isArray(row.replacements)
    ? row.replacements.flatMap((entry) => {
        const pair = entry as Record<string, unknown> | null
        return pair && typeof pair.from === 'string' && typeof pair.to === 'string' ? [{ from: pair.from, to: pair.to }] : []
      })
    : []
  return { act: act as MoneyPlanAct, milestoneIds: strings(row.milestoneIds), depositRequestIds: strings(row.depositRequestIds), replacements, why: typeof row.why === 'string' ? row.why : null }
}

// ---- coverage and overdue --------------------------------------------------------------------------------------------------

/** The steps that fall due with the goods' invoice (no request of their own). */
export const INVOICE_STEP_KINDS = ['ON_DELIVERY', 'ON_INVOICE'] as const satisfies readonly MilestoneKind[]
export const isInvoiceStep = (kind: MilestoneKind): boolean => (INVOICE_STEP_KINDS as readonly MilestoneKind[]).includes(kind)

export interface PlanStep {
  readonly id: string
  readonly seq: number
  readonly kind: MilestoneKind
  readonly status: MilestoneStatus
  readonly amount: number
  readonly dueDate: BusinessDate | null
  /** What payments placed on its request so far (null: it has no request). */
  readonly paidSoFar: number | null
}

/**
 * What the goods' invoices cover of each OPEN ON_DELIVERY / ON_INVOICE step: `goodsMoney` (paid on the order's goods invoices,
 * less refunds, plus what is written off on them) given out in seq order, each step at most its amount. Others: absent (0).
 */
export function coverageOf(steps: readonly PlanStep[], goodsMoney: number): Map<string, number> {
  const out = new Map<string, number>()
  let left = Math.max(0, goodsMoney)
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (step.status !== 'OPEN' || !isInvoiceStep(step.kind)) continue
    const covered = Math.min(Math.max(0, step.amount), left)
    out.set(step.id, covered)
    left -= covered
  }
  return out
}

export type SettledBy = 'PAYMENT' | 'INVOICES'

/** How a step is settled: PAID (its request paid), the goods' invoices cover an ON_* step in full, or not yet (null). */
export function settledByOf(step: Pick<PlanStep, 'kind' | 'status' | 'amount'>, covered: number): SettledBy | null {
  if (step.status === 'PAID') return 'PAYMENT'
  if (step.status === 'OPEN' && isInvoiceStep(step.kind) && step.amount > 0 && covered >= step.amount) return 'INVOICES'
  return null
}

/** What of the OPEN steps is past due on `today`: each step's amount less what is paid on it so far and what invoices cover. */
export function overdueOf(steps: readonly PlanStep[], coverage: ReadonlyMap<string, number>, today: BusinessDate): number {
  return steps.reduce((sum, step) => {
    if (step.status !== 'OPEN' || step.dueDate === null || step.dueDate >= today) return sum
    return sum + Math.max(0, step.amount - (step.paidSoFar ?? 0) - (coverage.get(step.id) ?? 0))
  }, 0)
}

// ---- undo a payment --------------------------------------------------------------------------------------------------------

/** Why a payment on a deposit request is not undone here (PR S2's POST /payments/:paymentId/undo refuses the same). */
export const UNDO_HELD = ['CARRIED', 'PAID', 'DEPOSIT_INVOICE_ISSUED', 'DEPOSIT_INVOICE_DRAFT', 'WRITE_OFF', 'HARD_LOCKED'] as const
export type UndoHeld = (typeof UNDO_HELD)[number]

export const UNDO_HELD_WORDS: Readonly<Record<UndoHeld, Words>> = Object.freeze({
  CARRIED: {
    en: "This deposit issues no deposit invoice and is paid: its money is carried onto the order's invoice, not undone.",
    it: "Questo acconto non emette fattura d'acconto ed è pagato: il suo importo passa sulla fattura dell'ordine, non si annulla.",
  },
  PAID: {
    en: 'This deposit is paid in full: its payments stay (a refund is a credit note and a refund, in Finance).',
    it: 'Questo acconto è pagato per intero: i suoi pagamenti restano (un rimborso è una nota di credito e un rimborso, in Finanza).',
  },
  DEPOSIT_INVOICE_ISSUED: {
    en: 'A deposit invoice was issued for this deposit: a credit note first, in Finance.',
    it: "Per questo acconto è stata emessa una fattura d'acconto: prima una nota di credito, in Finanza.",
  },
  DEPOSIT_INVOICE_DRAFT: {
    en: 'A deposit invoice draft is made for this deposit: delete the draft in Finance first.',
    it: "C'è una bozza di fattura d'acconto per questo acconto: prima elimina la bozza in Finanza.",
  },
  WRITE_OFF: {
    en: 'A small difference is written off on this payment: take the write-off back in Finance first.',
    it: 'Su questo pagamento è abbuonata una piccola differenza: prima annulla l’abbuono in Finanza.',
  },
  HARD_LOCKED: {
    en: "This payment's month is closed for good: it is not undone.",
    it: 'Il mese di questo pagamento è chiuso definitivamente: non si annulla.',
  },
})

export interface UndoFacts {
  /** The reader holds payments.record AND payments.void over the order (else no door at all). */
  readonly mayAct: boolean
  readonly request: { readonly status: string; readonly fiscalDocument: 'TD02' | 'NONE' }
  /** A TD02 of the request issued (not a draft, not rejected) and not credited in full. */
  readonly depositInvoiceIssued: boolean
  /** A TD02 draft of the request. */
  readonly depositInvoiceDraft: boolean
  /** A write-off still standing on the payment. */
  readonly writeOffStanding: boolean
  /** The payment's day is inside a HARD period lock. */
  readonly hardLocked: boolean
}

export interface UndoVerdict {
  readonly may: boolean
  /** Why not, in words; null when it may, or when the reader has no right (the screen hides the door). */
  readonly why: Words | null
  readonly code: UndoHeld | null
}

/** Whether a payment on a deposit request may be undone here, and why not (the first reason, in this order). */
export function undoVerdictOf(facts: UndoFacts): UndoVerdict {
  if (!facts.mayAct) return { may: false, why: null, code: null }
  const held = (code: UndoHeld): UndoVerdict => ({ may: false, why: UNDO_HELD_WORDS[code], code })
  if (facts.request.status === 'PAID' && facts.request.fiscalDocument === 'NONE') return held('CARRIED')
  if (facts.request.status === 'PAID') return held('PAID')
  if (facts.depositInvoiceIssued) return held('DEPOSIT_INVOICE_ISSUED')
  if (facts.depositInvoiceDraft) return held('DEPOSIT_INVOICE_DRAFT')
  if (facts.writeOffStanding) return held('WRITE_OFF')
  if (facts.hardLocked) return held('HARD_LOCKED')
  return { may: true, why: null, code: null }
}
