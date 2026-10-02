/**
 * MCP full control 07 O5 — the outbound reads, moved out of routes/fulfillment.routes.ts so the Outbound page and
 * Claude's fulfilment tools read one way. The code is the routes' own, moved unchanged: the routes answer byte for
 * byte as before (routes/fulfillment-read-parity.vitest.test.ts, snapshots written by the route code before the move).
 *
 *   pendingOrdersWhere(q)       the ship queue's filters (orders to ship, no live shipment), as the page reads them
 *   pendingOrdersQueue(q)       GET /fulfillment/outbound/pending-orders
 *   shipmentById(id)            GET /fulfillment/shipments/:id (null = not found)
 *   shipmentRates(id, warn)     GET /fulfillment/shipments/:id/rates — a LIVE carrier read (Sendcloud; Amazon Buy
 *                               Shipping when NEXUS_ENABLE_AMAZON_BUY_SHIPPING is set); it buys nothing
 *
 * Every read runs in the caller's business (row-level security).
 */

import prisma from '../../db.js'
import { AMAZON_SHIPS_WHERE } from './amazon-fulfilled-order.js'

function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * The ship queue's filters, as the Outbound page reads them: orders PENDING or PROCESSING with no live shipment, not in
 * the bin, by channel, market, search text and ship-by urgency (OVERDUE, TODAY, TOMORROW, THIS_WEEK, LATER, UNKNOWN),
 * and the urgency windows from `now`.
 *
 * 07 (lead review) — the queue holds only orders the business ships: an order Amazon ships (AMAZON_SHIPS_WHERE, the
 * fail-closed test of amazon-fulfilled-order.ts) is left out, as is an order in the bin. `amazonShips: 'only'` gives
 * the orders Amazon ships under the same filters instead (Claude's queue lists them apart, read only).
 */
export function pendingOrdersWhere(q: any, options: { amazonShips?: 'exclude' | 'only' } = {}) {
  const channelList: string[] | undefined = q.channel
    ? String(q.channel).split(',').map((s: string) => s.trim()).filter(Boolean)
    : undefined
  const marketplaceList: string[] | undefined = q.marketplace
    ? String(q.marketplace).split(',').map((s: string) => s.trim()).filter(Boolean)
    : undefined
  const urgencyList: string[] | undefined = q.urgency
    ? String(q.urgency).split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean)
    : undefined

  // ── Urgency window math (UTC-anchored). Buckets:
  //   OVERDUE   shipByDate < now
  //   TODAY     now ≤ shipByDate < now + 24h
  //   TOMORROW  +24h ≤ shipByDate < +48h
  //   THIS_WEEK +48h ≤ shipByDate < +7d
  //   LATER     shipByDate ≥ +7d
  //   UNKNOWN   shipByDate IS NULL
  const now = new Date()
  const inHrs = (h: number) => new Date(now.getTime() + h * 3_600_000)
  const t24 = inHrs(24)
  const t48 = inHrs(48)
  const t7d = inHrs(24 * 7)

  const where: any = {
    status: { in: ['PENDING', 'PROCESSING'] as any[] },
    // Exclude orders that already have an active shipment. Cancelled
    // shipments don't count — operator may have voided + needs to
    // re-create from scratch.
    shipments: { none: { status: { not: 'CANCELLED' as any } } },
    deletedAt: null,
    ...(options.amazonShips === 'only' ? {} : { NOT: AMAZON_SHIPS_WHERE }),
  }
  if (channelList?.length) where.channel = { in: channelList as any }
  if (marketplaceList?.length) where.marketplace = { in: marketplaceList }
  if (q.search?.trim()) {
    const s = q.search.trim()
    where.OR = [
      { channelOrderId: { contains: s, mode: 'insensitive' } },
      { customerName: { contains: s, mode: 'insensitive' } },
      { customerEmail: { contains: s, mode: 'insensitive' } },
      { items: { some: { sku: { contains: s, mode: 'insensitive' } } } },
    ]
  }
  // Urgency is ANDed with the existing where via a discriminated OR.
  if (urgencyList?.length) {
    const urgencyClauses: any[] = []
    for (const u of urgencyList) {
      if (u === 'OVERDUE') urgencyClauses.push({ shipByDate: { lt: now } })
      else if (u === 'TODAY') urgencyClauses.push({ shipByDate: { gte: now, lt: t24 } })
      else if (u === 'TOMORROW') urgencyClauses.push({ shipByDate: { gte: t24, lt: t48 } })
      else if (u === 'THIS_WEEK') urgencyClauses.push({ shipByDate: { gte: t48, lt: t7d } })
      else if (u === 'LATER') urgencyClauses.push({ shipByDate: { gte: t7d } })
      else if (u === 'UNKNOWN') urgencyClauses.push({ shipByDate: null })
    }
    // AND with existing search OR (if any) by nesting under AND.
    const prevOR = where.OR
    delete where.OR
    where.AND = [
      ...(prevOR ? [{ OR: prevOR }] : []),
      { OR: urgencyClauses },
    ]
  }

  return { where: options.amazonShips === 'only' ? { AND: [where, AMAZON_SHIPS_WHERE] } : where, now, t24, t48, t7d }
}

