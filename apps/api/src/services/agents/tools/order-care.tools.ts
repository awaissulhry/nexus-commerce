/**
 * MCP full control 07 O6 — Claude's after-sale reads: `return-search`, `customer-lookup`, `review-search`,
 * `order-report`, `privacy-requests`. Read only, in the caller's business only (row-level security).
 *
 * No personal data leaves (decision O-1): a buyer, a customer or a reviewer is a first name, a city, a country and a
 * masked e-mail at most; never a full name, an address, a phone, an e-mail or a tax code. Money that is revenue
 * (a customer's total spend, sales per currency, a day's corrispettivi) needs the financials permissions.
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
import { firstNameOf, maskBuyer, maskEmail } from '../../orders/buyer-mask.js'
import { orderReport, REPORT_KINDS, type ReportKind } from '../../orders/order-report.service.js'
import { listPrivacyRequests } from '../../privacy/customer-privacy.service.js'
import type { AgentTool, ToolContext, ToolPermission, ToolResult } from '../tool-types.js'

const ORDER_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL'] as const
const RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING', 'RESTOCKED', 'REFUNDED', 'REJECTED', 'SCRAPPED'] as const

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const upperList = (value: unknown) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value
  return Array.isArray(list) ? list.map(upper).filter((item) => item !== '') : list
}
/** true / false, also as the words "true" and "false" (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const isoDate = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'a date, e.g. 2026-09-30 or 2026-09-30T12:00:00Z')
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
const ci = (text: string) => ({ contains: likeEscaped(text), mode: 'insensitive' as const })

const paging = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`rows per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional().describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
}

async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

/** A cursor bound to this tool, this business and these filters; and where it points. */
function cursorOf(tool: string, args: Record<string, unknown>) {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  const scope = cursorScope(tool, { business: workspaceIdForQuery(), ...filters })
  return { scope, position: decodeCursor(scope, args.cursor as string | undefined), size: (args.limit as number | undefined) ?? DEFAULT_PAGE_SIZE }
}

const dateValue = (value: unknown): Date => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new InvalidCursorError()
  return new Date(value)
}
/** Rows strictly after a cursor in "newest `field` first, then id descending" (a field that is never empty). */
function afterDesc(field: string, position: CursorPosition | null): Record<string, unknown> {
  if (!position) return {}
  const at = dateValue(position.values[0])
  return { OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: position.id } }] }
}
/** The same for a field that may be empty: empty ones come last. */
function afterDescNullable(field: string, position: CursorPosition | null): Record<string, unknown> {
  if (!position) return {}
  const [value] = position.values
  if (value === null) return { [field]: null, id: { lt: position.id } }
  const at = dateValue(value)
  return { OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: position.id } }, { [field]: null }] }
}

// ── return-search ───────────────────────────────────────────────────────────────────────────────────

const returnSearchInput = z.object({
  status: z.preprocess(upperList, z.array(z.enum(RETURN_STATUSES)).min(1).max(RETURN_STATUSES.length)).optional()
    .describe(`one or more return statuses: ${RETURN_STATUSES.join(', ')}; omit for every status`),
  channel: z.preprocess(upper, z.enum(ORDER_CHANNELS)).optional().describe('only this channel'),
  marketplace: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this marketplace code, e.g. IT'),
  refundStatus: z.preprocess(upper, z.string().min(1).max(40)).optional().describe('only this refund status, e.g. PENDING, REFUNDED, FAILED'),
  fba: flag.optional().describe('true = only FBA returns (Amazon handles them), false = none of them'),
  search: z.string().trim().min(1).max(200).optional().describe('an RMA, a channel return id, an order number or a SKU (a fragment)'),
  dateFrom: isoDate.optional().describe('opened on or after this date (ISO)'),
  dateTo: isoDate.optional().describe('opened on or before this date (ISO)'),
  ...paging,
})

