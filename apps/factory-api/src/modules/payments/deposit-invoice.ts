import { DomainError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { depositInvoiceDecision } from '@nexus/factory-domain/invoicing/deposit'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { defineHandler, type EventHandler } from '../../platform/outbox/dispatch'
import { depositNotInvoiced, readDepositRequest } from '../invoicing/drafts'
import { issueDeposit } from './deposits'
import { lockMoney } from './locks'

/**
 * The deposit invoice (TD02) of a deposit whose payment's own command did not make it (B-W2b-F48, after B-W2b-436's bug 2;
 * B-W2b-F55; DPR 633/1972 art. 6 c.4: a payment received before the goods leave is invoiced then, for the amount paid). ONE
 * rule for every way a deposit request is paid:
 *
 *   the office      "deposit received" (deposits.ts depositReceived): the TD02 in its own command, at once (step-up)
 *   online          the worker's `payments.onlineFinished` on payment_intent.finished (online/follow-up.ts) → here
 *   a bank line     the worker's `payments.bankDepositInvoice` on bank_match.accepted of a match that recorded its payment
 *                   (accept, a person's own choice or split, Accept all High: each acceptance emits it) → here
 *   every other     B-W2b-F55: the worker's `payments.allocatedDepositInvoice` on payment.allocated to a deposit request
 *                   placed by any other command: a payment typed by hand (POST /payments with allocations:
 *                   `payments.record`; POST /payments/:id/allocations later: `payments.allocate`), the office's "deposit
 *                   received" when it made no TD02 in its command (issueDepositInvoice: false, e.g. a person without
 *                   invoices.issue), an online payment that arrived after its intent had failed or been cancelled (a late
 *                   success: no intent step runs), and any path added later → here
 *
 * They all take the same decision (factory-domain invoicing/deposit `depositInvoiceDecision`: the request's fiscal
 * document, what THIS payment placed on it, its day against the day the order's first goods left) and make the TD02 with
 * the same code (deposits.ts `issueDeposit`: the request's money lock, the series, `insertDepositDraft`, `issueInCommand`).
 * Here, in a command of its own under the request's money lock, so it can never undo the payment: the TD02 of what this
 * payment placed on the request, never more than what the request has paid and not yet invoiced (its issued TD02s less
 * their credit notes, as the office's deposit draft counts). So it is idempotent: a request whose TD02 was made already
 * (by the office, by hand through deposit-draft, by a retry or by the other path) gets no second one, and a request with a
 * DRAFT deposit invoice is left to the person drafting it. When the checks refuse (no tax identity, no series, a locked
 * month) the refusal is audited on the request (…DepositInvoiceHeld) and the office issues it (deposit-draft, then issue).
 *
 * A bank line's acceptance taken back (matching/accept.ts reverseMatch, B-W2b-406's "Take back") follows the office's
 * reversal (payments.ts reverseAllocation): a PAID request keeps its money, so its acceptance is not taken back at all; a
 * part payment's is (allocation reversed, payment voided) and the TD02 made for it STAYS ISSUED — an issued invoice never
 * changes or goes (DPR 633/1972 art. 26): a credit note is a person's decision. Until then the kept TD02 counts as
 * invoiced, so a later payment of the same request gets a TD02 only for what passes it (never two for the same money).
 * B-W2b-F55: an allocation taken back by a person (payments.ts reverseAllocation: a part payment only, a PAID request keeps
 * its) and the payment voided after it: the same — its TD02 stays ISSUED, no credit note by itself, a retry makes none.
 */

export type DepositInvoiceOutcome = 'issued' | 'held' | 'not_required' | 'exists'

/** How the deposit was paid: the intent (online), the accepted bank match, or (B-W2b-F55) an allocation placed by another command (`placedBy`). */
export type PaidThrough = { readonly kind: 'ONLINE'; readonly intentId: string } | { readonly kind: 'BANK'; readonly matchId: string } | { readonly kind: 'ALLOCATION'; readonly allocationId: string; readonly placedBy: string }

export interface DepositPaid {
  readonly paymentId: string
  readonly depositRequestId: string
  /** The day the money was received (the decision's payment day and the TD02's causale). */
  readonly paidOn: string
  readonly through: PaidThrough
}

/** The commands and audit actions of each path (the online ones as B-W2b-185 named them). */
function namesOf(through: PaidThrough, depositRequestId: string): { readonly issued: `payments.${string}`; readonly held: `payments.${string}`; readonly key: string; readonly heldKey: string; readonly input: Record<string, string>; readonly source: Record<string, string> } {
  if (through.kind === 'ONLINE') return { issued: 'payments.onlineDepositInvoice', held: 'payments.onlineDepositInvoiceHeld', key: `online-td02.${through.intentId}`, heldKey: `online-td02-held.${through.intentId}`, input: { intentId: through.intentId, depositRequestId }, source: { intentId: through.intentId } }
  // B-W2b-F55: one allocation (its event) at a time, the command that placed it named.
  if (through.kind === 'ALLOCATION') return { issued: 'payments.allocatedDepositInvoice', held: 'payments.allocatedDepositInvoiceHeld', key: `allocated-td02.${through.allocationId}`, heldKey: `allocated-td02-held.${through.allocationId}`, input: { allocationId: through.allocationId, placedBy: through.placedBy, depositRequestId }, source: { allocationId: through.allocationId, placedBy: through.placedBy } }
  return { issued: 'payments.bankDepositInvoice', held: 'payments.bankDepositInvoiceHeld', key: `bank-td02.${through.matchId}.${depositRequestId}`, heldKey: `bank-td02-held.${through.matchId}.${depositRequestId}`, input: { matchId: through.matchId, depositRequestId }, source: { matchId: through.matchId } }
}

type Owed = { readonly outcome: 'not_required' | 'exists'; readonly companyId: string } | { readonly outcome: 'owed'; readonly amount: number; readonly companyId: string }

/** What the request is owed in a TD02 for this payment (read again under the request's lock in the command). */
async function owedFor(db: CommandTx, paid: DepositPaid): Promise<Owed | null> {
  const request = await db.depositRequest.findUnique({ where: { id: paid.depositRequestId }, select: { id: true, companyId: true, fiscalDocument: true, fiscalRule: true, orderId: true } })
  if (!request) return null
  const payment = await db.payment.findUnique({ where: { id: paid.paymentId }, select: { status: true } })
  // What this payment placed on the request, its reversals counted (a taken-back acceptance places nothing).
  const placed = payment?.status === 'RECEIVED' ? ((await db.paymentAllocation.aggregate({ where: { paymentId: paid.paymentId, depositRequestId: request.id }, _sum: { amount: true } }))._sum.amount ?? 0) : 0
  const shipped = request.orderId ? await db.shipment.findFirst({ where: { salesOrderId: request.orderId, shippedAt: { not: null } }, orderBy: { shippedAt: 'asc' }, select: { shippedAt: true } }) : null
  const decision = depositInvoiceDecision({ fiscalDocument: request.fiscalDocument, fiscalRule: request.fiscalRule, paidAmount: placed, paidOn: paid.paidOn, goodsLeftOn: shipped?.shippedAt ? businessDate(shipped.shippedAt) : null })
  if (!decision.required || placed <= 0) return { outcome: 'not_required', companyId: request.companyId }
  if ((await db.invoice.count({ where: { depositRequestId: request.id, docType: 'TD02', status: 'DRAFT' } })) > 0) return { outcome: 'exists', companyId: request.companyId }
  const { paid: paidOnRequest, invoiced } = await depositNotInvoiced(db, request.id)
  const amount = Math.min(placed, paidOnRequest - invoiced)
  return amount > 0 ? { outcome: 'owed', amount, companyId: request.companyId } : { outcome: 'exists', companyId: request.companyId }
}

/** The TD02 of a deposit paid online or through an accepted bank line (see the file's comment). */
export async function depositInvoiceAfterPayment(caller: CommandCaller, paid: DepositPaid, causationId: string): Promise<DepositInvoiceOutcome | null> {
  const plan = await caller.withClient((db) => owedFor(db, paid))
  if (!plan) return null
  if (plan.outcome !== 'owed') return plan.outcome
  const names = namesOf(paid.through, paid.depositRequestId)
  try {
    const { result } = await command(caller, { name: names.issued, idempotencyKey: names.key, input: names.input, causationId }, async (tools) => {
      await lockMoney(tools.tx, tools.context, 'deposit', paid.depositRequestId)
      const now = await owedFor(tools.tx, paid)
      if (!now || now.outcome !== 'owed') return { invoiceId: null }
      const invoiceId = await issueDeposit(tools, (await readDepositRequest(tools.tx, paid.depositRequestId))!, now.amount, paid.paidOn)
      const number = (await tools.tx.invoice.findUnique({ where: { id: invoiceId }, select: { number: true } }))?.number ?? null
      tools.audit({ action: names.issued, recordType: 'DepositRequest', recordId: paid.depositRequestId, companyId: now.companyId, after: { ...names.source, paymentId: paid.paymentId, invoiceId, number } })
      return { invoiceId }
    })
    return result.invoiceId ? 'issued' : 'exists'
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    const reason = `${error.message}${error.issues && error.issues.length > 1 ? ` ${error.issues.map((issue) => issue.message).join(' ')}` : ''}`.slice(0, 500)
    await command(caller, { name: names.held, idempotencyKey: names.heldKey, input: names.source, causationId }, async (tools) => {
      tools.audit({ action: names.held, recordType: 'DepositRequest', recordId: paid.depositRequestId, companyId: plan.companyId, after: { ...names.source, paymentId: paid.paymentId, reason } })
      return { held: true }
    })
    return 'held'
  }
}

/** On bank_match.accepted: the TD02 of each deposit request the acceptance's recorded payment placed money on. */
export async function afterBankAcceptance(caller: CommandCaller, payload: { readonly matchId: string; readonly paymentId: string | null; readonly recorded: boolean }, causationId: string): Promise<Record<string, DepositInvoiceOutcome | null>> {
  // A payment typed by hand (recorded: false) was paid, and invoiced, where it was typed; money out pays no deposit.
  if (!payload.recorded || !payload.paymentId) return {}
  const paymentId = payload.paymentId
  const facts = await caller.withClient(async (db) => {
    const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { status: true, receivedOn: true } })
    const allocations = await db.paymentAllocation.findMany({ where: { paymentId, depositRequestId: { not: null }, reversalOfId: null }, select: { depositRequestId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return { payment, requestIds: [...new Set(allocations.map((row) => row.depositRequestId!))] }
  })
  if (facts.payment?.status !== 'RECEIVED') return {}
  const paidOn = facts.payment.receivedOn.toISOString().slice(0, 10)
  const outcomes: Record<string, DepositInvoiceOutcome | null> = {}
  for (const depositRequestId of facts.requestIds) {
    outcomes[depositRequestId] = await depositInvoiceAfterPayment(caller, { paymentId, depositRequestId, paidOn, through: { kind: 'BANK', matchId: payload.matchId } }, causationId)
  }
  return outcomes
}

/** The worker's handler (background.ts W2B_393_HANDLERS, beside the bank's suggestions). */
export function bankDepositInvoiceHandler(): EventHandler {
  return defineHandler({
    name: 'payments.bankDepositInvoice',
    events: ['bank_match.accepted'],
    async handle(event, tools) {
      await afterBankAcceptance(tools.caller, event.payload as { matchId: string; paymentId: string | null; recorded: boolean }, event.eventId)
    },
  })
}

// ---- B-W2b-F55: every other command that places money on a deposit request ------------------------------------------

/**
 * Every deposit request becomes PAID in one place (payments.ts allocateInCommand → markDepositPaid), and each allocation
 * to it emits payment.allocated with the command that placed it (the envelope's `source`). Two kinds have a TD02 step of
 * their own, so this one leaves them: a bank line's acceptance (`payments.bank.*` → bank_match.accepted above) and an online
 * payment its intent finished with (the intent SUCCEEDED naming the payment → `payments.onlineFinished`, which also tells
 * the receipt mail that the TD02 follows). Every other allocation to a deposit request is invoiced here.
 */
export async function hasTd02StepOfItsOwn(db: CommandTx, placedBy: string, paymentId: string): Promise<boolean> {
  if (placedBy.startsWith('payments.bank.')) return true
  return (await db.paymentIntent.count({ where: { paymentId, status: 'SUCCEEDED' } })) > 0
}

/**
 * On payment.allocated: the TD02 of the deposit request it placed money on, by the one rule above (a part for a part, as
 * "deposit received" does; nothing when a TD02 — the office's, one by hand, a retry's — or a DRAFT has it already). null
 * when not a deposit request or when its path has a TD02 step of its own. A voided payment or a taken-back allocation places
 * nothing: no TD02 is made, and one made before stays (a credit note is a person's decision).
 */
export async function afterDepositAllocation(caller: CommandCaller, placed: { readonly paymentId: string; readonly allocationId: string; readonly target: string; readonly targetId: string; readonly placedBy: string }, causationId: string): Promise<DepositInvoiceOutcome | null> {
  if (placed.target !== 'DEPOSIT_REQUEST') return null
  const payment = await caller.withClient(async (db) => ((await hasTd02StepOfItsOwn(db, placed.placedBy, placed.paymentId)) ? null : db.payment.findUnique({ where: { id: placed.paymentId }, select: { receivedOn: true } })))
  if (!payment) return null
  return depositInvoiceAfterPayment(caller, { paymentId: placed.paymentId, depositRequestId: placed.targetId, paidOn: payment.receivedOn.toISOString().slice(0, 10), through: { kind: 'ALLOCATION', allocationId: placed.allocationId, placedBy: placed.placedBy } }, causationId)
}

/** The worker's handler (background.ts W2B_393_HANDLERS, beside the bank's). */
export function allocatedDepositInvoiceHandler(): EventHandler {
  return defineHandler({
    name: 'payments.allocatedDepositInvoice',
    events: ['payment.allocated'],
    async handle(event, tools) {
      const payload = event.payload as { paymentId: string; allocationId: string; target: string; targetId: string }
      await afterDepositAllocation(tools.caller, { ...payload, placedBy: event.source }, event.eventId)
    },
  })
}
