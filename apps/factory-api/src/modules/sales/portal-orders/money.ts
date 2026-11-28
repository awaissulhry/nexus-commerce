import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { orderMoneyPartsOf, shareOf } from '@nexus/factory-domain/sales/orders/later-columns'
import { PORTAL_PAYMENTS_NOTIFY } from '@nexus/factory-domain/sales/portal-orders/permissions'
import { MONEY_WORDS, noticeProblem, REST_STEP_ID, stepStateOf, type AddsUpKey, type NoticeRefusal, type PlanState, type PlanStepKind } from '@nexus/factory-domain/sales/portal-orders/money'
import { partnerLocaleOf } from '@nexus/factory-domain/threads/partner/rules'
import { appClock, commandOn } from '../../../platform/portal/tasks/clock'
import { orderMoneyFactsOf } from '../orders/later-columns'
import { partnerOrder, portalReader, type PortalReader } from './access'
import { dayOrNull, readDeposits, type PortalOrderRow } from './store'

/**
 * The customer's Money tab of its order (owb- order workflow, S1 po2.2; design § 5m; the S1 Shape "MONEY"):
 *
 *   GET  /portal/sales-orders/:orderId/money             totals (order, invoiced, paid, still to pay), how it adds up, the payment plan
 *                                                         (its milestones, else its deposit requests, and the rest) with each step's
 *                                                         state and what was paid on it, the invoices and credit notes of the order
 *                                                         (the customer's own fiscal documents: numbers shown), its "I paid" notices
 *   POST /portal/sales-orders/:orderId/payment-notices   "I paid: tell the factory…" — a notice on the base's PaymentNotice (OPEN):
 *                                                         it changes NOTHING owed; the office records the payment or dismisses it
 *
 * Money only with the price grain (403 without: the Designer and the Viewer never — owb-b7: both read the orders, neither a price). Every figure
 * is the office's ONE rule (orderMoneyFactsOf + orderMoneyPartsOf, as the order record's `stillToPay`): never a second money rule.
 * The partner read finds the order first (another customer's: 404); the money rows the partner role cannot read (milestones, credit
 * notes' sums) are read in the tenant's scope for this one order only. No cost, no margin, no office person, no office series.
 */

type Locale = 'it' | 'en'
const said = (key: NoticeRefusal, locale: Locale): string => MONEY_WORDS[key][locale]

interface PlanStep {
  readonly id: string
  readonly kind: PlanStepKind
  readonly percent: number | null
  readonly amount: number
  readonly due: BusinessDate | null
  readonly state: PlanState
  readonly paid: number
  /** What a notice on it names. */
  readonly source: { readonly depositRequestId: string | null; readonly milestoneId: string | null }
}

interface MoneyFacts {
  readonly currency: string
  readonly totals: { readonly order: number; readonly invoiced: number; readonly paid: number; readonly stillToPay: number }
  readonly addsUp: { readonly key: AddsUpKey; readonly amount: number }[]
  readonly plan: PlanStep[]
  readonly invoices: { readonly id: string; readonly kind: 'INVOICE' | 'CREDIT_NOTE'; readonly number: string; readonly date: string; readonly amount: number; readonly open: number; readonly documentId: string | null }[]
}

const day = (value: Date | null): BusinessDate | null => (value === null ? null : dayOrNull(value))
/** A share percentage as the answer shows it (a Decimal(7,4) as a number with at most 2 decimals; never a money figure). */
const percentOf = (value: { toFixed(digits: number): string } | null): number | null => (value === null ? null : Number(value.toFixed(2)))

