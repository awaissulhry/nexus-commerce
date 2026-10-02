/**
 * MCP full control 07 O5 — Claude's fulfilment reads: `shipping-queue`, `shipment-detail`, `shipping-rates`.
 *
 * They read through services/fulfillment/shipment-read.service.ts, the reads the Outbound page uses, in the caller's
 * business only (row-level security). Buyer data is masked (O-1): first name, city, country, masked e-mail.
 *
 * FBA is shown, never queued: an order Amazon ships (FBA / AFN, an Amazon order without merchant evidence, or one with
 * a live Multi-Channel Fulfilment request — the one fail-closed test of services/fulfillment/amazon-fulfilled-order.ts)
 * is never in the queue Nexus ships from; the queue names those orders apart, read only. `shipping-rates` refuses a
 * shipment of such an order before any carrier is asked (Nexus buys no label for it).
 *
 * `shipping-rates` is a LIVE carrier read (Sendcloud; Amazon Buy Shipping when that switch is on). It buys nothing; its
 * answer says which carriers answered live and which with sample rates (dry run).
 */

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { likeEscaped } from '../../../lib/like-pattern.js'
import { logger } from '../../../utils/logger.js'
import {
  cursorScope,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  pageOf,
  type CursorPosition,
} from '../../../lib/pagination/cursor.js'
import { pendingOrdersWhere, shipmentRates } from '../../fulfillment/shipment-read.service.js'
import {
  AMAZON_FULFILLED_REASON,
  amazonFulfilledRefusal,
  isAmazonFulfilledOrder,
  MCF_NOT_SHIPPING_STATUSES,
} from '../../fulfillment/amazon-fulfilled-order.js'
import { maskBuyer } from '../../orders/buyer-mask.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

const ORDER_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL'] as const
const URGENCIES = ['OVERDUE', 'TODAY', 'TOMORROW', 'THIS_WEEK', 'LATER', 'UNKNOWN'] as const
/** The queue's FBA list is a glance, not a list to page through. */
const AMAZON_SHOWN = 20

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const upperList = (value: unknown) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value
  return Array.isArray(list) ? list.map(upper).filter((item) => item !== '') : list
}
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
const money = (value: unknown) => (value == null ? null : Number(value))

async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

// ── shipping-queue ──────────────────────────────────────────────────────────────────────────────────

