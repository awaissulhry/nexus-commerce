import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { ORDERS_MANAGE, ORDERS_WAIVE } from '@nexus/factory-domain/sales/orders/permissions'
import { MILESTONE_WORDS, paymentScheduleOf, remadeSchedule, stepRequestFor, type PlannedMilestone, type StoredMilestone } from '@nexus/factory-domain/sales/orders/schedule'
import { instalmentsOf } from '@nexus/factory-domain/sales/terms/terms'
import type { CustomerTaxProfile } from '@nexus/factory-domain/tax/vat-treatment'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { lockAll } from '../../payments/locks'
import { quotePartyOf } from '../quotes/store'
import { officeOrder } from './moves'
import { asDay, dayOf, dayOrNull, lockOrder, type OrderRow, type Reader } from './store'

/**
 * An order's payment schedule (B-W2a-30; SAL-216; the design's order.money.schedule card): its SalesOrderMilestone rows,
 * made from its payment terms and deposit (factory-domain sales/orders/schedule) in the command that makes the order (at
 * acceptance, make.ts; typed by the office, manual.ts), made again after an amendment (amend.ts), a DEPOSIT step PAID
 * when its deposit request is (the worker's handler on payment.deposit_paid, handlers.ts), the OPEN steps cancelled with
 * the order (moves.ts cancelOrder). Steps are never deleted: a remade or cancelled step keeps its row with why
 * (statusNote). Amounts are price grain.
 *
 * B-W2a-F2 (DPR 633/1972 art. 6 c.4: a payment received before the goods leave is an advance, invoiced for the amount
 * paid): a BEFORE_SHIPPING step has a deposit request of its own, so the money module's deposit flow (payments
 * deposit-received: payment → request PAID → TD02 issued → deducted on the goods' invoice) bills it exactly as it bills
 * the deposit, and the same handler marks the step PAID. The request (an ACCONTO of the step's amount, due on the step's
 * day, the deposit's fiscal rule: factory-domain `stepRequestFor`) is made with the step wherever steps are written —
 * at acceptance, at manual entry and when an amendment makes the steps again (`insertSteps`) — when the step has its
 * day; a step without one (its order had no promise date) and a step of an order made before this step get theirs when
 * the office opens the step: POST /sales/orders/:orderId/schedule/:milestoneId/request (`requestStep`). An amendment
 * cancels an unpaid before-shipping step together with its request (under the request's money lock, taken before the
 * order's row: `lockStepRequests`) and keeps a part-paid one.
 */

export const MILESTONE_COLUMNS = {
  id: true,
  orderId: true,
  seq: true,
  kind: true,
  label: true,
  sharePct: true,
  amount: true,
  dueDate: true,
  depositRequestId: true,
  status: true,
  paidAt: true,
  statusNote: true,
  version: true,
  createdAt: true,
} as const

type MilestoneRow = Awaited<ReturnType<typeof readMilestones>>[number]

export async function readMilestones(db: Reader, orderId: string) {
  return db.salesOrderMilestone.findMany({ where: { orderId }, select: MILESTONE_COLUMNS, orderBy: { seq: 'asc' } })
}

const stored = (row: MilestoneRow, paid: ReadonlyMap<string, number>): StoredMilestone => ({
  id: row.id,
  seq: row.seq,
  kind: row.kind,
  status: row.status,
  amount: row.amount,
  dueDate: dayOrNull(row.dueDate),
  depositRequestId: row.depositRequestId,
  requestPaid: row.depositRequestId === null ? 0 : (paid.get(row.depositRequestId) ?? 0),
})

/** What the payments placed on each request so far (allocations less their reversals). */
async function paidOnRequests(db: Reader, requestIds: readonly string[]): Promise<Map<string, number>> {
  if (requestIds.length === 0) return new Map()
  const rows = await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: [...requestIds] } }, _sum: { amount: true } })
  return new Map(rows.flatMap((row) => (row.depositRequestId ? [[row.depositRequestId, row._sum.amount ?? 0] as const] : [])))
}

/**
 * B-W2a-F2: the money locks of the deposit requests of an order's OPEN before-shipping steps (payments/locks.ts, id
 * order), taken BEFORE the order's row: a payment holds a request's lock and then needs the order's row (its TD02 names
 * the order), so taking them after the row could deadlock. An amendment calls it first; what is paid on them is then
 * read under the locks (no payment lands on a request being cancelled).
 */
