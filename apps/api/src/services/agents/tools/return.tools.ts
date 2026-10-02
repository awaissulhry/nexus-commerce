/**
 * MCP full control 07 O12 — returns and refunds: `create-return`, `update-return`, `dispose-return-items`,
 * `issue-refund`. Each runs the service the Returns page runs (services/returns/return-actions.service.ts,
 * services/refunds/issue-refund.service.ts), in the caller's business only, and refuses a run whose approval no longer
 * describes the return (stale refused).
 *
 *   - create-return, update-return: Nexus only (no decision reaches the channel or the buyer); a person approves them in
 *     Nexus, or confirms them in Claude when the business allows it.
 *   - dispose-return-items: puts units back into stock (the channels then see it) or scraps them; always waits for a
 *     person in Nexus; cannot be undone by Claude.
 *   - issue-refund (decision OD3 = A): money leaves the business the moment it runs and cannot be taken back. Always
 *     waits for a person's click in Nexus (never confirm, never auto), capped at what is still refundable on the order.
 *     Only a refund the channel really makes is offered: eBay (live, no switch) and Shopify while its switch is live.
 *     Amazon refunds are made in Seller Central (Amazon has no refund call); Etsy and WooCommerce are not wired; a
 *     Shopify refund in dry run would mark the return refunded while no money moves — all refused, with where to do it.
 *
 * A return of an order Amazon ships (an FBA return, or the fail-closed test of amazon-fulfilled-order.ts) is Amazon's:
 * every tool here refuses it.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { auditLogService } from '../../audit-log.service.js'
import { amazonFulfilledRefusal } from '../../fulfillment/amazon-fulfilled-order.js'
import {
  CONDITION_GRADES, DISPOSITIONS, RETURN_TYPES, UNSELLABLE_GRADES, WARRANTY_RESOLUTIONS, WARRANTY_STATUSES,
  amazonKeepsReturn, authorizeRequestedReturn, createReturn, inspectReturn, receiveReturn, rejectRequestedReturn, restockReturn, scrapReturn,
  updateReturnWarranty, type ReturnWho, type WarrantyBody,
} from '../../returns/return-actions.service.js'
import { ACTIVE_REFUND_STATUSES, issueRefund, refundableOn } from '../../refunds/issue-refund.service.js'
import { getRefundChannelAdapterStatus } from '../../refunds/refund-publisher.service.js'
import { staleRefusal } from './stale-preview.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const toolLog = {
  warn: (...args: unknown[]) => logger.warn('[return tools]', { detail: String(args[1] ?? args[0]) }),
  error: (...args: unknown[]) => logger.error('[return tools]', { detail: String(args[1] ?? args[0]) }),
}
const who = (ctx: ToolContext): ReturnWho => ({ userId: ctx.userId ?? null, ip: null })
const unique = (list: string[]) => new Set(list).size === list.length
const id = (what: string) => z.string().trim().min(1).max(64).describe(what)

async function freshOrStale(preview: () => Promise<ToolResult>, ctx: ToolContext, fields: string[], what: string) {
  const fresh = await preview()
  if (!fresh.ok) return { refusal: fresh }
  const stale = staleRefusal(ctx.approvedPreview, fresh.preview, fields, what)
  return stale ? { refusal: { ok: false, error: stale } as ToolResult } : { fresh }
}

const MAX_RETURNS = 20
const MAX_LINES = 50
/** An order is returned only once it has left (one that has not is cancelled instead). */
const RETURNABLE_ORDER = ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED', 'RETURNED']
const AMAZON_RETURN = 'a return of an order Amazon ships (FBA or Multi-Channel Fulfilment) is Amazon\'s: Nexus mirrors it read-only'

/** The return as the tools read it; null when it is not in this business. */
async function loadReturn(returnId: string) {
  return prisma.return.findFirst({
    where: { id: returnId },
    select: {
      id: true, rmaNumber: true, status: true, channel: true, orderId: true, isFbaReturn: true, returnType: true, currencyCode: true, refundStatus: true,
      warrantyStatus: true, warrantyResolution: true, manufacturerRef: true,
      order: { select: { id: true, channelOrderId: true, channel: true, marketplace: true, currencyCode: true } },
      items: { select: { id: true, sku: true, productId: true, quantity: true, conditionGrade: true }, orderBy: { id: 'asc' } },
    },
  })
}
type LoadedReturn = NonNullable<Awaited<ReturnType<typeof loadReturn>>>
const nameOf = (ret: { id: string; rmaNumber: string | null; order?: { channelOrderId: string } | null }) =>
  `Return ${ret.rmaNumber ?? ret.id}${ret.order ? ` (order ${ret.order.channelOrderId})` : ''}`

