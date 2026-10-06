/**
 * MCP full control 07 O8 — shipments and labels: `create-shipments`, `update-shipment`, `buy-shipping-label` (a return
 * label too), `void-shipping-label`.
 *
 * They write through services/fulfillment/shipment.service.ts and services/returns/return-label.service.ts — the code
 * the Outbound and Returns pages run — in the caller's business only. An order Amazon ships (FBA, Multi-Channel
 * Fulfilment; the fail-closed test of amazon-fulfilled-order.ts) never gets a shipment or a label. A label costs money:
 * every label preview gives its estimated price from the carriers' own rate read and says per carrier whether the
 * purchase is live or a dry run (NEXUS_ENABLE_SENDCLOUD_REAL, NEXUS_ENABLE_AMAZON_BUY_SHIPPING). Inside a business's
 * limits (labels per call, € per label, € in total) a label may be confirmed in Claude; above them a person approves
 * it in Nexus. A run whose approval no longer describes the shipments is refused (stale-preview.ts).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { amazonFulfilledRefusal } from '../../fulfillment/amazon-fulfilled-order.js'
import { shipmentRates } from '../../fulfillment/shipment-read.service.js'
import {
  bulkCreateShipments,
  cancelUnlabelledShipment,
  holdShipment,
  markShipmentShipped,
  printShipmentLabel,
  releaseShipment,
  restoreShipmentService,
  setManualTrackingNumber,
  UNLABELLED_STATUSES,
  voidShipmentLabel,
} from '../../fulfillment/shipment.service.js'
import { generateReturnLabel } from '../../returns/return-label.service.js'
import { schedulePickup } from '../../fulfillment/pickup.service.js'
import { TRACKING_UPLOAD_CHANNELS, trackingUploadMode } from '../../fulfillment/tracking-upload.service.js'
import { staleRefusal } from './stale-preview.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const CARRIERS = ['SENDCLOUD', 'AMAZON_BUY_SHIPPING', 'MANUAL'] as const
const LABEL_STATUSES = ['DRAFT', 'READY_TO_PICK', 'PICKED', 'PACKED'] as const
const MAX_ORDERS = 200
const MAX_LABELS = 50
const MAX_RETURN_LABELS = 20
const toolLog = { warn: (...args: unknown[]) => logger.warn('[shipping tools]', { detail: String(args[1] ?? args[0]) }), error: (...args: unknown[]) => logger.error('[shipping tools]', { detail: String(args[1] ?? args[0]) }) }
const ids = (what: string, max: number) => z.array(z.string().trim().min(1).max(64)).min(1).max(max).describe(what)
const unique = (list: string[]) => new Set(list).size === list.length

/** The carriers' modes, from the switches the label purchase itself reads. */
export function carrierModes() {
  return {
    sendcloud: process.env.NEXUS_ENABLE_SENDCLOUD_REAL === 'true' ? 'live: a label is bought and charged' : 'dry run: no label is bought',
    amazonBuyShipping: process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING ? 'live: a label is bought and charged' : 'off: no Buy Shipping label is bought',
  }
}

async function freshOrStale(preview: () => Promise<ToolResult>, ctx: ToolContext, fields: string[], what: string) {
  const fresh = await preview()
  if (!fresh.ok) return { refusal: fresh }
  const stale = staleRefusal(ctx.approvedPreview, fresh.preview, fields, what)
  return stale ? { refusal: { ok: false, error: stale } as ToolResult } : { fresh }
}

// ── create-shipments ────────────────────────────────────────────────────────────────────────────────

const createInput = z.object({
  orderIds: ids(`Nexus order ids to make a shipment for (at most ${MAX_ORDERS})`, MAX_ORDERS),
  warehouseId: z.string().trim().min(1).max(64).optional().describe('ship from this warehouse; omit to let the routing rules choose'),
  carrierCode: z.enum(CARRIERS).optional().describe('the carrier; omit to let the shipping rules choose'),
})
type CreateArgs = z.infer<typeof createInput>

export const CREATE_SHIPMENTS_LIMITS = z.object({
  maxOrders: z.number().int().min(1).max(MAX_ORDERS).default(20).describe('the most shipments made in one change without a person'),
})

/** create-shipments' dry run: which orders get a shipment, which are skipped and why. */
async function previewCreate(a: CreateArgs): Promise<ToolResult> {
  if (!unique(a.orderIds)) return { ok: false, error: 'An order is named twice. Nothing was queued.' }
  const orders = await prisma.order.findMany({
    where: { id: { in: a.orderIds }, deletedAt: null },
    select: { id: true, channel: true, channelOrderId: true, status: true, fulfillmentMethod: true, shipments: { where: { status: { not: 'CANCELLED' } }, select: { id: true } } },
  })
  if (!orders.length) return { ok: false, error: 'Order not found' }
  const create: Array<{ orderId: string; channel: string; channelOrderId: string; status: string }> = []
  const skipped: Array<{ orderId: string; reason: string }> = []
  for (const id of a.orderIds) {
    const order = orders.find((o) => o.id === id)
    if (!order) { skipped.push({ orderId: id, reason: 'order not found' }); continue }
    if (order.shipments.length) { skipped.push({ orderId: id, reason: 'it already has a shipment' }); continue }
    const amazon = await amazonFulfilledRefusal(prisma, order)
    if (amazon) { skipped.push({ orderId: id, reason: amazon.error }); continue }
    if (!['PENDING', 'PROCESSING', 'ON_HOLD', 'PARTIALLY_SHIPPED'].includes(order.status)) { skipped.push({ orderId: id, reason: `it is ${order.status}` }); continue }
    create.push({ orderId: id, channel: order.channel, channelOrderId: order.channelOrderId, status: order.status })
  }
  if (!create.length) return { ok: false, error: `No shipment to make: ${skipped.map((s) => `${s.orderId} (${s.reason})`).join('; ')}. Nothing was queued.` }
  return {
    ok: true,
    preview: {
      action: 'create-shipments',
      create,
      skipped,
      warehouse: a.warehouseId ?? 'by your routing rules',
      carrier: a.carrierCode ?? 'by your shipping rules (Sendcloud when none applies)',
      note: 'Makes draft shipments in Nexus; no label is bought and nothing reaches a carrier or a channel.',
    },
  }
}

