import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { carriedDeliveries, scheduleFitProblem } from '@nexus/factory-domain/sales/quote-terms/rules'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { day } from '../quotes/store'

/**
 * What a quote's delivery terms and schedule carry (B-W2b-294; SAL-151 "carried to the order", SAL-162 "on the quote and
 * order"), called from W1's own steps (each call marked B-W2b-294 there):
 *
 *   carryToRevisionInCommand   quotes/send.ts reviseQuote: the new DRAFT version takes the Incoterm and place, ship complete,
 *                              the acceptance mode and each line's deliveries still ahead (lines matched by their place, seq;
 *                              a delivery whose day passed is left out, the rest of the line goes at the promise date)
 *   carryToOrderInCommand      orders/make.ts makeOrderInCommand: the order takes the accepted version's Incoterm, place and
 *                              ship complete, and each line's deliveries (its quote line's, the days still ahead). An order
 *                              that waits for a yes (PENDING_APPROVAL, B-W2b-304's credit hold) takes its schedule when the
 *                              yes confirms it: the database keeps an order's schedule to CONFIRMED, IN_PRODUCTION and READY
 *   orderScheduleHandler       the worker's `sales.orderSchedule` (sales_order.status_changed PENDING_APPROVAL → CONFIRMED):
 *                              that later carry, once (an order that already has a schedule is left as it is)
 *   assertScheduleFits         quotes/lines.ts editLine: a line's new sizes must keep what its schedule brings (the database
 *                              checks a delivery when it is written, not when its line's sizes change)
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const asDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

interface DeliveryRow {
  readonly lineId: string
  readonly deliveryDate: Date
  readonly sizeQuantities: Prisma.JsonValue
  readonly quantity: number
  readonly note: string | null
}

const DELIVERY_COLUMNS = { lineId: true, deliveryDate: true, sizeQuantities: true, quantity: true, note: true } as const

const sizesOf = (value: Prisma.JsonValue): Record<string, number> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

/** The deliveries still ahead of a set of quote lines, and those whose day passed. */
async function deliveriesOf(tx: CommandTx, lineIds: readonly string[], today: string): Promise<{ kept: DeliveryRow[]; passed: DeliveryRow[] }> {
  const rows = lineIds.length === 0 ? [] : await tx.quoteLineDelivery.findMany({ where: { lineId: { in: [...lineIds] } }, select: DELIVERY_COLUMNS, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
  const dated = rows.map((row) => ({ ...row, deliveryDate: day(row.deliveryDate)! }))
  const { kept, passed } = carriedDeliveries(dated, today)
  const back = (entry: (typeof dated)[number]): DeliveryRow => ({ ...entry, deliveryDate: asDate(entry.deliveryDate) })
  return { kept: kept.map(back), passed: passed.map(back) }
}

/** quotes/send.ts reviseQuote, after its copyLines: the terms and the schedule of the version it revises. */
export async function carryToRevisionInCommand(tools: CommandTools, fromVersionId: string, toVersionId: string): Promise<void> {
  const { tx, now } = tools
  const terms = await tx.quoteVersion.findUniqueOrThrow({ where: { id: fromVersionId }, select: { incoterm: true, incotermPlace: true, shipComplete: true, acceptanceMode: true, depositPct: true } })
  const target = await tx.quoteVersion.findUniqueOrThrow({ where: { id: toVersionId }, select: { depositPct: true, partyId: true } })
  await tx.quoteVersion.update({
    where: { id: toVersionId },
    data: { incoterm: terms.incoterm, incotermPlace: terms.incotermPlace, shipComplete: terms.shipComplete, acceptanceMode: target.depositPct === null ? 'SIGN' : terms.acceptanceMode },
    select: { id: true },
  })
  const from = await tx.quoteLine.findMany({ where: { versionId: fromVersionId }, select: { id: true, seq: true } })
  const to = new Map((await tx.quoteLine.findMany({ where: { versionId: toVersionId }, select: { id: true, seq: true } })).map((row) => [row.seq, row.id]))
  const { kept, passed } = await deliveriesOf(tx, from.map((line) => line.id), businessDate(now))
  const seqOf = new Map(from.map((line) => [line.id, line.seq]))
  const actorId = actorIdOf(tools)
  for (const delivery of kept) {
    const lineId = to.get(seqOf.get(delivery.lineId) ?? -1)
    if (!lineId) continue
    await tx.quoteLineDelivery.create({ data: { id: newId(), lineId, partyId: target.partyId, deliveryDate: delivery.deliveryDate, ...(delivery.sizeQuantities === null ? {} : { sizeQuantities: delivery.sizeQuantities as Prisma.InputJsonValue }), quantity: delivery.quantity, note: delivery.note, createdById: actorId }, select: { id: true } })
  }
  if (kept.length > 0 || passed.length > 0 || terms.incoterm !== null || terms.shipComplete) {
    tools.audit({
      action: 'quotes.carryTerms',
      recordType: 'QuoteVersion',
      recordId: toVersionId,
      after: { fromVersionId, incoterm: terms.incoterm, incotermPlace: terms.incotermPlace, shipComplete: terms.shipComplete, deliveries: kept.length, passed: passed.map((row) => ({ seq: seqOf.get(row.lineId) ?? null, deliveryDate: day(row.deliveryDate) })) },
    })
  }
}

const SCHEDULE_STATES = new Set(['CONFIRMED', 'IN_PRODUCTION', 'READY'])

/** The order's lines that came from quote lines, with the deliveries of those quote lines still ahead (its own: none yet). */
async function scheduleToCarry(tx: CommandTx, orderId: string, today: string) {
  const lines = await tx.salesOrderLine.findMany({ where: { orderId, quoteLineId: { not: null } }, select: { id: true, seq: true, quoteLineId: true, kind: true } })
  const own = lines.length === 0 ? 0 : await tx.salesOrderLineDelivery.count({ where: { lineId: { in: lines.map((line) => line.id) } } })
  if (own > 0) return { lines, kept: [] as DeliveryRow[], passed: [] as DeliveryRow[], had: true }
  const { kept, passed } = await deliveriesOf(tx, lines.flatMap((line) => (line.kind === 'FEE' ? [] : [line.quoteLineId!])), today)
  return { lines, kept, passed, had: false }
}

async function writeOrderSchedule(tools: CommandTools, order: { readonly id: string; readonly partyId: string }, plan: Awaited<ReturnType<typeof scheduleToCarry>>): Promise<number> {
  const byQuoteLine = new Map(plan.lines.map((line) => [line.quoteLineId!, line.id]))
  const actorId = actorIdOf(tools)
  let written = 0
  for (const delivery of plan.kept) {
    const lineId = byQuoteLine.get(delivery.lineId)
    if (!lineId) continue
    await tools.tx.salesOrderLineDelivery.create({ data: { id: newId(), lineId, partyId: order.partyId, deliveryDate: delivery.deliveryDate, ...(delivery.sizeQuantities === null ? {} : { sizeQuantities: delivery.sizeQuantities as Prisma.InputJsonValue }), quantity: delivery.quantity, note: delivery.note, createdById: actorId }, select: { id: true } })
    written++
  }
  return written
}

/** orders/make.ts, after the order and its lines: the accepted version's delivery terms and schedule on the order. */
export async function carryToOrderInCommand(tools: CommandTools, orderId: string): Promise<void> {
  const { tx, now } = tools
  const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true, status: true, quoteVersionId: true } })
  if (order.quoteVersionId === null) return
  const terms = await tx.quoteVersion.findUniqueOrThrow({ where: { id: order.quoteVersionId }, select: { incoterm: true, incotermPlace: true, shipComplete: true } })
  if (terms.incoterm !== null || terms.shipComplete) await tx.salesOrder.update({ where: { id: order.id }, data: { incoterm: terms.incoterm, incotermPlace: terms.incotermPlace, shipComplete: terms.shipComplete }, select: { id: true } })
  // An order that waits for a yes takes its schedule when the yes confirms it (orderScheduleHandler).
  const plan = SCHEDULE_STATES.has(order.status) ? await scheduleToCarry(tx, order.id, businessDate(now)) : null
  const written = plan ? await writeOrderSchedule(tools, order, plan) : 0
  if (terms.incoterm !== null || terms.shipComplete || written > 0 || (plan?.passed.length ?? 0) > 0 || plan === null) {
    tools.audit({
      action: 'orders.carryTerms',
      recordType: 'SalesOrder',
      recordId: order.id,
      companyId: order.companyId,
      after: { quoteVersionId: order.quoteVersionId, incoterm: terms.incoterm, incotermPlace: terms.incotermPlace, shipComplete: terms.shipComplete, deliveries: written, passed: (plan?.passed ?? []).map((row) => day(row.deliveryDate)), scheduleWaits: plan === null ? order.status : null },
    })
  }
}

