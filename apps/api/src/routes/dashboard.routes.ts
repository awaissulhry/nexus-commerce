/**
 * ZZ — /api/dashboard/overview
 *
 * One-shot aggregation for the Command Center page. Computes:
 *   - revenue / orders / AOV / units, current window vs previous of
 *     equal length, with delta percent
 *   - per-channel breakdown (Amazon / eBay / Shopify / WooCommerce)
 *   - per-(channel, marketplace) matrix derived from order metadata
 *     and ChannelListing rows
 *   - catalog snapshot: products, parents, variants, draft + live
 *     listings
 *   - operational alerts: low stock, draft / failed listings, stale
 *     schemas, disconnected channels
 *   - 30-day sparkline (revenue + orders per day, gap-filled to
 *     zero so the line doesn't bend on missing days)
 *   - recent activity from BulkOperation + AuditLog
 *
 * One endpoint instead of N small ones because the dashboard renders
 * everything together; one round trip is cheaper for the client and
 * easier to cache server-side.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

type Window = 'today' | '7d' | '30d' | '90d' | 'ytd' | 'custom'

// DO.11 — comparison-period keys. `prev` is the legacy "previous of
// equal length" behavior; the others apply a fixed shift in days
// regardless of window length.
type Compare = 'prev' | 'dod' | 'wow' | 'mom' | 'yoy'

const COMPARE_SHIFT_DAYS: Record<Exclude<Compare, 'prev'>, number> = {
  dod: 1,
  wow: 7,
  mom: 30,
  yoy: 365,
}

// DO.2 — Italian operator timezone is Europe/Rome (UTC+1 winter,
// UTC+2 DST). Server runs in UTC, so the previous code's `today`
// = `from.setHours(0,0,0,0)` resolved to UTC midnight, meaning
// the operator's first 1–2 hours of every day were missing from
// the dashboard until 02:00 local. `ytd` had the same defect at
// the year boundary (Italy crosses Dec 31 → Jan 1 before UTC
// does). The rolling windows (7d/30d/90d) are unaffected — they
// are duration-based, not calendar-aligned.
const OPERATOR_TIMEZONE = 'Europe/Rome'

// Compute the UTC instant corresponding to local midnight (00:00)
// on the calendar date observed in `timeZone` at instant `at`. DST
// safe: probes the zone offset on the target civil date and
// subtracts it from UTC midnight on that same civil date.
function zonedStartOfDay(at: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  const [y, m, d] = ymd.split('-').map(Number)
  return zonedMidnight(y, m - 1, d, timeZone)
}

// UTC instant for local midnight on civil date (y, m, d) in zone.
function zonedMidnight(
  y: number,
  m: number,
  d: number,
  timeZone: string,
): Date {
  // Probe noon UTC on that civil date — comfortably inside the day
  // for any zone — then read what `timeZone` thinks the local time
  // is. The difference between observed-local and probe-UTC is the
  // zone offset in effect on that civil date.
  const probe = new Date(Date.UTC(y, m, d, 12, 0, 0))
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(probe)
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? '0')
  const observedLocal = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
  )
  const offsetMs = observedLocal - probe.getTime()
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMs)
}

// UTC instant for Jan 1 00:00 in the zone, for the calendar year
// observed in `timeZone` at instant `at`.
function zonedStartOfYear(at: Date, timeZone: string): Date {
  const yearStr = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
  }).format(at)
  const y = Number(yearStr)
  return zonedMidnight(y, 0, 1, timeZone)
}

function windowBounds(
  window: Window,
  compare: Compare = 'prev',
  customFrom?: Date,
  customTo?: Date,
): {
  from: Date
  to: Date
  prevFrom: Date
  prevTo: Date
  label: string
} {
  // DO.25 — custom range overrides the preset entirely. customTo
  // is allowed to be in the future for forward-looking ranges, but
  // typical usage is "show me last quarter": from/to both in past.
  let to: Date
  let from: Date
  let label: string
  if (window === 'custom' && customFrom && customTo) {
    from = customFrom
    to = customTo
    label = 'Custom range'
  } else {
    to = new Date()
    switch (window) {
      case 'today': {
        from = zonedStartOfDay(to, OPERATOR_TIMEZONE)
        label = 'Today'
        break
      }
      case '7d': {
        from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
        label = 'Last 7 days'
        break
      }
      case '90d': {
        from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000)
        label = 'Last 90 days'
        break
      }
      case 'ytd': {
        from = zonedStartOfYear(to, OPERATOR_TIMEZONE)
        label = 'Year to date'
        break
      }
      case '30d':
      default: {
        from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
        label = 'Last 30 days'
        break
      }
    }
  }
  // DO.11 — compute the comparison range. For `prev`, shift by the
  // window length (legacy behavior). For dod/wow/mom/yoy, shift by
  // a fixed number of days; the comparison range has the same
  // length as the current window so deltas remain comparable.
  const length = to.getTime() - from.getTime()
  let shiftMs: number
  if (compare === 'prev') {
    shiftMs = length
  } else {
    shiftMs = COMPARE_SHIFT_DAYS[compare] * 24 * 60 * 60 * 1000
  }
  const prevTo = new Date(to.getTime() - shiftMs)
  const prevFrom = new Date(from.getTime() - shiftMs)
  return { from, to, prevFrom, prevTo, label }
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0
  return ((current - previous) / previous) * 100
}

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      window?: string
      compare?: string
      from?: string
      to?: string
    }
  }>('/dashboard/overview', async (request, reply) => {
      // DO.37 — short server-side cache. The endpoint runs ~20
      // queries per request; with multiple browser tabs + the
      // 60s polling pulse + Live Mode (DO.16) re-fetch on every
      // SSE event, cache-less responses pile up. 30s Cache-Control
      // is safe because the SSE stream invalidates the visible UI
      // independently of HTTP caching — operator sees real
      // mutations within ~2s via the live channel, while the
      // background poll re-issues every 30s. Stale-while-revalidate
      // keeps the response feeling instant on repeat hits.
      reply.header(
        'Cache-Control',
        'private, max-age=30, stale-while-revalidate=60',
      )
      const rawWindow = request.query?.window ?? '30d'
      const window: Window =
        rawWindow === 'today' ||
        rawWindow === '7d' ||
        rawWindow === '90d' ||
        rawWindow === 'ytd' ||
        rawWindow === 'custom'
          ? rawWindow
          : '30d'
      const rawCompare = request.query?.compare
      const compare: Compare =
        rawCompare === 'dod' ||
        rawCompare === 'wow' ||
        rawCompare === 'mom' ||
        rawCompare === 'yoy'
          ? rawCompare
          : 'prev'
      // DO.25 — custom from/to. Reject if either is unparseable; fall
      // back to the default 30d window. Don't trust client input
      // beyond ISO-date parsing.
      let customFrom: Date | undefined
      let customTo: Date | undefined
      if (window === 'custom' && request.query?.from && request.query?.to) {
        const fParsed = new Date(request.query.from)
        const tParsed = new Date(request.query.to)
        if (
          !Number.isNaN(fParsed.getTime()) &&
          !Number.isNaN(tParsed.getTime()) &&
          fParsed.getTime() < tParsed.getTime()
        ) {
          customFrom = fParsed
          customTo = tParsed
        }
      }
      const { from, to, prevFrom, prevTo, label } = windowBounds(
        window,
        compare,
        customFrom,
        customTo,
      )

      // ── Period totals ─────────────────────────────────────────────
      const [
        currentOrders,
        previousOrders,
        currentItems,
        previousItems,
      ] = await Promise.all([
        prisma.order.findMany({
          where: { createdAt: { gte: from, lte: to } },
          select: {
            id: true,
            channel: true,
            totalPrice: true,
            currencyCode: true,
            status: true,
            createdAt: true,
            amazonMetadata: true,
            ebayMetadata: true,
          },
        }),
        prisma.order.findMany({
          where: { createdAt: { gte: prevFrom, lt: prevTo } },
          select: { totalPrice: true, currencyCode: true },
        }),
        prisma.orderItem.findMany({
          where: { order: { createdAt: { gte: from, lte: to } } },
          select: { quantity: true, productId: true, sku: true, price: true },
        }),
        prisma.orderItem.findMany({
          where: { order: { createdAt: { gte: prevFrom, lt: prevTo } } },
          select: { quantity: true },
        }),
      ])

      // DO.1 — multi-currency aware aggregation.
      //
      // Orders carry currencyCode (EUR, USD, GBP, …). Naively summing
      // totalPrice across currencies produces a meaningless blended
      // number; the previous code did exactly that and rendered the
      // result with a hardcoded $ symbol. The Italian operator on
      // mostly-EUR markets saw the wrong glyph on the wrong number.
      //
      // Now: bucket revenue by currency, pick a primary (highest-
      // revenue currency in the current window — falls back to EUR
      // when there are no orders), and report it alongside the full
      // breakdown so the client can show a secondary "incl. $X USD"
      // hint when multi-currency mixing is real.
      type CurrencyTotals = { current: number; previous: number }
      const byCurrency = new Map<string, CurrencyTotals>()
      const slotFor = (code: string): CurrencyTotals => {
        const ex = byCurrency.get(code)
        if (ex) return ex
        const fresh = { current: 0, previous: 0 }
        byCurrency.set(code, fresh)
        return fresh
      }
      for (const o of currentOrders) {
        const code = (o.currencyCode ?? 'EUR') || 'EUR'
        slotFor(code).current += Number((o.totalPrice as unknown as number) || 0)
      }
      for (const o of previousOrders) {
        const code = (o.currencyCode ?? 'EUR') || 'EUR'
        slotFor(code).previous += Number((o.totalPrice as unknown as number) || 0)
      }

      // Primary = currency with highest current-period revenue. With
      // ties or no data, fall back to EUR — Xavia's home market.
      let primaryCurrency = 'EUR'
      let topRevenue = -1
      for (const [code, totals] of byCurrency.entries()) {
        if (totals.current > topRevenue) {
          topRevenue = totals.current
          primaryCurrency = code
        }
      }

      const primaryTotals =
        byCurrency.get(primaryCurrency) ?? { current: 0, previous: 0 }

      const ordersInCurrency = (
        rows: Array<{ currencyCode: string | null }>,
        code: string,
      ): number =>
        rows.reduce(
          (acc, r) => acc + ((r.currencyCode ?? 'EUR') === code ? 1 : 0),
          0,
        )

      const sumQty = (rows: Array<{ quantity: number | null }>) =>
        rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0)

      const revenue = {
        current: primaryTotals.current,
        previous: primaryTotals.previous,
      }
      const orderCounts = {
        current: ordersInCurrency(currentOrders, primaryCurrency),
        previous: ordersInCurrency(previousOrders, primaryCurrency),
      }
      const units = {
        current: sumQty(currentItems),
        previous: sumQty(previousItems),
      }
      const aov = {
        current:
          orderCounts.current > 0 ? revenue.current / orderCounts.current : 0,
        previous:
          orderCounts.previous > 0
            ? revenue.previous / orderCounts.previous
            : 0,
      }

      // ── DO.12 — operational KPIs ──────────────────────────────────
      //
      // Pending / late shipments are point-in-time counts, not period
      // totals. They answer "what does the operator need to fix right
      // now?" — comparable to the alerts panel but glanceable from the
      // KPI strip. previous=0 + deltaPct=null leaves the delta pill
      // showing n/a; W12 swaps in a snapshot-based comparison once
      // KPI snapshots ship.
      //
      // Returns rate and refund value are period-bound and follow the
      // same currency / window scope as the financial KPIs.
      const [
        pendingShipmentsCount,
        lateShipmentsCount,
        returnsCurrentCount,
        returnsPreviousCount,
        refundCurrentCents,
        refundPreviousCents,
      ] = await Promise.all([
        prisma.order
          .count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } })
          .catch(() => 0),
        prisma.order
          .count({
            where: {
              status: { in: ['PENDING', 'PROCESSING'] },
              shipByDate: { lt: to, not: null },
            },
          })
          .catch(() => 0),
        prisma.return
          .count({
            where: {
              createdAt: { gte: from, lte: to },
              order: { currencyCode: primaryCurrency },
            },
          })
          .catch(() => 0),
        prisma.return
          .count({
            where: {
              createdAt: { gte: prevFrom, lt: prevTo },
              order: { currencyCode: primaryCurrency },
            },
          })
          .catch(() => 0),
        prisma.refund
          .aggregate({
            _sum: { amountCents: true },
            where: {
              createdAt: { gte: from, lte: to },
              currencyCode: primaryCurrency,
            },
          })
          .then((r) => Number(r._sum.amountCents ?? 0))
          .catch(() => 0),
        prisma.refund
          .aggregate({
            _sum: { amountCents: true },
            where: {
              createdAt: { gte: prevFrom, lt: prevTo },
              currencyCode: primaryCurrency,
            },
          })
          .then((r) => Number(r._sum.amountCents ?? 0))
          .catch(() => 0),
      ])

      // Returns rate as a percentage (0–100). Use `orderCounts` from
      // the headline (already filtered to primary currency) so the
      // ratio is apples-to-apples.
      const returnsRateCurrent =
        orderCounts.current > 0
          ? (returnsCurrentCount / orderCounts.current) * 100
          : 0
      const returnsRatePrevious =
        orderCounts.previous > 0
          ? (returnsPreviousCount / orderCounts.previous) * 100
          : 0

      // Refund value in primary-currency major units (€ not cents).
      const refundValueCurrent = refundCurrentCents / 100
      const refundValuePrevious = refundPreviousCents / 100

      // ── Per-channel breakdown ────────────────────────────────────
      const channelMap = new Map<
        string,
        { revenue: number; orders: number; units: number }
      >()
      for (const o of currentOrders) {
        const ch = String(o.channel)
        const slot = channelMap.get(ch) ?? { revenue: 0, orders: 0, units: 0 }
        slot.revenue += Number((o.totalPrice as unknown as number) || 0)
        slot.orders += 1
        channelMap.set(ch, slot)
      }
      // Distribute units back per channel by joining via OrderItem.
      const itemsByOrder = new Map<string, number>()
      for (const i of currentItems) {
        // Items don't carry channel directly; we need order → channel.
        // Build qty-by-orderId once and merge.
      }
      void itemsByOrder
      // Cheaper: re-aggregate via raw SQL.
      let unitsByChannel: Array<{ channel: string; total: bigint }> = []
      try {
        unitsByChannel = (await prisma.$queryRawUnsafe(
          `SELECT o."channel"::text AS channel, COALESCE(SUM(oi."quantity"), 0)::bigint AS total
           FROM "OrderItem" oi
           JOIN "Order" o ON o.id = oi."orderId"
           WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
           GROUP BY o."channel"`,
          from,
          to,
        )) as Array<{ channel: string; total: bigint }>
      } catch (err) {
        request.log.warn({ err }, '[dashboard] units-by-channel raw query failed')
      }
      for (const row of unitsByChannel) {
        const slot =
          channelMap.get(row.channel) ?? { revenue: 0, orders: 0, units: 0 }
        slot.units = Number(row.total)
        channelMap.set(row.channel, slot)
      }

      // Listings and sync status per channel.
      const listingsByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        _count: { _all: true },
      })
      const liveByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        where: { listingStatus: 'LIVE' },
        _count: { _all: true },
      })
      const draftByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        where: { listingStatus: 'DRAFT' },
        _count: { _all: true },
      })
      const failedByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        where: { listingStatus: 'FAILED' },
        _count: { _all: true },
      })

      // DO.17 — per-channel health signals. Combines ChannelConnection
      // last-sync age, 24h SyncError/SyncLog failures, Amazon
      // suppression count, and Amazon Buy Box win rate (7d).
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const [
        connectionsByChannel,
        syncErrorsByChannel,
        syncLogFailsByChannel,
        suppressionsActive,
        buyBoxRows,
      ] = await Promise.all([
        prisma.channelConnection.findMany({
          where: { isActive: true },
          select: {
            channelType: true,
            lastSyncAt: true,
            lastSyncStatus: true,
          },
          orderBy: { lastSyncAt: 'desc' },
        }),
        prisma.syncError.groupBy({
          by: ['channel'],
          where: { createdAt: { gte: since24h } },
          _count: { _all: true },
        }),
        prisma.syncLog.groupBy({
          by: ['syncType'],
          where: { status: 'FAILED', createdAt: { gte: since24h } },
          _count: { _all: true },
        }),
        prisma.amazonSuppression
          .count({ where: { resolvedAt: null } })
          .catch(() => 0),
        prisma.buyBoxHistory
          .findMany({
            where: { observedAt: { gte: since7d } },
            select: { channel: true, isOurOffer: true },
          })
          .catch(() => [] as Array<{ channel: string; isOurOffer: boolean }>),
      ])

      // Latest connection per channel (the orderBy above puts the
      // freshest first; we just take the head per channelType).
      const latestConnByChannel = new Map<
        string,
        { lastSyncAt: Date | null; lastSyncStatus: string | null }
      >()
      for (const c of connectionsByChannel) {
        if (!latestConnByChannel.has(c.channelType)) {
          latestConnByChannel.set(c.channelType, {
            lastSyncAt: c.lastSyncAt,
            lastSyncStatus: c.lastSyncStatus,
          })
        }
      }

      // SyncLog.syncType is shaped like "AMAZON_PUBLISH" or
      // "EBAY_INVENTORY"; the prefix is the channel.
      const syncLogFailsByCh = new Map<string, number>()
      for (const r of syncLogFailsByChannel) {
        const ch = r.syncType.split('_')[0] ?? 'UNKNOWN'
        syncLogFailsByCh.set(ch, (syncLogFailsByCh.get(ch) ?? 0) + r._count._all)
      }

      // Buy Box win-rate per channel (Amazon only today, but the
      // shape supports more channels if they ever expose a box concept).
      const buyBoxByChannel = new Map<
        string,
        { wins: number; obs: number }
      >()
      for (const r of buyBoxRows) {
        const slot = buyBoxByChannel.get(r.channel) ?? { wins: 0, obs: 0 }
        slot.obs += 1
        if (r.isOurOffer) slot.wins += 1
        buyBoxByChannel.set(r.channel, slot)
      }

      const knownChannels = new Set<string>([
        'AMAZON',
        'EBAY',
        'SHOPIFY',
        'WOOCOMMERCE',
        'ETSY',
      ])
      for (const r of listingsByChannel) knownChannels.add(r.channel)
      for (const c of channelMap.keys()) knownChannels.add(c)

      const byChannel = Array.from(knownChannels).map((ch) => {
        const slot = channelMap.get(ch) ?? { revenue: 0, orders: 0, units: 0 }
        const total =
          listingsByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const live =
          liveByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const draft =
          draftByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const failed =
          failedByChannel.find((r) => r.channel === ch)?._count._all ?? 0

        // DO.17 — health signals
        const conn = latestConnByChannel.get(ch) ?? null
        const syncErrors24h =
          syncErrorsByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const syncLogFails24h = syncLogFailsByCh.get(ch) ?? 0
        const errors24h = syncErrors24h + syncLogFails24h
        const suppressionsCount = ch === 'AMAZON' ? suppressionsActive : 0
        const buyBox = buyBoxByChannel.get(ch) ?? null
        const buyBoxWinRate7d =
          buyBox && buyBox.obs > 0 ? buyBox.wins / buyBox.obs : null

        // health: ok | warn | fail | inactive. Promotion logic:
        //   inactive — no active ChannelConnection on file
        //   fail     — last sync FAILED, OR > 5 errors in 24h, OR
        //              any unresolved Amazon suppression
        //   warn     — > 0 errors in 24h, OR last sync > 24h ago,
        //              OR any failed listings
        //   ok       — otherwise
        let health: 'ok' | 'warn' | 'fail' | 'inactive'
        if (!conn) {
          health = 'inactive'
        } else if (
          conn.lastSyncStatus === 'FAILED' ||
          errors24h > 5 ||
          suppressionsCount > 0
        ) {
          health = 'fail'
        } else if (
          errors24h > 0 ||
          (conn.lastSyncAt &&
            Date.now() - conn.lastSyncAt.getTime() > 24 * 60 * 60 * 1000) ||
          failed > 0
        ) {
          health = 'warn'
        } else {
          health = 'ok'
        }

        return {
          channel: ch,
          revenue: slot.revenue,
          orders: slot.orders,
          units: slot.units,
          aov: slot.orders > 0 ? slot.revenue / slot.orders : 0,
          listings: { total, live, draft, failed },
          health: {
            status: health,
            lastSyncAt: conn?.lastSyncAt ? conn.lastSyncAt.toISOString() : null,
            lastSyncStatus: conn?.lastSyncStatus ?? null,
            errors24h,
            suppressions: suppressionsCount,
            buyBoxWinRate7d,
            buyBoxObservations7d: buyBox?.obs ?? 0,
          },
        }
      })

      // ── Per-(channel, marketplace) matrix ───────────────────────
      //
      // DO.19 — cells now carry (orders, revenue, listings) instead
      // of listing-only counts. Operationally, "Amazon DE has 47
      // listings" is far less useful than "Amazon DE turned €2.3k on
      // 31 orders" — the listing count alone can't tell you whether
      // a market is producing revenue.
      //
      // Orders are bucketed in JS off the in-memory currentOrders
      // (already filtered to primary currency for the headline) so
      // we don't run a second SQL query just for this slice.
      const listingMatrix = await prisma.channelListing.groupBy({
        by: ['channel', 'marketplace'],
        _count: { _all: true },
      })
      const orderMatrix = new Map<
        string,
        { orders: number; revenue: number }
      >()
      for (const o of currentOrders) {
        const code = (o.currencyCode ?? 'EUR') || 'EUR'
        if (code !== primaryCurrency) continue
        const ch = String(o.channel)
        // o.marketplace is a TEXT column on Order; stringify with a
        // sentinel for null so the lookup key is stable.
        const mp =
          (o as unknown as { marketplace: string | null }).marketplace ??
          '∅'
        const key = `${ch}:${mp}`
        const slot = orderMatrix.get(key) ?? { orders: 0, revenue: 0 }
        slot.orders += 1
        slot.revenue += Number((o.totalPrice as unknown as number) || 0)
        orderMatrix.set(key, slot)
      }
      // Union of (channel, marketplace) keys from both sources so
      // marketplaces with orders but no listings (and vice versa)
      // both surface.
      const matrixKeys = new Set<string>()
      for (const r of listingMatrix)
        matrixKeys.add(`${r.channel}:${r.marketplace}`)
      for (const k of orderMatrix.keys()) matrixKeys.add(k)
      const byMarketplace = Array.from(matrixKeys).map((key) => {
        const [channel, marketplace] = key.split(':') as [string, string]
        const listings =
          listingMatrix.find(
            (r) => r.channel === channel && r.marketplace === marketplace,
          )?._count._all ?? 0
        const slot = orderMatrix.get(key) ?? { orders: 0, revenue: 0 }
        return {
          channel,
          marketplace,
          listings,
          orders: slot.orders,
          revenue: slot.revenue,
        }
      })

      // ── Catalog snapshot ─────────────────────────────────────────
      const [
        totalProducts,
        totalParents,
        totalVariants,
        liveListings,
        draftListings,
        failedListings,
        lowStockCount,
        outOfStockCount,
      ] = await Promise.all([
        prisma.product.count(),
        prisma.product.count({ where: { isParent: true } }),
        prisma.productVariation.count(),
        prisma.channelListing.count({ where: { listingStatus: 'LIVE' } }),
        prisma.channelListing.count({ where: { listingStatus: 'DRAFT' } }),
        // C.4 — schema lists DRAFT, ACTIVE, INACTIVE, ENDED, ERROR for
        // ChannelListing.listingStatus. The previous 'FAILED' filter
        // matched nothing, so this counter was permanently 0 and the
        // dashboard alert never fired even when listings genuinely
        // needed attention. ERROR is the real "publish/validation
        // failed" terminal state.
        prisma.channelListing.count({ where: { listingStatus: 'ERROR' } }),
        prisma.product.count({
          where: { totalStock: { gt: 0, lte: 10 } },
        }),
        prisma.product.count({ where: { totalStock: { lte: 0 } } }),
      ])

      // ── DO.28 — inventory enrichment ──────────────────────────────
      //
      // Three signals beyond raw counts:
      //   - stock value at current basePrice (rough valuation)
      //   - aged-SKU count: products with stock but no orders in 90d
      //   - top SKUs by velocity (already covered by topProducts —
      //     no additional query, just aliased in the response)
      const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      const [stockValueRow, agedSkuRow] = await Promise.all([
        prisma.$queryRawUnsafe(
          `SELECT COALESCE(SUM("totalStock" * "basePrice"), 0)::float AS value
           FROM "Product"
           WHERE status = 'ACTIVE' AND "totalStock" > 0`,
        )
          .then((r) => (r as Array<{ value: number }>)[0]?.value ?? 0)
          .catch(() => 0),
        prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::bigint AS n
           FROM "Product" p
           WHERE p.status = 'ACTIVE' AND p."totalStock" > 0
             AND NOT EXISTS (
               SELECT 1 FROM "OrderItem" oi
               JOIN "Order" o ON o.id = oi."orderId"
               WHERE oi."productId" = p.id
                 AND o."createdAt" >= $1
             )`,
          since90d,
        )
          .then((r) => Number((r as Array<{ n: bigint }>)[0]?.n ?? 0))
          .catch(() => 0),
      ])

      // ── Channel connectivity (eBay) ──────────────────────────────
      const [ebayActive, channelConnections] = await Promise.all([
        prisma.channelConnection.count({
          where: { channelType: 'EBAY', isActive: true },
        }),
        prisma.channelConnection.findMany({
          select: { channelType: true, isActive: true, lastSyncStatus: true },
        }),
      ])

      // ── Top SKUs by revenue in this window ──────────────────────
      let topProducts: Array<{
        sku: string
        revenue: number
        units: number
        productId: string | null
      }> = []
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT oi."sku" AS sku,
                  oi."productId" AS "productId",
                  COALESCE(SUM(oi."quantity"), 0)::bigint AS units,
                  COALESCE(SUM(oi."price" * oi."quantity"), 0)::float AS revenue
           FROM "OrderItem" oi
           JOIN "Order" o ON o.id = oi."orderId"
           WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
           GROUP BY oi."sku", oi."productId"
           ORDER BY revenue DESC
           LIMIT 10`,
          from,
          to,
        )) as Array<{
          sku: string
          productId: string | null
          units: bigint
          revenue: number
        }>
        topProducts = rows.map((r) => ({
          sku: r.sku,
          productId: r.productId,
          units: Number(r.units),
          revenue: Number(r.revenue),
        }))
      } catch (err) {
        request.log.warn({ err }, '[dashboard] top SKUs raw query failed')
      }

      // ── Sparkline (window-aware, gap-filled) ─────────────────────
      //
      // DO.3 — sparkline now follows the window selector. Previously
      // the sparkline was hardcoded to the trailing 30 days regardless
      // of whether the operator picked Today / 7d / 30d / 90d / YTD,
      // which made the chart silently lie about the headline number.
      //
      // We choose a per-day bucket count from the selected window:
      //   today → 24 hourly buckets (so the curve actually moves)
      //   7d    → 7 daily
      //   30d   → 30 daily (legacy default)
      //   90d   → 90 daily
      //   ytd   → days since Jan 1 in operator timezone
      //
      // The sparkline uses the same `from` as the headline KPI window
      // to guarantee the headline number == area-under-the-curve.
      //
      // DO.10 — also bucket per-KPI series so each KpiCard can render
      // its own mini sparkline. Revenue/orders/AOV come from the
      // Order bucketing here; units comes from a parallel OrderItem
      // bucket query. All filtered by primary currency to keep the
      // headline-vs-curve invariant from DO.1.
      const sparkBucketIsHour = window === 'today'
      let sparkBuckets: number
      if (window === 'today') sparkBuckets = 24
      else if (window === '7d') sparkBuckets = 7
      else if (window === '90d') sparkBuckets = 90
      else if (window === 'ytd') {
        const ms = to.getTime() - from.getTime()
        sparkBuckets = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)))
      } else sparkBuckets = 30
      const sparkFrom = from
      let sparkRows: Array<{ d: string; revenue: number; orders: bigint }> = []
      let unitsRows: Array<{ d: string; units: bigint }> = []
      try {
        const groupExpr = sparkBucketIsHour
          ? `to_char(date_trunc('hour', "createdAt"), 'YYYY-MM-DD"T"HH24')`
          : `to_char(date_trunc('day',  "createdAt"), 'YYYY-MM-DD')`
        const orderGroupExpr = sparkBucketIsHour
          ? `to_char(date_trunc('hour', o."createdAt"), 'YYYY-MM-DD"T"HH24')`
          : `to_char(date_trunc('day',  o."createdAt"), 'YYYY-MM-DD')`
        ;[sparkRows, unitsRows] = (await Promise.all([
          prisma.$queryRawUnsafe(
            `SELECT ${groupExpr} AS d,
                    COALESCE(SUM("totalPrice"), 0)::float AS revenue,
                    COUNT(*)::bigint AS orders
             FROM "Order"
             WHERE "createdAt" >= $1 AND "createdAt" <= $2
               AND COALESCE("currencyCode", 'EUR') = $3
             GROUP BY 1
             ORDER BY 1 ASC`,
            sparkFrom,
            to,
            primaryCurrency,
          ),
          prisma.$queryRawUnsafe(
            `SELECT ${orderGroupExpr} AS d,
                    COALESCE(SUM(oi.quantity), 0)::bigint AS units
             FROM "OrderItem" oi
             JOIN "Order" o ON o.id = oi."orderId"
             WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
               AND COALESCE(o."currencyCode", 'EUR') = $3
             GROUP BY 1
             ORDER BY 1 ASC`,
            sparkFrom,
            to,
            primaryCurrency,
          ),
        ])) as [
          Array<{ d: string; revenue: number; orders: bigint }>,
          Array<{ d: string; units: bigint }>,
        ]
      } catch (err) {
        request.log.warn({ err }, '[dashboard] sparkline raw query failed')
      }
      const sparkMap = new Map<string, { revenue: number; orders: number }>()
      for (const r of sparkRows) {
        sparkMap.set(r.d, { revenue: r.revenue, orders: Number(r.orders) })
      }
      const unitsMap = new Map<string, number>()
      for (const r of unitsRows) {
        unitsMap.set(r.d, Number(r.units))
      }

      // DO.26 — per-channel revenue per bucket. One additional grouped
      // query rather than re-bucketing currentOrders in JS — SQL is
      // strictly faster at this scale and we already have the right
      // index on (createdAt, channel) implicit in postgres's btree.
      const channelGroupExpr = sparkBucketIsHour
        ? `to_char(date_trunc('hour', "createdAt"), 'YYYY-MM-DD"T"HH24')`
        : `to_char(date_trunc('day',  "createdAt"), 'YYYY-MM-DD')`
      let channelSparkRows: Array<{
        d: string
        channel: string
        revenue: number
      }> = []
      try {
        channelSparkRows = (await prisma.$queryRawUnsafe(
          `SELECT ${channelGroupExpr} AS d,
                  channel::text AS channel,
                  COALESCE(SUM("totalPrice"), 0)::float AS revenue
           FROM "Order"
           WHERE "createdAt" >= $1 AND "createdAt" <= $2
             AND COALESCE("currencyCode", 'EUR') = $3
           GROUP BY 1, 2
           ORDER BY 1 ASC`,
          sparkFrom,
          to,
          primaryCurrency,
        )) as Array<{ d: string; channel: string; revenue: number }>
      } catch (err) {
        request.log.warn(
          { err },
          '[dashboard] per-channel sparkline raw query failed',
        )
      }
      const channelSparkMap = new Map<string, Map<string, number>>()
      for (const r of channelSparkRows) {
        const slot =
          channelSparkMap.get(r.channel) ?? new Map<string, number>()
        slot.set(r.d, r.revenue)
        channelSparkMap.set(r.channel, slot)
      }
      const sparkline: Array<{
        date: string
        revenue: number
        orders: number
      } & Record<string, number | string>> = []
      const seriesRevenue: number[] = []
      const seriesOrders: number[] = []
      const seriesUnits: number[] = []
      const seriesAov: number[] = []
      const channelKeys = Array.from(channelSparkMap.keys())
      for (let i = 0; i < sparkBuckets; i++) {
        const d = new Date(sparkFrom)
        if (sparkBucketIsHour) d.setHours(d.getHours() + i)
        else d.setDate(d.getDate() + i)
        const key = sparkBucketIsHour
          ? d.toISOString().slice(0, 13) // YYYY-MM-DDTHH
          : d.toISOString().slice(0, 10)
        const slot = sparkMap.get(key) ?? { revenue: 0, orders: 0 }
        const units = unitsMap.get(key) ?? 0
        // DO.26 — fold per-channel revenue into the same row so
        // recharts can render multiple lines from one dataset.
        const row: Record<string, number | string> = {
          date: key,
          revenue: slot.revenue,
          orders: slot.orders,
        }
        for (const ch of channelKeys) {
          row[`channel_${ch}`] = channelSparkMap.get(ch)?.get(key) ?? 0
        }
        sparkline.push(
          row as { date: string; revenue: number; orders: number },
        )
        seriesRevenue.push(slot.revenue)
        seriesOrders.push(slot.orders)
        seriesUnits.push(units)
        seriesAov.push(slot.orders > 0 ? slot.revenue / slot.orders : 0)
      }

      // ── Recent activity (BulkOperation + AuditLog) ──────────────
      let recentActivity: Array<{
        type: string
        ts: string
        summary: string
      }> = []
      try {
        const [ops, audits] = await Promise.all([
          prisma.bulkOperation.findMany({
            take: 8,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              changeCount: true,
              productCount: true,
              status: true,
              createdAt: true,
            },
          }),
          prisma.auditLog
            .findMany({
              take: 8,
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                entityType: true,
                action: true,
                createdAt: true,
              },
            })
            .catch(() => []),
        ])
        for (const o of ops) {
          recentActivity.push({
            type: 'bulkOp',
            ts: o.createdAt.toISOString(),
            summary: `${o.status} — ${o.changeCount} change${
              o.changeCount === 1 ? '' : 's'
            } across ${o.productCount} product${
              o.productCount === 1 ? '' : 's'
            }`,
          })
        }
        for (const a of audits) {
          recentActivity.push({
            type: 'audit',
            ts: a.createdAt.toISOString(),
            summary: `${a.action} ${a.entityType}`,
          })
        }
        recentActivity.sort((x, y) => (x.ts < y.ts ? 1 : -1))
        recentActivity = recentActivity.slice(0, 12)
      } catch (err) {
        request.log.warn({ err }, '[dashboard] activity feed failed')
      }

      // ── Pending orders count (operational alert) ─────────────────
      const pendingOrders = await prisma.order
        .count({ where: { status: 'PENDING' } })
        .catch(() => 0)

      // ── DO.21 — additional operational alerts ────────────────────
      //
      // Five new categories surfaced as count-based alert rows:
      //
      //  1. Late shipments — overlaps DO.12's KPI but rendering as an
      //     alert too gives the operator a one-click drill-down from
      //     the panel where action lives. Same data, different surface.
      //  2. Suppressions — sum of Amazon unresolved AmazonSuppression
      //     rows (already computed for DO.17, reused here).
      //  3. Returns awaiting inspection — Return rows in REQUESTED /
      //     AUTHORIZED / IN_TRANSIT / RECEIVED status; haven't been
      //     processed past inspection.
      //  4. Sync failures channel-wide — channels with errors24h > 0
      //     count, fed by the same SyncError + SyncLog signal as
      //     DO.17.
      //  5. API rate-limit hits — OutboundApiCallLog rows with
      //     statusCode=429 OR errorType='RATE_LIMIT' in the last
      //     hour. A burst here means SP-API throttling — operator
      //     should slow the cron cadence.
      const since1h = new Date(Date.now() - 60 * 60 * 1000)
      const [
        returnsBacklog,
        rateLimitHits1h,
      ] = await Promise.all([
        prisma.return
          .count({
            where: {
              status: {
                in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED'],
              },
            },
          })
          .catch(() => 0),
        prisma.outboundApiCallLog
          .count({
            where: {
              createdAt: { gte: since1h },
              OR: [{ statusCode: 429 }, { errorType: 'RATE_LIMIT' }],
            },
          })
          .catch(() => 0),
      ])

      // Sync-fail signal is the sum of byChannel.health.errors24h —
      // we already computed those, just sum them up. Done after
      // byChannel is built.

      // ── DO.30 — goal tracking ─────────────────────────────────────
      //
      // Read every ACTIVE Goal for the operator (default-user pre-
      // auth) and compute current progress against the goal's
      // period bounds. Period bounds use the same Europe/Rome
      // zoning as the headline window (DO.2) so daily / weekly /
      // monthly windows align with the operator's calendar.
      //
      // Progress numerators come from existing data:
      //   revenue          → SUM(Order.totalPrice) in primary currency
      //   orders           → COUNT(Order)
      //   aov              → revenue / orders
      //   units            → SUM(OrderItem.quantity)
      //   newCustomers     → COUNT(Customer firstOrderAt in period)
      //
      // Currency goals filter on goal.currency (or primary as
      // fallback when goal.currency is null).
      const goals = await prisma.goal
        .findMany({
          where: { userId: 'default-user', status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 6,
        })
        .catch(() => [] as Array<{
          id: string
          type: string
          period: string
          targetValue: unknown
          currency: string | null
          label: string | null
        }>)

      const goalProgress = await Promise.all(
        goals.map(async (g) => {
          const now = new Date()
          let pFrom: Date
          const pTo = now
          switch (g.period) {
            case 'daily':
              pFrom = zonedStartOfDay(now, OPERATOR_TIMEZONE)
              break
            case 'weekly': {
              // Week starts Monday in Italy.
              const day = zonedStartOfDay(now, OPERATOR_TIMEZONE)
              const dow = (day.getUTCDay() + 6) % 7 // Mon=0
              pFrom = new Date(day.getTime() - dow * 24 * 60 * 60 * 1000)
              break
            }
            case 'monthly': {
              const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: OPERATOR_TIMEZONE,
                year: 'numeric',
                month: '2-digit',
              })
              const [y, m] = fmt.format(now).split('-').map(Number)
              pFrom = zonedStartOfDay(
                new Date(Date.UTC(y, m - 1, 1, 12)),
                OPERATOR_TIMEZONE,
              )
              break
            }
            case 'quarterly': {
              const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: OPERATOR_TIMEZONE,
                year: 'numeric',
                month: '2-digit',
              })
              const [y, m] = fmt.format(now).split('-').map(Number)
              const qStartMonth = Math.floor((m - 1) / 3) * 3
              pFrom = zonedStartOfDay(
                new Date(Date.UTC(y, qStartMonth, 1, 12)),
                OPERATOR_TIMEZONE,
              )
              break
            }
            case 'yearly':
            default:
              pFrom = zonedStartOfYear(now, OPERATOR_TIMEZONE)
              break
          }

          const goalCurrency = g.currency ?? primaryCurrency
          let current = 0
          try {
            if (g.type === 'revenue' || g.type === 'aov') {
              const rows = await prisma.order.findMany({
                where: {
                  createdAt: { gte: pFrom, lte: pTo },
                  currencyCode: goalCurrency,
                },
                select: { totalPrice: true },
              })
              const sum = rows.reduce(
                (s, r) => s + Number((r.totalPrice as unknown as number) || 0),
                0,
              )
              if (g.type === 'revenue') current = sum
              else current = rows.length > 0 ? sum / rows.length : 0
            } else if (g.type === 'orders') {
              current = await prisma.order.count({
                where: {
                  createdAt: { gte: pFrom, lte: pTo },
                  currencyCode: goalCurrency,
                },
              })
            } else if (g.type === 'units') {
              const r = await prisma.$queryRawUnsafe<Array<{ u: bigint }>>(
                `SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS u
                 FROM "OrderItem" oi
                 JOIN "Order" o ON o.id = oi."orderId"
                 WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
                   AND COALESCE(o."currencyCode", 'EUR') = $3`,
                pFrom,
                pTo,
                goalCurrency,
              )
              current = Number(r[0]?.u ?? 0n)
            } else if (g.type === 'newCustomers') {
              current = await prisma.customer.count({
                where: { firstOrderAt: { gte: pFrom, lte: pTo } },
              })
            }
          } catch {
            current = 0
          }

          const target = Number((g.targetValue as unknown as number) || 0)
          const pct = target > 0 ? (current / target) * 100 : 0

          return {
            id: g.id,
            type: g.type,
            period: g.period,
            label: g.label,
            currency: goalCurrency,
            target,
            current,
            pct,
            periodFrom: pFrom.toISOString(),
            periodTo: pTo.toISOString(),
          }
        }),
      )

      // ── DO.31 — predictive insights ───────────────────────────────
      //
      // Surface the daily forecast cron's ReplenishmentForecast
      // output:
      //   - aggregate units forecast for the next 7d / 30d
      //   - count of SKUs whose 7-day forecast exceeds current
      //     totalStock — the operator's "what's about to run out"
      //     list
      //
      // The forecast is per-SKU per-day; we sum across all rows
      // for the horizon counts and join to Product for the
      // stock-out check. Wraps in .catch() because forecast may
      // not have run yet on a fresh deploy.
      const today = zonedStartOfDay(new Date(), OPERATOR_TIMEZONE)
      const next7d = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
      const next30d = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
      const [
        forecast7dRow,
        forecast30dRow,
        stockoutRiskRow,
      ] = await Promise.all([
        prisma.$queryRawUnsafe(
          `SELECT COALESCE(SUM("forecastUnits"), 0)::float AS units
           FROM "ReplenishmentForecast"
           WHERE "horizonDay" >= $1 AND "horizonDay" < $2`,
          today,
          next7d,
        )
          .then((r) => (r as Array<{ units: number }>)[0]?.units ?? 0)
          .catch(() => 0),
        prisma.$queryRawUnsafe(
          `SELECT COALESCE(SUM("forecastUnits"), 0)::float AS units
           FROM "ReplenishmentForecast"
           WHERE "horizonDay" >= $1 AND "horizonDay" < $2`,
          today,
          next30d,
        )
          .then((r) => (r as Array<{ units: number }>)[0]?.units ?? 0)
          .catch(() => 0),
        prisma.$queryRawUnsafe(
          `SELECT COUNT(DISTINCT rf.sku)::bigint AS n
           FROM "ReplenishmentForecast" rf
           JOIN "Product" p ON p.sku = rf.sku
           WHERE rf."horizonDay" >= $1 AND rf."horizonDay" < $2
           GROUP BY rf.sku
           HAVING SUM(rf."forecastUnits") > MAX(p."totalStock")`,
          today,
          next7d,
        )
          .then((r) => (r as Array<{ n: bigint }>).length)
          .catch(() => 0),
      ])

      const predictive = {
        forecastUnits7d: forecast7dRow,
        forecastUnits30d: forecast30dRow,
        stockoutRisk7d: stockoutRiskRow,
        // generatedAt = the freshest forecast row's generatedAt;
        // null when the table is empty (forecast cron hasn't run).
        generatedAt: await prisma.replenishmentForecast
          .findFirst({
            orderBy: { generatedAt: 'desc' },
            select: { generatedAt: true },
          })
          .then((r) => (r ? r.generatedAt.toISOString() : null))
          .catch(() => null),
      }

      // ── DO.29 — financial overview ─────────────────────────────────
      //
      // Three signals beyond the KPI strip:
      //   - gross margin estimate: revenue − Σ(qty × costPrice).
      //     Costs are partial today — Xavia is mid-rollout on
      //     Product.costPrice — so margin is rendered as a "best
      //     estimate" with a coverage ratio.
      //   - refund count (vs the existing refund value KPI)
      //   - tax collected aggregate from OrderItem.vatRate
      //
      // Italian VAT compliance reporting lives at /reports/business +
      // /reports/corrispettivi; the panel here only summarises so
      // the operator sees the headline tax owed without leaving the
      // Command Center.
      const [marginRow, refundCountCurrent, taxRow] = await Promise.all([
        prisma.$queryRawUnsafe(
          `SELECT
             COALESCE(SUM(oi."price" * oi."quantity"), 0)::float AS gross,
             COALESCE(SUM(p."costPrice" * oi."quantity"), 0)::float AS cogs,
             COUNT(*) FILTER (WHERE p."costPrice" IS NOT NULL)::bigint AS items_with_cost,
             COUNT(*)::bigint AS items_total
           FROM "OrderItem" oi
           JOIN "Order" o ON o.id = oi."orderId"
           LEFT JOIN "Product" p ON p.id = oi."productId"
           WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
             AND COALESCE(o."currencyCode", 'EUR') = $3`,
          from,
          to,
          primaryCurrency,
        )
          .then(
            (r) =>
              (r as Array<{
                gross: number
                cogs: number
                items_with_cost: bigint
                items_total: bigint
              }>)[0] ?? { gross: 0, cogs: 0, items_with_cost: 0n, items_total: 0n },
          )
          .catch(() => ({
            gross: 0,
            cogs: 0,
            items_with_cost: 0n,
            items_total: 0n,
          })),
        prisma.refund
          .count({
            where: {
              createdAt: { gte: from, lte: to },
              currencyCode: primaryCurrency,
            },
          })
          .catch(() => 0),
        prisma.$queryRawUnsafe(
          `SELECT COALESCE(SUM(oi."price" * oi."quantity" * oi."vatRate" / 100), 0)::float AS tax
           FROM "OrderItem" oi
           JOIN "Order" o ON o.id = oi."orderId"
           WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
             AND COALESCE(o."currencyCode", 'EUR') = $3
             AND oi."vatRate" IS NOT NULL`,
          from,
          to,
          primaryCurrency,
        )
          .then((r) => (r as Array<{ tax: number }>)[0]?.tax ?? 0)
          .catch(() => 0),
      ])

      const itemsWithCost = Number(marginRow.items_with_cost)
      const itemsTotal = Number(marginRow.items_total)
      const financial = {
        grossRevenue: marginRow.gross,
        cogs: marginRow.cogs,
        margin: marginRow.gross - marginRow.cogs,
        marginPct:
          marginRow.gross > 0
            ? ((marginRow.gross - marginRow.cogs) / marginRow.gross) * 100
            : 0,
        // Cost coverage = % of order-items that have a costPrice on
        // file. Renders as a "n% of items have cost data" caveat so
        // the operator doesn't trust the margin number more than it
        // deserves while costPrice rollout is in progress.
        costCoveragePct:
          itemsTotal > 0 ? (itemsWithCost / itemsTotal) * 100 : 0,
        refundCount: refundCountCurrent,
        taxCollected: taxRow,
      }

      // ── DO.27 — customer intelligence ─────────────────────────────
      //
      // Three signals operators ask for daily:
      //   - new vs returning split in the active window
      //   - top customers by lifetime value (LTV)
      //   - geographic distribution (top 5 ship-to countries)
      //
      // The Customer table carries firstOrderAt + lastOrderAt + totalSpentCents,
      // so new/returning is a single filter on firstOrderAt vs the
      // window. LTV reads totalSpentCents directly. Geo comes from
      // Order.shippingAddress.country — there's no normalised
      // address table yet, so we extract via raw SQL on the JSONB.
      const [
        customersNew,
        customersReturning,
        topCustomers,
        countryRows,
      ] = await Promise.all([
        prisma.customer
          .count({
            where: { firstOrderAt: { gte: from, lte: to } },
          })
          .catch(() => 0),
        prisma.customer
          .count({
            where: {
              firstOrderAt: { lt: from },
              lastOrderAt: { gte: from, lte: to },
            },
          })
          .catch(() => 0),
        prisma.customer
          .findMany({
            orderBy: { totalSpentCents: 'desc' },
            take: 5,
            select: {
              id: true,
              email: true,
              name: true,
              totalOrders: true,
              totalSpentCents: true,
              lastOrderAt: true,
            },
          })
          .catch(() => [] as Array<{
            id: string
            email: string
            name: string | null
            totalOrders: number
            totalSpentCents: bigint
            lastOrderAt: Date | null
          }>),
        prisma.$queryRawUnsafe(
          `SELECT
             COALESCE("shippingAddress"->>'country', 'Unknown') AS country,
             COUNT(*)::bigint AS orders,
             COALESCE(SUM("totalPrice"), 0)::float AS revenue
           FROM "Order"
           WHERE "createdAt" >= $1 AND "createdAt" <= $2
             AND COALESCE("currencyCode", 'EUR') = $3
           GROUP BY 1
           ORDER BY orders DESC
           LIMIT 8`,
          from,
          to,
          primaryCurrency,
        )
          .then((r) => r as Array<{ country: string; orders: bigint; revenue: number }>)
          .catch(() => [] as Array<{ country: string; orders: bigint; revenue: number }>),
      ])

      const customers = {
        newInWindow: customersNew,
        returningInWindow: customersReturning,
        topByLtv: topCustomers.map((c) => ({
          id: c.id,
          email: c.email,
          name: c.name,
          orders: c.totalOrders,
          spentCents: Number(c.totalSpentCents),
          lastOrderAt: c.lastOrderAt ? c.lastOrderAt.toISOString() : null,
        })),
        byCountry: countryRows.map((r) => ({
          country: r.country,
          orders: Number(r.orders),
          revenue: r.revenue,
        })),
      }

      // ── DO.32 / DO.33 / DO.39 — layout + saved-view roster ────────
      const [layout, savedViews] = await Promise.all([
        prisma.dashboardLayout
          .findUnique({
            where: { userId: 'default-user' },
            select: {
              hiddenWidgets: true,
              widgetOrder: true,
              activeViewId: true,
            },
          })
          .catch(() => null),
        prisma.dashboardView
          .findMany({
            where: { userId: 'default-user' },
            orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              isDefault: true,
            },
          })
          .catch(() => [] as Array<{
            id: string
            name: string
            isDefault: boolean
          }>),
      ])

      // ── DO.20 — recent unread notifications ───────────────────────
      //
      // Surface up to 8 most recent unread Notification rows in the
      // alerts panel. Pre-auth scope: 'default-user' (matches the
      // existing /api/notifications convention from H.8). When real
      // auth lands, swap the userId resolver in both places.
      const notifications = await prisma.notification
        .findMany({
          where: { userId: 'default-user', readAt: null },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: {
            id: true,
            type: true,
            severity: true,
            title: true,
            body: true,
            href: true,
            createdAt: true,
          },
        })
        .catch(() => [] as Array<{
          id: string
          type: string
          severity: string
          title: string
          body: string | null
          href: string | null
          createdAt: Date
        }>)

      return {
        window: {
          from: from.toISOString(),
          to: to.toISOString(),
          label,
          key: window,
        },
        compare: {
          key: compare,
          // ISO bounds of the comparison range so the client can
          // surface "vs Mar 1 – Apr 1" tooltips when needed.
          from: prevFrom.toISOString(),
          to: prevTo.toISOString(),
        },
        currency: {
          primary: primaryCurrency,
          // Sorted desc by current-period revenue so the client can
          // render "incl. $X USD" lines in priority order without
          // re-sorting.
          breakdown: Array.from(byCurrency.entries())
            .map(([code, totals]) => ({
              code,
              current: totals.current,
              previous: totals.previous,
            }))
            .sort((a, b) => b.current - a.current),
        },
        totals: {
          revenue: {
            current: revenue.current,
            previous: revenue.previous,
            deltaPct: deltaPct(revenue.current, revenue.previous),
            series: seriesRevenue,
          },
          orders: {
            current: orderCounts.current,
            previous: orderCounts.previous,
            deltaPct: deltaPct(orderCounts.current, orderCounts.previous),
            series: seriesOrders,
          },
          aov: {
            current: aov.current,
            previous: aov.previous,
            deltaPct: deltaPct(aov.current, aov.previous),
            series: seriesAov,
          },
          units: {
            current: units.current,
            previous: units.previous,
            deltaPct: deltaPct(units.current, units.previous),
            series: seriesUnits,
          },
          // DO.12 — operational KPIs. pending/lateShipments are
          // point-in-time counts (no period semantic), so previous=0
          // and deltaPct=null. The frontend renders n/a for those.
          // returnsRate is a percentage; refundValue is currency.
          pendingShipments: {
            current: pendingShipmentsCount,
            previous: 0,
            deltaPct: null,
          },
          lateShipments: {
            current: lateShipmentsCount,
            previous: 0,
            deltaPct: null,
          },
          returnsRate: {
            current: returnsRateCurrent,
            previous: returnsRatePrevious,
            deltaPct: deltaPct(returnsRateCurrent, returnsRatePrevious),
          },
          refundValue: {
            current: refundValueCurrent,
            previous: refundValuePrevious,
            deltaPct: deltaPct(refundValueCurrent, refundValuePrevious),
          },
        },
        byChannel,
        byMarketplace,
        topProducts,
        sparkline,
        // DO.26 — channel keys present in the sparkline rows so the
        // client knows which `channel_<X>` columns exist without
        // sniffing every bucket.
        sparklineChannels: channelKeys,
        recentActivity,
        // DO.27 — customer intelligence block.
        customers,
        // DO.29 — financial overview (margin estimate + refund count
        // + tax collected). Costs are partial today; costCoveragePct
        // tells the operator how much of the underlying data is on
        // file.
        financial,
        // DO.31 — forecast cron output: 7d / 30d unit forecasts +
        // stock-out-at-risk SKU count.
        predictive,
        // DO.30 — operator-set goals + computed progress against
        // each goal's period bounds.
        goals: goalProgress,
        // DO.32 / DO.33 / DO.39 — layout + saved-view roster.
        layout: {
          hiddenWidgets: layout?.hiddenWidgets ?? [],
          widgetOrder: layout?.widgetOrder ?? [],
          activeViewId: layout?.activeViewId ?? null,
          views: savedViews,
        },
        catalog: {
          totalProducts,
          totalParents,
          totalVariants,
          liveListings,
          draftListings,
          failedListings,
          lowStockCount,
          outOfStockCount,
          // DO.28 — inventory enrichment.
          stockValue: stockValueRow,
          agedSkuCount: agedSkuRow,
        },
        alerts: {
          lowStock: lowStockCount,
          outOfStock: outOfStockCount,
          failedListings,
          draftListings,
          pendingOrders,
          // DO.21 — operational rows.
          lateShipments: lateShipmentsCount,
          suppressions: suppressionsActive,
          returnsBacklog,
          syncFailures24h: byChannel.reduce(
            (s, c) => s + (c.health?.errors24h ?? 0),
            0,
          ),
          rateLimitHits1h,
          ebayConnected: ebayActive > 0,
          channelConnections: channelConnections.map((c) => ({
            channelType: c.channelType,
            isActive: c.isActive,
            lastSyncStatus: c.lastSyncStatus,
          })),
          // DO.20 — Notification rows surface as the top section in
          // the alerts panel. Each entry carries severity / type so
          // the renderer can colorize and icon them.
          notifications: notifications.map((n) => ({
            id: n.id,
            type: n.type,
            severity: n.severity,
            title: n.title,
            body: n.body,
            href: n.href,
            createdAt: n.createdAt.toISOString(),
          })),
        },
      }
    },
  )

  /**
   * DO.14 — Command Center event stream (SSE).
   *
   * `GET /api/dashboard/events` — long-lived text/event-stream that
   * fans in every operationally-relevant in-process event bus and
   * republishes them under a unified envelope. Drives the live
   * activity feed on /dashboard/overview.
   *
   * Sources subscribed:
   *   - order-events     (order.created / updated / cancelled,
   *                       return.created)
   *   - outbound-events  (shipment.created / updated / deleted,
   *                       order.shipped, tracking.event)
   *   - listing-events   (listing.synced / syncing / updated /
   *                       created / deleted, wizard.submitted)
   *   - inbound-events   (inbound.created / updated / received /
   *                       discrepancy / cancelled)
   *   - sync-logs-events (api-call.recorded)
   *
   * Pattern matches /api/orders/events (O.6) and
   * /api/fulfillment/outbound/events (O.32): heartbeat every 25s
   * keeps the connection alive past most reverse-proxy idle
   * timeouts; client EventSource auto-reconnects on transient drops.
   * Event payloads stay light — subscribers re-fetch on receipt
   * rather than apply deltas.
   */
  fastify.get('/dashboard/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(
      `event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`,
    )

    const send = (event: { type: string; ts?: number } & Record<string, unknown>) => {
      try {
        reply.raw.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
      } catch {
        // Connection dead — cleanup runs in the close handler.
      }
    }

    // Lazy-load subscribers to avoid a startup cycle through every
    // event service when this route is never hit.
    const [
      { subscribeOrderEvents },
      { subscribeOutboundEvents },
      { subscribeListingEvents },
      { subscribeInboundEvents },
      { subscribeSyncLogEvents },
    ] = await Promise.all([
      import('../services/order-events.service.js'),
      import('../services/outbound-events.service.js'),
      import('../services/listing-events.service.js'),
      import('../services/inbound-events.service.js'),
      import('../services/sync-logs-events.service.js'),
    ])

    const unsubscribers = [
      subscribeOrderEvents(send),
      subscribeOutboundEvents(send),
      subscribeListingEvents(send),
      subscribeInboundEvents(send),
      subscribeSyncLogEvents(send),
    ]

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      for (const unsub of unsubscribers) unsub()
    })

    // Hold the connection open. Resolves when `close` fires.
    await new Promise(() => {})
  })

  /**
   * H.13 — sync health dashboard data.
   *
   *   GET /api/dashboard/health
   *
   * Single-shot rollup the operator can hit when something feels off:
   *   - Queue: OutboundSyncQueue depth (pending / inFlight / failed)
   *     plus the oldest pending row (drives the "stuck job" warning).
   *   - Per-channel sync: ChannelConnection status, last sync result,
   *     24h error count, derived status (ok / warn / fail).
   *   - 24h SyncLog roll-up: success + fail counts and computed error
   *     rate. Powers the headline stat at the top of the page.
   *   - Recent errors: last 20 from SyncError + SyncLog(status=FAILED)
   *     merged and sorted newest-first so the operator can scan.
   *
   * Replaces the "tab-hop between /sync-logs, /logs, /api/monitoring/
   * queue-stats" workflow. 30s Cache-Control because the page is
   * polled, and these tables don't change second-to-second.
   */
  fastify.get('/dashboard/health', async (_request, reply) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // ── Queue depth + oldest stuck row ─────────────────────────────
    const [pending, inFlight, failed, oldestPending] = await Promise.all([
      prisma.outboundSyncQueue.count({ where: { syncStatus: 'PENDING' } }),
      prisma.outboundSyncQueue.count({ where: { syncStatus: 'IN_PROGRESS' } }),
      prisma.outboundSyncQueue.count({ where: { syncStatus: 'FAILED' } }),
      prisma.outboundSyncQueue.findFirst({
        where: { syncStatus: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true, targetChannel: true },
      }),
    ])

    // ── 24h sync log rollup ─────────────────────────────────────────
    const [logsSuccessful, logsFailed] = await Promise.all([
      prisma.syncLog.count({
        where: { status: 'SUCCESS', createdAt: { gte: since24h } },
      }),
      prisma.syncLog.count({
        where: { status: 'FAILED', createdAt: { gte: since24h } },
      }),
    ])
    const logsTotal = logsSuccessful + logsFailed
    const errorRate24h = logsTotal === 0 ? 0 : logsFailed / logsTotal

    // ── Per-channel status ─────────────────────────────────────────
    const connections = await prisma.channelConnection.findMany({
      orderBy: [{ channelType: 'asc' }, { marketplace: 'asc' }],
      select: {
        id: true,
        channelType: true,
        marketplace: true,
        managedBy: true,
        isActive: true,
        lastSyncStatus: true,
        lastSyncAt: true,
        lastSyncError: true,
        displayName: true,
      },
    })

    // 24h error count per channel from SyncError. groupBy on (channel)
    // gives one query for every channel rather than N findMany calls.
    const errorByChannel = await prisma.syncError.groupBy({
      by: ['channel'],
      where: { createdAt: { gte: since24h } },
      _count: { _all: true },
    })
    const errorCountByChannel = new Map(
      errorByChannel.map((r) => [r.channel, r._count._all]),
    )

    const channels = connections.map((c) => {
      const errors24h = errorCountByChannel.get(c.channelType) ?? 0
      const status =
        !c.isActive
          ? 'inactive'
          : c.lastSyncStatus === 'FAILED'
            ? 'fail'
            : errors24h > 5
              ? 'warn'
              : 'ok'
      return {
        id: c.id,
        channel: c.channelType,
        marketplace: c.marketplace,
        managedBy: c.managedBy,
        isActive: c.isActive,
        displayName: c.displayName,
        lastSyncStatus: c.lastSyncStatus,
        lastSyncAt: c.lastSyncAt,
        lastSyncError: c.lastSyncError,
        errors24h,
        status,
      }
    })

    // ── Recent errors: merge SyncError + SyncLog(FAILED) ────────────
    // SyncError captures ad-hoc cross-channel failures; SyncLog
    // captures per-product publish attempts. Merging gives the
    // operator one timeline to triage from.
    const [syncErrors, failedLogs] = await Promise.all([
      prisma.syncError.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          channel: true,
          errorType: true,
          errorMessage: true,
          context: true,
          createdAt: true,
        },
      }),
      prisma.syncLog.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          syncType: true,
          errorMessage: true,
          productId: true,
          createdAt: true,
        },
      }),
    ])
    const recentErrors = [
      ...syncErrors.map((e) => ({
        id: `err:${e.id}`,
        kind: 'sync-error' as const,
        when: e.createdAt,
        channel: e.channel,
        type: e.errorType,
        message: e.errorMessage,
        productId: null,
        context: e.context,
      })),
      ...failedLogs.map((l) => ({
        id: `log:${l.id}`,
        kind: 'sync-log' as const,
        when: l.createdAt,
        channel: l.syncType.split('_')[0] ?? 'UNKNOWN',
        type: l.syncType,
        message: l.errorMessage ?? 'Unknown error',
        productId: l.productId,
        context: null,
      })),
    ]
      .sort((a, b) => b.when.getTime() - a.when.getTime())
      .slice(0, 20)

    reply.header('Cache-Control', 'private, max-age=30')
    return {
      generatedAt: new Date().toISOString(),
      queue: {
        pending,
        inFlight,
        failed,
        total: pending + inFlight + failed,
        oldestPending: oldestPending
          ? {
              id: oldestPending.id,
              createdAt: oldestPending.createdAt,
              targetChannel: oldestPending.targetChannel,
              ageMs: Date.now() - oldestPending.createdAt.getTime(),
            }
          : null,
      },
      logs24h: {
        successful: logsSuccessful,
        failed: logsFailed,
        total: logsTotal,
        errorRate: errorRate24h,
      },
      channels,
      recentErrors,
    }
  })

  // Cron observability — latest run per known job + recent failures.
  // Powers the CronStatusPanel on /dashboard/health.
  // Backed by the CronRun table written by recordCronRun().
  fastify.get('/dashboard/cron-runs', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=15')

      // Latest run per jobName via DISTINCT ON (Postgres-specific). The
      // grouped-window equivalent in pure Prisma is awkward; raw SQL is
      // cleaner here.
      const latest = await prisma.$queryRaw<
        Array<{
          jobName: string
          startedAt: Date
          finishedAt: Date | null
          status: string
          errorMessage: string | null
          outputSummary: string | null
          triggeredBy: string
        }>
      >`
        SELECT DISTINCT ON ("jobName")
          "jobName", "startedAt", "finishedAt", "status",
          "errorMessage", "outputSummary", "triggeredBy"
        FROM "CronRun"
        WHERE "startedAt" > NOW() - INTERVAL '30 days'
        ORDER BY "jobName", "startedAt" DESC
      `

      // Stale RUNNING rows (>2h) — likely a crash before the wrapper
      // could update. Surface as health flags.
      const staleRunning = await prisma.cronRun.findMany({
        where: {
          status: 'RUNNING',
          startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        select: {
          id: true,
          jobName: true,
          startedAt: true,
          triggeredBy: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 20,
      })

      // Last 20 failures across all jobs.
      const recentFailures = await prisma.cronRun.findMany({
        where: { status: 'FAILED' },
        select: {
          id: true,
          jobName: true,
          startedAt: true,
          finishedAt: true,
          errorMessage: true,
          triggeredBy: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 20,
      })

      return {
        latest: latest.map((r) => ({
          ...r,
          durationMs:
            r.finishedAt
              ? new Date(r.finishedAt).getTime() -
                new Date(r.startedAt).getTime()
              : null,
        })),
        staleRunning,
        recentFailures,
        generatedAt: new Date().toISOString(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/cron-runs] failed')
      return reply.code(500).send({ error: message })
    }
  })

  // Force-resync a single drifting ChannelListing. Repairs the
  // displayed value to match the master snapshot + enqueues an
  // OutboundSyncQueue row with no grace window so the cron worker
  // pushes immediately.
  //
  // Body: { kind: 'quantity' | 'price' }. The quantity case sets
  // ChannelListing.quantity = masterQuantity - stockBuffer; the price
  // case sets price = masterPrice when pricingRule=FIXED. Other rules
  // are intentional divergence (PERCENT_OF_MASTER, MATCH_AMAZON) and
  // get a 409.
  fastify.post<{
    Params: { id: string }
    Body: { kind?: 'quantity' | 'price' }
  }>('/dashboard/stock-drift/:id/resync', async (request, reply) => {
    try {
      const { id } = request.params
      const kind = request.body?.kind ?? 'quantity'
      const listing = await prisma.channelListing.findUnique({
        where: { id },
        select: {
          id: true,
          channel: true,
          region: true,
          marketplace: true,
          externalListingId: true,
          productId: true,
          masterPrice: true,
          price: true,
          masterQuantity: true,
          quantity: true,
          stockBuffer: true,
          pricingRule: true,
          followMasterQuantity: true,
          followMasterPrice: true,
        },
      })
      if (!listing) {
        return reply.code(404).send({ error: 'Listing not found' })
      }

      if (kind === 'quantity') {
        if (!listing.followMasterQuantity) {
          return reply.code(409).send({
            error:
              'Listing has followMasterQuantity=false; quantity divergence is intentional. Toggle on to resync.',
          })
        }
        if (listing.masterQuantity == null) {
          return reply.code(409).send({
            error: 'Master quantity not snapshotted yet; cannot resync.',
          })
        }
        const newQty = Math.max(
          0,
          listing.masterQuantity - (listing.stockBuffer ?? 0),
        )
        await prisma.$transaction(async (tx) => {
          await tx.channelListing.update({
            where: { id },
            data: {
              quantity: newQty,
              lastSyncStatus: 'PENDING',
              version: { increment: 1 },
            },
          })
          await tx.outboundSyncQueue.create({
            data: {
              productId: listing.productId,
              channelListingId: listing.id,
              targetChannel: listing.channel as any,
              targetRegion: listing.region,
              syncStatus: 'PENDING' as any,
              syncType: 'QUANTITY_UPDATE',
              holdUntil: null, // immediate — operator-initiated
              externalListingId: listing.externalListingId,
              payload: { quantity: newQty } as any,
            },
          })
        })
        return reply.send({
          success: true,
          kind,
          newValue: newQty,
        })
      }

      // kind === 'price'
      if (!listing.followMasterPrice) {
        return reply.code(409).send({
          error:
            'Listing has followMasterPrice=false; price divergence is intentional.',
        })
      }
      if (listing.pricingRule !== 'FIXED') {
        return reply.code(409).send({
          error: `pricingRule=${listing.pricingRule} intentionally diverges from master; only FIXED is a literal-follow rule.`,
        })
      }
      if (listing.masterPrice == null) {
        return reply.code(409).send({
          error: 'Master price not snapshotted yet; cannot resync.',
        })
      }
      const newPrice = Number(listing.masterPrice)
      await prisma.$transaction(async (tx) => {
        await tx.channelListing.update({
          where: { id },
          data: {
            price: newPrice.toFixed(2),
            lastSyncStatus: 'PENDING',
            version: { increment: 1 },
          },
        })
        await tx.outboundSyncQueue.create({
          data: {
            productId: listing.productId,
            channelListingId: listing.id,
            targetChannel: listing.channel as any,
            targetRegion: listing.region,
            syncStatus: 'PENDING' as any,
            syncType: 'PRICE_UPDATE',
            holdUntil: null,
            externalListingId: listing.externalListingId,
            payload: { price: newPrice } as any,
          },
        })
      })
      return reply.send({ success: true, kind, newValue: newPrice })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/stock-drift/:id/resync] failed')
      return reply.code(500).send({ error: message })
    }
  })

  // Stock drift detection — surface ChannelListings where the cached
  // master snapshot disagrees with the displayed value. The Phase 13
  // master-cascade should keep these in sync; persistent drift means
  // a sync queue row failed, the cron worker is stuck, or a manual
  // override was applied without followMaster being flipped off.
  //
  // Two drift classes:
  //   1. quantityDrift: followMasterQuantity=true AND
  //      |masterQuantity - quantity| > 0
  //   2. priceDrift: followMasterPrice=true AND pricingRule=FIXED AND
  //      |masterPrice - price| > 0.01
  //
  // Returns up to 100 of each, sorted by largest absolute drift first.
  fastify.get<{
    Querystring: { qtyThreshold?: string; priceThreshold?: string }
  }>('/dashboard/stock-drift', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const qtyThreshold = Math.max(
        0,
        Number(request.query.qtyThreshold ?? 0),
      )
      const priceThreshold = Math.max(
        0,
        Number(request.query.priceThreshold ?? 0.01),
      )

      type DriftRow = {
        id: string
        channel: string
        marketplace: string | null
        productId: string
        sku: string | null
        productName: string | null
        masterQuantity: number | null
        quantity: number | null
        quantityDelta: number | null
        masterPrice: string | null
        price: string | null
        priceDelta: number | null
        followMasterQuantity: boolean
        followMasterPrice: boolean
        pricingRule: string | null
        lastSyncStatus: string | null
        lastSyncedAt: Date | null
        updatedAt: Date
      }

      // Quantity drift: cached snapshot vs displayed.
      const qtyDriftRows = await prisma.$queryRaw<DriftRow[]>`
        SELECT
          cl.id,
          cl.channel,
          cl.marketplace,
          cl."productId",
          p.sku,
          p.name AS "productName",
          cl."masterQuantity",
          cl.quantity,
          (COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) AS "quantityDelta",
          NULL::text AS "masterPrice",
          NULL::text AS "price",
          NULL::numeric AS "priceDelta",
          cl."followMasterQuantity",
          cl."followMasterPrice",
          cl."pricingRule",
          cl."lastSyncStatus",
          cl."lastSyncedAt",
          cl."updatedAt"
        FROM "ChannelListing" cl
        JOIN "Product" p ON p.id = cl."productId"
        WHERE cl."followMasterQuantity" = true
          AND cl."masterQuantity" IS NOT NULL
          AND cl.quantity IS NOT NULL
          AND ABS(COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) > ${qtyThreshold}
        ORDER BY ABS(COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) DESC
        LIMIT 100
      `

      // Price drift: only relevant when pricingRule=FIXED (the rule
      // explicitly says "follow master price, no transformation").
      // PERCENT_OF_MASTER and MATCH_AMAZON intentionally diverge.
      const priceDriftRows = await prisma.$queryRaw<DriftRow[]>`
        SELECT
          cl.id,
          cl.channel,
          cl.marketplace,
          cl."productId",
          p.sku,
          p.name AS "productName",
          NULL::int AS "masterQuantity",
          NULL::int AS quantity,
          NULL::int AS "quantityDelta",
          cl."masterPrice"::text AS "masterPrice",
          cl.price::text AS price,
          (COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0))::numeric AS "priceDelta",
          cl."followMasterQuantity",
          cl."followMasterPrice",
          cl."pricingRule",
          cl."lastSyncStatus",
          cl."lastSyncedAt",
          cl."updatedAt"
        FROM "ChannelListing" cl
        JOIN "Product" p ON p.id = cl."productId"
        WHERE cl."followMasterPrice" = true
          AND cl."pricingRule" = 'FIXED'
          AND cl."masterPrice" IS NOT NULL
          AND cl.price IS NOT NULL
          AND ABS(COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0)) > ${priceThreshold}
        ORDER BY ABS(COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0)) DESC
        LIMIT 100
      `

      // Total counts (unbounded by limit) for the headline KPIs.
      const [qtyTotalRow] = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*)::bigint AS c FROM "ChannelListing" cl
        WHERE cl."followMasterQuantity" = true
          AND cl."masterQuantity" IS NOT NULL
          AND cl.quantity IS NOT NULL
          AND ABS(COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) > ${qtyThreshold}
      `
      const [priceTotalRow] = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*)::bigint AS c FROM "ChannelListing" cl
        WHERE cl."followMasterPrice" = true
          AND cl."pricingRule" = 'FIXED'
          AND cl."masterPrice" IS NOT NULL
          AND cl.price IS NOT NULL
          AND ABS(COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0)) > ${priceThreshold}
      `

      return {
        quantityDrift: {
          totalCount: Number(qtyTotalRow?.c ?? 0n),
          rows: qtyDriftRows,
          threshold: qtyThreshold,
        },
        priceDrift: {
          totalCount: Number(priceTotalRow?.c ?? 0n),
          rows: priceDriftRows,
          threshold: priceThreshold,
        },
        generatedAt: new Date().toISOString(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/stock-drift] failed')
      return reply.code(500).send({ error: message })
    }
  })

  // DO.32 — dashboard layout PUT.
  //
  // Persist the operator's hidden-widgets deny-list. Body shape:
  //   { hiddenWidgets: string[] }
  //
  // Upsert keyed on userId so a fresh row materialises on first
  // save. The endpoint is intentionally simple — no per-role view,
  // no order field, no validation against a known widget id list
  // (operator can stash unknown ids and they're ignored by the
  // renderer until a matching widget exists).
  // DO.39 — saved view CRUD.
  //
  //   POST   /dashboard/views          — create from current layout
  //   POST   /dashboard/views/:id/apply — copy view → live layout
  //   PUT    /dashboard/views/:id       — rename / overwrite
  //   DELETE /dashboard/views/:id       — drop view
  //
  // Switch behaviour: applying a view copies its hiddenWidgets +
  // widgetOrder into the singleton DashboardLayout row and points
  // activeViewId at the source. The dashboard renderer reads the
  // copy, so a half-finished customise session can never poison
  // the saved view.
  fastify.post<{
    Body: { name?: string; hiddenWidgets?: unknown; widgetOrder?: unknown }
  }>('/dashboard/views', async (request, reply) => {
    const name = String(request.body?.name ?? '').trim().slice(0, 80)
    if (!name) return reply.code(400).send({ error: 'name required' })
    const sanitiseList = (raw: unknown): string[] =>
      Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === 'string').slice(0, 50)
        : []
    const hidden = sanitiseList(request.body?.hiddenWidgets)
    const order = sanitiseList(request.body?.widgetOrder)
    try {
      // Auto-default if this is the first view for the operator.
      const existingCount = await prisma.dashboardView.count({
        where: { userId: 'default-user' },
      })
      const view = await prisma.dashboardView.create({
        data: {
          userId: 'default-user',
          name,
          hiddenWidgets: hidden,
          widgetOrder: order,
          isDefault: existingCount === 0,
        },
      })
      return { ok: true, view }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // P2002 = unique violation on (userId, name).
      if (message.includes('Unique constraint')) {
        return reply.code(409).send({ error: 'name already exists' })
      }
      fastify.log.error({ err }, '[dashboard/views] create failed')
      return reply.code(500).send({ error: message })
    }
  })

  fastify.post<{ Params: { id: string } }>(
    '/dashboard/views/:id/apply',
    async (request, reply) => {
      const { id } = request.params
      try {
        const view = await prisma.dashboardView.findFirst({
          where: { id, userId: 'default-user' },
          select: { id: true, hiddenWidgets: true, widgetOrder: true },
        })
        if (!view) return reply.code(404).send({ error: 'view not found' })
        const row = await prisma.dashboardLayout.upsert({
          where: { userId: 'default-user' },
          create: {
            userId: 'default-user',
            hiddenWidgets: view.hiddenWidgets,
            widgetOrder: view.widgetOrder,
            activeViewId: view.id,
          },
          update: {
            hiddenWidgets: view.hiddenWidgets,
            widgetOrder: view.widgetOrder,
            activeViewId: view.id,
          },
          select: {
            hiddenWidgets: true,
            widgetOrder: true,
            activeViewId: true,
          },
        })
        return { ok: true, layout: row }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[dashboard/views/:id/apply] failed')
        return reply.code(500).send({ error: message })
      }
    },
  )

  fastify.put<{
    Params: { id: string }
    Body: { name?: string; hiddenWidgets?: unknown; widgetOrder?: unknown }
  }>('/dashboard/views/:id', async (request, reply) => {
    const { id } = request.params
    const data: {
      name?: string
      hiddenWidgets?: string[]
      widgetOrder?: string[]
    } = {}
    if (typeof request.body?.name === 'string') {
      data.name = request.body.name.trim().slice(0, 80)
      if (!data.name) return reply.code(400).send({ error: 'name required' })
    }
    if (Array.isArray(request.body?.hiddenWidgets)) {
      data.hiddenWidgets = request.body!.hiddenWidgets!
        .filter((v): v is string => typeof v === 'string')
        .slice(0, 50)
    }
    if (Array.isArray(request.body?.widgetOrder)) {
      data.widgetOrder = request.body!.widgetOrder!
        .filter((v): v is string => typeof v === 'string')
        .slice(0, 50)
    }
    try {
      const view = await prisma.dashboardView.update({
        where: { id, userId: 'default-user' } as { id: string; userId?: string },
        data,
      })
      return { ok: true, view }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('Unique constraint')) {
        return reply.code(409).send({ error: 'name already exists' })
      }
      if (message.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'view not found' })
      }
      fastify.log.error({ err }, '[dashboard/views/:id] update failed')
      return reply.code(500).send({ error: message })
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/dashboard/views/:id',
    async (request, reply) => {
      const { id } = request.params
      try {
        // Clear activeViewId if pointing at the deleted row.
        await prisma.dashboardLayout.updateMany({
          where: { userId: 'default-user', activeViewId: id },
          data: { activeViewId: null },
        })
        const result = await prisma.dashboardView.deleteMany({
          where: { id, userId: 'default-user' },
        })
        if (result.count === 0)
          return reply.code(404).send({ error: 'view not found' })
        return { ok: true, deleted: result.count }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[dashboard/views/:id] delete failed')
        return reply.code(500).send({ error: message })
      }
    },
  )

  fastify.put<{
    Body: { hiddenWidgets?: unknown; widgetOrder?: unknown }
  }>('/dashboard/layout', async (request, reply) => {
    const sanitiseList = (raw: unknown): string[] =>
      Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === 'string').slice(0, 50)
        : []
    const hidden = sanitiseList(request.body?.hiddenWidgets)
    const order = sanitiseList(request.body?.widgetOrder)
    try {
      const row = await prisma.dashboardLayout.upsert({
        where: { userId: 'default-user' },
        create: {
          userId: 'default-user',
          hiddenWidgets: hidden,
          widgetOrder: order,
        },
        update: { hiddenWidgets: hidden, widgetOrder: order },
        select: { hiddenWidgets: true, widgetOrder: true },
      })
      return {
        ok: true,
        hiddenWidgets: row.hiddenWidgets,
        widgetOrder: row.widgetOrder,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/layout] upsert failed')
      return reply.code(500).send({ error: message })
    }
  })
}

export default dashboardRoutes