const createShipments: AgentTool = {
  name: 'create-shipments',
  title: 'Create shipments',
  input: createInput,
  requires: [F.outboundManage],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: CREATE_SHIPMENTS_LIMITS,
  withinLimits(preview, limits) {
    const count = ((preview as { create?: unknown[] } | null)?.create ?? null)?.length
    if (count == null) return 'there is no preview of the change to judge'
    return count > Number(limits.maxOrders) ? `it makes ${count} shipments, more than the ${limits.maxOrders} allowed without a person` : null
  },
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { shipmentIds?: string[] }
      const rows = await prisma.shipment.findMany({
        where: { id: { in: after.shipmentIds ?? [] }, deletedAt: null, status: { in: [...UNLABELLED_STATUSES] }, labelUrl: null, sendcloudParcelId: null },
        select: { id: true },
      })
      return { shipmentIds: (after.shipmentIds ?? []).filter((id) => rows.some((row) => row.id === id)) }
    },
    request(change) {
      const after = (change.after ?? {}) as { shipmentIds?: string[] }
      if (!after.shipmentIds?.length) return { refusal: 'This change made no shipment.' }
      return { tool: 'update-shipment', args: { shipments: after.shipmentIds.map((shipmentId) => ({ shipmentId, action: 'cancel' })) } }
    },
  },
  description:
    'Make draft shipments for orders this business ships (never for an order Amazon ships), by the routing and shipping '
    + 'rules unless a warehouse or carrier is named. No label is bought. Waits for a person to approve it in Nexus unless '
    + 'the business lets it run inside its limits. Undo cancels the shipments it made while they have no label.',
  handler: (args) => previewCreate(args as CreateArgs),
  async execute(args, ctx) {
    const a = args as CreateArgs
    const checked = await freshOrStale(() => previewCreate(a), ctx, ['create'], 'an order')
    if ('refusal' in checked) return checked.refusal
    const create = (checked.fresh.preview as { create: Array<{ orderId: string }> }).create.map((c) => c.orderId)
    const answer = await bulkCreateShipments({ orderIds: create, warehouseId: a.warehouseId, carrierCode: a.carrierCode }, toolLog)
    if (!answer.ok) return { ok: false, error: answer.body?.error ?? `could not create (${answer.status})` }
    const made = await prisma.shipment.findMany({ where: { orderId: { in: create }, status: { not: 'CANCELLED' }, deletedAt: null }, select: { id: true, orderId: true, status: true } })
    return {
      ok: true,
      data: { created: answer.body.created, errors: answer.body.errors, shipments: made },
      change: { before: { orderIds: create }, after: { shipmentIds: made.map((m) => m.id).sort() } },
    }
  },
}

// ── update-shipment ─────────────────────────────────────────────────────────────────────────────────

const ACTIONS = ['hold', 'release', 'cancel', 'service'] as const
const updateInput = z.object({
  shipments: z.array(z.object({
    shipmentId: z.string().trim().min(1).max(64).describe('Nexus shipment id'),
    action: z.enum(ACTIONS).describe('hold (pause it), release (from hold), cancel (no label yet), or service (change carrier/service)'),
    reason: z.string().trim().min(1).max(300).optional().describe('hold: why it is held'),
    carrierCode: z.enum(CARRIERS).optional().describe('service: the carrier'),
    serviceCode: z.string().trim().min(1).max(100).nullable().optional().describe('service: the carrier service id (from shipping-rates); null for none'),
    serviceName: z.string().trim().min(1).max(200).nullable().optional().describe('service: its name'),
  })).min(1).max(MAX_LABELS).describe(`the shipments and what to do with each (at most ${MAX_LABELS})`),
})
type UpdateArgs = z.infer<typeof updateInput>
type ShipmentState = { shipmentId: string; status: string; heldReason: string | null; carrierCode: string; serviceCode: string | null; serviceName: string | null }

const stateSelect = { id: true, status: true, heldReason: true, carrierCode: true, serviceCode: true, serviceName: true, labelUrl: true, sendcloudParcelId: true, order: { select: { channelOrderId: true } } } as const
const stateOf = (row: { id: string; status: string; heldReason: string | null; carrierCode: string; serviceCode: string | null; serviceName: string | null }): ShipmentState =>
  ({ shipmentId: row.id, status: row.status, heldReason: row.heldReason, carrierCode: row.carrierCode, serviceCode: row.serviceCode, serviceName: row.serviceName })

