import { newId } from '@nexus/factory-domain/core/ids'
import { ORDER_OPTION_STATES } from '@nexus/factory-domain/sales/configurator/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'

/**
 * The picks travel (B-W2b-340; SAL-133; CF1:03): frozen on the quote line, copied as they are —
 *
 *   carryOptionsToRevision    quotes/send.ts revise: the new version's lines (by seq) take the options of the version they
 *                             were copied from (their frozen surcharges; the waterfall was copied with the price, B-W2b-330)
 *   carryOptionsToOrder       orders/make.ts: the order's lines take their quote lines' options (the surcharges as
 *                             accepted) while the order is CONFIRMED (the database takes options from CONFIRMED on); an
 *                             order that waits for a yes takes them when the yes confirms it (`orderOptionsHandler`)
 *   optionValueIdsOf          production/work-orders: each cell made from an order line names the values chosen on it
 *                             (WorkOrderSize.optionValueIds), so the release copies a routing step only for some options
 *                             when a cell has one of them (B-W2b-225's stepIsFor)
 */

const COLUMNS = { lineId: true, groupId: true, valueId: true, freeText: true, byDefault: true, colourId: true, itemId: true, itemColourId: true, surchargeAmount: true, surchargePct: true } as const
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** quotes/send.ts revise, after copyLines: the options of each line (by seq) onto the new version's line. */
export async function carryOptionsToRevision(tools: CommandTools, fromVersionId: string, toVersionId: string): Promise<void> {
  const { tx } = tools
  const from = await tx.quoteLine.findMany({ where: { versionId: fromVersionId }, select: { id: true, seq: true } })
  if (from.length === 0) return
  const rows = await tx.quoteLineOption.findMany({ where: { lineId: { in: from.map((line) => line.id) } }, select: COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (rows.length === 0) return
  const to = new Map((await tx.quoteLine.findMany({ where: { versionId: toVersionId }, select: { id: true, seq: true, partyId: true, kind: true } })).map((line) => [line.seq, line]))
  const seqOf = new Map(from.map((line) => [line.id, line.seq]))
  const actorId = actorIdOf(tools)
  let copied = 0
  for (const { lineId, ...row } of rows) {
    const target = to.get(seqOf.get(lineId) ?? -1)
    if (!target || target.kind === 'FEE') continue
    await tx.quoteLineOption.create({ data: { id: newId(), lineId: target.id, partyId: target.partyId, ...row, createdById: actorId }, select: { id: true } })
    copied++
  }
  tools.audit({ action: 'quotes.carryOptions', recordType: 'QuoteVersion', recordId: toVersionId, after: { fromVersionId, options: copied } })
}

/** The order's lines made from quote lines that have options, when the order has none of its own yet. */
async function optionsToCarry(tx: CommandTx, orderId: string) {
  const lines = await tx.salesOrderLine.findMany({ where: { orderId, quoteLineId: { not: null }, kind: { not: 'FEE' } }, select: { id: true, partyId: true, quoteLineId: true } })
  if (lines.length === 0) return { lines, rows: [], had: false }
  const had = (await tx.salesOrderLineOption.count({ where: { lineId: { in: lines.map((line) => line.id) } } })) > 0
  const rows = had ? [] : await tx.quoteLineOption.findMany({ where: { lineId: { in: lines.map((line) => line.quoteLineId!) } }, select: COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return { lines, rows, had }
}

async function writeOrderOptions(tools: CommandTools, plan: Awaited<ReturnType<typeof optionsToCarry>>): Promise<string[]> {
  const byQuoteLine = new Map(plan.lines.map((line) => [line.quoteLineId!, line]))
  const actorId = actorIdOf(tools)
  const touched = new Set<string>()
  for (const { lineId, ...row } of plan.rows) {
    const target = byQuoteLine.get(lineId)
    if (!target) continue
    await tools.tx.salesOrderLineOption.create({ data: { id: newId(), lineId: target.id, partyId: target.partyId, ...row, createdById: actorId }, select: { id: true } })
    touched.add(target.id)
  }
  return [...touched]
}

const OPEN = new Set<string>(ORDER_OPTION_STATES)

/** orders/make.ts, after the order's lines: their quote lines' options, when the order is CONFIRMED (else after its yes). */
export async function carryOptionsToOrder(tools: CommandTools, orderId: string): Promise<void> {
  const order = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, companyId: true, status: true } })
  const plan = await optionsToCarry(tools.tx, order.id)
  if (plan.rows.length === 0 && plan.lines.length === 0) return
  const quoteHasOptions = plan.lines.length > 0 && (await tools.tx.quoteLineOption.count({ where: { lineId: { in: plan.lines.map((line) => line.quoteLineId!) } } })) > 0
  if (!quoteHasOptions) return
  const lineIds = OPEN.has(order.status) ? await writeOrderOptions(tools, plan) : []
  tools.audit({ action: 'orders.carryOptions', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { lines: lineIds.length, ...(OPEN.has(order.status) ? {} : { waits: order.status }) } })
}

/** Whether a CONFIRMED order made from a quote still has its quote lines' options to take (read only, before a command). */
async function hasOptionsToCarry(client: CommandTx, orderId: string): Promise<boolean> {
  const order = await client.salesOrder.findUnique({ where: { id: orderId }, select: { status: true, quoteVersionId: true } })
  if (!order || order.quoteVersionId === null || !OPEN.has(order.status)) return false
  const plan = await optionsToCarry(client, orderId)
  return !plan.had && plan.rows.length > 0
}

/** The options of an order that waited for a yes, once it is CONFIRMED (a system command, once per order). */
export async function carryOptionsAfterYes(caller: CommandCaller, orderId: string, causationId?: string): Promise<{ lines: number }> {
  if (!(await caller.withClient((client) => hasOptionsToCarry(client, orderId)))) return { lines: 0 }
  const { result } = await command(caller, { name: 'orders.carryOptions', idempotencyKey: `order-options-${orderId}`, input: { orderId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${orderId}::uuid FOR UPDATE`
    const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, number: true, companyId: true, status: true } })
    // Checked again under the lock: a race that changed the order meanwhile writes nothing, and its audit row says so.
    const plan = OPEN.has(order.status) ? await optionsToCarry(tx, order.id) : null
    const lineIds = plan && !plan.had ? await writeOrderOptions(tools, plan) : []
    tools.audit({ action: 'orders.carryOptions', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { lines: lineIds.length, ...(plan && !plan.had ? {} : { skipped: plan ? 'HAS_OPTIONS' : order.status }) } })
    if (lineIds.length > 0) tools.emit({ type: 'sales_order.options_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, lineIds, change: 'COPIED' } })
    return { lines: lineIds.length }
  })
  return result
}

/** The worker's `sales.orderOptions` (background.ts): an order confirmed by its yes takes its quote lines' options. */
export function orderOptionsHandler(): EventHandler {
  return defineHandler({
    name: 'sales.orderOptions',
    events: ['sales_order.status_changed'],
    attempts: 5,
    async handle(event, { caller }) {
      const { orderId, from, to } = event.payload as { orderId: string; from: string; to: string }
      if (from !== 'PENDING_APPROVAL' || to !== 'CONFIRMED') return
      await carryOptionsAfterYes(caller, orderId, event.eventId)
    },
  })
}

/** production/work-orders: the values chosen on each order line (a cell made from it names them). */
export async function optionValueIdsOf(tx: CommandTx, lineIds: readonly string[]): Promise<Map<string, string[]>> {
  if (lineIds.length === 0) return new Map()
  const rows = await tx.salesOrderLineOption.findMany({ where: { lineId: { in: [...new Set(lineIds)] } }, select: { lineId: true, valueId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const values = out.get(row.lineId) ?? []
    if (!values.includes(row.valueId)) values.push(row.valueId)
    out.set(row.lineId, values)
  }
  return out
}
