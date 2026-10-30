import type { CurrencyCode, MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec, HUNDRED, ZERO, type Decimal } from '../../tax/decimal'
import type { CustomerTaxProfile } from '../../tax/vat-treatment'
import { depositFiscalOf, type DepositDraft } from '../deposits/deposits'
import { addDays } from '../quotes/quotes'
import { splitByShare, type Instalment, type InstalmentEvent } from '../terms/terms'

/**
 * An order's payment schedule (B-W2a-30; SAL-216; the design's order.money.schedule "Deposit and balance milestones
 * with their state"), pure: what of the order's gross total falls due when, made from the payment terms it was sold
 * with (factory-db SalesOrder.paymentTermsId, pricing.prisma PaymentTerms.instalments) and the deposit it asked
 * (its DepositRequest). apps/factory-api's modules/sales/orders writes the steps (SalesOrderMilestone) when the order is
 * made (at acceptance or typed by the office) and makes the OPEN ones again after an amendment.
 *
 *   DEPOSIT          the deposit request's own amount and due date (the request is the deposit: a PAID request makes
 *                    the step PAID)
 *   BEFORE_SHIPPING  an instalment "before shipping": due the promise date less its days, once the order has a promise
 *   ON_DELIVERY      an instalment "on delivery": due when the goods arrive (no day yet)
 *   ON_INVOICE       an instalment on the invoice's terms (its due day comes with the invoice)
 *
 * The deposit may differ from the terms' order share (the customer's own percentage, typed on the quote): the rest of
 * the gross is shared among the terms' other instalments in their own proportions. Terms that ask nothing before the
 * invoice, and an order without terms or deposit, have no schedule: "paid on invoice terms; no milestones" (the
 * design's empty state). Amounts are VAT included, in minor units; the last part takes the rounding.
 *
 * B-W2a-F2: a step paid before the goods leave is an advance (DPR 633/1972 art. 6 c.4: the supply happens at the
 * payment, for the amount paid), invoiced with a deposit invoice (TD02) that the goods' invoice deducts. The money
 * module invoices a payment only through the deposit request it is allocated to, so the DEPOSIT step and each
 * BEFORE_SHIPPING step name their own request (ADVANCE_STEP_KINDS; `stepRequestFor` is a before-shipping step's,
 * asked for the step's amount and due on its day). ON_DELIVERY and ON_INVOICE steps fall due with the goods' invoice.
 */