async function previewUpdate(a: UpdateArgs): Promise<ToolResult> {
  const named = a.shipments.map((s) => s.shipmentId)
  if (!unique(named)) return { ok: false, error: 'A shipment is named twice. Nothing was queued.' }
  const rows = await prisma.shipment.findMany({ where: { id: { in: named }, deletedAt: null }, select: stateSelect })
  const missing = named.filter((id) => !rows.some((row) => row.id === id))
  if (missing.length) return { ok: false, error: `Shipment not found: ${missing.join(', ')}. Nothing was queued.` }
  const steps = []
  for (const item of a.shipments) {
    const row = rows.find((r) => r.id === item.shipmentId)!
    const labelled = !(UNLABELLED_STATUSES as readonly string[]).includes(row.status) || !!row.labelUrl || !!row.sendcloudParcelId
    const refuse = (why: string) => ({ ok: false as const, error: `Shipment ${row.id}${row.order ? ` (order ${row.order.channelOrderId})` : ''}: ${why}. Nothing was queued.` })
    const from = stateOf(row)
    let to: ShipmentState
    if (item.action === 'hold') {
      if (labelled || row.status === 'ON_HOLD') return refuse(row.status === 'ON_HOLD' ? 'it is already on hold' : `a ${row.status} shipment cannot be held; void its label first`)
      to = { ...from, status: 'ON_HOLD', heldReason: item.reason ?? 'Manually held by operator' }
    } else if (item.action === 'release') {
      if (row.status !== 'ON_HOLD') return refuse(`it is not on hold (${row.status})`)
      to = { ...from, status: 'DRAFT', heldReason: null }
    } else if (item.action === 'cancel') {
      if (labelled) return refuse(`a ${row.status} shipment or one with a label cannot be cancelled; void its label first`)
      to = { ...from, status: 'CANCELLED' }
    } else {
      if (labelled) return refuse('its service cannot change after the label; void it first')
      if (!item.carrierCode && item.serviceCode === undefined) return refuse('name a carrierCode or a serviceCode')
      to = {
        ...from,
        carrierCode: item.carrierCode ?? from.carrierCode,
        serviceCode: item.serviceCode !== undefined ? item.serviceCode : from.serviceCode,
        serviceName: item.serviceName !== undefined ? item.serviceName : from.serviceName,
      }
    }
    steps.push({ action: item.action, from, to })
  }
  return {
    ok: true,
    preview: { action: 'update-shipment', shipments: steps, note: 'Changes shipments in Nexus only; no carrier is called and no label is bought or voided.' },
  }
}