/** The ship queue's page, filters and counts, exactly as GET /fulfillment/outbound/pending-orders answers them. */
export async function pendingOrdersQueue(q: any) {
  const page = Math.max(1, safeNum(q.page, 1) ?? 1)
  const pageSize = Math.min(200, safeNum(q.pageSize, 50) ?? 50)
  const sort = (q.sort as string) || 'ship-by-asc'

  const { where, now, t24, t48, t7d } = pendingOrdersWhere(q)

  // Sort. Postgres sorts NULLs last for ASC by default in Prisma 5+.
  let orderBy: any = [{ shipByDate: 'asc' }, { purchaseDate: 'asc' }]
  if (sort === 'value-desc') orderBy = [{ totalPrice: 'desc' }, { shipByDate: 'asc' }]
  else if (sort === 'age-desc') orderBy = [{ purchaseDate: 'asc' }, { shipByDate: 'asc' }]

  const [total, items] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        channel: true,
        marketplace: true,
        channelOrderId: true,
        status: true,
        customerName: true,
        customerEmail: true,
        shippingAddress: true,
        purchaseDate: true,
        shipByDate: true,
        earliestShipDate: true,
        latestDeliveryDate: true,
        fulfillmentLatency: true,
        isPrime: true,
        totalPrice: true,
        currencyCode: true,
        createdAt: true,
        items: {
          select: { id: true, sku: true, quantity: true, productId: true, price: true },
        },
      },
    }),
  ])

  // Decorate each row with derived urgency + line-item totals, and
  // serialize Decimal → number to keep the wire shape JSON-safe
  // (D.2 lesson — see TECH_DEBT.md on Decimal+gzip).
  const classifyUrgency = (d: Date | null | undefined): string => {
    if (!d) return 'UNKNOWN'
    const t = d.getTime()
    if (t < now.getTime()) return 'OVERDUE'
    if (t < t24.getTime()) return 'TODAY'
    if (t < t48.getTime()) return 'TOMORROW'
    if (t < t7d.getTime()) return 'THIS_WEEK'
    return 'LATER'
  }
  const decorated = items.map((o) => {
    const totalQuantity = o.items.reduce((n, it) => n + it.quantity, 0)
    return {
      ...o,
      totalPrice: Number(o.totalPrice),
      items: o.items.map((it) => ({ ...it, price: Number(it.price) })),
      itemCount: o.items.length,
      totalQuantity,
      urgency: classifyUrgency(o.shipByDate),
    }
  })

  // Counts — cheap aggregate queries against the same base where
  // (minus the urgency filter so the count chips reflect "of all
  // pending orders matching channel/search, how many overdue?").
  const baseWhere: any = { ...where }
  delete baseWhere.AND
  delete baseWhere.OR
  // Re-apply non-urgency clauses
  if (q.search?.trim()) {
    const s = q.search.trim()
    baseWhere.OR = [
      { channelOrderId: { contains: s, mode: 'insensitive' } },
      { customerName: { contains: s, mode: 'insensitive' } },
      { customerEmail: { contains: s, mode: 'insensitive' } },
      { items: { some: { sku: { contains: s, mode: 'insensitive' } } } },
    ]
  }

  const [overdue, today, tomorrow, thisWeek, later, unknown, byChannelRows] =
    await Promise.all([
      prisma.order.count({ where: { ...baseWhere, shipByDate: { lt: now } } }),
      prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: now, lt: t24 } } }),
      prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: t24, lt: t48 } } }),
      prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: t48, lt: t7d } } }),
      prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: t7d } } }),
      prisma.order.count({ where: { ...baseWhere, shipByDate: null } }),
      prisma.order.groupBy({
        by: ['channel'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ])

  const byChannel: Record<string, number> = {}
  for (const row of byChannelRows) byChannel[row.channel as string] = row._count._all

  return {
    items: decorated,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    counts: { overdue, today, tomorrow, thisWeek, later, unknown, byChannel },
  }
}

/** GET /fulfillment/shipments/:id — the shipment with its lines and warehouse; null when not found. */
export async function shipmentById(id: string) {
  return prisma.shipment.findUnique({
    where: { id },
    include: { items: true, warehouse: true },
  })
}

/** What GET /fulfillment/shipments/:id/rates answers: its status code and body. */
export type ShipmentRatesAnswer =
  | { status: 404 | 400; body: { error: string } }
  | { status: 200; body: { rates: Array<{ source: 'SENDCLOUD' | 'AMAZON_BUY_SHIPPING'; carrier: string; serviceName: string; serviceCode: string; priceEur: number; estimatedDays?: number }>; weightKg: number; destinationCountry: string } }