/** The order's money, read once (see the module's head): the ONE rule's parts, the plan, the documents. */
async function moneyFactsOf(request: FastifyRequest, reader: PortalReader, order: PortalOrderRow, today: BusinessDate): Promise<MoneyFacts> {
  const deposits = await request.withClient((client) => readDeposits(client, order.id))
  const read = await reader.inTenant(async (client) => {
    const lines = await client.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, orderId: true, kind: true, quantity: true, closedShortQuantity: true, feeCreditedAt: true, netAmount: true, vatAmount: true } })
    const facts = await orderMoneyFactsOf(client, [order.id], lines)
    const parts = orderMoneyPartsOf({ ...facts.factsOf({ id: order.id, grossAmount: order.grossAmount }), ...(order.status === 'CANCELLED' ? { status: 'CANCELLED' as const } : {}) })
    const shares = facts.invoicesOf(order.id)
    const ids = shares.map((share) => share.id)
    const invoices = ids.length > 0 ? await client.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, issueDate: true, grossTotal: true, pdfFileId: true }, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }] }) : []
    const credits = ids.length > 0 ? await client.invoice.findMany({ where: { docType: 'TD04', status: { not: 'DRAFT' }, creditOfId: { in: ids } }, select: { id: true, number: true, issueDate: true, grossTotal: true, pdfFileId: true }, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }] }) : []
    const milestones = await client.salesOrderMilestone.findMany({ where: { orderId: order.id, status: { in: ['OPEN', 'PAID'] } }, select: { id: true, kind: true, sharePct: true, amount: true, dueDate: true, depositRequestId: true, status: true }, orderBy: { seq: 'asc' } })
    const requestIds = [...new Set([...deposits.map((row) => row.id), ...milestones.flatMap((row) => (row.depositRequestId ? [row.depositRequestId] : []))])]
    const placed = requestIds.length > 0 ? await client.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requestIds } }, _sum: { amount: true } }) : []
    return { lines, parts, shares, invoices, credits, milestones, placed: new Map(placed.flatMap((row) => (row.depositRequestId ? [[row.depositRequestId, row._sum.amount ?? 0] as const] : []))) }
  })
  const { parts } = read
  const goods = read.lines.filter((line) => line.kind !== 'FEE')
  const fees = read.lines.filter((line) => line.kind === 'FEE')
  const sum = <T>(rows: readonly T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0)
  const steps: PlanStep[] =
    read.milestones.length > 0
      ? read.milestones.map((row) => {
          const paid = row.status === 'PAID' ? row.amount : Math.min(row.amount, row.depositRequestId ? (read.placed.get(row.depositRequestId) ?? 0) : 0)
          const kind: PlanStepKind = row.kind === 'DEPOSIT' ? 'DEPOSIT' : 'MILESTONE'
          const due = day(row.dueDate)
          return { id: row.id, kind, percent: percentOf(row.sharePct), amount: row.amount, due, paid, state: stepStateOf({ amount: row.amount, paid, due, settled: row.status === 'PAID', dueWithoutDay: kind === 'DEPOSIT' }, today), source: { depositRequestId: row.depositRequestId, milestoneId: row.id } }
        })
      : deposits
          .filter((row) => row.status === 'OPEN' || row.status === 'PAID')
          .map((row) => {
            const paid = row.status === 'PAID' ? row.amount : Math.min(row.amount, read.placed.get(row.id) ?? 0)
            const due = day(row.dueDate)
            return { id: row.id, kind: 'DEPOSIT' as const, percent: null, amount: row.amount, due, paid, state: stepStateOf({ amount: row.amount, paid, due, settled: row.status === 'PAID', dueWithoutDay: true }, today), source: { depositRequestId: row.id, milestoneId: null } }
          })
  // The rest: what the steps do not cover of what is owed (the order less what is never billed and credited), and what was paid on it.
  const owed = Math.max(0, order.grossAmount - parts.neverBilled - parts.credited)
  const restAmount = Math.max(0, owed - sum(steps, (step) => step.amount))
  const restPaid = Math.min(restAmount, Math.max(0, parts.paid - sum(steps, (step) => step.paid)))
  const plan = restAmount > 0 ? [...steps, { id: REST_STEP_ID, kind: 'REST' as const, percent: null, amount: restAmount, due: null, paid: restPaid, state: stepStateOf({ amount: restAmount, paid: restPaid, due: null, settled: false, dueWithoutDay: false }, today), source: { depositRequestId: null, milestoneId: null } }] : steps
  const shareById = new Map(read.shares.map((share) => [share.id, share]))
  return {
    currency: order.currency,
    totals: { order: order.grossAmount, invoiced: sum(read.shares, (share) => shareOf(share.grossTotal, share.part, share.whole)), paid: parts.paid, stillToPay: parts.balance },
    addsUp: [
      { key: 'LINES', amount: sum(goods, (line) => line.netAmount) },
      { key: 'CHARGES', amount: sum(fees, (line) => line.netAmount) },
      { key: 'VAT', amount: sum(read.lines, (line) => line.vatAmount) },
      { key: 'CREDIT_NOTES', amount: -parts.credited },
      { key: 'PAID', amount: -parts.paid },
    ],
    plan,
    invoices: [
      ...read.invoices.map((row) => {
        const share = shareById.get(row.id)
        const open = share ? Math.max(0, row.grossTotal - share.placed - share.creditedGross - (share.writtenOff ?? 0)) : 0
        return { id: row.id, kind: 'INVOICE' as const, number: row.number ?? '', date: day(row.issueDate) ?? '', amount: row.grossTotal, open, documentId: row.pdfFileId }
      }),
      ...read.credits.map((row) => ({ id: row.id, kind: 'CREDIT_NOTE' as const, number: row.number ?? '', date: day(row.issueDate) ?? '', amount: row.grossTotal, open: 0, documentId: row.pdfFileId })),
    ],
  }
}

