/**
 * MCP full control 07 O4 — the order reads, moved out of routes/orders.routes.ts so the Orders page and Claude's
 * order tools read one way. The code is the routes' own, moved unchanged: the routes answer byte for byte as before
 * (routes/orders-read-parity.vitest.test.ts, snapshots written by the route code before the move).
 *
 *   orderListScope(q)   the list's filters, sort and paging, from the page's query string (GET /api/orders)
 *   listOrders(q)       one page of the list, as GET /api/orders answers it
 *   orderDetail(id)     GET /api/orders/:id (null = not found)
 *   orderTimeline(id)   GET /api/orders/:id/timeline (null = not found)
 *   orderFinancials(id) GET /api/orders/:id/financials
 *
 * Every read runs in the caller's business (row-level security); an order of another business is not found.
 */

import prisma from '../../db.js'

export function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function csvParam(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v || v === 'ALL') return undefined
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/** What GET /api/orders filters, sorts and pages by. */
export interface OrderListScope {
  where: any
  orderBy: any
  page: number
  pageSize: number
  /** Applied after the page is read (they need the returns and refunds of its orders). */
  hasReturn: boolean | null
  hasRefund: boolean | null
}

/** The list's filters, sort and paging from its query string, as GET /api/orders reads them. */
export function orderListScope(q: any): OrderListScope {
  const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
  const pageSize = Math.min(500, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
  const search = (q.search ?? '').trim()

  const channels = csvParam(q.channel)
  const marketplaces = csvParam(q.marketplace)
  // OX.16 — "ALL" is the sentinel the StatusTabs uses to mark
  // "user explicitly chose All" (distinct from no status param,
  // which triggers the default-to-Unshipped redirect). Filter it
  // out here so it doesn't reach the WHERE clause.
  const statuses = csvParam(q.status)?.filter((s: string) => s !== 'ALL')
  const fulfillment = csvParam(q.fulfillment)
  const tagIds = csvParam(q.tags)
  const reviewStatus = csvParam(q.reviewStatus)
  const customerEmail = (q.customerEmail ?? '').trim() || null
  const dateFrom = q.dateFrom ? new Date(q.dateFrom) : null
  const dateTo = q.dateTo ? new Date(q.dateTo) : null
  const hasReturn = q.hasReturn === 'true' ? true : q.hasReturn === 'false' ? false : null
  const hasRefund = q.hasRefund === 'true' ? true : q.hasRefund === 'false' ? false : null
  const reviewEligible = q.reviewEligible === 'true'
  // OX.2: Italian "No Invoice Uploaded" tab — orders that should
  // have a FiscalInvoice (paid + non-terminal) but don't.
  const noInvoice = q.noInvoice === 'true'
  // PV-RT.3 — drill-through from the reconciliation banner's
  // "+N awaiting price" chip. Filters to Amazon EUR orders where
  // Order.totalPrice = 0 AND at least one OrderItem has quantity > 0
  // (matches the count query in dashboard.routes /sales-reconciliation).
  const awaitingPrice = q.awaitingPrice === 'true'
  // PV-RT.5 — abandoned-awaiting mode. After N days (default 60,
  // NEXUS_AWAITING_PRICE_ABANDONMENT_DAYS overrides) Amazon
  // realistically won't release OrderTotal. The default awaitingPrice
  // mode hides these so the chip count stays operationally useful;
  // operator can explicitly list them via this param to triage with
  // POST /admin/orders/:id/manual-total.
  const abandonedAwaitingPrice = q.abandonedAwaitingPrice === 'true'
  // OX.3 — order-type filter. Values map to:
  //   PRIME      → Order.isPrime = true
  //   BUSINESS   → amazonMetadata.IsBusinessOrder = true
  //   STANDARD   → not Prime AND not Business
  // Multi-select OR within the dimension.
  const orderTypes = csvParam(q.orderType)
  // OX.3 — date-range preset. The API also accepts explicit
  // dateFrom/dateTo; this is a shortcut: ?dateRange=24h|7d|30d|90d
  // resolves to the equivalent dateFrom (dateTo defaults to now).
  const dateRangePreset = (q.dateRange ?? '').toString().trim() as
    | ''
    | '24h'
    | '7d'
    | '30d'
    | '90d'
  let presetFrom: Date | null = null
  switch (dateRangePreset) {
    case '24h': presetFrom = new Date(Date.now() - 24 * 60 * 60 * 1000); break
    case '7d': presetFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); break
    case '30d': presetFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); break
    case '90d': presetFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); break
  }

  const sortBy = (q.sortBy ?? 'purchaseDate') as string
  const sortDir = (q.sortDir === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'

  // RB.1 — recycle-bin scope. Default = live-only (deletedAt IS NULL).
  // ?deleted=true flips to bin-only (deletedAt IS NOT NULL).
  const showDeleted = q.deleted === 'true'

  const where: any = {}
  where.deletedAt = showDeleted ? { not: null } : null
  if (channels && channels.length) where.channel = { in: channels }
  if (marketplaces && marketplaces.length) where.marketplace = { in: marketplaces }
  if (statuses && statuses.length) {
    where.status = { in: statuses }
  } else {
    // OX.17 — when no explicit status filter is set (e.g. user
    // clicks the All tab → status=ALL → stripped above), hide
    // cancelled/refunded/returned rows so the list matches the
    // "All" headline count. To see them, the operator clicks the
    // Cancelled tab which sets an explicit status filter.
    where.status = { notIn: ['CANCELLED', 'REFUNDED', 'RETURNED'] }
  }
  if (fulfillment && fulfillment.length) where.fulfillmentMethod = { in: fulfillment }
  if (customerEmail) where.customerEmail = { contains: customerEmail, mode: 'insensitive' }
  // OX.3 — explicit dateFrom/dateTo wins, otherwise apply the preset.
  const effectiveFrom = dateFrom ?? presetFrom
  if (effectiveFrom || dateTo) {
    where.purchaseDate = {}
    if (effectiveFrom) where.purchaseDate.gte = effectiveFrom
    if (dateTo) where.purchaseDate.lte = dateTo
  }
  // OX.3 — order-type filter. Multi-select OR within the dimension,
  // ANDed with the rest of the WHERE clause. Standard = NOT Prime
  // AND NOT Business (client-derived, no new index needed).
  if (orderTypes && orderTypes.length) {
    const typeClauses: any[] = []
    for (const t of orderTypes) {
      if (t === 'PRIME') typeClauses.push({ isPrime: true })
      else if (t === 'BUSINESS') typeClauses.push({ amazonMetadata: { path: ['IsBusinessOrder'], equals: true } })
      else if (t === 'STANDARD') {
        typeClauses.push({
          AND: [
            { OR: [{ isPrime: false }, { isPrime: null }] },
            { NOT: { amazonMetadata: { path: ['IsBusinessOrder'], equals: true } } },
          ],
        })
      }
    }
    if (typeClauses.length > 0) {
      where.AND = (where.AND ?? []).concat({ OR: typeClauses })
    }
  }
  if (search) {
    where.OR = [
      { channelOrderId: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerEmail: { contains: search, mode: 'insensitive' } },
      { items: { some: { sku: { contains: search, mode: 'insensitive' } } } },
    ]
  }
  // PV-RT.3 / PV-RT.5 — awaiting-price drill-through.
  //
  // awaitingPrice=true (default): orders where Amazon hasn't released
  //   OrderTotal AND the order is recent enough to still be
  //   automated-recoverable (purchaseDate >= now - abandonmentDays).
  //   These are the orders the banner counts + the operator should
  //   wait on or back-fill.
  //
  // abandonedAwaitingPrice=true: orders that fell off the automated
  //   recovery curve. Operator triages via POST /admin/orders/:id/
  //   manual-total or accepts the €0.
  if (awaitingPrice || abandonedAwaitingPrice) {
    where.channel = 'AMAZON'
    // Awaiting-price is currency-agnostic: an order missing its OrderTotal
    // is "awaiting price" on UK/SE/PL just as on the EUR markets. The old
    // currencyCode='EUR' filter was a single-market leftover that silently
    // hid genuine awaiting-price orders on non-EUR marketplaces (MS-series
    // expanded Xavia to 11 EU markets). No currency is summed here — this
    // only counts/lists orders — so removing the filter is safe.
    where.totalPrice = 0
    where.items = { some: { quantity: { gt: 0 } } }
    const abandonmentDaysRaw = Number(process.env.NEXUS_AWAITING_PRICE_ABANDONMENT_DAYS ?? 60)
    const abandonmentDays =
      Number.isFinite(abandonmentDaysRaw) && abandonmentDaysRaw > 0
        ? Math.trunc(abandonmentDaysRaw)
        : 60
    const cutoff = new Date(Date.now() - abandonmentDays * 86_400_000)
    if (awaitingPrice) {
      // Recent enough to still be automated-recoverable.
      where.purchaseDate = { ...(where.purchaseDate ?? {}), gte: cutoff }
    } else {
      // abandonedAwaitingPrice — older than the cutoff.
      where.purchaseDate = { ...(where.purchaseDate ?? {}), lt: cutoff }
    }
  }
  if (tagIds && tagIds.length) {
    where.tags = { some: { tagId: { in: tagIds } } }
  }
  if (reviewStatus && reviewStatus.length) {
    where.reviewRequests = { some: { status: { in: reviewStatus } } }
  }
  if (reviewEligible) {
    where.deliveredAt = { not: null }
    // OX.3: concat instead of assign so other AND-clauses (orderType,
    // noInvoice) can coexist.
    where.AND = (where.AND ?? []).concat([
      { reviewRequests: { none: {} } },
      { returns: { none: { status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } } } },
    ])
  }
  if (noInvoice) {
    // OX.2 — Italian compliance: paid + non-terminal orders that
    // never got a FiscalInvoice row issued. Mirrors the
    // /api/orders/stats `noInvoice` aggregate.
    where.marketplace = 'IT'
    where.status = { in: ['PROCESSING', 'SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'] }
    where.fiscalInvoice = null
  }

  // Order-by translation
  let orderBy: any
  switch (sortBy) {
    case 'createdAt': orderBy = { createdAt: sortDir }; break
    case 'updatedAt': orderBy = { updatedAt: sortDir }; break
    case 'totalPrice': orderBy = { totalPrice: sortDir }; break
    case 'customer': orderBy = { customerEmail: sortDir }; break
    case 'channel': orderBy = [{ channel: sortDir }, { marketplace: 'asc' }]; break
    case 'status': orderBy = { status: sortDir }; break
    case 'purchaseDate':
    default: orderBy = { purchaseDate: sortDir }
  }

  return { where, orderBy, page, pageSize, hasReturn, hasRefund }
}