// ── create-return ───────────────────────────────────────────────────────────────────────────────────

const createInput = z.object({
  orderId: id('Nexus order id (from order-search) the buyer returns from; it must have shipped'),
  items: z.array(z.object({
    orderItemId: id('the order line returned (its id from order-detail)'),
    quantity: z.number().int().min(1).max(999).describe('units of that line returned'),
  })).min(1).max(MAX_LINES).describe(`the lines returned and how many units of each (at most ${MAX_LINES} lines)`),
  reason: z.string().trim().min(3).max(300).optional().describe('why the buyer returns it, in a few words'),
  returnType: z.enum(RETURN_TYPES).optional().describe('STANDARD (change of mind; the default), WARRANTY or DEFECT (these start the warranty diagnosis)'),
})
type CreateArgs = z.infer<typeof createInput>

async function previewCreate(a: CreateArgs): Promise<ToolResult> {
  const order = await prisma.order.findFirst({
    where: { id: a.orderId, deletedAt: null },
    select: {
      id: true, channel: true, channelOrderId: true, marketplace: true, status: true, fulfillmentMethod: true, currencyCode: true,
      items: { select: { id: true, sku: true, productId: true, quantity: true } },
    },
  })
  if (!order) return { ok: false, error: 'Order not found' }
  const which = `Order ${order.channelOrderId}`
  if (await amazonFulfilledRefusal(prisma, order)) return { ok: false, error: `${which}: Amazon ships it (FBA or Multi-Channel Fulfilment), so Amazon handles its returns; they come into Nexus from Amazon's returns report. Nothing was queued.` }
  if (!RETURNABLE_ORDER.includes(order.status)) return { ok: false, error: `${which} is ${order.status}: only an order that has shipped is returned (one that has not is cancelled). Nothing was queued.` }
  const named = a.items.map((i) => i.orderItemId)
  if (!unique(named)) return { ok: false, error: 'An order line is named twice. Nothing was queued.' }
  // Units of each line already in a return that was not rejected.
  const earlier = await prisma.returnItem.groupBy({
    by: ['orderItemId'],
    where: { orderItemId: { in: named }, return: { orderId: order.id, status: { not: 'REJECTED' } } },
    _sum: { quantity: true },
  })
  const returnedOf = (lineId: string) => earlier.find((e) => e.orderItemId === lineId)?._sum.quantity ?? 0
  const lines = []
  for (const item of a.items) {
    const line = order.items.find((l) => l.id === item.orderItemId)
    if (!line) return { ok: false, error: `${which} has no line ${item.orderItemId} (see order-detail). Nothing was queued.` }
    const left = line.quantity - returnedOf(line.id)
    if (item.quantity > left) return { ok: false, error: `${which}, line ${line.sku}: ${item.quantity} units asked, ${left} of its ${line.quantity} not yet in a return. Nothing was queued.` }
    lines.push({ orderItemId: line.id, sku: line.sku, productId: line.productId, quantity: item.quantity, ordered: line.quantity, alreadyReturned: returnedOf(line.id) })
  }
  return {
    ok: true,
    preview: {
      action: 'create-return',
      order: { id: order.id, channel: order.channel, marketplace: order.marketplace, channelOrderId: order.channelOrderId, status: order.status, currencyCode: order.currencyCode },
      returnType: a.returnType ?? 'STANDARD',
      reason: a.reason ?? null,
      items: lines,
      note: 'Opens a return (RMA) in Nexus, REQUESTED. Nothing reaches the channel or the buyer; no stock moves and no money is refunded.',
    },
  }
}

