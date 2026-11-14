import { ConflictError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { DEPOSIT_CANCELLATION_RULE, depositOutcomeOf, madeToMeasureOf, pickRule, type CancelledBy } from '@nexus/factory-domain/invoicing/cancellation/cancellation'
import { creditable } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import { lockMoney } from '../../payments/locks'
import { creditNoteInCommand } from '../credit-note/credit-note'
import { creditedInvoiceOf } from '../from-shipment/store'
import { assertMay, invoiceDetail, officeContextOf, readInvoice, type Reader } from '../store'
import { refusingInWords } from '../tax-codes/store'
import { activeRules } from './rules'

/**
 * A cancelled order's deposits (B-W2b-396; FIN-080 "Deposit on cancellation"; c.c. artt. 1385, 1386; D.Lgs. 206/2005 art. 59
 * c.1 lett. c):
 *
 *   GET  /invoicing/orders/:orderId/deposit-cancellation?cancelledBy   each deposit request paid on the order: what was
 *        paid and invoiced (TD02, less its credit notes), the company's rule for its kind, the side that cancels and the
 *        order's kind (made to measure: a line with a measurement profile, or the order states no withdrawal), and what
 *        follows: kept, paid back (and the extra half of a double), the credit note's amount (invoices.view); any order,
 *        so the office sees it before cancelling;
 *   POST …/deposit-cancellation {cancelledBy}   (invoices.manage) on a CANCELLED order: ONE command drafts, per deposit
 *        request not decided yet, the credit note (TD04, reason "deposit given back", by amount at its deposit invoice's
 *        VAT) of what is paid back that its deposit invoices billed, oldest invoice first; each draft is issued and sent like
 *        any invoice (invoices.issue + step-up); the refund itself is paid in Finance › Payments. A request whose deposit
 *        invoice has a credit note already (drafted or issued) counts as decided and is left as it is.
 * The rules are factory-domain invoicing/cancellation (UNVERIFIED, GATE-ACCOUNTANT): with no rule everything is paid back.
 */

async function readOrder(db: Reader, orderId: string) {
  if (!isUuid(orderId)) return null
  return db.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, status: true, companyId: true, partyId: true, noWithdrawal: true, lines: { select: { kind: true, measurementProfileId: true } } } })
}

async function outcomesOf(db: Reader, order: NonNullable<Awaited<ReturnType<typeof readOrder>>>, cancelledBy: CancelledBy) {
  const madeToMeasure = madeToMeasureOf(order)
  const rules = await activeRules(db, order.companyId)
  const requests = await db.depositRequest.findMany({ where: { orderId: order.id }, select: { id: true, kind: true, currency: true, status: true, allocations: { select: { amount: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const deposits = []
  for (const request of requests) {
    const paid = request.allocations.reduce((sum, row) => sum + row.amount, 0)
    if (paid <= 0) continue
    const invoices = await db.invoice.findMany({ where: { depositRequestId: request.id, docType: 'TD02', status: { not: 'DRAFT' } }, select: { id: true, grossTotal: true, issueDate: true }, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }] })
    const credits = invoices.length > 0 ? await db.invoice.findMany({ where: { creditOfId: { in: invoices.map((row) => row.id) }, docType: 'TD04' }, select: { creditOfId: true, status: true, grossTotal: true } }) : []
    const invoiced = invoices.reduce((sum, row) => sum + row.grossTotal, 0) - credits.filter((row) => row.status !== 'DRAFT').reduce((sum, row) => sum + row.grossTotal, 0)
    const rule = pickRule(rules, { depositKind: request.kind, cancelledBy, madeToMeasure })
    const outcome = depositOutcomeOf({ depositKind: request.kind, currency: request.currency, paid, invoiced }, rule, cancelledBy)
    deposits.push({ request, invoices, decided: credits.length > 0, rule, outcome, paid, invoiced })
  }
  return { madeToMeasure, deposits }
}

const outcomeView = (entry: Awaited<ReturnType<typeof outcomesOf>>['deposits'][number]) => ({
  depositRequestId: entry.request.id,
  depositKind: entry.request.kind,
  currency: entry.request.currency,
  paid: asMoney('price', entry.paid),
  invoiced: asMoney('price', entry.invoiced),
  source: entry.outcome.source,
  ruleId: entry.rule?.id ?? null,
  refundRule: entry.outcome.refundRule,
  keepPct: entry.outcome.keepPct,
  kept: asMoney('price', entry.outcome.kept),
  refund: asMoney('price', entry.outcome.refund),
  extra: asMoney('price', entry.outcome.extra),
  document: entry.outcome.document,
  creditAmount: asMoney('price', entry.outcome.creditAmount),
  decided: entry.decided,
  words: entry.decided ? `${entry.outcome.words} A credit note of its deposit invoice exists already: decided.` : entry.outcome.words,
})

/** GET /invoicing/orders/:orderId/deposit-cancellation (invoices.view). */
export async function orderOutcome(caller: CommandCaller, orderId: string, query: { cancelledBy: CancelledBy }) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const order = await readOrder(client, orderId)
    assertMay(context, INVOICES_VIEW, INVOICES_VIEW, order ? { companyId: order.companyId, partyId: order.partyId } : null, 'Order')
    const { madeToMeasure, deposits } = await outcomesOf(client, order!, query.cancelledBy)
    return { orderId: order!.id, number: order!.number, status: order!.status, madeToMeasure, cancelledBy: query.cancelledBy, deposits: deposits.map(outcomeView), rule: { status: DEPOSIT_CANCELLATION_RULE.status, words: DEPOSIT_CANCELLATION_RULE.words } }
  })
}