/** One page of the order list, exactly as GET /api/orders answers it. */
export async function listOrders(q: any) {
  const { where, orderBy, page, pageSize, hasReturn, hasRefund } = orderListScope(q)

  const [total, rawOrders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        // OX.4 — row needs first item's product name + ASIN +
        // thumbnail. Include enough product fields to render the
        // Amazon-style product cell without an N+1.
        items: {
          select: {
            id: true,
            sku: true,
            quantity: true,
            price: true,
            productId: true,
            product: {
              select: {
                id: true,
                name: true,
                amazonAsin: true,
                images: { select: { url: true }, take: 1, orderBy: { sortOrder: 'asc' } },
              },
            },
          },
        },
        tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
        reviewRequests: { select: { id: true, channel: true, status: true, sentAt: true, scheduledFor: true } },
        _count: { select: { items: true, shipments: true, returns: true, financialTransactions: true } },
      },
    }),
  ])

  // Optional flags computed in JS — has-return / has-refund / repeat-customer
  const orderIds = rawOrders.map((o) => o.id)
  const emails = Array.from(new Set(rawOrders.map((o) => o.customerEmail).filter(Boolean)))

  const [activeReturnsByOrder, refundsByOrder, customerOrderCounts] = await Promise.all([
    prisma.return.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds }, status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } },
      _count: true,
    }),
    prisma.financialTransaction.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds }, transactionType: 'Refund' },
      _count: true,
    }),
    emails.length === 0 ? Promise.resolve([] as Array<{ customerEmail: string; _count: number }>) : prisma.order.groupBy({
      by: ['customerEmail'],
      where: { customerEmail: { in: emails } },
      _count: true,
    }),
  ])
  const activeReturns = new Set(activeReturnsByOrder.map((r) => r.orderId))
  const hasRefundSet = new Set(refundsByOrder.map((r) => r.orderId))
  const customerOrderCountMap = new Map(customerOrderCounts.map((c: any) => [c.customerEmail, c._count]))

  const orders = rawOrders
    .filter((o) => {
      if (hasReturn === true && !activeReturns.has(o.id)) return false
      if (hasReturn === false && activeReturns.has(o.id)) return false
      if (hasRefund === true && !hasRefundSet.has(o.id)) return false
      if (hasRefund === false && hasRefundSet.has(o.id)) return false
      return true
    })
    .map((o) => {
      // OX.4 — surface the first item's product on the row so the
      // Amazon-style cell can render thumbnail + name + ASIN +
      // line subtotal without an N+1 fetch.
      const firstItem = o.items[0]
      const firstProduct = firstItem?.product ?? null
      const isBusinessOrder = !!(o.amazonMetadata as any)?.IsBusinessOrder
      return {
        id: o.id,
        channel: o.channel,
        marketplace: o.marketplace,
        channelOrderId: o.channelOrderId,
        status: o.status,
        fulfillmentMethod: o.fulfillmentMethod,
        totalPrice: Number(o.totalPrice),
        currencyCode: o.currencyCode,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        shippingAddress: o.shippingAddress,
        purchaseDate: o.purchaseDate,
        paidAt: o.paidAt,
        shippedAt: o.shippedAt,
        deliveredAt: o.deliveredAt,
        cancelledAt: o.cancelledAt,
        // OX.4 — Amazon ship-by + deliver-by promises (already in
        // schema; was missing from the list payload).
        shipByDate: o.shipByDate,
        latestDeliveryDate: o.latestDeliveryDate,
        isPrime: o.isPrime,
        isBusinessOrder,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        itemCount: o._count.items,
        shipmentCount: o._count.shipments,
        returnCount: o._count.returns,
        financialTxCount: o._count.financialTransactions,
        hasActiveReturn: activeReturns.has(o.id),
        hasRefund: hasRefundSet.has(o.id),
        customerOrderCount: customerOrderCountMap.get(o.customerEmail) ?? 1,
        tags: o.tags.map((t: any) => t.tag),
        reviewRequests: o.reviewRequests,
        items: o.items.map((it) => ({
          id: it.id,
          sku: it.sku,
          quantity: it.quantity,
          price: Number(it.price),
          productId: it.productId,
        })),
        firstItem: firstItem
          ? {
              sku: firstItem.sku,
              quantity: firstItem.quantity,
              price: Number(firstItem.price),
              subtotal: Number(firstItem.price) * firstItem.quantity,
              productName: firstProduct?.name ?? null,
              amazonAsin: firstProduct?.amazonAsin ?? null,
              thumbnailUrl: firstProduct?.images?.[0]?.url ?? null,
            }
          : null,
      }
    })

  return {
    orders,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** GET /api/orders/:id — the order with its relations and the buyer's last 10 other orders; null when not found. */
export async function orderDetail(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: { select: { id: true, sku: true, name: true, basePrice: true, images: { select: { url: true }, take: 1 } } },
        },
      },
      financialTransactions: { orderBy: { transactionDate: 'desc' } },
      shipments: { include: { items: true, warehouse: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' } },
      returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
      reviewRequests: { include: { rule: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } },
      tags: { include: { tag: true } },
      // OX.14 — surface CE.4 routing audit so operators can see
      // why a particular warehouse was picked for fulfilment.
      routingDecisions: { orderBy: { createdAt: 'desc' } },
      // OX.14 — Italian fiscal block needs the FiscalInvoice link
      // (status + invoice number + SDI status) when one exists.
      fiscalInvoice: true,
    },
  })
  if (!order) return null

  // Customer history sidebar — last 10 orders from this email.
  // OX.0: include currencyCode so the widget renders in the order's
  // actual currency (not a hardcoded €) and so PENDING Amazon
  // orders with totalPrice=0 can render as "Awaiting payment"
  // rather than "€0.00".
  const history = await prisma.order.findMany({
    where: { customerEmail: order.customerEmail, id: { not: order.id } },
    select: { id: true, channelOrderId: true, channel: true, totalPrice: true, currencyCode: true, status: true, purchaseDate: true, createdAt: true },
    orderBy: { purchaseDate: 'desc' },
    take: 10,
  })

  return {
    ...order,
    totalPrice: Number(order.totalPrice),
    items: order.items.map((it) => ({
      ...it,
      price: Number(it.price),
      product: it.product
        ? { ...it.product, basePrice: Number(it.product.basePrice), thumbnailUrl: it.product.images?.[0]?.url ?? null }
        : null,
    })),
    financialTransactions: order.financialTransactions.map((tx) => ({
      ...tx,
      amount: Number(tx.amount),
      amazonFee: Number(tx.amazonFee),
      fbaFee: Number(tx.fbaFee),
      paymentServicesFee: Number(tx.paymentServicesFee),
      ebayFee: Number(tx.ebayFee),
      paypalFee: Number(tx.paypalFee),
      otherFees: Number(tx.otherFees),
      grossRevenue: Number(tx.grossRevenue),
      netRevenue: Number(tx.netRevenue),
    })),
    tags: order.tags.map((t: any) => t.tag),
    customerHistory: history.map((h) => ({ ...h, totalPrice: Number(h.totalPrice) })),
  }
}