const createReturnTool: AgentTool = {
  name: 'create-return',
  title: 'Open a return',
  input: createInput,
  requires: [F.returnsProcess],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { returnId?: string }
      const row = after.returnId ? await prisma.return.findFirst({ where: { id: after.returnId }, select: { id: true, rmaNumber: true, status: true } }) : null
      return row ? { returnId: row.id, rmaNumber: row.rmaNumber, status: row.status } : { returnId: after.returnId ?? null, status: 'gone' }
    },
    request(change) {
      const after = (change.after ?? {}) as { returnId?: string }
      return after.returnId
        ? { tool: 'update-return', args: { returns: [{ returnId: after.returnId, action: 'reject' }] } }
        : { refusal: 'This change opened no return.' }
    },
  },
  description:
    'Open a return (RMA) for an order of this business that has shipped: the lines and units the buyer sends back, '
    + 'the reason, and the type (STANDARD, WARRANTY, DEFECT). Nexus only: nothing reaches the channel or the buyer. '
    + 'Refused for an order Amazon ships (Amazon handles those returns) and for more units than a line has left. Waits '
    + 'for a person: approved in Nexus, or confirmed in Claude where the business allows it. Undo rejects the return '
    + 'while it is still REQUESTED.',
  handler: (args) => previewCreate(args as CreateArgs),
  async execute(args, ctx) {
    const a = args as CreateArgs
    const checked = await freshOrStale(() => previewCreate(a), ctx, ['order', 'items', 'returnType', 'reason'], 'the order')
    if ('refusal' in checked) return checked.refusal
    const p = checked.fresh.preview as { order: { id: string; channel: string; marketplace: string | null }; items: Array<{ orderItemId: string; sku: string; productId: string | null; quantity: number }> }
    // The approval is the idempotency key: a run carried out twice opens one return.
    const answer = await createReturn(
      {
        orderId: p.order.id, channel: p.order.channel, marketplace: p.order.marketplace ?? undefined, reason: a.reason, returnType: a.returnType ?? 'STANDARD', isFbaReturn: false,
        items: p.items.map((i) => ({ orderItemId: i.orderItemId, productId: i.productId ?? undefined, sku: i.sku, quantity: i.quantity })),
      },
      ctx.approvalId ? `agent-approval-${ctx.approvalId}` : null,
      who(ctx),
      toolLog,
    )
    if (!answer.ok) return { ok: false, error: answer.body?.error ?? `no return opened (${answer.status})` }
    const ret = answer.body as { id: string; rmaNumber: string | null; status: string }
    return {
      ok: true,
      data: { returnId: ret.id, rmaNumber: ret.rmaNumber, status: ret.status, items: p.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) },
      change: { before: { orderId: p.order.id, returnId: null }, after: { returnId: ret.id, rmaNumber: ret.rmaNumber, status: ret.status } },
    }
  },
}

// ── update-return ───────────────────────────────────────────────────────────────────────────────────

const UPDATE_ACTIONS = ['authorize', 'reject', 'receive', 'inspect', 'warranty'] as const
const updateInput = z.object({
  returns: z.array(z.object({
    returnId: id('Nexus return id (from return-search)'),
    action: z.enum(UPDATE_ACTIONS).describe('authorize or reject a REQUESTED return; receive it (it arrived); inspect it (grade its items); or warranty (the diagnosis of a WARRANTY or DEFECT return)'),
    warehouseId: id('receive: the warehouse it arrived at (from shipping-queue); omit for the default one').optional(),
    items: z.array(z.object({
      itemId: id('the return item (from return-search)'),
      grade: z.enum(CONDITION_GRADES).describe('its condition'),
      disposition: z.enum(DISPOSITIONS).optional().describe('where it goes; omit to derive it from the grade (NEW/LIKE_NEW/GOOD sellable, DAMAGED/UNUSABLE scrap)'),
      notes: z.string().trim().min(1).max(500).optional().describe('what the inspection found'),
      scrapReason: z.string().trim().min(1).max(200).optional().describe('for a scrapped item: why'),
    })).min(1).max(MAX_LINES).optional().describe(`inspect: the items and their grades (at most ${MAX_LINES})`),
    overallCondition: z.enum(CONDITION_GRADES).optional().describe('inspect: the condition of the return as a whole'),
    warrantyStatus: z.enum(WARRANTY_STATUSES).nullable().optional().describe('warranty: where the diagnosis stands'),
    warrantyResolution: z.enum(WARRANTY_RESOLUTIONS).nullable().optional().describe('warranty: the decision (a REFUND is then made with issue-refund)'),
    manufacturerRef: z.string().trim().min(1).max(100).nullable().optional().describe('warranty: the claim reference at the manufacturer'),
  })).min(1).max(MAX_RETURNS).describe(`the returns and what to do with each (at most ${MAX_RETURNS})`),
})
type UpdateArgs = z.infer<typeof updateInput>
type ReturnState = { returnId: string; rmaNumber: string | null; status: string; warrantyStatus: string | null; warrantyResolution: string | null; manufacturerRef: string | null }
const stateOf = (r: Pick<LoadedReturn, 'id' | 'rmaNumber' | 'status' | 'warrantyStatus' | 'warrantyResolution' | 'manufacturerRef'>): ReturnState =>
  ({ returnId: r.id, rmaNumber: r.rmaNumber, status: r.status, warrantyStatus: r.warrantyStatus, warrantyResolution: r.warrantyResolution, manufacturerRef: r.manufacturerRef })
