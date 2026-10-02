/**
 * MCP full control 07 O4 — Claude's order reads, v2: `order-search` and `order-detail`.
 *
 * They read through services/orders/order-read.service.ts, the same reads the Orders page uses (its filters, its
 * detail, timeline and financials), in the caller's business only (row-level security: another business's order is
 * not found). An order in the bin is never a result (07 O1).
 *
 * Buyer data is MASKED (decision O-1): first name, city, country and a masked e-mail. Never the full name, the street,
 * the postal code, the phone, the e-mail or the buyer's tax codes; a tool that needs them finds them inside Nexus.
 *
 * Amazon-fulfilled orders (FBA, or an eBay/Shopify order sent to Amazon Multi-Channel Fulfilment) are shown with their
 * MCF requests, read only: `amazonShips` uses the one fail-closed test of services/fulfillment/amazon-fulfilled-order.ts.
 *
 * Money: the order total and line prices are operational and always shown; revenue, fees and net are stripped for a
 * caller without the matching financials permission (lib/auth/financial-fields.ts and restrictedFields below).
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { likeEscaped } from '../../../lib/like-pattern.js'
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
import { orderDetail, orderFinancials, orderListScope, orderTimeline } from '../../orders/order-read.service.js'
import { maskBuyer } from '../../orders/buyer-mask.js'
import { isAmazonFulfilledOrder, MCF_NOT_SHIPPING_STATUSES } from '../../fulfillment/amazon-fulfilled-order.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

/** Every order status Nexus holds (schema OrderStatus). */
export const ORDER_STATUSES = [
  'PENDING', 'AWAITING_PAYMENT', 'PROCESSING', 'ON_HOLD', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED',
] as const
const ORDER_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL'] as const

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
/** One value or several, upper case: "shipped", "SHIPPED,DELIVERED" and ["shipped"] all read the same. */
const upperList = (value: unknown) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value
  return Array.isArray(list) ? list.map(upper).filter((item) => item !== '') : list
}
const isoDate = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'a date, e.g. 2026-09-30 or 2026-09-30T12:00:00Z')

const money = (value: unknown) => (value == null ? null : Number(value))
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

/** The masked buyer of an order (O-1). */
const buyerOf = (order: { customerName?: unknown; customerEmail?: unknown; shippingAddress?: unknown }) =>
  maskBuyer({ name: order.customerName, email: order.customerEmail, address: order.shippingAddress })

/** A bad cursor is a wrongly made call; anything else is a real failure. */
async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

// ── order-search ────────────────────────────────────────────────────────────────────────────────────