export async function lockStepRequests(tools: Pick<CommandTools, 'tx' | 'context'>, orderId: string): Promise<void> {
  const steps = await tools.tx.salesOrderMilestone.findMany({ where: { orderId, kind: 'BEFORE_SHIPPING', status: 'OPEN', depositRequestId: { not: null } }, select: { depositRequestId: true } })
  await lockAll(tools.tx, tools.context, 'deposit', steps.flatMap((step) => (step.depositRequestId ? [step.depositRequestId] : [])))
}

/** The terms' instalments of an order (none: no library terms, or terms not found). */
export async function instalmentsOfOrder(db: Reader, paymentTermsId: string | null) {
  if (paymentTermsId === null) return null
  const row = await db.paymentTerms.findUnique({ where: { id: paymentTermsId }, select: { instalments: true } })
  return row ? instalmentsOf(row.instalments) : null
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

type StepOrder = Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId' | 'currency'>

/** The customer's tax profile now (the fiscal decision of a step's request), read once per command. */
async function profileNow(tx: CommandTx, partyId: string, now: Date): Promise<CustomerTaxProfile | null> {
  return (await quotePartyOf(tx, partyId, businessDate(now), now))?.profile ?? null
}

/**
 * B-W2a-F2: the deposit request of a before-shipping step (factory-domain `stepRequestFor`), named on the order (no
 * quote version), OPEN. Null when the step asks none (no day yet, nothing to pay). Inside the command that writes the step.
 */
async function createStepRequest(tools: CommandTools, order: StepOrder, step: Pick<PlannedMilestone, 'kind' | 'amount' | 'sharePct' | 'dueDate'>, profile: CustomerTaxProfile | null, milestoneId: string): Promise<string | null> {
  const draft = stepRequestFor(step, order.currency, profile)
  if (!draft) return null
  const id = newId()
  await tools.tx.depositRequest.create({
    data: {
      id,
      companyId: order.companyId,
      partyId: order.partyId,
      orderId: order.id,
      kind: draft.kind,
      depositPct: draft.depositPct,
      currency: draft.currency,
      amount: draft.amount,
      dueDate: asDay(draft.dueDate),
      fiscalDocument: draft.fiscalDocument,
      fiscalRule: draft.fiscalRule,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  tools.audit({
    action: 'sales.deposits.request',
    recordType: 'DepositRequest',
    recordId: id,
    companyId: order.companyId,
    after: { orderId: order.id, milestoneId, stepKind: step.kind, kind: draft.kind, depositPct: draft.depositPct, currency: draft.currency, amount: markMoney('price', draft.amount), dueDate: draft.dueDate, fiscalDocument: draft.fiscalDocument, fiscalRule: draft.fiscalRule, reason: draft.reason, status: 'OPEN' },
  })
  // B-W2b-16: a request made on the order has its own event (deposit_request.created needs a quote version).
  tools.emit({
    type: 'deposit_request.created_for_order',
    subject: id,
    companyId: order.companyId,
    payload: { depositRequestId: id, orderId: order.id, number: order.number, partyId: order.partyId, stepKind: 'BEFORE_SHIPPING', fiscalDocument: draft.fiscalDocument, dueDate: draft.dueDate },
  })
  return id
}

async function insertSteps(tools: CommandTools, order: StepOrder, steps: readonly PlannedMilestone[]): Promise<string[]> {
  const ids: string[] = []
  // B-W2a-F2: a before-shipping step with its day gets its own deposit request, made first (the step names it).
  const profile = steps.some((step) => step.kind === 'BEFORE_SHIPPING' && step.depositRequestId === null && step.dueDate !== null) ? await profileNow(tools.tx, order.partyId, tools.now) : null
  for (const step of steps) {
    const id = newId()
    const depositRequestId = step.depositRequestId ?? (step.kind === 'BEFORE_SHIPPING' ? await createStepRequest(tools, order, step, profile, id) : null)
    await tools.tx.salesOrderMilestone.create({
      data: {
        id,
        companyId: order.companyId,
        orderId: order.id,
        partyId: order.partyId,
        seq: step.seq,
        kind: step.kind,
        sharePct: step.sharePct,
        amount: step.amount,
        dueDate: step.dueDate === null ? null : asDay(step.dueDate),
        depositRequestId,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    ids.push(id)
  }
  return ids
}

const stepAudit = (steps: readonly PlannedMilestone[]) => markMoney('price', steps.map((step) => ({ seq: step.seq, kind: step.kind, sharePct: step.sharePct, amount: step.amount, dueDate: step.dueDate, depositRequestId: step.depositRequestId })))

/**
 * Inside the command that made the order: its schedule from its terms and its deposit request (the request's amount and
 * due date), when anything falls due before the invoice. Returns the steps written (none: paid on invoice terms).
 */
export async function makeScheduleInCommand(
  tools: CommandTools,
  order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId' | 'currency' | 'grossAmount' | 'promiseDate' | 'paymentTermsId'>,
  deposit: { readonly id: string; readonly amount: number; readonly dueDate: Date; readonly depositPct: { toString(): string } | null } | null,
): Promise<string[]> {
  if ((await tools.tx.salesOrderMilestone.count({ where: { orderId: order.id } })) > 0) return []
  const steps = paymentScheduleOf({
    gross: order.grossAmount,
    instalments: await instalmentsOfOrder(tools.tx, order.paymentTermsId),
    deposit: deposit ? { requestId: deposit.id, amount: deposit.amount, dueDate: dayOf(deposit.dueDate), sharePct: deposit.depositPct === null ? null : decimalText(deposit.depositPct.toString()) } : null,
    promiseDate: dayOrNull(order.promiseDate),
  })
  if (steps.length === 0) return []
  const ids = await insertSteps(tools, order, steps)
  tools.audit({ action: 'orders.schedule', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { change: 'MADE', paymentTermsId: order.paymentTermsId, steps: stepAudit(steps) } })
  tools.emit({ type: 'sales_order.schedule_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'MADE', milestoneIds: ids } })
  return ids
}

/**
 * Inside an amendment's command, after the order's new totals: its OPEN steps made again for the new gross (the deposit,
 * the settled steps and a part-paid before-shipping step stay; factory-domain `remadeSchedule`). A cancelled step's
 * unpaid deposit request is cancelled with it (B-W2a-F2; the caller took the requests' locks first, `lockStepRequests`),
 * and a new before-shipping step gets its own. Returns what changed (nothing for an order without a schedule or an
 * unchanged plan) and what the kept steps cover beyond the new gross.
 */
export async function remakeScheduleInCommand(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId' | 'currency' | 'promiseDate' | 'paymentTermsId'>, gross: number, revision: number) {
  const rows = await readMilestones(tools.tx, order.id)
  const requestIds = rows.flatMap((row) => (row.status === 'OPEN' && row.kind === 'BEFORE_SHIPPING' && row.depositRequestId ? [row.depositRequestId] : []))
  // Re-entrant: the amendment took these before the order's row; a request named since is locked here.
  await lockAll(tools.tx, tools.context, 'deposit', requestIds)
  const paid = await paidOnRequests(tools.tx, requestIds)
  const plan = remadeSchedule(
    rows.map((row) => stored(row, paid)),
    { gross, instalments: await instalmentsOfOrder(tools.tx, order.paymentTermsId), promiseDate: dayOrNull(order.promiseDate) },
  )
  if (plan.cancel.length === 0 && plan.insert.length === 0) return { cancelled: [] as string[], inserted: [] as string[], overpaid: plan.overpaid }
  const note = `Amendment ${revision}: the schedule was made again for the new total.`
  const cancelledRequests: string[] = []
  for (const id of plan.cancel) {
    await tools.tx.salesOrderMilestone.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CANCELLED', statusNote: note, updatedAt: tools.now, version: { increment: 1 } } })
    const requestId = rows.find((row) => row.id === id)?.depositRequestId ?? null
    if (requestId === null || (paid.get(requestId) ?? 0) !== 0) continue
    const { count } = await tools.tx.depositRequest.updateMany({ where: { id: requestId, status: 'OPEN' }, data: { status: 'CANCELLED', statusNote: note, updatedAt: tools.now, version: { increment: 1 } } })
    if (count !== 1) continue
    cancelledRequests.push(requestId)
    tools.audit({ action: 'orders.cancelDeposit', recordType: 'DepositRequest', recordId: requestId, companyId: order.companyId, before: { status: 'OPEN' }, after: { status: 'CANCELLED', orderId: order.id, milestoneId: id }, reason: note })
  }
  const inserted = await insertSteps(tools, order, plan.insert)
  tools.audit({ action: 'orders.schedule', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { change: 'REMADE', revision, cancelled: plan.cancel, cancelledDepositRequestIds: cancelledRequests, steps: stepAudit(plan.insert), overpaid: markMoney('price', plan.overpaid) } })
  tools.emit({ type: 'sales_order.schedule_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'REMADE', milestoneIds: [...plan.cancel, ...inserted] } })
  return { cancelled: [...plan.cancel], inserted, overpaid: plan.overpaid }
}

/** Inside the cancel's command: the OPEN steps cancelled with the order (statusNote says why). */
export async function cancelScheduleInCommand(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId'>, reason: string): Promise<string[]> {
  const open = await tools.tx.salesOrderMilestone.findMany({ where: { orderId: order.id, status: 'OPEN' }, select: { id: true }, orderBy: { seq: 'asc' } })
  if (open.length === 0) return []
  await tools.tx.salesOrderMilestone.updateMany({ where: { id: { in: open.map((row) => row.id) }, status: 'OPEN' }, data: { status: 'CANCELLED', statusNote: `Order ${order.number} cancelled: ${reason}`, updatedAt: tools.now, version: { increment: 1 } } })
  const ids = open.map((row) => row.id)
  tools.emit({ type: 'sales_order.schedule_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'CANCELLED', milestoneIds: ids } })
  return ids
}

/**
 * The steps of a deposit request follow it once it is PAID (the money module marks the request; the step's state has no
 * database tie to it): OPEN → PAID with the request's paidAt — the DEPOSIT step and, B-W2a-F2, a BEFORE_SHIPPING step
 * (its own request). Inside a command of the system or the office.
 */
export async function followDepositInCommand(tools: CommandTools, depositRequestId: string): Promise<string[]> {
  const request = await tools.tx.depositRequest.findUnique({ where: { id: depositRequestId }, select: { status: true, paidAt: true } })
  if (!request || request.status !== 'PAID' || request.paidAt === null) return []
  const steps = await tools.tx.salesOrderMilestone.findMany({ where: { depositRequestId, status: 'OPEN' }, select: { id: true, orderId: true, companyId: true }, orderBy: { id: 'asc' } })
  const paid: string[] = []
  for (const step of steps) {
    const { count } = await tools.tx.salesOrderMilestone.updateMany({ where: { id: step.id, status: 'OPEN' }, data: { status: 'PAID', paidAt: request.paidAt, updatedAt: tools.now, version: { increment: 1 } } })
    if (count !== 1) continue
    paid.push(step.id)
    const order = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: step.orderId }, select: { number: true } })
    tools.audit({ action: 'orders.schedulePaid', recordType: 'SalesOrder', recordId: step.orderId, companyId: step.companyId, before: { milestoneId: step.id, status: 'OPEN' }, after: { milestoneId: step.id, status: 'PAID', paidAt: toUtcIso(request.paidAt), depositRequestId } })
    tools.emit({ type: 'sales_order.schedule_changed', subject: step.orderId, companyId: step.companyId, payload: { orderId: step.orderId, number: order.number, change: 'PAID', milestoneIds: [step.id] } })
  }
  return paid
}

/** A step as the record's schedule card shows it. */
export function milestoneView(row: MilestoneRow) {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    label: row.label ?? MILESTONE_WORDS[row.kind],
    sharePct: row.sharePct === null ? null : decimalText(row.sharePct.toString()),
    amount: asMoney('price', row.amount),
    dueDate: dayOrNull(row.dueDate),
    depositRequestId: row.depositRequestId,
    status: row.status,
    paidAt: row.paidAt === null ? null : toUtcIso(row.paidAt),
    statusNote: row.statusNote,
    version: row.version,
  }
}

/**
 * orders.view: the order's payment schedule (the design's order.money.schedule card): its steps in order, the open total,
 * and `steps` empty for an order paid on invoice terms. Cancelled steps (remade or cancelled with the order) are listed
 * with their note, after the live ones.
 */
export async function getSchedule(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const rows = await readMilestones(client, order.id)
    const live = rows.filter((row) => row.status !== 'CANCELLED')
    return {
      orderId: order.id,
      number: order.number,
      currency: order.currency,
      grossAmount: asMoney('price', order.grossAmount),
      steps: live.map(milestoneView),
      cancelled: rows.filter((row) => row.status === 'CANCELLED').map(milestoneView),
      openAmount: asMoney('price', live.filter((row) => row.status === 'OPEN').reduce((sum, row) => sum + row.amount, 0)),
      paidAmount: asMoney('price', live.filter((row) => row.status === 'PAID').reduce((sum, row) => sum + row.amount, 0)),
    }
  })
}

// ---- the office opens a before-shipping step (B-W2a-F2) -----------------------------------------------------------------

/** The order states a before-shipping step is opened in: nothing has left yet (PARTLY_SHIPPED and later: goods left). */
const OPENABLE = ['CONFIRMED', 'IN_PRODUCTION', 'READY'] as const

export interface StepRequestBody {
  /** The step's version (the schedule's `version`): a stale one is refused. */
  readonly version: number
  /** The day it falls due; none: the step's own day (refused when it has none). */
  readonly dueDate?: BusinessDate | null | undefined
}

/**
 * orders.manage: a BEFORE_SHIPPING step's deposit request made now (B-W2a-F2), for a step that has none — an order made
 * before this step, or a step without its day when the order was made (no promise date): the customer can then pay it
 * as an advance before the goods leave, and the deposit flow issues its TD02 (DPR 633/1972 art. 6 c.4). ONE command: the
 * order's row, the step at its version (OPEN, BEFORE_SHIPPING, no request yet), the order still before shipping (no
 * goods left), the request (`stepRequestFor`: the step's amount, due the day given or the step's own, the deposit's
 * fiscal rule for the customer now), the step names it (and takes the day given), audit + sales_order.schedule_changed
 * REQUESTED. Refused in words: another kind of step (the deposit's request is made with the order; on delivery and on
 * the invoice fall due with the goods' invoice), a step settled or with its request already, goods that left, no day.
 */
export async function requestStep(caller: CommandCaller, orderId: string, milestoneId: string, body: StepRequestBody, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.requestStep', idempotencyKey, input: { orderId, milestoneId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockOrder(tx, order.id)
    const step = isUuid(milestoneId) ? await tx.salesOrderMilestone.findFirst({ where: { id: milestoneId, orderId: order.id }, select: { ...MILESTONE_COLUMNS, companyId: true, partyId: true } }) : null
    if (!step) throw new NotFoundError('Payment schedule step not found on this order.')
    if (step.version !== body.version) throw new StaleVersionError('SalesOrderMilestone', step.id, step.version, body.version)
    if (step.kind !== 'BEFORE_SHIPPING') {
      throw new InvalidStateError(
        step.kind === 'DEPOSIT'
          ? `The deposit step of order ${order.number} has its request from the order itself: only a step before shipping is opened here.`
          : `This step of order ${order.number} falls due with the invoice of the shipped goods (${MILESTONE_WORDS[step.kind].toLowerCase()}): it has no deposit request; only a step before shipping is opened here.`,
      )
    }
    if (step.status !== 'OPEN') throw new InvalidStateError(`This step of order ${order.number} is ${step.status.toLowerCase()}: there is nothing to ask.`)
    if (step.depositRequestId !== null) throw new InvalidStateError(`This step of order ${order.number} has its deposit request already: the customer pays it (payments: deposit received).`)
    if (!(OPENABLE as readonly string[]).includes(locked.status)) {
      throw new InvalidStateError(`Order ${order.number} is ${locked.status.toLowerCase().replace('_', ' ')}: a step before shipping is opened only while nothing has left (confirmed, in production or ready).`)
    }
    const left = await tx.shipment.findFirst({ where: { salesOrderId: order.id, shippedAt: { not: null } }, orderBy: { shippedAt: 'asc' }, select: { shippedAt: true } })
    if (left?.shippedAt) {
      throw new InvalidStateError(`Goods of order ${order.number} left on ${businessDate(left.shippedAt)}: what is still due is paid on the goods' invoice, not as an advance before shipping.`)
    }
    const dueDate = body.dueDate ?? dayOrNull(step.dueDate)
    if (dueDate === null) {
      throw new ValidationError('Say the day this step falls due.', [{ path: 'body/dueDate', message: `This step of order ${order.number} has no due day (the order had no promise date when it was made): give the day the customer pays it.` }])
    }
    const profile = await profileNow(tx, step.partyId, tools.now)
    const requestId = await createStepRequest(tools, { id: order.id, number: order.number, companyId: order.companyId, partyId: order.partyId, currency: order.currency }, { kind: step.kind, amount: step.amount, sharePct: step.sharePct === null ? null : step.sharePct.toFixed(4), dueDate }, profile, step.id)
    if (requestId === null) throw new InvalidStateError(`This step of order ${order.number} asks nothing.`)
    await tx.salesOrderMilestone.update({ where: { id: step.id }, data: { depositRequestId: requestId, dueDate: asDay(dueDate), updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'orders.requestStep',
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      before: { milestoneId: step.id, depositRequestId: null, dueDate: dayOrNull(step.dueDate) },
      after: { milestoneId: step.id, depositRequestId: requestId, dueDate },
    })
    tools.emit({ type: 'sales_order.schedule_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'REQUESTED', milestoneIds: [step.id] } })
    return { requestId }
  })
  return { ...(await getSchedule(caller, order.id)), depositRequestId: result.requestId }
}

// ---- the owner waives a deposit or a step before shipping (B-W2b-16) ----------------------------------------------------

export interface WaiveBody {
  /** The step's version (a step), or the request's (a deposit request without a step). */
  readonly version: number
  /** Why it is waived (stays on the step and the request). */
  readonly reason: string
}

/** What can be waived: an advance (the deposit, a balance before shipping), not a step that falls due with the invoice. */
const WAIVABLE_KINDS = ['DEPOSIT', 'BEFORE_SHIPPING'] as const

/**
 * orders.waive (+ a fresh step-up; design orders.depositRequest "Waive… (Owner)", quote.docs.deposit "Waive (Owner,
 * reason)"; B-W2a-F2's gap "no waive route for a step or a balance request"): the customer need not pay an advance. A
 * deposit or a before-shipping step (`target.milestoneId`), or a deposit request no step names (an order made before the
 * payment schedule, `target.requestId`). ONE command: the request's money lock FIRST (a payment holds it, then needs the
 * order's row for its TD02: the same order as the amendment's `lockStepRequests`), then the order's row, the step or the
 * request at its version; what payments placed on the request read under the lock: nothing (a part-paid request is
 * refused in words: the rest is billed on the goods' invoice); the step OPEN → WAIVED and its OPEN request → WAIVED, both
 * with the reason (statusNote; the database wants it). A waived deposit lets production start (the release's deposit
 * gate takes PAID or WAIVED); a waived balance is billed on the goods' invoice. Events sales_order.schedule_changed
 * WAIVED (a step) and deposit_request.waived (a request); audit rows on the order and the request.
 */
export async function waiveDeposit(
  caller: CommandCaller,
  orderId: string,
  target: { readonly milestoneId: string } | { readonly requestId: string },
  body: WaiveBody,
  stepUp: () => void | Promise<void>,
  idempotencyKey?: string,
) {
  const order = await officeOrder(caller, orderId, ORDERS_WAIVE)
  const reason = body.reason.trim()
  if (reason.length < 3 || reason.length > 500) throw new ValidationError('Say why it is waived.', [{ path: 'body/reason', message: 'Say why the customer need not pay it in advance (it stays on the step and the request).' }])
  await stepUp()
  const { result } = await command(caller, { name: 'orders.waiveDeposit', idempotencyKey, input: { orderId, ...target, ...body } }, async (tools) => {
    const { tx, now } = tools
    const stepColumns = { ...MILESTONE_COLUMNS, companyId: true, partyId: true } as const
    const seenStep = 'milestoneId' in target ? (isUuid(target.milestoneId) ? await tx.salesOrderMilestone.findFirst({ where: { id: target.milestoneId, orderId: order.id }, select: stepColumns }) : null) : null
    if ('milestoneId' in target && !seenStep) throw new NotFoundError('Payment schedule step not found on this order.')
    const requestId = 'requestId' in target ? target.requestId : (seenStep?.depositRequestId ?? null)
    // The request's money lock before the order's row (a payment takes them in that order).
    if (requestId !== null && isUuid(requestId)) await lockAll(tx, tools.context, 'deposit', [requestId])
    const locked = await lockOrder(tx, order.id)
    const request = requestId !== null && isUuid(requestId) ? await tx.depositRequest.findFirst({ where: { id: requestId, orderId: order.id }, select: { id: true, status: true, version: true } }) : null
    if ('requestId' in target && !request) throw new NotFoundError('Deposit request not found on this order.')
    const step = seenStep ? await tx.salesOrderMilestone.findUniqueOrThrow({ where: { id: seenStep.id }, select: stepColumns }) : null
    const steps = step ? [step] : await tx.salesOrderMilestone.findMany({ where: { orderId: order.id, depositRequestId: request!.id, status: 'OPEN' }, select: stepColumns })
    const versioned = step ?? request!
    if (versioned.version !== body.version) throw new StaleVersionError(step ? 'SalesOrderMilestone' : 'DepositRequest', versioned.id, versioned.version, body.version)
    if (locked.status === 'CANCELLED' || locked.status === 'CLOSED') throw new InvalidStateError(`Order ${order.number} is ${locked.status.toLowerCase()}: nothing on it is waived any more.`)
    for (const entry of steps) {
      if (!(WAIVABLE_KINDS as readonly string[]).includes(entry.kind)) {
        throw new InvalidStateError(`This step of order ${order.number} falls due with the invoice of the shipped goods (${MILESTONE_WORDS[entry.kind].toLowerCase()}): it is billed there, so there is no advance to waive.`)
      }
      if (entry.status !== 'OPEN') throw new InvalidStateError(`This step of order ${order.number} is ${entry.status.toLowerCase()}: there is nothing to waive.`)
    }
    if (request && request.status !== 'OPEN' && steps.length === 0) throw new InvalidStateError(`The deposit request is ${request.status.toLowerCase()}: there is nothing to waive.`)
    const paid = request ? ((await paidOnRequests(tx, [request.id])).get(request.id) ?? 0) : 0
    if (paid !== 0) {
      throw new InvalidStateError(`Money is already placed on this deposit request: it is not waived (the rest is billed on the goods' invoice, or take the allocation back in Finance first).`)
    }
    const note = `Waived: ${reason}`
    for (const entry of steps) {
      await tx.salesOrderMilestone.update({ where: { id: entry.id }, data: { status: 'WAIVED', statusNote: note, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    let waivedRequest: string | null = null
    if (request && request.status === 'OPEN') {
      await tx.depositRequest.update({ where: { id: request.id }, data: { status: 'WAIVED', statusNote: note, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      waivedRequest = request.id
      tools.audit({ action: 'orders.waiveDeposit', recordType: 'DepositRequest', recordId: request.id, companyId: order.companyId, before: { status: 'OPEN' }, after: { status: 'WAIVED', orderId: order.id, milestoneIds: steps.map((entry) => entry.id) }, reason })
      tools.emit({ type: 'deposit_request.waived', subject: request.id, companyId: order.companyId, payload: { depositRequestId: request.id, orderId: order.id, number: order.number, partyId: order.partyId, milestoneIds: steps.map((entry) => entry.id) } })
    }
    await tx.salesOrder.update({ where: { id: order.id }, data: { updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'orders.waiveStep',
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      before: { steps: steps.map((entry) => ({ milestoneId: entry.id, kind: entry.kind, status: 'OPEN' })), depositRequestId: request?.id ?? null },
      after: { steps: steps.map((entry) => ({ milestoneId: entry.id, kind: entry.kind, status: 'WAIVED', amount: markMoney('price', entry.amount) })), depositRequestId: waivedRequest },
      reason,
    })
    if (steps.length > 0) tools.emit({ type: 'sales_order.schedule_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'WAIVED', milestoneIds: steps.map((entry) => entry.id) } })
    return { milestoneIds: steps.map((entry) => entry.id), depositRequestId: waivedRequest }
  })
  return { ...(await getSchedule(caller, order.id)), waived: result }
}