const queueInput = z.object({
  channel: z.preprocess(upper, z.enum(ORDER_CHANNELS)).optional().describe(`only this channel: ${ORDER_CHANNELS.join(', ')}`),
  marketplace: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this marketplace code, e.g. IT or DE'),
  urgency: z.preprocess(upperList, z.array(z.enum(URGENCIES)).min(1).max(URGENCIES.length)).optional()
    .describe(`ship-by urgency, one or more: ${URGENCIES.join(', ')} (UNKNOWN = no ship-by date)`),
  search: z.string().trim().min(1).max(200).optional()
    .describe('an order number, a buyer name or e-mail, or a SKU (a fragment); matched as typed'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`orders per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
    .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
})
type QueueArgs = z.infer<typeof queueInput>

/** Ship-by first (no date last), then the oldest purchase, then the id: every order has one place. */
const QUEUE_ORDER = [
  { shipByDate: { sort: 'asc' as const, nulls: 'last' as const } },
  { purchaseDate: { sort: 'asc' as const, nulls: 'last' as const } },
  { id: 'asc' as const },
]

const dateOf = (value: unknown): Date => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new InvalidCursorError()
  return new Date(value)
}
/** The orders strictly after (purchaseDate, id) within one ship-by value. */
function afterPurchase(purchase: unknown, id: string): Record<string, unknown> {
  if (purchase === null) return { purchaseDate: null, id: { gt: id } }
  const at = dateOf(purchase)
  return { OR: [{ purchaseDate: { gt: at } }, { purchaseDate: null }, { purchaseDate: at, id: { gt: id } }] }
}
/** The orders strictly after a cursor's order, in QUEUE_ORDER. */
function afterQueue(position: CursorPosition | null): Record<string, unknown> {
  if (!position) return {}
  const [shipBy, purchase] = position.values
  if (shipBy === null) return { shipByDate: null, ...afterPurchase(purchase, position.id) }
  const at = dateOf(shipBy)
  return { OR: [{ shipByDate: { gt: at } }, { shipByDate: null }, { AND: [{ shipByDate: at }, afterPurchase(purchase, position.id)] }] }
}

const QUEUE_SELECT = {
  id: true, channel: true, marketplace: true, channelOrderId: true, status: true, fulfillmentMethod: true,
  customerName: true, customerEmail: true, shippingAddress: true, purchaseDate: true, shipByDate: true,
  latestDeliveryDate: true, isPrime: true, totalPrice: true, currencyCode: true,
  items: { select: { sku: true, quantity: true } },
  _count: { select: { mcfShipments: { where: { status: { notIn: [...MCF_NOT_SHIPPING_STATUSES] } } } } },
} satisfies Prisma.OrderSelect

const shippingQueue: AgentTool = {
  name: 'shipping-queue',
  title: 'Orders to ship',
  input: queueInput,
  requires: [F.outboundManage],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'The orders this business still has to ship (PENDING or PROCESSING, no live shipment), most urgent ship-by date '
    + 'first, with their urgency (OVERDUE, TODAY, TOMORROW, THIS_WEEK, LATER, UNKNOWN); filter by channel, marketplace, '
    + 'urgency or a search text. Orders Amazon ships (FBA or Multi-Channel Fulfilment) are never in the queue: they are '
    + 'counted and named apart under amazonShips, read only. The buyer is masked. Paged: follow nextCursor.',
  handler: (args) =>
    listTool('shipping-queue', async () => {
      const a = args as QueueArgs
      const size = a.limit ?? DEFAULT_PAGE_SIZE
      const { limit: _limit, cursor: _cursor, ...filters } = a
      const scope = cursorScope('shipping-queue', { business: workspaceIdForQuery(), ...filters })
      const position = decodeCursor(scope, a.cursor)
      const pageFilters = {
        ...(a.channel ? { channel: a.channel } : {}),
        ...(a.marketplace ? { marketplace: a.marketplace } : {}),
        ...(a.urgency ? { urgency: a.urgency.join(',') } : {}),
        ...(a.search ? { search: likeEscaped(a.search) } : {}),
      }
      // The page's own queue (orders the business ships, none in the bin) and, apart, those Amazon ships.
      const { where: merchantWhere, now, t24, t48, t7d } = pendingOrdersWhere(pageFilters)
      const { where: amazonWhere } = pendingOrdersWhere(pageFilters, { amazonShips: 'only' })
      const urgencyOf = (d: Date | null): string => {
        if (!d) return 'UNKNOWN'
        const t = d.getTime()
        if (t < now.getTime()) return 'OVERDUE'
        if (t < t24.getTime()) return 'TODAY'
        if (t < t48.getTime()) return 'TOMORROW'
        if (t < t7d.getTime()) return 'THIS_WEEK'
        return 'LATER'
      }
      const [total, rows, amazonTotal, amazonRows] = await Promise.all([
        prisma.order.count({ where: merchantWhere }),
        prisma.order.findMany({ where: { AND: [merchantWhere, afterQueue(position)] }, orderBy: QUEUE_ORDER, take: size + 1, select: QUEUE_SELECT }),
        prisma.order.count({ where: amazonWhere }),
        prisma.order.findMany({ where: amazonWhere, orderBy: QUEUE_ORDER, take: AMAZON_SHOWN, select: QUEUE_SELECT }),
      ])
      const page = pageOf(rows, size, scope, (row) => ({ values: [iso(row.shipByDate), iso(row.purchaseDate)], id: row.id }))
      // The SQL test and the TypeScript test agree; should they ever not, the order stays out of the queue.
      const amazonShips = (row: (typeof rows)[number]) => isAmazonFulfilledOrder(row, row._count.mcfShipments)
      const shape = (o: (typeof rows)[number]) => ({
        id: o.id,
        channel: o.channel,
        marketplace: o.marketplace,
        channelOrderId: o.channelOrderId,
        status: o.status,
        fulfillmentMethod: o.fulfillmentMethod,
        urgency: urgencyOf(o.shipByDate),
        shipByDate: iso(o.shipByDate),
        latestDeliveryDate: iso(o.latestDeliveryDate),
        purchaseDate: iso(o.purchaseDate),
        isPrime: o.isPrime,
        totalPrice: money(o.totalPrice),
        currencyCode: o.currencyCode,
        lines: o.items.length,
        units: o.items.reduce((n, it) => n + it.quantity, 0),
        skus: o.items.slice(0, 5).map((it) => it.sku),
        buyer: maskBuyer({ name: o.customerName, email: o.customerEmail, address: o.shippingAddress }),
      })
      const queued = page.items.filter((row) => !amazonShips(row))
      const strays = page.items.filter(amazonShips)
      return {
        ok: true,
        data: {
          total,
          count: queued.length,
          nextCursor: page.nextCursor,
          orders: queued.map(shape),
          amazonShips: {
            note: 'Amazon ships these orders (FBA or Multi-Channel Fulfilment): Nexus never ships them; read only.',
            total: amazonTotal + strays.length,
            orders: [...strays, ...amazonRows].slice(0, AMAZON_SHOWN).map(shape),
          },
        },
      }
    }),
}

// ── shipment-detail ─────────────────────────────────────────────────────────────────────────────────

const shipmentIdInput = z.object({ shipmentId: z.string().trim().min(1).max(64).describe('Nexus shipment id (from order-detail or shipping-queue)') })

const shipmentDetail: AgentTool = {
  name: 'shipment-detail',
  title: 'Shipment details',
  input: shipmentIdInput,
  requires: [F.outboundManage],
  // The label's cost to the business is a cost (the shared money registry has no name for this key).
  restrictedFields: { labelCostCents: FIELDS.financialsCostsView },
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Read one shipment of this business: status, carrier and service, tracking number, label, weight and size, its '
    + 'lines and warehouse, its order (buyer masked), the carrier\'s tracking events, and every tracking upload to the '
    + 'channel (status, attempts, last error). A shipment in the bin or of another business is not found.',
  async handler(args) {
    const id = String(args.shipmentId ?? '')
    const shipment = await prisma.shipment.findFirst({
      where: { id, deletedAt: null },
      include: {
        items: { select: { sku: true, quantity: true } },
        warehouse: { select: { code: true, name: true } },
        order: {
          select: {
            id: true, channel: true, marketplace: true, channelOrderId: true, status: true, fulfillmentMethod: true,
            customerName: true, customerEmail: true, shippingAddress: true, shipByDate: true,
          },
        },
        trackingEvents: {
          orderBy: { occurredAt: 'asc' },
          select: { occurredAt: true, code: true, description: true, location: true, source: true },
        },
        trackingMessageLogs: {
          orderBy: { createdAt: 'asc' },
          select: {
            channel: true, marketplace: true, status: true, attemptCount: true, maxAttempts: true, nextAttemptAt: true,
            lastAttemptedAt: true, lastError: true, lastErrorCode: true, createdAt: true,
          },
        },
      },
    })
    if (!shipment) return { ok: false, error: 'Shipment not found' }
    const order = shipment.order
    return {
      ok: true,
      data: {
        id: shipment.id,
        status: shipment.status,
        carrier: shipment.carrierCode,
        service: { code: shipment.serviceCode, name: shipment.serviceName },
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl,
        hasLabel: !!shipment.labelUrl,
        labelCostCents: shipment.costCents,
        currencyCode: shipment.currencyCode,
        weightGrams: shipment.weightGrams,
        sizeCm: { length: money(shipment.lengthCm), width: money(shipment.widthCm), height: money(shipment.heightCm) },
        warehouse: shipment.warehouse,
        lines: shipment.items,
        dates: {
          pickedAt: iso(shipment.pickedAt),
          packedAt: iso(shipment.packedAt),
          labelPrintedAt: iso(shipment.labelPrintedAt),
          shippedAt: iso(shipment.shippedAt),
          deliveredAt: iso(shipment.deliveredAt),
          cancelledAt: iso(shipment.cancelledAt),
          heldAt: iso(shipment.heldAt),
          trackingPushedAt: iso(shipment.trackingPushedAt),
        },
        heldReason: shipment.heldReason,
        trackingPushError: shipment.trackingPushError,
        order: order
          ? {
              id: order.id,
              channel: order.channel,
              marketplace: order.marketplace,
              channelOrderId: order.channelOrderId,
              status: order.status,
              shipByDate: iso(order.shipByDate),
              buyer: maskBuyer({ name: order.customerName, email: order.customerEmail, address: order.shippingAddress }),
            }
          : null,
        trackingEvents: shipment.trackingEvents.map((e) => ({ ...e, occurredAt: iso(e.occurredAt) })),
        trackingUploads: shipment.trackingMessageLogs.map((log) => ({
          ...log,
          nextAttemptAt: iso(log.nextAttemptAt),
          lastAttemptedAt: iso(log.lastAttemptedAt),
          createdAt: iso(log.createdAt),
        })),
      },
    }
  },
}

// ── shipping-rates ──────────────────────────────────────────────────────────────────────────────────

const shippingRates: AgentTool = {
  name: 'shipping-rates',
  title: 'Shipping rates',
  input: shipmentIdInput,
  requires: [F.outboundManage],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    'Ask the carriers what a shipment of this business would cost: Sendcloud\'s services for its weight and '
    + 'destination and, for an Amazon order with Buy Shipping on, Amazon\'s; cheapest first. A live carrier read that '
    + 'buys nothing; carrierModes says which carriers answered live and which with sample rates. Refused for an order '
    + 'Amazon ships (FBA or Multi-Channel Fulfilment) before any carrier is asked.',
  async handler(args) {
    const id = String(args.shipmentId ?? '')
    const shipment = await prisma.shipment.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, order: { select: { id: true, channel: true, fulfillmentMethod: true, channelOrderId: true } } },
    })
    if (!shipment) return { ok: false, error: 'Shipment not found' }
    if (shipment.order && (await amazonFulfilledRefusal(prisma, shipment.order))) return { ok: false, error: AMAZON_FULFILLED_REASON }
    const answer = await shipmentRates(id, (detail, message) => logger.warn(message, { shipmentId: detail.shipmentId }))
    if (answer.status !== 200) return { ok: false, error: answer.body.error }
    return {
      ok: true,
      data: {
        order: shipment.order ? { id: shipment.order.id, channel: shipment.order.channel, channelOrderId: shipment.order.channelOrderId } : null,
        destinationCountry: answer.body.destinationCountry,
        weightKg: answer.body.weightKg,
        carrierModes: {
          sendcloud: process.env.NEXUS_ENABLE_SENDCLOUD_REAL === 'true' ? 'live' : 'sample rates (Sendcloud dry run)',
          amazonBuyShipping:
            shipment.order?.channel !== 'AMAZON' ? 'not for this channel' : process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING ? 'live' : 'off',
        },
        rates: answer.body.rates,
      },
    }
  },
}

export const FULFILMENT_TOOLS: AgentTool[] = [shippingQueue, shipmentDetail, shippingRates]