export const MILESTONE_KINDS = ['DEPOSIT', 'BEFORE_SHIPPING', 'ON_DELIVERY', 'ON_INVOICE'] as const
export type MilestoneKind = (typeof MILESTONE_KINDS)[number]
export const MILESTONE_STATUSES = ['OPEN', 'PAID', 'WAIVED', 'CANCELLED'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

/** The step an instalment of the terms becomes. */
export const MILESTONE_OF: Readonly<Record<InstalmentEvent, MilestoneKind>> = Object.freeze({
  ORDER: 'DEPOSIT',
  BEFORE_SHIPPING: 'BEFORE_SHIPPING',
  DELIVERY: 'ON_DELIVERY',
  INVOICE: 'ON_INVOICE',
})

/** The steps paid through a deposit request of their own (invoiced as an advance, TD02, when paid before the goods leave). */
export const ADVANCE_STEP_KINDS = ['DEPOSIT', 'BEFORE_SHIPPING'] as const satisfies readonly MilestoneKind[]
export type AdvanceStepKind = (typeof ADVANCE_STEP_KINDS)[number]
export const isAdvanceStep = (kind: MilestoneKind): kind is AdvanceStepKind => (ADVANCE_STEP_KINDS as readonly MilestoneKind[]).includes(kind)

export const MILESTONE_WORDS: Readonly<Record<MilestoneKind, string>> = Object.freeze({
  DEPOSIT: 'Deposit on the order',
  BEFORE_SHIPPING: 'Before shipping',
  ON_DELIVERY: 'On delivery',
  ON_INVOICE: 'On the invoice',
})

/** The order's deposit, as its request asks it. */
export interface ScheduleDeposit {
  readonly requestId: string
  readonly amount: MinorUnits
  readonly dueDate: BusinessDate
  /** The request's percentage of the gross, when it has one. */
  readonly sharePct: string | null
}

export interface ScheduleInput {
  /** The order's gross total, VAT included, in minor units. */
  readonly gross: MinorUnits
  /** The terms' instalments; null: the order names no library terms. */
  readonly instalments: readonly Instalment[] | null
  readonly deposit: ScheduleDeposit | null
  /** The order's promise date (a BEFORE_SHIPPING step falls due its days before it). */
  readonly promiseDate: BusinessDate | null
}

/** One step as it is written (SalesOrderMilestone). */
export interface PlannedMilestone {
  readonly seq: number
  readonly kind: MilestoneKind
  /** Percent of the gross it stands for, 4 places (above 0, at most 100); null when it is not a share. */
  readonly sharePct: string | null
  readonly amount: MinorUnits
  readonly dueDate: BusinessDate | null
  readonly depositRequestId: string | null
}

const pct = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
const shareOf = (amount: MinorUnits, gross: MinorUnits): string | null => {
  if (gross <= 0 || amount <= 0) return null
  const value = new Dec(amount).times(HUNDRED).dividedBy(gross)
  return value.gt(ZERO) && value.lte(HUNDRED) ? pct(value) : null
}

/** The terms' instalments after the order (everything but the deposit on the order). */
const laterInstalments = (instalments: readonly Instalment[] | null): Instalment[] => (instalments ?? []).filter((item) => item.from !== 'ORDER')

/** A BEFORE_SHIPPING step's due day: its days before the promise (null without a promise). */
function dueOf(kind: MilestoneKind, item: Pick<Instalment, 'days'> | null, promiseDate: BusinessDate | null): BusinessDate | null {
  if (kind !== 'BEFORE_SHIPPING' || promiseDate === null) return null
  return addDays(promiseDate, -(item?.days ?? 0))
}

/**
 * The steps that share `amount` among the instalments (their proportions), from `seq` on; an amount with no instalment
 * to share it falls due on the invoice. Steps of 0 are left out (a step is above 0).
 */
function share(amount: MinorUnits, gross: MinorUnits, instalments: readonly Instalment[], promiseDate: BusinessDate | null, seq: number): PlannedMilestone[] {
  if (amount <= 0) return []
  if (instalments.length === 0) return [{ seq, kind: 'ON_INVOICE', sharePct: shareOf(amount, gross), amount, dueDate: null, depositRequestId: null }]
  const parts = splitByShare(amount, instalments.map((item) => item.sharePct))
  const steps: PlannedMilestone[] = []
  instalments.forEach((item, index) => {
    const part = parts[index]!
    if (part <= 0) return
    const kind = MILESTONE_OF[item.from]
    steps.push({ seq: seq + steps.length * 10, kind, sharePct: shareOf(part, gross), amount: part, dueDate: dueOf(kind, item, promiseDate), depositRequestId: null })
  })
  return steps
}

/**
 * The schedule of an order (made with it): the deposit step (its request), then the rest of the gross over the terms'
 * later instalments. Empty when nothing falls due before the invoice: no deposit and terms (or none) that ask only on
 * the invoice.
 */
export function paymentScheduleOf(input: ScheduleInput): PlannedMilestone[] {
  const later = laterInstalments(input.instalments)
  const deposit = input.deposit !== null && input.deposit.amount > 0 ? input.deposit : null
  const beforeInvoice = later.some((item) => item.from !== 'INVOICE')
  if (deposit === null && !beforeInvoice) return []
  const steps: PlannedMilestone[] = []
  if (deposit) {
    steps.push({ seq: 10, kind: 'DEPOSIT', sharePct: deposit.sharePct ?? shareOf(deposit.amount, input.gross), amount: Math.min(deposit.amount, input.gross), dueDate: deposit.dueDate, depositRequestId: deposit.requestId })
  }
  const rest = input.gross - (deposit ? Math.min(deposit.amount, input.gross) : 0)
  return [...steps, ...share(rest, input.gross, later, input.promiseDate, (steps.length + 1) * 10)]
}

/** A step as it stands (SalesOrderMilestone). */
export interface StoredMilestone {
  readonly id: string
  readonly seq: number
  readonly kind: MilestoneKind
  readonly status: MilestoneStatus
  readonly amount: MinorUnits
  readonly dueDate: BusinessDate | null
  readonly depositRequestId: string | null
  /** B-W2a-F2: what the payments placed on its deposit request so far (allocations less reversals); 0 or absent: none. */
  readonly requestPaid?: MinorUnits | undefined
}

// ---- a before-shipping step's deposit request (B-W2a-F2) ------------------------------------------------------------

/** The deposit request of a before-shipping step: an ACCONTO, its percent the step's share (null when it has none). */
export type StepRequestDraft = Omit<DepositDraft, 'depositPct'> & { readonly depositPct: string | null }

/**
 * The deposit request a BEFORE_SHIPPING step asks (B-W2a-F2): an advance on the price (ACCONTO) of the step's amount,
 * due on the step's day, with the fiscal decision of the VAT rules for the customer now (sales/deposits
 * `depositFiscalOf`, the deposit's own rule: TD02 when the rule says so, NONE for an EU business buying goods with a
 * VIES proof). Null for another kind of step, a step of nothing, or a step without a day yet (its order had no promise
 * date: the office gives the day when it opens the step).
 */
export function stepRequestFor(step: Pick<PlannedMilestone, 'kind' | 'amount' | 'sharePct' | 'dueDate'>, currency: CurrencyCode, profile: CustomerTaxProfile | null): StepRequestDraft | null {
  if (step.kind !== 'BEFORE_SHIPPING' || step.amount <= 0 || step.dueDate === null) return null
  return { kind: 'ACCONTO', depositPct: step.sharePct, currency, amount: step.amount, dueDate: step.dueDate, ...depositFiscalOf('ACCONTO', profile) }
}

/**
 * Whether an OPEN step stays as it is when the schedule is made again: the deposit step (its request is what the
 * customer accepted), and a before-shipping step whose request has money on it already (part paid: its TD02s name it;
 * B-W2a-F2). Any other OPEN step is cancelled and shared again (its unpaid request is cancelled with it).
 */
export const stepStays = (step: Pick<StoredMilestone, 'kind' | 'status' | 'depositRequestId' | 'requestPaid'>): boolean =>
  step.status !== 'OPEN' || step.kind === 'DEPOSIT' || (step.kind === 'BEFORE_SHIPPING' && step.depositRequestId !== null && (step.requestPaid ?? 0) > 0)

export interface RemadeSchedule {
  /** The OPEN steps cancelled (never deleted: their statusNote says why). */
  readonly cancel: readonly string[]
  /** The new OPEN steps, numbered after the last one. */
  readonly insert: readonly PlannedMilestone[]
  /** What the steps that stay (paid, waived, the deposit's) already cover beyond the new gross; 0 when they do not. */
  readonly overpaid: MinorUnits
}

const sameStep = (a: Pick<PlannedMilestone, 'kind' | 'amount' | 'dueDate'>, b: Pick<StoredMilestone, 'kind' | 'amount' | 'dueDate'>): boolean => a.kind === b.kind && a.amount === b.amount && a.dueDate === b.dueDate

/**
 * After an amendment (SAL-217 → SAL-216): the schedule of the new gross. Steps that are no longer OPEN (paid, waived)
 * stay, and so does the OPEN deposit step (its request's amount is what the customer accepted and does not change) and
 * an OPEN before-shipping step already part paid (`stepStays`, B-W2a-F2); the other OPEN steps are cancelled and the
 * rest of the new gross is shared again among the terms' instalments whose step is not settled yet (none left: on the
 * invoice). An order without a schedule keeps none; an unchanged plan changes nothing.
 */
export function remadeSchedule(existing: readonly StoredMilestone[], input: Omit<ScheduleInput, 'deposit'>): RemadeSchedule {
  const live = [...existing].sort((a, b) => a.seq - b.seq).filter((step) => step.status !== 'CANCELLED')
  if (live.length === 0) return { cancel: [], insert: [], overpaid: 0 }
  const kept = live.filter(stepStays)
  const open = live.filter((step) => !stepStays(step))
  const covered = kept.reduce((total, step) => total + step.amount, 0)
  const settledKinds = new Set(kept.map((step) => step.kind))
  const later = laterInstalments(input.instalments).filter((item) => !settledKinds.has(MILESTONE_OF[item.from]))
  const nextSeq = Math.max(0, ...existing.map((step) => step.seq)) + 10
  const planned = share(Math.max(0, input.gross - covered), input.gross, later, input.promiseDate, nextSeq)
  const overpaid = Math.max(0, covered - input.gross)
  if (planned.length === open.length && planned.every((step, index) => sameStep(step, open[index]!))) return { cancel: [], insert: [], overpaid }
  return { cancel: open.map((step) => step.id), insert: planned, overpaid }
}