/** The money read's own reader: the price grain, else 403 in words (owb-b7: the Viewer and the Designer read the orders, refused here). */
function moneyReader(app: FastifyInstance, request: FastifyRequest): { readonly reader: PortalReader; readonly locale: Locale } {
  const reader = portalReader(app, request)
  const locale = partnerLocaleOf(reader.session.person.locale)
  if (!reader.seesPrices) throw new ForbiddenError(said('NO_PRICES', locale))
  return { reader, locale }
}

const noticeView = (row: { readonly id: string; readonly depositRequestId: string | null; readonly milestoneId: string | null; readonly amount: number; readonly paidOn: Date; readonly state: string }) => ({
  id: row.id,
  stepId: row.milestoneId ?? row.depositRequestId,
  amount: asMoney('price', row.amount),
  paidOn: row.paidOn.toISOString().slice(0, 10),
  state: row.state as 'OPEN' | 'RECORDED' | 'DISMISSED',
})

/** GET /portal/sales-orders/:orderId/money (see the module's head). */
export async function orderMoney(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const { reader } = moneyReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const today = businessDate(now)
  const money = await moneyFactsOf(request, reader, order, today)
  const notices = await request.withClient((client) => client.paymentNotice.findMany({ where: { salesOrderId: order.id }, select: { id: true, depositRequestId: true, milestoneId: true, amount: true, paidOn: true, state: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }))
  const open = new Set(notices.filter((row) => row.state === 'OPEN').map((row) => row.milestoneId ?? row.depositRequestId ?? REST_STEP_ID))
  const notify = !reader.session.preview && can(reader.actor, PORTAL_PAYMENTS_NOTIFY, { companyId: reader.session.company.id, partyId: reader.session.partyId }) && money.totals.stillToPay > 0
  return {
    currency: money.currency,
    totals: { order: asMoney('price', money.totals.order), invoiced: asMoney('price', money.totals.invoiced), paid: asMoney('price', money.totals.paid), stillToPay: asMoney('price', money.totals.stillToPay) },
    addsUp: money.addsUp.map((entry) => ({ key: entry.key, amount: asMoney('price', entry.amount) })),
    plan: money.plan.map((step) => ({ id: step.id, kind: step.kind, percent: step.percent, amount: asMoney('price', step.amount), due: step.due, state: step.state, paid: asMoney('price', step.paid), noticeOpen: open.has(step.id) })),
    invoices: money.invoices.map((row) => ({ ...row, amount: asMoney('price', row.amount), open: asMoney('price', row.open) })),
    notices: notices.map(noticeView),
    may: { notify },
  }
}

export interface NoticeBody {
  readonly stepId: string | null
  /** Absent when the caller holds no price grain (the marked input strips it): refused as AMOUNT. */
  readonly amount?: number | undefined
  readonly paidOn: BusinessDate
  readonly method?: string | undefined
  readonly note?: string | undefined
  readonly fileId?: string | undefined
}

/**
 * POST /portal/sales-orders/:orderId/payment-notices (portal.payments.notify: the Buyer, the Admin; the price grain). A notice, OPEN,
 * on the order (a step of its plan, or none: the rest); 409 when the order has nothing still to pay; 400 an amount above it, a day
 * ahead, a step of another order, a receipt the customer did not send. The event `payment_notice.sent` (ids) tells the office.
 */
export async function sendPaymentNotice(app: FastifyInstance, request: FastifyRequest, orderId: string, body: NoticeBody, idempotencyKey?: string) {
  const { reader, locale } = moneyReader(app, request)
  if (reader.session.preview) throw new ForbiddenError('A preview of the portal sends nothing.')
  const order = await partnerOrder(request, reader, orderId)
  const today = businessDate(appClock(app).now())
  const money = await moneyFactsOf(request, reader, order, today)
  const amount = body.amount ?? 0
  const problem = noticeProblem({ amount, stillToPay: money.totals.stillToPay, paidOn: body.paidOn, today })
  if (problem === 'NOTHING_TO_PAY') throw new DomainError('conflict', said(problem, locale), [{ path: 'refusal/NOTHING_TO_PAY', message: said(problem, locale) }])
  if (problem) throw new ValidationError(said(problem, locale), [{ path: problem === 'FUTURE' ? 'body/paidOn' : 'body/amount', message: said(problem, locale) }])
  const step = body.stepId === null ? null : money.plan.find((entry) => entry.id === body.stepId && entry.id !== REST_STEP_ID)
  if (body.stepId !== null && !step) throw new ValidationError(said('STEP', locale), [{ path: 'body/stepId', message: said('STEP', locale) }])
  if (body.fileId !== undefined) {
    const fileId = body.fileId
    const file = isUuid(fileId) ? await request.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, partyId: reader.session.partyId, status: 'AVAILABLE' }, select: { id: true } })) : null
    if (!file) throw new ValidationError(said('FILE', locale), [{ path: 'body/fileId', message: said('FILE', locale) }])
  }
  const id = newId()
  const { result } = await commandOn(app, request, { name: 'portalOrders.paymentNotice', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const row = await tools.tx.paymentNotice.create({
      data: {
        id,
        companyId: order.companyId,
        partyId: reader.session.partyId,
        salesOrderId: order.id,
        depositRequestId: step?.source.depositRequestId ?? null,
        milestoneId: step?.source.milestoneId ?? null,
        amount,
        currency: order.currency,
        paidOn: new Date(`${body.paidOn}T00:00:00.000Z`),
        method: body.method?.trim() || null,
        note: body.note?.trim() || null,
        fileId: body.fileId ?? null,
        createdById: reader.session.userId,
        createdAt: tools.now,
        updatedAt: tools.now,
      },
      select: { id: true, depositRequestId: true, milestoneId: true, amount: true, paidOn: true, state: true },
    })
    tools.audit({ action: 'portalOrders.paymentNotice', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { noticeId: id, stepId: body.stepId, amount: markMoney('price', amount), paidOn: body.paidOn, byPartner: true } })
    tools.emit({ type: 'payment_notice.sent', subject: order.id, companyId: order.companyId, payload: { noticeId: id, salesOrderId: order.id, partyId: reader.session.partyId } })
    return row
  })
  return noticeView(result)
}