type UpdateStep = { action: string; from: ReturnState; to: ReturnState; warehouseId?: string; items?: Array<{ itemId: string; sku: string; grade: string; disposition?: string; notes?: string; scrapReason?: string }>; overallCondition?: string }

async function previewUpdate(a: UpdateArgs): Promise<ToolResult> {
  if (!unique(a.returns.map((r) => r.returnId))) return { ok: false, error: 'A return is named twice. Nothing was queued.' }
  const steps: UpdateStep[] = []
  for (const item of a.returns) {
    const ret = await loadReturn(item.returnId)
    if (!ret) return { ok: false, error: `Return not found: ${item.returnId}. Nothing was queued.` }
    const refuse = (why: string): ToolResult => ({ ok: false, error: `${nameOf(ret)}: ${why}. Nothing was queued.` })
    if (await amazonKeepsReturn(ret)) return refuse(AMAZON_RETURN)
    const from = stateOf(ret)
    if (item.action === 'authorize' || item.action === 'reject') {
      if (ret.status !== 'REQUESTED') return refuse(`it is ${ret.status}; only a REQUESTED return is authorized or rejected`)
      steps.push({ action: item.action, from, to: { ...from, status: item.action === 'authorize' ? 'AUTHORIZED' : 'REJECTED' } })
    } else if (item.action === 'receive') {
      if (!['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT'].includes(ret.status)) return refuse(`it is ${ret.status}; it was received already or is closed`)
      if (item.warehouseId && !(await prisma.warehouse.findFirst({ where: { id: item.warehouseId }, select: { id: true } }))) return refuse(`warehouse ${item.warehouseId} not found`)
      steps.push({ action: 'receive', from, to: { ...from, status: 'RECEIVED' }, ...(item.warehouseId ? { warehouseId: item.warehouseId } : {}) })
    } else if (item.action === 'inspect') {
      if (!['RECEIVED', 'INSPECTING'].includes(ret.status)) return refuse(`it is ${ret.status}; a return is inspected once received`)
      if (!item.items?.length) return refuse('name the items and their grades')
      if (!unique(item.items.map((i) => i.itemId))) return refuse('an item is named twice')
      const graded = []
      for (const g of item.items) {
        const line = ret.items.find((l) => l.id === g.itemId)
        if (!line) return refuse(`it has no item ${g.itemId}`)
        graded.push({ itemId: line.id, sku: line.sku, grade: g.grade, ...(g.disposition ? { disposition: g.disposition } : {}), ...(g.notes ? { notes: g.notes } : {}), ...(g.scrapReason ? { scrapReason: g.scrapReason } : {}) })
      }
      steps.push({ action: 'inspect', from, to: { ...from, status: 'INSPECTING' }, items: graded, ...(item.overallCondition ? { overallCondition: item.overallCondition } : {}) })
    } else {
      if (ret.returnType !== 'WARRANTY' && ret.returnType !== 'DEFECT') return refuse(`it is a ${ret.returnType} return; only a WARRANTY or DEFECT return has a diagnosis`)
      if (item.warrantyStatus === undefined && item.warrantyResolution === undefined && item.manufacturerRef === undefined) return refuse('name a warrantyStatus, warrantyResolution or manufacturerRef')
      steps.push({
        action: 'warranty', from,
        to: {
          ...from,
          warrantyStatus: item.warrantyStatus !== undefined ? item.warrantyStatus : from.warrantyStatus,
          warrantyResolution: item.warrantyResolution !== undefined ? item.warrantyResolution : from.warrantyResolution,
          manufacturerRef: item.manufacturerRef !== undefined ? item.manufacturerRef : from.manufacturerRef,
        },
      })
    }
  }
  return {
    ok: true,
    preview: { action: 'update-return', returns: steps, note: 'Changes returns in Nexus only: nothing reaches the channel or the buyer, no stock moves and no money is refunded.' },
  }
}