const orderSearchInput = z.object({
  search: z.string().trim().min(1).max(200).optional()
    .describe('an order number, a buyer name or e-mail, or a SKU (a fragment); matched as typed: _ and % are characters'),
  buyer: z.string().trim().min(1).max(200).optional().describe('the same as search (kept for older calls)'),
  status: z.preprocess(upperList, z.array(z.enum(ORDER_STATUSES)).min(1).max(ORDER_STATUSES.length)).optional()
    .describe(`one or more order statuses: ${ORDER_STATUSES.join(', ')}; omit for every status`),
  channel: z.preprocess(upper, z.enum(ORDER_CHANNELS)).optional().describe(`only this channel: ${ORDER_CHANNELS.join(', ')}`),
  marketplace: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this marketplace code, e.g. IT or DE'),
  fulfillment: z.preprocess(upper, z.enum(['FBA', 'FBM'])).optional()
    .describe('FBA = Amazon ships it, FBM = the business ships it (as the channel reported it)'),
  dateFrom: isoDate.optional().describe('bought on or after this date (ISO)'),
  dateTo: isoDate.optional().describe('bought on or before this date (ISO)'),
  shipByBefore: isoDate.optional().describe('its ship-by date is on or before this moment (late or due); ISO'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`orders per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
    .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
})
type OrderSearchArgs = z.infer<typeof orderSearchInput>

/** Newest purchase first; an order without a purchase date last; the id breaks ties. */
const SEARCH_ORDER = [{ purchaseDate: { sort: 'desc' as const, nulls: 'last' as const } }, { id: 'desc' as const }]

/** The orders strictly after a cursor's order, in SEARCH_ORDER. */
function after(position: CursorPosition | null): Record<string, unknown> {
  if (!position) return {}
  const [bought] = position.values
  if (bought === null) return { purchaseDate: null, id: { lt: position.id } }
  if (typeof bought !== 'string' || Number.isNaN(Date.parse(bought))) throw new InvalidCursorError()
  const at = new Date(bought)
  return { OR: [{ purchaseDate: { lt: at } }, { purchaseDate: at, id: { lt: position.id } }, { purchaseDate: null }] }
}

/** The page's query string as the Orders page sends it: its filters, read by the page's own scope. */
function pageQuery(args: OrderSearchArgs): Record<string, string> {
  const text = args.search ?? args.buyer
  return {
    // Every status unless named: the page's "All" tab hides cancelled, refunded and returned orders; Claude sees them.
    status: (args.status ?? ORDER_STATUSES).join(','),
    ...(args.channel ? { channel: args.channel } : {}),
    ...(args.marketplace ? { marketplace: args.marketplace } : {}),
    ...(args.fulfillment ? { fulfillment: args.fulfillment } : {}),
    ...(args.dateFrom ? { dateFrom: args.dateFrom } : {}),
    ...(args.dateTo ? { dateTo: args.dateTo } : {}),
    ...(text ? { search: likeEscaped(text) } : {}),
  }
}

const orderSearch: AgentTool = {
  name: 'order-search',
  title: 'Search orders',
  input: orderSearchInput,
  requires: [F.ordersView],
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find orders in this business, newest first: by status (every status Nexus holds), channel, marketplace, FBA/FBM, '
    + 'purchase dates, ship-by date, or a search text (order number, buyer, SKU). Orders in the bin are left out. The '
    + 'buyer is masked: first name, city, country and a masked e-mail. amazonShips = Amazon ships it (FBA or Multi-Channel '
    + 'Fulfilment): Nexus only reads those. Paged: follow nextCursor with the same filters.',
  handler: (args) =>
    listTool('order-search', async () => {
      const a = args as OrderSearchArgs
      const size = a.limit ?? DEFAULT_PAGE_SIZE
      const { limit: _limit, cursor: _cursor, ...filters } = a
      const scope = cursorScope('order-search', { business: workspaceIdForQuery(), ...filters })
      const position = decodeCursor(scope, a.cursor)
      const base = orderListScope(pageQuery(a)).where
      if (a.shipByBefore) base.AND = (base.AND ?? []).concat({ shipByDate: { lte: new Date(a.shipByBefore) } })
      const [total, rows] = await Promise.all([
        prisma.order.count({ where: base }),
        prisma.order.findMany({
          where: { AND: [base, after(position)] },
          orderBy: SEARCH_ORDER,
          take: size + 1,
          select: {
            id: true, channel: true, marketplace: true, channelOrderId: true, status: true, fulfillmentMethod: true,
            totalPrice: true, currencyCode: true, customerName: true, customerEmail: true, shippingAddress: true,
            purchaseDate: true, paidAt: true, shipByDate: true, shippedAt: true, deliveredAt: true, cancelledAt: true,
            _count: {
              select: {
                items: true,
                shipments: true,
                returns: true,
                mcfShipments: { where: { status: { notIn: [...MCF_NOT_SHIPPING_STATUSES] } } },
              },
            },
          },
        }),
      ])
      const page = pageOf(rows, size, scope, (row) => ({ values: [iso(row.purchaseDate)], id: row.id }))
      return {
        ok: true,
        data: {
          total,
          count: page.items.length,
          nextCursor: page.nextCursor,
          orders: page.items.map((o) => ({
            id: o.id,
            channel: o.channel,
            marketplace: o.marketplace,
            channelOrderId: o.channelOrderId,
            status: o.status,
            fulfillmentMethod: o.fulfillmentMethod,
            amazonShips: isAmazonFulfilledOrder(o, o._count.mcfShipments),
            totalPrice: money(o.totalPrice),
            currencyCode: o.currencyCode,
            buyer: buyerOf(o),
            purchaseDate: iso(o.purchaseDate),
            paidAt: iso(o.paidAt),
            shipByDate: iso(o.shipByDate),
            shippedAt: iso(o.shippedAt),
            deliveredAt: iso(o.deliveredAt),
            cancelledAt: iso(o.cancelledAt),
            itemCount: o._count.items,
            shipmentCount: o._count.shipments,
            returnCount: o._count.returns,
          })),
        },
      }
    }),
}

// ── order-detail ────────────────────────────────────────────────────────────────────────────────────

const orderDetailTool: AgentTool = {
  name: 'order-detail',
  title: 'Order details',
  input: z.object({ orderId: z.string().trim().min(1).max(64).describe('Nexus order id (from order-search)') }),
  requires: [F.ordersView],
  // The fee total has no name the shared money registry knows: it is a fee.
  restrictedFields: { feesTotal: FIELDS.financialsFeesView },
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    'Read one order of this business: status, dates and promises, lines, shipments and tracking, returns, the invoice, '
    + 'the timeline, and its money (revenue, fees and net need the financials permissions). The buyer is masked: first '
    + 'name, city, country and a masked e-mail. Amazon-fulfilled orders (FBA, Multi-Channel Fulfilment) show their MCF '
    + 'requests, read only. An order in the bin or of another business is not found.',
  async handler(args) {
    const id = String(args.orderId ?? '')
    if (!id) return { ok: false, error: 'orderId is required' }
    const order = await orderDetail(id)
    // 07 O1 — an order in the bin reads as not found.
    if (!order || order.deletedAt) return { ok: false, error: 'Order not found' }
    const [timeline, financials, mcf, noteCount] = await Promise.all([
      orderTimeline(id),
      orderFinancials(id),
      prisma.mCFShipment.findMany({
        where: { orderId: id },
        orderBy: { requestedAt: 'desc' },
        select: {
          id: true, status: true, amazonFulfillmentOrderId: true, displayableOrderId: true, shippingSpeedCategory: true,
          requestedAt: true, shippedAt: true, deliveredAt: true, cancelledAt: true, trackingNumber: true, carrier: true, lastError: true,
        },
      }),
      prisma.orderNote.count({ where: { orderId: id } }),
    ])
    const activeMcf = mcf.filter((m) => !(MCF_NOT_SHIPPING_STATUSES as readonly string[]).includes(m.status)).length
    const amazonShips = isAmazonFulfilledOrder(order, activeMcf)
    const refunds = financials.transactions.filter((tx) => tx.transactionType === 'Refund')
    return {
      ok: true,
      data: {
        id: order.id,
        channel: order.channel,
        marketplace: order.marketplace,
        channelOrderId: order.channelOrderId,
        status: order.status,
        fiscalKind: order.fiscalKind,
        isPrime: order.isPrime,
        isBusinessOrder: !!(order.amazonMetadata as { IsBusinessOrder?: unknown } | null)?.IsBusinessOrder,
        totalPrice: order.totalPrice,
        currencyCode: order.currencyCode,
        buyer: { ...buyerOf(order), otherOrders: order.customerHistory.length },
        dates: {
          purchaseDate: iso(order.purchaseDate),
          paidAt: iso(order.paidAt),
          earliestShipDate: iso(order.earliestShipDate),
          shipByDate: iso(order.shipByDate),
          latestDeliveryDate: iso(order.latestDeliveryDate),
          shippedAt: iso(order.shippedAt),
          deliveredAt: iso(order.deliveredAt),
          cancelledAt: iso(order.cancelledAt),
        },
        fulfilment: {
          method: order.fulfillmentMethod,
          amazonShips,
          ...(amazonShips ? { note: 'Amazon ships this order (FBA or Multi-Channel Fulfilment): Nexus only reads it.' } : {}),
          mcfRequests: mcf.map((m) => ({
            id: m.id,
            status: m.status,
            amazonFulfillmentOrderId: m.amazonFulfillmentOrderId,
            displayableOrderId: m.displayableOrderId,
            speed: m.shippingSpeedCategory,
            requestedAt: iso(m.requestedAt),
            shippedAt: iso(m.shippedAt),
            deliveredAt: iso(m.deliveredAt),
            cancelledAt: iso(m.cancelledAt),
            carrier: m.carrier,
            trackingNumber: m.trackingNumber,
            lastError: m.lastError,
          })),
        },
        items: order.items.map((it) => ({
          sku: it.sku,
          quantity: it.quantity,
          price: it.price,
          productId: it.productId,
          productName: it.product?.name ?? null,
        })),
        shipments: order.shipments.map((s) => ({
          id: s.id,
          status: s.status,
          carrier: s.carrierCode,
          service: s.serviceName,
          trackingNumber: s.trackingNumber,
          warehouse: s.warehouse?.code ?? null,
          labelPrintedAt: iso(s.labelPrintedAt),
          shippedAt: iso(s.shippedAt),
          deliveredAt: iso(s.deliveredAt),
          heldAt: iso(s.heldAt),
          parcels: s.items.length,
        })),
        returns: order.returns.map((r) => ({
          id: r.id,
          rmaNumber: r.rmaNumber,
          status: r.status,
          reason: r.reason,
          refundCents: r.refundCents,
          receivedAt: iso(r.receivedAt),
          refundedAt: iso(r.refundedAt),
          lines: r.items.length,
        })),
        invoice: order.fiscalInvoice
          ? { invoiceNumber: order.fiscalInvoice.invoiceNumber, issuedAt: iso(order.fiscalInvoice.issuedAt), sdiStatus: order.fiscalInvoice.sdiStatus }
          : null,
        reviewRequests: order.reviewRequests.map((rr) => ({ channel: rr.channel, status: rr.status, scheduledFor: iso(rr.scheduledFor), sentAt: iso(rr.sentAt) })),
        tags: order.tags.map((t: { name: string }) => t.name),
        noteCount,
        money: {
          grossRevenue: financials.rollup.gross,
          feesTotal: financials.rollup.fees,
          netRevenue: financials.rollup.net,
          refundTransactions: refunds.length,
          transactionCount: financials.transactions.length,
        },
        timeline: (timeline?.events ?? []).map((event) => ({ at: iso(event.at), kind: event.kind, label: event.label })),
      },
    }
  },
}

export const ORDER_READ_TOOLS: AgentTool[] = [orderSearch, orderDetailTool]