/**
 * The rate shop for one shipment: Sendcloud's methods for its weight and destination (a carrier read; a dry-run
 * Sendcloud answers its own sample rates) and, for an Amazon order with Buy Shipping on, Amazon's eligible services.
 * Cheapest first. `warn` receives a failed Buy Shipping read (the route passes its logger).
 */
export async function shipmentRates(id: string, warn: (detail: Record<string, unknown>, message: string) => void): Promise<ShipmentRatesAnswer> {
  const shipment = await prisma.shipment.findUnique({
    where: { id },
    include: {
      warehouse: true,
      order: {
        select: {
          shippingAddress: true,
          channel: true,
          channelOrderId: true,
          items: { select: { id: true, quantity: true, amazonMetadata: true } },
        },
      },
    },
  })
  if (!shipment) return { status: 404 as const, body: { error: 'Shipment not found' } }
  if (!shipment.order) return { status: 400 as const, body: { error: 'Shipment has no order' } }

  const ship = shipment.order.shippingAddress as any
  const country = (ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? 'IT')
    .toString()
    .toUpperCase()
  const weightKg = (shipment.weightGrams ?? 1500) / 1000

  const sendcloud = await import('../sendcloud/index.js')
  const rates: Array<{
    source: 'SENDCLOUD' | 'AMAZON_BUY_SHIPPING'
    carrier: string
    serviceName: string
    serviceCode: string
    priceEur: number
    estimatedDays?: number
  }> = []

  // CR.13 — pull each carrier's preferences once so we can skip
  // those opted-out of rate-shop. Single read; carriers are <10
  // rows for a single-account install. Default = include.
  const carrierPrefs = await prisma.carrier.findMany({
    select: { code: true, preferences: true },
  })
  const includeSendcloud = (() => {
    const p = carrierPrefs.find((c) => c.code === 'SENDCLOUD')?.preferences as any
    return p?.includeInRateShop !== false // default true when unset
  })()
  const includeBuyShipping = (() => {
    const p = carrierPrefs.find((c) => c.code === 'AMAZON_BUY_SHIPPING')?.preferences as any
    return p?.includeInRateShop !== false
  })()

  if (includeSendcloud) {
    try {
      const creds = await sendcloud.resolveCredentials()
      const methods = await sendcloud.listShippingMethods(creds, { weightKg, toCountry: country })
      for (const m of methods) {
        rates.push({
          source: 'SENDCLOUD',
          carrier: m.carrier,
          serviceName: m.name,
          serviceCode: String(m.id),
          priceEur: m.price,
        })
      }
    } catch {
      // Sendcloud unconnected or unavailable — skip but keep going so
      // Buy Shipping rates still surface for Amazon orders.
    }
  }

  // CR.4: Buy Shipping is only relevant for Amazon orders. Pre-CR.4
  // this passed empty amazonOrderId + empty itemList + hardcoded
  // Riccione ship-from, which Amazon's MFN API rejects in real
  // mode. Now: real channelOrderId + real itemList (Amazon
  // OrderItemId from amazonMetadata) + warehouse-derived
  // shipFromAddress. Skip silently if the warehouse is not bound
  // or has no address — UI shows Sendcloud rates only.
  if (includeBuyShipping && shipment.order.channel === 'AMAZON' && process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING) {
    const wh = shipment.warehouse
    if (wh && wh.addressLine1 && wh.city && wh.postalCode && wh.country) {
      try {
        const buyShipping = await import('../amazon-pushback/buy-shipping.js')
        const itemList = shipment.order.items.map((it) => {
          const meta = it.amazonMetadata as any
          return {
            orderItemId: meta?.OrderItemId ?? meta?.orderItemId ?? it.id,
            quantity: it.quantity,
          }
        })
        const services = await buyShipping.getEligibleShippingServices({
          amazonOrderId: shipment.order.channelOrderId,
          itemList,
          shipFromAddress: {
            name: wh.name,
            addressLine1: wh.addressLine1,
            addressLine2: wh.addressLine2 ?? undefined,
            city: wh.city,
            postalCode: wh.postalCode,
            countryCode: wh.country,
          },
          weightGrams: shipment.weightGrams ?? Math.round(weightKg * 1000),
        })
        for (const s of services) {
          rates.push({
            source: 'AMAZON_BUY_SHIPPING',
            carrier: s.carrierName,
            serviceName: s.shippingServiceName,
            serviceCode: s.shippingServiceOfferId,
            priceEur: s.rate.amount,
          })
        }
      } catch (err: any) {
        warn({ err, shipmentId: id }, '[shipments/:id/rates] Buy Shipping rate fetch failed')
      }
    }
  }

  rates.sort((a, b) => a.priceEur - b.priceEur)
  return { status: 200 as const, body: { rates, weightKg, destinationCountry: country } }
}