const updateReturnTool: AgentTool = {
  name: 'update-return',
  title: 'Update returns',
  input: updateInput,
  requires: [F.returnsProcess],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { returns?: ReturnState[] }
      const rows = await prisma.return.findMany({
        where: { id: { in: (after.returns ?? []).map((r) => r.returnId) } },
        select: { id: true, rmaNumber: true, status: true, warrantyStatus: true, warrantyResolution: true, manufacturerRef: true },
      })
      return { returns: (after.returns ?? []).map((r) => { const row = rows.find((x) => x.id === r.returnId); return row ? stateOf(row) : { returnId: r.returnId, status: 'gone' } }) }
    },
    request(change) {
      const before = (change.before ?? {}) as { returns?: Array<ReturnState & { action: string }> }
      const steps = before.returns ?? []
      if (!steps.length) return { refusal: 'This change named no return.' }
      if (steps.some((s) => s.action !== 'warranty')) return { refusal: 'Authorizing, rejecting, receiving and inspecting a return are not taken back by Claude; only a warranty diagnosis is put back.' }
      return { tool: 'update-return', args: { returns: steps.map((s) => ({ returnId: s.returnId, action: 'warranty', warrantyStatus: s.warrantyStatus, warrantyResolution: s.warrantyResolution, manufacturerRef: s.manufacturerRef })) } }
    },
  },
  description:
    'Move returns of this business along in Nexus: authorize or reject a REQUESTED return, receive it (it arrived; '
    + 'optionally at which warehouse), inspect it (grade each item; the grade decides what a restock puts back), or '
    + 'record the warranty diagnosis of a WARRANTY/DEFECT return. Nexus only: nothing reaches the channel or the buyer, '
    + 'no stock moves (dispose-return-items does that) and no money is refunded (issue-refund). Refused for a return of '
    + 'an order Amazon ships. Waits for a person: approved in Nexus, or confirmed in Claude where the business allows '
    + 'it. Undo puts a warranty diagnosis back; the other steps are not taken back.',
  handler: (args) => previewUpdate(args as UpdateArgs),
  async execute(args, ctx) {
    const checked = await freshOrStale(() => previewUpdate(args as UpdateArgs), ctx, ['returns'], 'a return')
    if ('refusal' in checked) return checked.refusal
    const steps = (checked.fresh.preview as { returns: UpdateStep[] }).returns
    const done: UpdateStep[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const step of steps) {
      const returnId = step.from.returnId
      let error: string | null = null
      if (step.action === 'authorize' || step.action === 'reject') {
        const applied = step.action === 'authorize' ? await authorizeRequestedReturn(returnId) : await rejectRequestedReturn(returnId)
        if (applied.ok === false) error = applied.error
        else void auditLogService.write({ ...who(ctx), entityType: 'Return', entityId: returnId, action: step.action === 'authorize' ? 'approve' : 'deny', metadata: { via: ctx.via } })
      } else {
        const answer = step.action === 'receive' ? await receiveReturn(returnId, { warehouseId: step.warehouseId }, who(ctx), toolLog)
          : step.action === 'inspect'
            ? await inspectReturn(returnId, {
              items: (step.items ?? []).map((i) => ({ itemId: i.itemId, conditionGrade: i.grade, notes: i.notes, disposition: i.disposition, scrapReason: i.scrapReason })),
              overallCondition: step.overallCondition,
            }, who(ctx))
            : await updateReturnWarranty(returnId, { warrantyStatus: step.to.warrantyStatus, warrantyResolution: step.to.warrantyResolution, manufacturerRef: step.to.manufacturerRef } satisfies WarrantyBody, who(ctx))
        if (!answer.ok) error = answer.body?.error ?? String(answer.status)
      }
      if (error) { failed.push({ id: returnId, error }); continue }
      done.push(step)
    }
    // What ran is recorded (a warranty step can be undone); what failed is said.
    if (!done.length) return { ok: false, error: `Nothing changed: ${failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
    return {
      ok: true,
      data: { updated: done.length, failed, returns: done.map((s) => ({ returnId: s.to.returnId, action: s.action, status: s.to.status })) },
      change: { before: { returns: done.map((s) => ({ ...s.from, action: s.action })) }, after: { returns: done.map((s) => s.to) } },
    }
  },
}

// ── dispose-return-items ────────────────────────────────────────────────────────────────────────────

const disposeInput = z.object({
  returns: z.array(z.object({
    returnId: id('Nexus return id (from return-search); it must be inspected (INSPECTING)'),
    action: z.enum(['restock', 'scrap']).describe('restock: its sellable items go back into stock; scrap: nothing goes back (it is closed as SCRAPPED)'),
    warehouseId: id('restock: the warehouse the units go to (from shipping-queue); omit for the default one').optional(),
  })).min(1).max(MAX_RETURNS).describe(`the inspected returns and what to do with each (at most ${MAX_RETURNS})`),
})
type DisposeArgs = z.infer<typeof disposeInput>

async function previewDispose(a: DisposeArgs): Promise<ToolResult> {
  if (!unique(a.returns.map((r) => r.returnId))) return { ok: false, error: 'A return is named twice. Nothing was queued.' }
  const plans = []
  let unitsBack = 0
  for (const item of a.returns) {
    const ret = await loadReturn(item.returnId)
    if (!ret) return { ok: false, error: `Return not found: ${item.returnId}. Nothing was queued.` }
    const refuse = (why: string): ToolResult => ({ ok: false, error: `${nameOf(ret)}: ${why}. Nothing was queued.` })
    if (await amazonKeepsReturn(ret)) return refuse('Amazon keeps the units of a return of an order it ships (FBA or Multi-Channel Fulfilment); Nexus does not put them into its own stock')
    if (ret.status !== 'INSPECTING') return refuse(`it is ${ret.status}; a return is restocked or scrapped once inspected (update-return inspect)`)
    let warehouse: { id: string; code: string } | null = null
    if (item.action === 'restock') {
      const ungraded = ret.items.filter((i) => i.productId && !i.conditionGrade)
      if (ungraded.length) return refuse(`grade ${ungraded.map((i) => i.sku).join(', ')} first (update-return inspect)`)
      warehouse = item.warehouseId
        ? await prisma.warehouse.findFirst({ where: { id: item.warehouseId }, select: { id: true, code: true } })
        : await prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true, code: true } })
      if (item.warehouseId && !warehouse) return refuse(`warehouse ${item.warehouseId} not found`)
    }
    const lines = ret.items.map((i) => {
      const back = item.action === 'restock' && !!i.productId && !(UNSELLABLE_GRADES as readonly string[]).includes(i.conditionGrade ?? '')
      if (back) unitsBack += i.quantity
      return {
        sku: i.sku, quantity: i.quantity, grade: i.conditionGrade,
        outcome: back ? 'back in stock' : item.action === 'scrap' ? 'scrapped (it never entered stock)' : !i.productId ? 'skipped: no product in Nexus' : `skipped: ${i.conditionGrade}`,
      }
    })
    plans.push({
      returnId: ret.id, rmaNumber: ret.rmaNumber, orderNumber: ret.order?.channelOrderId ?? null, action: item.action, from: ret.status,
      to: item.action === 'restock' ? 'RESTOCKED' : 'SCRAPPED',
      ...(item.action === 'restock' ? { warehouse: warehouse ? warehouse.code : 'the default stock location' } : {}),
      items: lines,
    })
  }
  return {
    ok: true,
    preview: {
      action: 'dispose-return-items',
      returns: plans,
      unitsBackInStock: unitsBack,
      note: 'Restocked units go back to the shared stock their order took them from, else to the warehouse shown; the channels then see the new stock. It cannot be undone by Claude (a stock correction can).',
    },
  }
}

const disposeTool: AgentTool = {
  name: 'dispose-return-items',
  title: 'Restock or scrap returns',
  input: disposeInput,
  requires: [F.returnsProcess, F.inventoryAdjust],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Close inspected returns of this business: restock (each item graded NEW, LIKE_NEW or GOOD goes back into stock — '
    + 'to the shared stock its order took it from, else to the warehouse named or the default one — and the channels see '
    + 'the new stock) or scrap (nothing goes back). Refused before inspection, for an ungraded item, and for a return of '
    + 'an order Amazon ships (Amazon keeps those units). Always waits for a person to approve it in Nexus; Claude cannot '
    + 'undo it.',
  handler: (args) => previewDispose(args as DisposeArgs),
  async execute(args, ctx) {
    const checked = await freshOrStale(() => previewDispose(args as DisposeArgs), ctx, ['returns', 'unitsBackInStock'], 'a return')
    if ('refusal' in checked) return checked.refusal
    const plans = (checked.fresh.preview as { returns: Array<{ returnId: string; action: string; from: string; to: string }> }).returns
    const a = args as DisposeArgs
    const done: typeof plans = []
    const failed: Array<{ id: string; error: string }> = []
    for (const plan of plans) {
      const warehouseId = a.returns.find((r) => r.returnId === plan.returnId)?.warehouseId
      const answer = plan.action === 'restock'
        ? await restockReturn(plan.returnId, warehouseId ? { warehouseId } : {}, who(ctx), toolLog)
        : await scrapReturn(plan.returnId, who(ctx), toolLog)
      if (!answer.ok) { failed.push({ id: plan.returnId, error: answer.body?.error ?? String(answer.status) }); continue }
      done.push(plan)
    }
    if (!done.length) return { ok: false, error: `Nothing changed: ${failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
    return {
      ok: true,
      data: { done: done.map((p) => ({ returnId: p.returnId, action: p.action, status: p.to })), failed },
      change: { before: { returns: done.map((p) => ({ returnId: p.returnId, status: p.from })) }, after: { returns: done.map((p) => ({ returnId: p.returnId, status: p.to })) } },
    }
  },
}

// ── issue-refund ────────────────────────────────────────────────────────────────────────────────────

const refundInput = z.object({
  returnId: id('Nexus return id (from return-search) the refund is for'),
  amount: z.number().positive().max(100_000).describe('the amount to refund, in the order\'s currency (e.g. 24.90); at most what is still refundable on the order'),
  reason: z.string().trim().min(3).max(300).optional().describe('the reason the channel is given (eBay: the refund comment)'),
})
type RefundArgs = z.infer<typeof refundInput>

/** How the return's channel refunds, from the switch the publisher itself reads; null when Nexus cannot make the refund. */
function channelRefundOf(channel: string): { mode: string } | { refusal: string } {
  const adapter = getRefundChannelAdapterStatus().find((s) => s.channel === channel)
  if (channel === 'AMAZON') return { refusal: 'an Amazon refund is made in Seller Central (Amazon has no refund call Nexus can make; for an order Amazon ships, Amazon refunds the buyer itself). Do it in Seller Central; the Returns page can then record it' }
  if (channel === 'EBAY' && adapter?.mode === 'real') return { mode: 'live: eBay refunds the buyer at once (real money; eBay refunds have no switch)' }
  if (channel === 'SHOPIFY') {
    return adapter?.mode === 'real'
      ? { mode: 'live: Shopify refunds the buyer at once (NEXUS_ENABLE_SHOPIFY_REFUND on)' }
      : { refusal: 'Shopify refunds are a dry run here (NEXUS_ENABLE_SHOPIFY_REFUND off): Nexus would mark it refunded while no money moves. Refund it in Shopify; the Returns page can then record it' }
  }
  return { refusal: `Nexus cannot refund on ${channel} (not wired). Refund it in ${channel}; the Returns page can then record it` }
}

async function previewRefund(a: RefundArgs): Promise<ToolResult> {
  const cents = Math.round(a.amount * 100)
  if (Math.abs(cents - a.amount * 100) > 1e-6) return { ok: false, error: 'Give the amount with at most two decimals. Nothing was queued.' }
  const ret = await loadReturn(a.returnId)
  if (!ret) return { ok: false, error: 'Return not found' }
  const refuse = (why: string): ToolResult => ({ ok: false, error: `${nameOf(ret)}: ${why}. Nothing was queued.` })
  if (ret.isFbaReturn) return refuse('Amazon refunds the buyer of an order it ships itself; nothing to refund from Nexus')
  const channel = channelRefundOf(ret.channel)
  if ('refusal' in channel) return refuse(channel.refusal)
  if (!ret.order) return refuse('it has no order, so neither the channel nor the cap can be worked out; refund it on the Returns page')
  if (ret.status === 'REJECTED') return refuse('it was rejected')
  const active = await prisma.refund.findFirst({ where: { returnId: ret.id, channelStatus: { in: [...ACTIVE_REFUND_STATUSES] } }, select: { channelStatus: true } })
  if (active) return refuse(`it has a refund already (${active.channelStatus}); one refund per return`)
  const cap = await refundableOn(ret.order.id)
  if (!cap) return refuse('its order is not found')
  if ((ret.currencyCode || 'EUR') !== cap.currencyCode) return refuse(`its currency (${ret.currencyCode}) is not its order's (${cap.currencyCode}); refund it on the Returns page`)
  const eur = (c: number) => Number((c / 100).toFixed(2))
  if (cents > cap.leftCents) return refuse(`${a.amount.toFixed(2)} ${cap.currencyCode} is more than is still refundable on the order: ${eur(cap.leftCents).toFixed(2)} ${cap.currencyCode} (paid ${eur(cap.paidCents).toFixed(2)}, refunded ${eur(cap.refundedCents).toFixed(2)})`)
  return {
    ok: true,
    preview: {
      action: 'issue-refund',
      return: { id: ret.id, rmaNumber: ret.rmaNumber, status: ret.status, channel: ret.channel },
      order: { id: ret.order.id, channel: ret.order.channel, marketplace: ret.order.marketplace, channelOrderId: ret.order.channelOrderId },
      refund: { amount: eur(cents), currencyCode: cap.currencyCode },
      refundable: { paid: eur(cap.paidCents), refunded: eur(cap.refundedCents), leftAfter: eur(cap.leftCents - cents), currencyCode: cap.currencyCode },
      reason: a.reason ?? null,
      channelRefund: channel.mode,
      note: `${eur(cents).toFixed(2)} ${cap.currencyCode} leaves your account to the buyer. A refund cannot be taken back.`,
    },
  }
}

const issueRefundTool: AgentTool = {
  name: 'issue-refund',
  title: 'Refund a return',
  input: refundInput,
  requires: [F.returnsProcess, F.ordersRefund],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Refund the buyer of a return of this business, through its channel: eBay (live; eBay refunds have no switch) or '
    + 'Shopify (when its refund switch is live). Capped at what is still refundable on the order (what it paid less its '
    + 'refunds); one refund per return. Refused for Amazon (refunds are made in Seller Central), for a channel Nexus '
    + 'cannot refund on, and for a Shopify refund in dry run. Money leaves the business when it runs: it always waits '
    + 'for a person to approve it in Nexus and cannot be undone. If the return or the order changes before the approval '
    + 'runs, nothing is refunded.',
  handler: (args) => previewRefund(args as RefundArgs),
  async execute(args, ctx) {
    const a = args as RefundArgs
    const checked = await freshOrStale(() => previewRefund(a), ctx, ['return', 'order', 'refund', 'refundable', 'channelRefund'], 'the return')
    if ('refusal' in checked) return checked.refusal
    const p = checked.fresh.preview as { return: { id: string; status: string }; refund: { amount: number; currencyCode: string } }
    const answer = await issueRefund(a.returnId, { refundCents: Math.round(a.amount * 100), kind: 'CASH', reason: a.reason }, ctx.userId ?? null, who(ctx), toolLog)
    if (!answer.ok) {
      const body = answer.body as { error?: string; channelError?: string } | undefined
      return answer.status === 502
        ? { ok: false, error: `The channel refused the refund: ${body?.channelError ?? body?.error ?? 'unknown error'}. No money moved; the return shows the failure on the Returns page, where it can be retried.` }
        : { ok: false, error: body?.error ?? `not refunded (${answer.status})` }
    }
    const body = answer.body as { refundId: string; channelOutcome: string; channelRefundId?: string | null; status: string }
    return {
      ok: true,
      data: { returnId: a.returnId, refundId: body.refundId, refund: p.refund, channelOutcome: body.channelOutcome, channelRefundId: body.channelRefundId ?? null, returnStatus: body.status },
      change: { before: { returnId: a.returnId, status: p.return.status }, after: { returnId: a.returnId, status: body.status, refundId: body.refundId } },
    }
  },
}

export const RETURN_TOOLS: AgentTool[] = [createReturnTool, updateReturnTool, disposeTool, issueRefundTool]