const updateShipment: AgentTool = {
  name: 'update-shipment',
  title: 'Update shipments',
  input: updateInput,
  requires: [F.outboundManage],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { shipments?: ShipmentState[] }
      const rows = await prisma.shipment.findMany({ where: { id: { in: (after.shipments ?? []).map((s) => s.shipmentId) } }, select: stateSelect })
      return { shipments: (after.shipments ?? []).map((s) => { const row = rows.find((r) => r.id === s.shipmentId); return row ? stateOf(row) : { shipmentId: s.shipmentId, status: 'gone' } }) }
    },
    request(change) {
      const before = (change.before ?? {}) as { shipments?: Array<ShipmentState & { action: string }> }
      const steps = before.shipments ?? []
      if (steps.some((s) => s.action === 'cancel')) return { refusal: 'A cancelled shipment is not brought back: make a new one with create-shipments.' }
      const shipments = steps.map((s) =>
        s.action === 'hold' ? { shipmentId: s.shipmentId, action: 'release' }
          : s.action === 'release' ? { shipmentId: s.shipmentId, action: 'hold', ...(s.heldReason ? { reason: s.heldReason } : {}) }
            : { shipmentId: s.shipmentId, action: 'service', carrierCode: s.carrierCode, serviceCode: s.serviceCode, serviceName: s.serviceName })
      return shipments.length ? { tool: 'update-shipment', args: { shipments } } : { refusal: 'This change named no shipment.' }
    },
  },
  description:
    'Change shipments of this business before their label: hold (with a reason), release from hold, cancel, or set the '
    + 'carrier and service (from shipping-rates). No carrier is called. Waits for a person: approved in Nexus, or '
    + 'confirmed in Claude where the business allows it. Undo releases, holds or sets the service back; a cancelled '
    + 'shipment is not brought back.',
  handler: (args) => previewUpdate(args as UpdateArgs),
  async execute(args, ctx) {
    const checked = await freshOrStale(() => previewUpdate(args as UpdateArgs), ctx, ['shipments'], 'a shipment')
    if ('refusal' in checked) return checked.refusal
    const steps = (checked.fresh.preview as { shipments: Array<{ action: string; from: ShipmentState; to: ShipmentState }> }).shipments
    const done: typeof steps = []
    const failed: Array<{ id: string; error: string }> = []
    for (const step of steps) {
      const id = step.from.shipmentId
      const answer = step.action === 'hold' ? await holdShipment(id, { reason: step.to.heldReason ?? undefined }, toolLog)
        : step.action === 'release' ? await releaseShipment(id, toolLog)
          : step.action === 'cancel' ? await cancelUnlabelledShipment(id)
            : await restoreShipmentService(id, { carrierCode: step.to.carrierCode, serviceCode: step.to.serviceCode, serviceName: step.to.serviceName })
      if (!answer.ok) { failed.push({ id, error: answer.body?.error ?? String(answer.status) }); continue }
      done.push(step)
    }
    // What ran is recorded (and can be undone); what failed is said.
    if (!done.length) return { ok: false, error: `Nothing changed: ${failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
    return { ok: true, data: { updated: done.length, failed }, change: changeOf(done) }
  },
}

function changeOf(steps: Array<{ action: string; from: ShipmentState; to: ShipmentState }>) {
  return {
    before: { shipments: steps.map((s) => ({ ...s.from, action: s.action })) },
    after: { shipments: steps.map((s) => s.to) },
  }
}

// ── buy-shipping-label ──────────────────────────────────────────────────────────────────────────────

const buyInput = z.object({
  shipmentIds: ids(`shipments to buy a label for (at most ${MAX_LABELS}); each with no label yet`, MAX_LABELS).optional(),
  returnIds: ids(`returns to buy a prepaid return label for, via Sendcloud (at most ${MAX_RETURN_LABELS})`, MAX_RETURN_LABELS).optional(),
})
type BuyArgs = z.infer<typeof buyInput>

export const BUY_LABEL_LIMITS = z.object({
  maxLabels: z.number().int().min(1).max(MAX_LABELS).default(10).describe('the most labels in one change confirmed in Claude'),
  maxEurPerLabel: z.number().positive().max(500).default(15).describe('the most one label may cost, in EUR'),
  maxEurTotal: z.number().positive().max(5000).default(150).describe('the most all labels of one change may cost, in EUR'),
})

type LabelLine = { shipmentId: string; orderNumber: string | null; carrier: string; service: string | null; destination: string; weightKg: number; estimatedEur: number | null }

/** The price the label would most likely cost: the bound service's rate, else the cheapest of its carrier; MANUAL is free. */
async function estimateLabel(shipment: { id: string; carrierCode: string; serviceCode: string | null }): Promise<{ eur: number | null; destination: string; weightKg: number }> {
  if (shipment.carrierCode === 'MANUAL') return { eur: 0, destination: '', weightKg: 0 }
  const answer = await shipmentRates(shipment.id, () => undefined)
  if (answer.status !== 200) return { eur: null, destination: '', weightKg: 0 }
  const source = shipment.carrierCode === 'AMAZON_BUY_SHIPPING' ? 'AMAZON_BUY_SHIPPING' : 'SENDCLOUD'
  const own = answer.body.rates.filter((r) => r.source === source)
  const bound = shipment.serviceCode ? own.find((r) => r.serviceCode === shipment.serviceCode) : undefined
  const price = bound?.priceEur ?? (own.length ? Math.min(...own.map((r) => r.priceEur)) : null)
  return { eur: price, destination: answer.body.destinationCountry, weightKg: answer.body.weightKg }
}

async function previewBuy(a: BuyArgs, ctx: ToolContext): Promise<ToolResult> {
  const shipmentIds = a.shipmentIds ?? []
  const returnIds = a.returnIds ?? []
  if (!shipmentIds.length && !returnIds.length) return { ok: false, error: 'Name the shipments (shipmentIds) or returns (returnIds) to buy labels for. Nothing was queued.' }
  if (!unique(shipmentIds) || !unique(returnIds)) return { ok: false, error: 'A shipment or return is named twice. Nothing was queued.' }
  if (returnIds.length && !ctx.can(F.returnsProcess)) return { ok: false, error: 'A return label needs returns.process, which you do not hold in this business.' }
  const rows = shipmentIds.length
    ? await prisma.shipment.findMany({
        where: { id: { in: shipmentIds }, deletedAt: null },
        select: { id: true, status: true, carrierCode: true, serviceCode: true, serviceName: true, labelUrl: true, order: { select: { id: true, channel: true, channelOrderId: true, fulfillmentMethod: true } } },
      })
    : []
  const missing = shipmentIds.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length) return { ok: false, error: `Shipment not found: ${missing.join(', ')}. Nothing was queued.` }
  const labels: LabelLine[] = []
  for (const id of shipmentIds) {
    const row = rows.find((r) => r.id === id)!
    if (!row.order) return { ok: false, error: `Shipment ${id} has no order. Nothing was queued.` }
    if (await amazonFulfilledRefusal(prisma, row.order)) return { ok: false, error: `Shipment ${id}: Amazon ships this order (FBA or Multi-Channel Fulfilment): Nexus buys no label for it. Nothing was queued.` }
    if (!(LABEL_STATUSES as readonly string[]).includes(row.status) || row.labelUrl) return { ok: false, error: `Shipment ${id} (order ${row.order.channelOrderId}) is ${row.status}${row.labelUrl ? ' with a label' : ''}: no label is bought for it. Nothing was queued.` }
    const estimate = await estimateLabel(row)
    labels.push({ shipmentId: id, orderNumber: row.order.channelOrderId, carrier: row.carrierCode, service: row.serviceName ?? row.serviceCode, destination: estimate.destination, weightKg: estimate.weightKg, estimatedEur: estimate.eur })
  }
  const returns = returnIds.length
    ? await prisma.return.findMany({ where: { id: { in: returnIds } }, select: { id: true, rmaNumber: true, returnLabelUrl: true, isFbaReturn: true, orderId: true } })
    : []
  const missingReturns = returnIds.filter((id) => !returns.some((r) => r.id === id))
  if (missingReturns.length) return { ok: false, error: `Return not found: ${missingReturns.join(', ')}. Nothing was queued.` }
  const returnLabels = []
  for (const id of returnIds) {
    const ret = returns.find((r) => r.id === id)!
    if (ret.returnLabelUrl) return { ok: false, error: `Return ${ret.rmaNumber ?? id} already has a label. Nothing was queued.` }
    if (ret.isFbaReturn) return { ok: false, error: `Return ${ret.rmaNumber ?? id} goes back to Amazon (FBA): Nexus buys no label for it. Nothing was queued.` }
    if (!ret.orderId) return { ok: false, error: `Return ${ret.rmaNumber ?? id} has no order. Nothing was queued.` }
    // Sendcloud bills a return parcel when it is scanned; its price is not known before.
    returnLabels.push({ returnId: id, rmaNumber: ret.rmaNumber, carrier: 'SENDCLOUD', estimatedEur: null as number | null })
  }
  const known = labels.map((l) => l.estimatedEur).filter((v): v is number => v != null)
  return {
    ok: true,
    preview: {
      action: 'buy-shipping-label',
      labels,
      returnLabels,
      count: labels.length + returnLabels.length,
      totalEur: Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100,
      unknownPrices: labels.length - known.length + returnLabels.length,
      modes: carrierModes(),
      note: 'Buys carrier labels: in live mode money leaves your carrier account, and a label can only be voided while the carrier allows it.',
    },
  }
}

export function buyLabelWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { labels?: LabelLine[]; returnLabels?: unknown[]; count?: number; totalEur?: number; unknownPrices?: number } | null
  if (!p?.labels) return 'there is no preview of the change to judge'
  if (Number(p.count) > Number(limits.maxLabels)) return `it buys ${p.count} labels, more than the ${limits.maxLabels} allowed without a person in Nexus`
  if (Number(p.unknownPrices) > 0) return `${p.unknownPrices} label price${Number(p.unknownPrices) > 1 ? 's are' : ' is'} not known before buying`
  const dear = p.labels.find((l) => (l.estimatedEur ?? 0) > Number(limits.maxEurPerLabel))
  if (dear) return `a label costs about €${dear.estimatedEur}, more than the €${limits.maxEurPerLabel} allowed per label without a person in Nexus`
  if (Number(p.totalEur) > Number(limits.maxEurTotal)) return `the labels cost about €${p.totalEur}, more than the €${limits.maxEurTotal} allowed in total without a person in Nexus`
  return null
}

type Bought = { shipmentId: string; status: string; carrier: string; trackingNumber: string | null; parcel: string | null }

const buyShippingLabel: AgentTool = {
  name: 'buy-shipping-label',
  title: 'Buy shipping labels',
  input: buyInput,
  requires: [F.outboundManage, F.ordersFulfill],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  limits: BUY_LABEL_LIMITS,
  withinLimits: buyLabelWithinLimits,
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { shipments?: Bought[] }
      const rows = await prisma.shipment.findMany({ where: { id: { in: (after.shipments ?? []).map((s) => s.shipmentId) } }, select: { id: true, status: true, carrierCode: true, trackingNumber: true, sendcloudParcelId: true } })
      return {
        shipments: (after.shipments ?? []).map((s) => { const r = rows.find((row) => row.id === s.shipmentId); return r ? { shipmentId: r.id, status: r.status, carrier: r.carrierCode, trackingNumber: r.trackingNumber, parcel: r.sendcloudParcelId } : { shipmentId: s.shipmentId, status: 'gone' } }),
        returns: (change.after as { returns?: unknown[] } | null)?.returns ?? [],
      }
    },
    request(change) {
      const after = (change.after ?? {}) as { shipments?: Bought[]; returns?: unknown[] }
      const voidable = (after.shipments ?? []).filter((s) => s.parcel)
      if (!voidable.length) return { refusal: 'None of these labels can be voided from Nexus (only Sendcloud parcels can; Amazon Buy Shipping and return labels cannot).' }
      return { tool: 'void-shipping-label', args: { shipmentIds: voidable.map((s) => s.shipmentId) } }
    },
  },
  description:
    'Buy carrier labels for shipments of this business that have none yet (Sendcloud, Amazon Buy Shipping; MANUAL makes '
    + 'none), or a prepaid Sendcloud return label for a return. Costs money in live mode: the preview gives each label\'s '
    + 'estimated price, the total and whether each carrier is live or a dry run. Never for an order Amazon ships. Always '
    + 'waits for a person: approved in Nexus, or confirmed in Claude inside the business\'s limits. Undo voids the '
    + 'Sendcloud labels while the carrier allows it.',
  handler: (args, ctx) => previewBuy(args as BuyArgs, ctx),
  async execute(args, ctx) {
    const a = args as BuyArgs
    const checked = await freshOrStale(() => previewBuy(a, ctx), ctx, ['labels', 'returnLabels', 'modes'], 'a shipment, a price or a carrier mode')
    if ('refusal' in checked) return checked.refusal
    const bought: Bought[] = []
    const before: Array<{ shipmentId: string; status: string }> = []
    const failed: Array<{ id: string; error: string }> = []
    const returns: Array<{ returnId: string; trackingNumber: string | null }> = []
    for (const id of a.shipmentIds ?? []) {
      const prior = await prisma.shipment.findFirst({ where: { id }, select: { status: true } })
      const answer = await printShipmentLabel(id, toolLog)
      if (!answer.ok) { failed.push({ id, error: answer.body?.error ?? String(answer.status) }); continue }
      before.push({ shipmentId: id, status: prior?.status ?? 'DRAFT' })
      bought.push({ shipmentId: id, status: answer.body.status, carrier: answer.body.carrierCode, trackingNumber: answer.body.trackingNumber ?? null, parcel: answer.body.sendcloudParcelId ?? null })
    }
    for (const id of a.returnIds ?? []) {
      const answer = await generateReturnLabel(id, toolLog)
      if (!answer.ok) { failed.push({ id, error: answer.body?.error ?? String(answer.status) }); continue }
      returns.push({ returnId: id, trackingNumber: answer.body?.return?.returnTrackingNumber ?? null })
    }
    // What was bought is recorded (money left; it can be voided where the carrier allows); what failed is said.
    if (!bought.length && !returns.length) return { ok: false, error: `No label bought: ${failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
    return {
      ok: true,
      data: { bought: bought.length, returnLabels: returns.length, failed, modes: carrierModes(), labels: bought },
      change: { before: { shipments: before }, after: { shipments: bought, returns } },
    }
  },
}

// ── void-shipping-label ─────────────────────────────────────────────────────────────────────────────

const voidInput = z.object({ shipmentIds: ids(`shipments whose Sendcloud label to void (at most ${MAX_LABELS})`, MAX_LABELS) })
type VoidArgs = z.infer<typeof voidInput>

async function previewVoid(a: VoidArgs): Promise<ToolResult> {
  if (!unique(a.shipmentIds)) return { ok: false, error: 'A shipment is named twice. Nothing was queued.' }
  const rows = await prisma.shipment.findMany({
    where: { id: { in: a.shipmentIds }, deletedAt: null },
    select: { id: true, status: true, carrierCode: true, trackingNumber: true, sendcloudParcelId: true, order: { select: { channelOrderId: true } } },
  })
  const missing = a.shipmentIds.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length) return { ok: false, error: `Shipment not found: ${missing.join(', ')}. Nothing was queued.` }
  for (const row of rows) {
    const which = `Shipment ${row.id}${row.order ? ` (order ${row.order.channelOrderId})` : ''}`
    if (row.status !== 'LABEL_PRINTED') return { ok: false, error: `${which} is ${row.status}: only a printed label that has not left can be voided. Nothing was queued.` }
    if (!row.sendcloudParcelId) return { ok: false, error: `${which} has no Sendcloud parcel: its label (${row.carrierCode}) cannot be voided from Nexus. Nothing was queued.` }
  }
  return {
    ok: true,
    preview: {
      action: 'void-shipping-label',
      labels: a.shipmentIds.map((id) => { const r = rows.find((row) => row.id === id)!; return { shipmentId: id, orderNumber: r.order?.channelOrderId ?? null, carrier: r.carrierCode, trackingNumber: r.trackingNumber, parcel: r.sendcloudParcelId } }),
      modes: carrierModes(),
      note: 'Asks Sendcloud to cancel each parcel; it refuses once the carrier has it. The shipment goes back to packed (or draft) for a new label.',
    },
  }
}