/** The schedule of an order that waited for a yes, once it is CONFIRMED (a system command, once per order). */
export async function carryScheduleAfterYes(caller: CommandCaller, orderId: string, causationId?: string): Promise<{ written: number }> {
  const { result } = await command(caller, { name: 'orders.carrySchedule', idempotencyKey: `order-schedule-${orderId}`, input: { orderId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${orderId}::uuid FOR UPDATE`
    const order = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, companyId: true, partyId: true, status: true, quoteVersionId: true } })
    if (!order || order.quoteVersionId === null || !SCHEDULE_STATES.has(order.status)) return { written: 0 }
    const plan = await scheduleToCarry(tx, order.id, businessDate(now))
    if (plan.had) return { written: 0 }
    const written = await writeOrderSchedule(tools, order, plan)
    if (written > 0 || plan.passed.length > 0) tools.audit({ action: 'orders.carrySchedule', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { quoteVersionId: order.quoteVersionId, deliveries: written, passed: plan.passed.map((row) => day(row.deliveryDate)) } })
    return { written }
  })
  return result
}

/** The worker's `sales.orderSchedule` (background.ts): an order confirmed by its yes takes its quote's schedule. */
export function orderScheduleHandler(): EventHandler {
  return defineHandler({
    name: 'sales.orderSchedule',
    events: ['sales_order.status_changed'],
    attempts: 5,
    async handle(event, { caller }) {
      const { orderId, from, to } = event.payload as { orderId: string; from: string; to: string }
      if (from !== 'PENDING_APPROVAL' || to !== 'CONFIRMED') return
      await carryScheduleAfterYes(caller, orderId, event.eventId)
    },
  })
}

/** quotes/lines.ts editLine: the line's schedule must still fit its new sizes (409 in words before anything is written). */
export async function assertScheduleFits(tx: CommandTx, line: { readonly id: string; readonly seq: number }, nextSizes: readonly { readonly size: string; readonly quantity: number }[]): Promise<void> {
  const deliveries = await tx.quoteLineDelivery.findMany({ where: { lineId: line.id }, select: { deliveryDate: true, sizeQuantities: true } })
  const problem = scheduleFitProblem(line, nextSizes, deliveries.map((row) => ({ deliveryDate: day(row.deliveryDate)!, sizeQuantities: sizesOf(row.sizeQuantities) })))
  if (problem) throw new DomainError('conflict', problem, [{ path: 'body/sizes', message: problem }])
}