/** POST /invoicing/orders/:orderId/deposit-cancellation (invoices.manage): the credit notes of a cancelled order's deposits. */
export async function decideOrder(caller: CommandCaller, orderId: string, body: { cancelledBy: CancelledBy }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await caller.withClient((client) => readOrder(client, orderId))
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, order ? { companyId: order.companyId, partyId: order.partyId } : null, 'Order')
  if (order!.status !== 'CANCELLED') throw new InvalidStateError(`Order ${order!.number} is ${order!.status}: its deposits are decided once it is cancelled.`)
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'invoices.decideDepositCancellation', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
      const { tx } = tools
      const requests = await tx.depositRequest.findMany({ where: { orderId: order!.id }, select: { id: true }, orderBy: { id: 'asc' } })
      for (const request of requests) await lockMoney(tx, tools.context, 'deposit', request.id)
      const { deposits } = await outcomesOf(tx, order!, body.cancelledBy)
      const open = deposits.filter((entry) => !entry.decided && entry.outcome.creditAmount > 0)
      if (deposits.length === 0) throw new ConflictError(`Nothing was paid on the deposits of order ${order!.number}: no document follows.`)
      if (open.length === 0) throw new ConflictError(deposits.some((entry) => entry.decided) ? `The deposits of order ${order!.number} are decided already (their credit notes exist).` : `No credit note follows for the deposits of order ${order!.number}: ${deposits.map((entry) => entry.outcome.words).join(' ')}`)
      const creditNoteIds: string[] = []
      for (const entry of open) {
        let left = entry.outcome.creditAmount
        for (const invoice of entry.invoices) {
          if (left <= 0) break
          await lockMoney(tx, tools.context, 'invoice', invoice.id)
          const credited = (await creditedInvoiceOf(tx, invoice.id, null))!
          const amount = Math.min(left, creditable(credited).gross)
          if (amount <= 0) continue
          const made = await creditNoteInCommand(tools, invoice.id, { mode: 'AMOUNT', amount, basis: 'GROSS' }, 'DEPOSIT_REFUND', `annullamento dell'ordine ${order!.number}`, null, 'invoices.depositCancellationNote')
          creditNoteIds.push(made.id)
          left -= amount
        }
      }
      tools.audit({
        action: 'invoices.decideDepositCancellation',
        recordType: 'SalesOrder',
        recordId: order!.id,
        companyId: order!.companyId,
        after: { cancelledBy: body.cancelledBy, deposits: deposits.map((entry) => ({ depositRequestId: entry.request.id, refundRule: entry.outcome.refundRule, source: entry.outcome.source, ruleId: entry.rule?.id ?? null, decided: entry.decided })), creditNoteIds },
      })
      tools.emit({ type: 'deposit_cancellation.decided', subject: order!.id, companyId: order!.companyId, payload: { orderId: order!.id, cancelledBy: body.cancelledBy, creditNoteIds } })
      const after = await outcomesOf(tx, order!, body.cancelledBy)
      const creditNotes = []
      for (const id of creditNoteIds) creditNotes.push(await invoiceDetail(tx, (await readInvoice(tx, id))!))
      return { orderId: order!.id, deposits: after.deposits.map(outcomeView), creditNotes }
    }),
  )
  return result
}