const voidShippingLabel: AgentTool = {
  name: 'void-shipping-label',
  title: 'Void shipping labels',
  input: voidInput,
  requires: [F.outboundManage, F.ordersFulfill],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { shipments?: Array<{ shipmentId: string; status: string }> }
      const rows = await prisma.shipment.findMany({ where: { id: { in: (after.shipments ?? []).map((s) => s.shipmentId) } }, select: { id: true, status: true } })
      return { shipments: (after.shipments ?? []).map((s) => ({ shipmentId: s.shipmentId, status: rows.find((r) => r.id === s.shipmentId)?.status ?? 'gone' })) }
    },
    request(change) {
      const after = (change.after ?? {}) as { shipments?: Array<{ shipmentId: string }> }
      if (!after.shipments?.length) return { refusal: 'This change voided no label.' }
      return { tool: 'buy-shipping-label', args: { shipmentIds: after.shipments.map((s) => s.shipmentId) } }
    },
  },
  description:
    'Void Sendcloud labels of this business that have not left yet: the parcel is cancelled at Sendcloud (refused once '
    + 'the carrier has it) and the shipment goes back for a new label. Always waits for a person: approved in Nexus or '
    + 'confirmed in Claude. Undo buys new labels (a new cost, approved again).',
  handler: (args) => previewVoid(args as VoidArgs),
  async execute(args, ctx) {
    const a = args as VoidArgs
    const checked = await freshOrStale(() => previewVoid(a), ctx, ['labels', 'modes'], 'a label')
    if ('refusal' in checked) return checked.refusal
    const voided: Array<{ shipmentId: string; status: string }> = []
    const before: Array<Record<string, unknown>> = []
    const failed: Array<{ id: string; error: string }> = []
    for (const label of (checked.fresh.preview as { labels: Array<{ shipmentId: string; trackingNumber: string | null; parcel: string | null }> }).labels) {
      const answer = await voidShipmentLabel(label.shipmentId, toolLog)
      if (!answer.ok) { failed.push({ id: label.shipmentId, error: answer.body?.error ?? String(answer.status) }); continue }
      before.push({ shipmentId: label.shipmentId, status: 'LABEL_PRINTED', trackingNumber: label.trackingNumber, parcel: label.parcel })
      voided.push({ shipmentId: label.shipmentId, status: answer.body.status })
    }
    if (!voided.length) return { ok: false, error: `No label voided: ${failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
    return { ok: true, data: { voided: voided.length, failed, modes: carrierModes() }, change: { before: { shipments: before }, after: { shipments: voided } } }
  },
}

// ── confirm-shipment ────────────────────────────────────────────────────────────────────────────────

const confirmInput = z.object({
  shipments: z.array(z.object({
    shipmentId: z.string().trim().min(1).max(64).describe('Nexus shipment id'),
    trackingNumber: z.string().trim().min(1).max(100).optional().describe("a MANUAL-carrier shipment's tracking number (a carrier label has its own)"),
    trackingUrl: z.string().trim().url().max(500).optional().describe('its tracking page, if the carrier has one'),
    carrierName: z.string().trim().min(1).max(100).optional().describe('which carrier a MANUAL shipment travels with'),
  })).min(1).max(MAX_LABELS).describe(`the shipments that left (at most ${MAX_LABELS})`),
})
type ConfirmArgs = z.infer<typeof confirmInput>

/** How a shipment's tracking reaches its channel once it is marked shipped. */
function uploadPlan(carrier: string, channel: string, tracking: string | null): string {
  if (carrier === 'SENDCLOUD') return "the carrier's first scan sends it (Sendcloud), not this change"
  if (carrier === 'AMAZON_BUY_SHIPPING') return 'Amazon has it already (Buy Shipping)'
  if (!(TRACKING_UPLOAD_CHANNELS as readonly string[]).includes(channel)) return trackingUploadMode(channel)
  return tracking ? `uploaded to ${channel}: ${trackingUploadMode(channel)}` : 'no tracking number: nothing is uploaded'
}

async function previewConfirm(a: ConfirmArgs): Promise<ToolResult> {
  const named = a.shipments.map((s) => s.shipmentId)
  if (!unique(named)) return { ok: false, error: 'A shipment is named twice. Nothing was queued.' }
  const rows = await prisma.shipment.findMany({
    where: { id: { in: named }, deletedAt: null },
    select: { id: true, status: true, carrierCode: true, trackingNumber: true, order: { select: { id: true, channel: true, channelOrderId: true, fulfillmentMethod: true } } },
  })
  const missing = named.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length) return { ok: false, error: `Shipment not found: ${missing.join(', ')}. Nothing was queued.` }
  const shipments = []
  for (const item of a.shipments) {
    const row = rows.find((r) => r.id === item.shipmentId)!
    const which = `Shipment ${row.id}${row.order ? ` (order ${row.order.channelOrderId})` : ''}`
    if (!row.order) return { ok: false, error: `${which} has no order. Nothing was queued.` }
    if (await amazonFulfilledRefusal(prisma, row.order)) return { ok: false, error: `${which}: Amazon ships this order (FBA or Multi-Channel Fulfilment); Nexus confirms nothing for it. Nothing was queued.` }
    if (!['PACKED', 'LABEL_PRINTED'].includes(row.status)) return { ok: false, error: `${which} is ${row.status}: only a packed or labelled shipment is marked shipped. Nothing was queued.` }
    if (item.trackingNumber && row.carrierCode !== 'MANUAL') return { ok: false, error: `${which}: a ${row.carrierCode} label carries its own tracking number. Nothing was queued.` }
    const tracking = item.trackingNumber ?? row.trackingNumber
    shipments.push({ shipmentId: row.id, orderNumber: row.order.channelOrderId, channel: row.order.channel, carrier: row.carrierCode, status: row.status, trackingNumber: tracking, upload: uploadPlan(row.carrierCode, row.order.channel, tracking) })
  }
  return {
    ok: true,
    preview: {
      action: 'confirm-shipment',
      shipments,
      note: 'Marks the shipments shipped and sends each MANUAL tracking number to its channel (the channel tells the buyer). Cannot be undone.',
    },
  }
}

const confirmShipment: AgentTool = {
  name: 'confirm-shipment',
  title: 'Confirm shipments',
  input: confirmInput,
  requires: [F.outboundManage, F.ordersFulfill],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Mark shipments of this business shipped, with the tracking number of a MANUAL-carrier shipment: its tracking is '
    + 'uploaded to the channel (live or a dry run, as the preview says per channel; a Sendcloud parcel\'s goes with the '
    + 'carrier\'s first scan). Never for an order Amazon ships. Always waits for a person to approve it in Nexus; it '
    + 'cannot be undone (the channel and the buyer are told).',
  handler: (args) => previewConfirm(args as ConfirmArgs),
  async execute(args, ctx) {
    const a = args as ConfirmArgs
    const fresh = await previewConfirm(a)
    if (!fresh.ok) return fresh
    const stale = staleRefusal(ctx.approvedPreview, fresh.preview, ['shipments'], 'a shipment')
    if (stale) return { ok: false, error: stale }
    const done: Array<{ shipmentId: string; uploaded: boolean }> = []
    const failed: Array<{ id: string; error: string }> = []
    for (const item of a.shipments) {
      if (item.trackingNumber) {
        const set = await setManualTrackingNumber(item.shipmentId, item)
        if (!set.ok) { failed.push({ id: item.shipmentId, error: set.body?.error ?? String(set.status) }); continue }
      }
      const shipped = await markShipmentShipped(item.shipmentId, toolLog)
      if (!shipped.ok) { failed.push({ id: item.shipmentId, error: shipped.body?.error ?? String(shipped.status) }); continue }
      const uploads = await prisma.trackingMessageLog.count({ where: { shipmentId: item.shipmentId } })
      done.push({ shipmentId: item.shipmentId, uploaded: uploads > 0 })
    }
    if (!done.length) return { ok: false, error: `Nothing was confirmed: ${failed.map((f) => `${f.id} (${f.error})`).join('; ')}` }
    return { ok: true, data: { confirmed: done, failed }, change: { before: { shipments: (fresh.preview as { shipments: unknown[] }).shipments }, after: { shipments: done } } }
  },
}

// ── schedule-pickup (07 O17) ────────────────────────────────────────────────────────────────────────

const PICKUP_CARRIERS = ['MANUAL', 'SENDCLOUD'] as const
const pickupInput = z.object({
  carrier: z.enum(PICKUP_CARRIERS).describe('MANUAL (recorded in Nexus; you book it with the carrier) or SENDCLOUD (Sendcloud is asked for the pickup)'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('the pickup day, YYYY-MM-DD: today up to 30 days ahead'),
  warehouseId: z.string().trim().min(1).max(64).optional().describe('the warehouse the parcels are collected from (from shipping-queue); omit for the default one'),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('the earliest time, HH:MM'),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('the latest time, HH:MM'),
  notes: z.string().trim().min(1).max(300).optional().describe('a note for the driver (no personal data)'),
})
type PickupArgs = z.infer<typeof pickupInput>

const DAY_MS = 86_400_000
const pickupMode = (carrier: string) => carrier === 'SENDCLOUD'
  ? (process.env.NEXUS_ENABLE_SENDCLOUD_REAL === 'true' ? 'live: Sendcloud books the pickup with the carrier' : 'dry run: Sendcloud is not asked (NEXUS_ENABLE_SENDCLOUD_REAL off); the pickup is recorded with a mock reference')
  : 'recorded in Nexus only: book it with the carrier yourself'

/** schedule-pickup's dry run: the carrier, the day, the warehouse, and what is asked of whom. */
async function previewPickup(a: PickupArgs): Promise<ToolResult> {
  const carrier = await prisma.carrier.findFirst({ where: { code: a.carrier }, select: { id: true, isActive: true } })
  if (!carrier || !carrier.isActive) return { ok: false, error: `Carrier ${a.carrier} is not connected in this business. Nothing was queued.` }
  const day = new Date(`${a.date}T12:00:00Z`)
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z')
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== a.date) return { ok: false, error: `${a.date} is not a date. Nothing was queued.` }
  if (day < today || day.getTime() - today.getTime() > 30 * DAY_MS) return { ok: false, error: `A pickup is booked for today up to 30 days ahead; ${a.date} is not. Nothing was queued.` }
  if (a.windowStart && a.windowEnd && a.windowEnd <= a.windowStart) return { ok: false, error: 'The window ends before it starts. Nothing was queued.' }
  const warehouse = a.warehouseId
    ? await prisma.warehouse.findFirst({ where: { id: a.warehouseId }, select: { id: true, code: true, name: true } })
    : await prisma.warehouse.findFirst({ where: { isDefault: true }, select: { id: true, code: true, name: true } })
  if (a.warehouseId && !warehouse) return { ok: false, error: `Warehouse not found: ${a.warehouseId}. Nothing was queued.` }
  const booked = await prisma.pickupSchedule.findFirst({
    where: { carrierId: carrier.id, isRecurring: false, status: 'ACTIVE', scheduledFor: { gte: new Date(`${a.date}T00:00:00Z`), lt: new Date(`${a.date}T23:59:59.999Z`) }, ...(warehouse ? { warehouseId: warehouse.id } : {}) },
    select: { externalRef: true },
  })
  if (booked) return { ok: false, error: `A ${a.carrier} pickup is booked for ${a.date} already${booked.externalRef ? ` (${booked.externalRef})` : ''}. Nothing was queued.` }
  return {
    ok: true,
    preview: {
      action: 'schedule-pickup',
      pickup: { carrier: a.carrier, date: a.date, windowStart: a.windowStart ?? null, windowEnd: a.windowEnd ?? null, notes: a.notes ?? null, warehouse: warehouse ? { id: warehouse.id, code: warehouse.code, name: warehouse.name } : null },
      mode: pickupMode(a.carrier),
      note: 'A one-time pickup. A booked carrier pickup is not cancelled from Nexus (cancelling here only marks it in Nexus).',
    },
  }
}

const schedulePickupTool: AgentTool = {
  name: 'schedule-pickup',
  title: 'Book a carrier pickup',
  input: pickupInput,
  requires: [F.carriersManage],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Book a one-time carrier pickup for this business: SENDCLOUD (Sendcloud books it with the carrier; live or a dry run, '
    + 'as the preview says) or MANUAL (recorded in Nexus; you book it). Today up to 30 days ahead, from a warehouse; one '
    + 'per carrier, warehouse and day. Recurring pickups are set on the Carriers page. Always waits for a person in Nexus; '
    + 'a booked pickup is not cancelled from Nexus.',
  handler: (args) => previewPickup(args as PickupArgs),
  async execute(args, ctx) {
    const a = args as PickupArgs
    const checked = await freshOrStale(() => previewPickup(a), ctx, ['pickup', 'mode'], 'the pickup')
    if ('refusal' in checked) return checked.refusal
    const p = checked.fresh.preview as { pickup: { warehouse: { id: string } | null } }
    const answer = await schedulePickup(a.carrier, {
      scheduledFor: `${a.date}T12:00:00.000Z`, warehouseId: p.pickup.warehouse?.id ?? null,
      windowStart: a.windowStart ?? null, windowEnd: a.windowEnd ?? null, notes: a.notes ?? null,
    }, toolLog)
    if (!answer.ok) return { ok: false, error: answer.body?.error ?? `not booked (${answer.status})` }
    const pickup = (answer.body as { pickup: { id: string; externalRef: string | null; lastDispatchErr: string | null } }).pickup
    if (pickup.lastDispatchErr) return { ok: false, error: `Sendcloud did not book it: ${pickup.lastDispatchErr}. The request is on the Carriers page with that error.` }
    return {
      ok: true,
      data: { pickupId: pickup.id, carrier: a.carrier, date: a.date, externalRef: pickup.externalRef },
      change: { before: { pickupId: null }, after: { pickupId: pickup.id, externalRef: pickup.externalRef } },
    }
  },
}

export const SHIPPING_TOOLS: AgentTool[] = [createShipments, updateShipment, buyShippingLabel, voidShippingLabel, confirmShipment, schedulePickupTool]