const returnSearch: AgentTool = {
  name: 'return-search',
  title: 'Search returns',
  input: returnSearchInput,
  requires: [F.returnsView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find the returns of this business, newest first: by status, channel, marketplace, refund status, FBA, dates or a '
    + 'search text (RMA, channel return id, order number, SKU). Each return gives its lines, its refunds, its label and '
    + 'tracking, and its order (buyer masked). Paged: follow nextCursor.',
  handler: (args) =>
    listTool('return-search', async () => {
      const a = args as z.infer<typeof returnSearchInput>
      const { scope, position, size } = cursorOf('return-search', a)
      const where: Record<string, unknown> = {
        ...(a.status ? { status: { in: a.status } } : {}),
        ...(a.channel ? { channel: a.channel } : {}),
        ...(a.marketplace ? { marketplace: a.marketplace } : {}),
        ...(a.refundStatus ? { refundStatus: a.refundStatus } : {}),
        ...(a.fba !== undefined ? { isFbaReturn: a.fba } : {}),
        ...(a.dateFrom || a.dateTo
          ? { createdAt: { ...(a.dateFrom ? { gte: new Date(a.dateFrom) } : {}), ...(a.dateTo ? { lte: new Date(a.dateTo) } : {}) } }
          : {}),
        ...(a.search
          ? { OR: [{ rmaNumber: ci(a.search) }, { channelReturnId: ci(a.search) }, { order: { channelOrderId: ci(a.search) } }, { items: { some: { sku: ci(a.search) } } }] }
          : {}),
      }
      const [total, rows] = await Promise.all([
        prisma.return.count({ where }),
        prisma.return.findMany({
          where: { AND: [where, afterDesc('createdAt', position)] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: size + 1,
          select: {
            id: true, rmaNumber: true, channel: true, marketplace: true, channelReturnId: true, status: true, reason: true,
            conditionGrade: true, refundStatus: true, refundCents: true, currencyCode: true, isFbaReturn: true, returnType: true,
            warrantyStatus: true, returnLabelCarrier: true, returnTrackingNumber: true, channelRefundError: true,
            createdAt: true, receivedAt: true, inspectedAt: true, refundedAt: true, restockedAt: true,
            items: { select: { sku: true, quantity: true, conditionGrade: true, disposition: true } },
            refunds: { orderBy: { createdAt: 'asc' }, select: { amountCents: true, currencyCode: true, kind: true, channelStatus: true, channelError: true, channelPostedAt: true } },
            order: { select: { id: true, channelOrderId: true, customerName: true, customerEmail: true, shippingAddress: true } },
          },
        }),
      ])
      const page = pageOf(rows, size, scope, (row) => ({ values: [iso(row.createdAt)], id: row.id }))
      return {
        ok: true,
        data: {
          total,
          count: page.items.length,
          nextCursor: page.nextCursor,
          returns: page.items.map(({ order, createdAt, receivedAt, inspectedAt, refundedAt, restockedAt, refunds, ...r }) => ({
            ...r,
            dates: { opened: iso(createdAt), received: iso(receivedAt), inspected: iso(inspectedAt), refunded: iso(refundedAt), restocked: iso(restockedAt) },
            refunds: refunds.map((refund) => ({ ...refund, channelPostedAt: iso(refund.channelPostedAt) })),
            order: order
              ? { id: order.id, channelOrderId: order.channelOrderId, buyer: maskBuyer({ name: order.customerName, email: order.customerEmail, address: order.shippingAddress }) }
              : null,
          })),
        },
      }
    }),
}

// ── customer-lookup ─────────────────────────────────────────────────────────────────────────────────

const customerLookupInput = z.object({
  customerId: z.string().trim().min(1).max(200).optional().describe('one customer, by Nexus customer id: also lists their recent orders'),
  search: z.string().trim().min(1).max(200).optional().describe('a name or e-mail fragment, matched as typed'),
  riskFlag: z.string().trim().min(1).max(40).optional().describe('only customers with this risk flag'),
  tag: z.string().trim().min(1).max(60).optional().describe('only customers with this tag'),
  ...paging,
})

const customerLookup: AgentTool = {
  name: 'customer-lookup',
  title: 'Look up customers',
  input: customerLookupInput,
  requires: [F.customersView],
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find customers of this business, most recent buyers first, by a name or e-mail fragment, a risk flag or a tag; or '
    + 'read one by customerId with their recent orders. Each customer is masked: first name, city, country, masked '
    + 'e-mail; never an address, phone, e-mail or tax code. Orders, first and last order; total spend needs the revenue '
    + 'permission. Paged: follow nextCursor.',
  handler: (args) =>
    listTool('customer-lookup', async () => {
      const a = args as z.infer<typeof customerLookupInput>
      const { scope, position, size } = cursorOf('customer-lookup', a)
      const where: Record<string, unknown> = {
        ...(a.customerId ? { id: a.customerId } : {}),
        ...(a.riskFlag ? { riskFlag: a.riskFlag } : {}),
        ...(a.tag ? { tags: { has: a.tag } } : {}),
        ...(a.search ? { OR: [{ name: ci(a.search) }, { email: ci(a.search) }] } : {}),
      }
      const [total, rows] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({
          where: { AND: [where, afterDescNullable('lastOrderAt', position)] },
          orderBy: [{ lastOrderAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          take: size + 1,
          select: {
            id: true, name: true, email: true, fiscalKind: true, partitaIva: true, totalOrders: true, totalSpentCents: true,
            firstOrderAt: true, lastOrderAt: true, channelOrderCounts: true, tags: true, riskFlag: true, manualReviewState: true,
            rfmLabel: true, rfmScore: true,
            addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }], take: 1, select: { city: true, country: true } },
            _count: { select: { notes: true } },
          },
        }),
      ])
      if (a.customerId && total === 0) return { ok: false, error: 'Customer not found' }
      const page = pageOf(rows, size, scope, (row) => ({ values: [iso(row.lastOrderAt)], id: row.id }))
      const recentOrders = a.customerId && page.items[0]
        ? await prisma.order.findMany({
            where: { customerId: page.items[0].id, deletedAt: null },
            orderBy: [{ purchaseDate: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
            take: 20,
            select: { id: true, channel: true, marketplace: true, channelOrderId: true, status: true, totalPrice: true, currencyCode: true, purchaseDate: true },
          })
        : null
      return {
        ok: true,
        data: {
          total,
          count: page.items.length,
          nextCursor: page.nextCursor,
          customers: page.items.map((c) => ({
            id: c.id,
            firstName: firstNameOf(c.name),
            email: maskEmail(c.email),
            city: c.addresses[0]?.city ?? null,
            country: c.addresses[0]?.country ?? null,
            fiscalKind: c.fiscalKind,
            hasVatNumber: !!c.partitaIva,
            totalOrders: c.totalOrders,
            totalSpentCents: Number(c.totalSpentCents),
            firstOrderAt: iso(c.firstOrderAt),
            lastOrderAt: iso(c.lastOrderAt),
            channelOrderCounts: c.channelOrderCounts,
            tags: c.tags,
            riskFlag: c.riskFlag,
            manualReviewState: c.manualReviewState,
            rfm: c.rfmLabel ? { label: c.rfmLabel, score: c.rfmScore } : null,
            noteCount: c._count.notes,
          })),
          ...(recentOrders
            ? { recentOrders: recentOrders.map((o) => ({ ...o, totalPrice: Number(o.totalPrice), purchaseDate: iso(o.purchaseDate) })) }
            : {}),
        },
      }
    }),
}

// ── review-search ───────────────────────────────────────────────────────────────────────────────────

const REVIEW_BODY_CHARS = 600
const reviewSearchInput = z.object({
  channel: z.preprocess(upper, z.enum(ORDER_CHANNELS)).optional().describe('only this channel'),
  marketplace: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this marketplace code'),
  productId: z.string().trim().min(1).max(64).optional().describe('only reviews of this Nexus product'),
  sku: z.string().trim().min(1).max(100).optional().describe('only reviews of this SKU (or one starting with it)'),
  minRating: z.coerce.number().int().min(1).max(5).optional().describe('rating at least (1–5)'),
  maxRating: z.coerce.number().int().min(1).max(5).optional().describe('rating at most (1–5); e.g. 2 for the bad ones'),
  triageStatus: z.string().trim().min(1).max(40).optional().describe('only this triage status, as the review desk sets it'),
  unanswered: flag.optional().describe('true = only reviews with no reply sent'),
  search: z.string().trim().min(1).max(200).optional().describe('words in the title or text, matched as typed'),
  dateFrom: isoDate.optional().describe('posted on or after this date (ISO)'),
  dateTo: isoDate.optional().describe('posted on or before this date (ISO)'),
  ...paging,
})

const reviewSearch: AgentTool = {
  name: 'review-search',
  title: 'Search reviews',
  input: reviewSearchInput,
  requires: [F.reviewsView],
  category: 'comms',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find the reviews this business received, newest first: by channel, marketplace, product or SKU, rating, triage '
    + 'status, unanswered, dates or words. Each gives its rating, title and text (cut to 600 characters), the '
    + "reviewer's first name only, the sentiment Nexus read, and its replies' status. Also the count and the average "
    + 'rating of all that match. Paged: follow nextCursor.',
  handler: (args) =>
    listTool('review-search', async () => {
      const a = args as z.infer<typeof reviewSearchInput>
      const { scope, position, size } = cursorOf('review-search', a)
      const rating = a.minRating || a.maxRating ? { rating: { ...(a.minRating ? { gte: a.minRating } : {}), ...(a.maxRating ? { lte: a.maxRating } : {}) } } : {}
      const where: Record<string, unknown> = {
        ...(a.channel ? { channel: a.channel } : {}),
        ...(a.marketplace ? { marketplace: a.marketplace } : {}),
        ...(a.productId ? { productId: a.productId } : {}),
        ...(a.sku ? { sku: { startsWith: likeEscaped(a.sku), mode: 'insensitive' } } : {}),
        ...rating,
        ...(a.triageStatus ? { triageStatus: a.triageStatus } : {}),
        ...(a.unanswered ? { responses: { none: { status: 'SENT' } } } : {}),
        ...(a.search ? { OR: [{ title: ci(a.search) }, { body: ci(a.search) }] } : {}),
        ...(a.dateFrom || a.dateTo
          ? { postedAt: { ...(a.dateFrom ? { gte: new Date(a.dateFrom) } : {}), ...(a.dateTo ? { lte: new Date(a.dateTo) } : {}) } }
          : {}),
      }
      const [summary, rows] = await Promise.all([
        prisma.review.aggregate({ where, _count: { _all: true }, _avg: { rating: true } }),
        prisma.review.findMany({
          where: { AND: [where, afterDesc('postedAt', position)] },
          orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
          take: size + 1,
          select: {
            id: true, channel: true, marketplace: true, productId: true, sku: true, asin: true, rating: true, title: true, body: true,
            authorName: true, verifiedPurchase: true, helpfulVotes: true, postedAt: true, triageStatus: true, triageTags: true,
            sentiment: { select: { label: true, categories: true } },
            responses: { orderBy: { createdAt: 'desc' }, select: { status: true, sentAt: true } },
          },
        }),
      ])
      const page = pageOf(rows, size, scope, (row) => ({ values: [iso(row.postedAt)], id: row.id }))
      return {
        ok: true,
        data: {
          total: summary._count._all,
          averageRating: summary._avg.rating == null ? null : Math.round(summary._avg.rating * 100) / 100,
          count: page.items.length,
          nextCursor: page.nextCursor,
          reviews: page.items.map(({ authorName, body, postedAt, responses, ...r }) => ({
            ...r,
            reviewer: firstNameOf(authorName),
            body: body.length > REVIEW_BODY_CHARS ? `${body.slice(0, REVIEW_BODY_CHARS)}…` : body,
            postedAt: iso(postedAt),
            replies: responses.map((reply) => ({ status: reply.status, sentAt: iso(reply.sentAt) })),
          })),
        },
      }
    }),
}

// ── order-report ────────────────────────────────────────────────────────────────────────────────────

/** What each report needs on top of orders.view: its data's own view permission (the pages' own rules). */
const REPORT_NEEDS: Record<ReportKind, ToolPermission[]> = {
  orders: [],
  'sync-health': [],
  shipping: [F.outboundManage],
  returns: [F.returnsView],
  'refund-deadlines': [F.returnsView],
  'review-requests': [F.reviewsView],
  corrispettivi: [F.ordersExport, FIELDS.financialsRevenueView],
}

const orderReportInput = z.object({
  kind: z.enum(REPORT_KINDS).describe(
    'which report: orders (by status, channel, marketplace; sales; to ship and late), sync-health (newest order per '
      + 'channel), shipping (queue by urgency, shipments, tracking uploads), returns (by status, refund status, reason; '
      + 'return rate), refund-deadlines (received returns against the 14-day refund rule), review-requests (by status '
      + 'and channel), corrispettivi (one day\'s B2C summary by VAT rate, preview only)',
  ),
  days: z.coerce.number().int().min(1).max(365).optional().describe('the window in days, for the reports that have one (default 30)'),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('corrispettivi only: the day, YYYY-MM-DD (default yesterday)'),
})

const orderReportTool: AgentTool = {
  name: 'order-report',
  title: 'Order desk reports',
  input: orderReportInput,
  requires: [F.ordersView],
  // Revenue with names the shared money registry does not know.
  restrictedFields: {
    salesByCurrency: FIELDS.financialsRevenueView,
    byRate: FIELDS.financialsRevenueView,
    totalImponibile: FIELDS.financialsRevenueView,
    totalImposta: FIELDS.financialsRevenueView,
    grandTotal: FIELDS.financialsRevenueView,
  },
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    'One report of this business\'s order desk: counts and totals only, never a buyer. Some reports need more than '
    + 'orders.view: shipping needs outbound.manage, returns and refund-deadlines need returns.view, review-requests '
    + 'needs reviews.view, corrispettivi needs orders.export and the revenue permission; sales totals need the revenue '
    + 'permission.',
  async handler(args, ctx: ToolContext) {
    const kind = args.kind as ReportKind
    const missing = REPORT_NEEDS[kind].filter((permission) => !ctx.can(permission))
    if (missing.length) return { ok: false, error: `The ${kind} report needs ${missing.join(' and ')}, which you do not hold in this business.` }
    try {
      return { ok: true, data: { kind, ...(await orderReport(kind, { days: args.days as number | undefined, date: args.date as string | undefined })) } }
    } catch (error) {
      if (kind === 'corrispettivi') return { ok: false, error: `No corrispettivi preview for that day: ${error instanceof Error ? error.message : String(error)}` }
      throw error
    }
  },
}

// ── privacy-requests ────────────────────────────────────────────────────────────────────────────────

const privacyRequestsInput = z.object({
  status: z.string().trim().min(1).max(40).optional().describe('only this status, e.g. REVIEW_REQUIRED'),
  channel: z.preprocess(upper, z.enum(ORDER_CHANNELS)).optional().describe('only notices from this channel'),
  ...paging,
})

const privacyRequests: AgentTool = {
  name: 'privacy-requests',
  title: 'Privacy requests',
  input: privacyRequestsInput,
  // Not settings.privacy.manage: no tool may require it (09 §2, tool-never). The list carries no personal data.
  requires: [F.customersView],
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    "The buyers' privacy requests this business received (today: eBay account-deletion notices matched to one of its "
    + 'orders), newest first, with how many wait for a decision. Read only and with no personal data: ids, channel, how '
    + 'the notice was matched, status, dates and the order it matched. Deciding and erasing stay with a person in '
    + 'Nexus (Settings → Privacy); Claude cannot do either. Paged: follow nextCursor.',
  handler: (args) =>
    listTool('privacy-requests', async () => {
      const a = args as z.infer<typeof privacyRequestsInput>
      const { scope, position, size } = cursorOf('privacy-requests', a)
      const after = position ? { createdAt: dateValue(position.values[0]), id: position.id } : null
      const found = await listPrivacyRequests({ status: a.status, channel: a.channel }, { take: size + 1, after })
      const page = pageOf(found.rows, size, scope, (row) => ({ values: [iso(row.createdAt)], id: row.id }))
      return {
        ok: true,
        data: {
          total: found.total,
          byStatus: found.byStatus,
          count: page.items.length,
          nextCursor: page.nextCursor,
          requests: page.items.map((row) => ({
            ...row,
            createdAt: iso(row.createdAt),
            decidedAt: iso(row.decidedAt),
            decide: 'in Nexus, Settings → Privacy (a person)',
          })),
        },
      }
    }),
}

export const ORDER_CARE_TOOLS: AgentTool[] = [returnSearch, customerLookup, reviewSearch, orderReportTool, privacyRequests]
