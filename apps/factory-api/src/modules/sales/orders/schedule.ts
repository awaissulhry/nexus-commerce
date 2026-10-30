import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { MILESTONE_WORDS, paymentScheduleOf, remadeSchedule, type PlannedMilestone, type StoredMilestone } from '@nexus/factory-domain/sales/orders/schedule'
import { instalmentsOf } from '@nexus/factory-domain/sales/terms/terms'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { officeOrder } from './moves'
import { asDay, dayOf, dayOrNull, type OrderRow, type Reader } from './store'

/**
 * An order's payment schedule (B-W2a-30; SAL-216; the design's order.money.schedule card): its SalesOrderMilestone rows,
 * made from its payment terms and deposit (factory-domain sales/orders/schedule) in the command that makes the order (at
 * acceptance, make.ts; typed by the office, manual.ts), made again after an amendment (amend.ts), a DEPOSIT step PAID
 * when its deposit request is (the worker's handler on payment.deposit_paid, handlers.ts), the OPEN steps cancelled with
 * the order (moves.ts cancelOrder). Steps are never deleted: a remade or cancelled step keeps its row with why
 * (statusNote). Amounts are price grain.
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

const stored = (row: MilestoneRow): StoredMilestone => ({ id: row.id, seq: row.seq, kind: row.kind, status: row.status, amount: row.amount, dueDate: dayOrNull(row.dueDate), depositRequestId: row.depositRequestId })

/** The terms' instalments of an order (none: no library terms, or terms not found). */
export async function instalmentsOfOrder(db: Reader, paymentTermsId: string | null) {
  if (paymentTermsId === null) return null
  const row = await db.paymentTerms.findUnique({ where: { id: paymentTermsId }, select: { instalments: true } })
  return row ? instalmentsOf(row.instalments) : null
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

async function insertSteps(tools: CommandTools, order: Pick<OrderRow, 'id' | 'companyId' | 'partyId'>, steps: readonly PlannedMilestone[]): Promise<string[]> {
  const ids: string[] = []
  for (const step of steps) {
    const id = newId()
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
        depositRequestId: step.depositRequestId,
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
  order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId' | 'grossAmount' | 'promiseDate' | 'paymentTermsId'>,
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
 * Inside an amendment's command, after the order's new totals: its OPEN steps made again for the new gross (the deposit
 * and the settled steps stay; factory-domain `remadeSchedule`). Returns what changed (nothing for an order without a
 * schedule or an unchanged plan) and what the kept steps cover beyond the new gross.
 */
export async function remakeScheduleInCommand(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId' | 'promiseDate' | 'paymentTermsId'>, gross: number, revision: number) {
  const rows = await readMilestones(tools.tx, order.id)
  const plan = remadeSchedule(rows.map(stored), { gross, instalments: await instalmentsOfOrder(tools.tx, order.paymentTermsId), promiseDate: dayOrNull(order.promiseDate) })
  if (plan.cancel.length === 0 && plan.insert.length === 0) return { cancelled: [] as string[], inserted: [] as string[], overpaid: plan.overpaid }
  const note = `Amendment ${revision}: the schedule was made again for the new total.`
  for (const id of plan.cancel) {
    await tools.tx.salesOrderMilestone.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CANCELLED', statusNote: note, updatedAt: tools.now, version: { increment: 1 } } })
  }
  const inserted = await insertSteps(tools, order, plan.insert)
  tools.audit({ action: 'orders.schedule', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { change: 'REMADE', revision, cancelled: plan.cancel, steps: stepAudit(plan.insert), overpaid: markMoney('price', plan.overpaid) } })
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
 * The DEPOSIT steps of a deposit request follow it once it is PAID (the money module marks the request; the step has no
 * database tie to it): OPEN → PAID with the request's paidAt. Inside a command of the system or the office.
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