/** GET /api/orders/:id/timeline — the order's events, oldest first; null when not found. */
export async function orderTimeline(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      shipments: { select: { id: true, status: true, carrierCode: true, trackingNumber: true, shippedAt: true, deliveredAt: true, createdAt: true } },
      returns: { select: { id: true, rmaNumber: true, status: true, receivedAt: true, refundedAt: true, restockedAt: true, createdAt: true } },
      reviewRequests: { select: { id: true, channel: true, status: true, scheduledFor: true, sentAt: true, errorMessage: true } },
    },
  })
  if (!order) return null

  type Event = { at: Date; kind: string; label: string; meta?: any }
  const events: Event[] = []
  if (order.purchaseDate) events.push({ at: order.purchaseDate, kind: 'placed', label: 'Order placed' })
  if (order.paidAt) events.push({ at: order.paidAt, kind: 'paid', label: 'Payment received' })
  if (order.shippedAt) events.push({ at: order.shippedAt, kind: 'shipped', label: 'Shipped' })
  if (order.deliveredAt) events.push({ at: order.deliveredAt, kind: 'delivered', label: 'Delivered' })
  if (order.cancelledAt) events.push({ at: order.cancelledAt, kind: 'cancelled', label: 'Cancelled' })
  for (const s of order.shipments) {
    if (s.shippedAt) events.push({ at: s.shippedAt, kind: 'shipment-shipped', label: `Shipment ${s.trackingNumber ?? ''} shipped`, meta: { shipmentId: s.id, carrier: s.carrierCode } })
    if (s.deliveredAt) events.push({ at: s.deliveredAt, kind: 'shipment-delivered', label: `Shipment ${s.trackingNumber ?? ''} delivered`, meta: { shipmentId: s.id } })
  }
  for (const r of order.returns) {
    if (r.receivedAt) events.push({ at: r.receivedAt, kind: 'return-received', label: `Return ${r.rmaNumber ?? ''} received`, meta: { returnId: r.id } })
    if (r.refundedAt) events.push({ at: r.refundedAt, kind: 'return-refunded', label: `Return ${r.rmaNumber ?? ''} refunded`, meta: { returnId: r.id } })
    if (r.restockedAt) events.push({ at: r.restockedAt, kind: 'return-restocked', label: `Return ${r.rmaNumber ?? ''} restocked`, meta: { returnId: r.id } })
  }
  for (const rr of order.reviewRequests) {
    if (rr.sentAt) events.push({ at: rr.sentAt, kind: 'review-sent', label: `Review request sent on ${rr.channel}`, meta: { reviewRequestId: rr.id, status: rr.status } })
    if (rr.scheduledFor && !rr.sentAt) events.push({ at: rr.scheduledFor, kind: 'review-scheduled', label: `Review request scheduled (${rr.channel})`, meta: { reviewRequestId: rr.id } })
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime())
  return { events }
}

/** GET /api/orders/:id/financials — gross, fees and net, and every transaction (none for an unknown order). */
export async function orderFinancials(id: string) {
  const txs = await prisma.financialTransaction.findMany({
    where: { orderId: id },
    orderBy: { transactionDate: 'desc' },
  })
  let gross = 0, fees = 0, net = 0
  for (const tx of txs) {
    gross += Number(tx.grossRevenue)
    fees += Number(tx.amazonFee) + Number(tx.fbaFee) + Number(tx.paymentServicesFee) + Number(tx.ebayFee) + Number(tx.paypalFee) + Number(tx.otherFees)
    net += Number(tx.netRevenue)
  }
  return {
    rollup: { gross, fees, net },
    transactions: txs.map((tx) => ({
      ...tx,
      amount: Number(tx.amount),
      amazonFee: Number(tx.amazonFee),
      fbaFee: Number(tx.fbaFee),
      paymentServicesFee: Number(tx.paymentServicesFee),
      ebayFee: Number(tx.ebayFee),
      paypalFee: Number(tx.paypalFee),
      otherFees: Number(tx.otherFees),
      grossRevenue: Number(tx.grossRevenue),
      netRevenue: Number(tx.netRevenue),
    })),
  }
}
