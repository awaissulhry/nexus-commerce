/**
 * MCP full control P3 — the dashboard's Global Snapshot (GS.1) and Amazon market health (MS.4), read in one place:
 * GET /api/dashboard/global-snapshot and GET /api/dashboard/market-health (dashboard.routes.ts) call these, and
 * Claude's `insights-report` read (report: snapshot) can call the same code instead of a copy.
 *
 * Moved from the route without a change in behaviour; global-snapshot.service.vitest.test.ts holds the routes' answers
 * byte for byte (every period, a marketplace filter, the EUR-equivalent basis, market health), with business profiles
 * off and on.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { OPERATOR_TIMEZONE, zonedStartOfDay } from './zoned-time.js'

/** The query the route reads, as it arrives: every field optional and parsed here, as the route parsed it. */
export interface GlobalSnapshotQuery {
  /** today (default) | yesterday | 7d | 30d | 90d — any other value reads as today. */
  period?: string
  /** One marketplace code (trimmed, upper-cased); empty or absent means every marketplace. */
  marketplace?: string
  /** EUR (default: non-EUR sales stay apart as chips) or EUR_EQUIV (folded into the headline at the stored rate). */
  baseCurrency?: string
}

/**
 * Where the two best-effort steps (the sparkline estimate fold, the FX lookup) say they failed. The route passes its
 * own Fastify logger, as before; other callers get the redacting app logger.
 */
export interface SnapshotLog {
  warn: (details: unknown, message: string) => void
}

const appLog: SnapshotLog = {
  warn: (details, message) => logger.warn(message, details as Record<string, any>),
}

/**
 * GS.1 — the Global Snapshot: Sales (gross, Amazon's semantic: cancellations still count), the 7-day sparkline, sales
 * and open orders per marketplace, and the estimate for Amazon orders whose total Amazon withheld (€0 with units).
 */
export async function globalSnapshot(query: GlobalSnapshotQuery, log: SnapshotLog = appLog) {
  const period = (query.period ?? 'today') as
    | 'today' | 'yesterday' | '7d' | '30d' | '90d'
  // SA.3 — optional marketplace scope. When set, every count +
  // sparkline + byMarketplace row is filtered to this single
  // marketplace. The byMarketplace array still returns to keep
  // the response shape stable for the UI.
  const marketplaceFilter = (query.marketplace ?? '').trim().toUpperCase() || null
  // DA-RT.8b — operator's currency basis choice. 'EUR' (default
  // legacy behaviour: EUR-only headline + non-EUR as native chips)
  // OR 'EUR_EQUIV' (DA-RT.8 conversion: non-EUR orders converted
  // to EUR via the FxRate daily snapshot and folded into the
  // single headline number). 'EUR' kept as default so legacy
  // clients see no behaviour change until they opt in.
  const baseCurrency = (query.baseCurrency ?? 'EUR').toUpperCase()
  const convertNonEur = baseCurrency === 'EUR_EQUIV'
  const now = new Date()
  const todayStart = zonedStartOfDay(now, OPERATOR_TIMEZONE)
  let from: Date
  let to: Date = now
  switch (period) {
    case 'yesterday':
      from = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
      to = todayStart
      break
    case '7d':
      from = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000)
      break
    case '30d':
      from = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000)
      break
    case '90d':
      from = new Date(todayStart.getTime() - 90 * 24 * 60 * 60 * 1000)
      break
    case 'today':
    default:
      from = todayStart
  }

  // Region grouping mirrors Amazon Seller Central's home-page
  // table. The "marketplaces Xavia sells on" set lives in
  // CLAUDE memory; we group by region for the panel UI.
  const REGION: Record<string, string> = {
    IT: 'Europe', DE: 'Europe', FR: 'Europe', ES: 'Europe', UK: 'Europe',
    NL: 'Europe', SE: 'Europe', PL: 'Europe', BE: 'Europe', IE: 'Europe',
    TR: 'Europe', AE: 'Middle East', SA: 'Middle East',
    US: 'Americas', CA: 'Americas', MX: 'Americas',
    JP: 'Asia',
  }

  // ── Sales aggregation ────────────────────────────────────────
  // MS.6 — Amazon Seller Central "Sales" semantic. Amazon's tile
  // counts the original ordered amount regardless of subsequent
  // cancellation/refund (refunds appear as their own line in
  // financials, not as negative sales). This is intentionally
  // different from the /orders page which excludes
  // CANCELLED/REFUNDED/RETURNED (OX.17) — that page is the
  // operator's "what's actionable" view. The snapshot is the
  // "what would Amazon show me on its home page" view.
  // SA.3 — optional marketplace scope merged into every WHERE.
  const salesWhere = {
    deletedAt: null,
    purchaseDate: { gte: from, lt: to },
    ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
  }
  const salesByMarketplace = await prisma.order.groupBy({
    by: ['marketplace', 'currencyCode'],
    where: salesWhere,
    _sum: { totalPrice: true },
    _count: { _all: true },
  })

  // Per-line units (each OrderItem.quantity summed per order's marketplace).
  // SA.3: marketplace filter applied via dynamic WHERE fragment.
  // MS.6: no status exclusion — Amazon "Sales" semantic.
  const itemUnits = marketplaceFilter
    ? await prisma.$queryRaw<Array<{ marketplace: string | null; units: bigint }>>`
        SELECT o."marketplace", COALESCE(SUM(oi."quantity"), 0)::bigint AS units
          FROM "Order" o
          JOIN "OrderItem" oi ON oi."orderId" = o.id
         WHERE o."deletedAt" IS NULL
           AND o."purchaseDate" >= ${from}
           AND o."purchaseDate" <  ${to}
           AND o."marketplace" = ${marketplaceFilter}
         GROUP BY o."marketplace"
      `
    : await prisma.$queryRaw<Array<{ marketplace: string | null; units: bigint }>>`
        SELECT o."marketplace", COALESCE(SUM(oi."quantity"), 0)::bigint AS units
          FROM "Order" o
          JOIN "OrderItem" oi ON oi."orderId" = o.id
         WHERE o."deletedAt" IS NULL
           AND o."purchaseDate" >= ${from}
           AND o."purchaseDate" <  ${to}
         GROUP BY o."marketplace"
      `
  const unitsByMarketplace = new Map(
    itemUnits.map((r) => [r.marketplace ?? 'UNKNOWN', Number(r.units)]),
  )

  // 7-day sparkline (always 7 days regardless of `period` so the
  // tile chart is consistent) — daily totals in primary currency.
  // SA.3: marketplace filter applied via dynamic WHERE fragment.
  const sparkStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000)
  // MS.6: no status exclusion — Amazon "Sales" semantic.
  const sparkRaw = marketplaceFilter
    ? await prisma.$queryRaw<Array<{ day: Date; cents: bigint }>>`
        SELECT date_trunc('day', o."purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date AS day,
               COALESCE(SUM(ROUND(o."totalPrice" * 100)), 0)::bigint AS cents
          FROM "Order" o
         WHERE o."deletedAt" IS NULL
           AND o."purchaseDate" >= ${sparkStart}
           AND o."currencyCode" = 'EUR'
           AND o."marketplace" = ${marketplaceFilter}
         GROUP BY day
         ORDER BY day ASC
      `
    : await prisma.$queryRaw<Array<{ day: Date; cents: bigint }>>`
        SELECT date_trunc('day', o."purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date AS day,
               COALESCE(SUM(ROUND(o."totalPrice" * 100)), 0)::bigint AS cents
          FROM "Order" o
         WHERE o."deletedAt" IS NULL
           AND o."purchaseDate" >= ${sparkStart}
           AND o."currencyCode" = 'EUR'
         GROUP BY day
         ORDER BY day ASC
      `
  // GA-RT.1 — TZ-safe day-key helper. Both sparkMap (from
  // sparkRaw) and the sparkline loop need to produce the SAME
  // calendar-date string for the SAME Europe/Rome local day.
  // Without it, `d.toISOString().slice(0,10)` of a local-midnight
  // instant returns the UTC date — which is the PREVIOUS day
  // during CEST (summer time). Result: every sparkline bucket
  // shows the data of the NEXT day's orders, or zero. Same
  // helper used in sparkEstimateMap below for the same reason.
  const isoLocalDay = (d: Date): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: OPERATOR_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)

  const sparkMap = new Map(
    // Postgres date_trunc(... AT TZ 'Europe/Rome')::date already
    // produces the right calendar date as a UTC-midnight JS Date,
    // so r.day.toISOString().slice(0,10) IS the local-tz date
    // here (since UTC-midnight of date X is "X" in ISO no matter
    // the zone). Kept identical for the existing rows.
    sparkRaw.map((r) => [r.day.toISOString().slice(0, 10), Number(r.cents)]),
  )

  // GS-RT.8 — fold ChannelListing-based estimates into each
  // sparkline day for €0+units orders. Without this the line
  // chart silently undercounts on days that have stuck rows
  // (Amazon-withheld OrderTotal). Same data source as the
  // headline + per-marketplace estimate, just grouped by day.
  // Once GS-RT.7 backfill repairs stuck rows their totalPrice
  // > 0 → they drop from the €0 query → sparkline naturally
  // shows the real revenue without estimate contamination.
  //
  // Window extended back 1 extra day (sparkStart - 1d) so the
  // "vs same day last week" delta below can also fold its prev
  // day's estimate — for "today" period prev = todayStart - 7d
  // which sits 1 day before the sparkline's normal 6d window.
  const sparkEstimateScanStart = new Date(sparkStart.getTime() - 24 * 60 * 60 * 1000)
  const sparkEstimateMap = new Map<string, number>()
  try {
    const sparkZeroOrders = await prisma.order.findMany({
      where: {
        deletedAt: null,
        channel: 'AMAZON',
        totalPrice: 0,
        currencyCode: 'EUR',
        purchaseDate: { gte: sparkEstimateScanStart, lt: todayStart },
        status: { notIn: ['CANCELLED'] as any },
        items: { some: { quantity: { gt: 0 } } },
        ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
      },
      select: {
        purchaseDate: true,
        marketplace: true,
        items: { select: { quantity: true, productId: true } },
      },
      take: 500,
    })
    if (sparkZeroOrders.length > 0) {
      // Resolve productId → ChannelListing.price map (per
      // channel+marketplace) once for the whole sparkline batch
      // to keep query count bounded.
      const productIds = Array.from(
        new Set(
          sparkZeroOrders.flatMap((o) =>
            o.items.map((i) => i.productId).filter((p): p is string => !!p),
          ),
        ),
      )
      const sparkListings = productIds.length > 0
        ? await prisma.channelListing.findMany({
            where: {
              productId: { in: productIds },
              channel: 'AMAZON',
              marketplace: { in: ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'PL', 'SE', 'BE', 'IE', 'TR', 'AE', 'SA', 'US', 'CA', 'JP'] },
            },
            select: { productId: true, marketplace: true, price: true, salePrice: true },
          })
        : []
      const sparkProducts = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, basePrice: true },
          })
        : []
      const sparkBaseByProduct = new Map(sparkProducts.map((p) => [p.id, Number(p.basePrice)]))
      const sparkPriceByPair = new Map<string, number>()
      for (const l of sparkListings) {
        const eff = l.salePrice != null ? Number(l.salePrice) : l.price != null ? Number(l.price) : null
        if (eff != null && eff > 0) {
          sparkPriceByPair.set(`${l.productId}|${l.marketplace}`, eff)
        }
      }
      for (const o of sparkZeroOrders) {
        let cents = 0
        for (const it of o.items) {
          if (!it.productId) continue
          const pairKey = `${it.productId}|${o.marketplace ?? 'DEFAULT'}`
          const unit = sparkPriceByPair.get(pairKey) ?? sparkBaseByProduct.get(it.productId) ?? 0
          cents += Math.round(unit * 100) * it.quantity
        }
        // Date key in Europe/Rome to match sparkRaw's TZ bucket.
        const iso = new Intl.DateTimeFormat('en-CA', {
          timeZone: OPERATOR_TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(o.purchaseDate)
        sparkEstimateMap.set(iso, (sparkEstimateMap.get(iso) ?? 0) + cents)
      }
    }
  } catch (sparkErr) {
    // Best-effort — sparkline base values still render. Log so
    // operators can see if estimate folding is failing silently.
    log.warn(
      { err: sparkErr },
      '[dashboard/global-snapshot] sparkline estimate fold failed (line chart will undercount stuck €0 days)',
    )
  }

  const sparkline: Array<{ date: string; valueCents: number }> = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000)
    // GA-RT.1 — use the TZ-aware key. `d` is the UTC instant of
    // local-midnight on day-N-ago in Europe/Rome. Under CEST that
    // instant's UTC date is the PREVIOUS day, so the old
    // `d.toISOString().slice(0,10)` returned the wrong calendar
    // date and the resulting map lookup missed every bucket. The
    // helper produces the local-tz calendar date that aligns
    // with sparkMap + sparkEstimateMap keys.
    const iso = isoLocalDay(d)
    // GS-RT.8 — combine confirmed + estimated for each day.
    sparkline.push({
      date: iso,
      valueCents: (sparkMap.get(iso) ?? 0) + (sparkEstimateMap.get(iso) ?? 0),
    })
  }

  // ── Open Orders aggregation ─────────────────────────────────
  // Cluster the same way the /orders status tabs do (OX.2):
  //   FBM unshipped → PROCESSING/ON_HOLD on FBM rows
  //   FBM pending   → PENDING/AWAITING_PAYMENT on FBM rows
  //   FBA pending   → PENDING/AWAITING_PAYMENT on FBA rows
  const openOrdersGroups = await prisma.order.groupBy({
    by: ['marketplace', 'fulfillmentMethod', 'status'],
    where: {
      deletedAt: null,
      status: {
        in: ['PROCESSING', 'ON_HOLD', 'PENDING', 'AWAITING_PAYMENT'] as any,
      },
      ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
    },
    _count: { _all: true },
  })

  type MarketStats = {
    marketplace: string
    region: string
    fbmUnshipped: number
    fbmPending: number
    fbaPending: number
  }
  const openByMarket = new Map<string, MarketStats>()
  const ensureMarket = (mkt: string): MarketStats => {
    let existing = openByMarket.get(mkt)
    if (!existing) {
      existing = {
        marketplace: mkt,
        region: REGION[mkt] ?? 'Other',
        fbmUnshipped: 0,
        fbmPending: 0,
        fbaPending: 0,
      }
      openByMarket.set(mkt, existing)
    }
    return existing
  }
  let openTotal = 0
  let totalFbmUnshipped = 0
  let totalFbmPending = 0
  let totalFbaPending = 0
  for (const g of openOrdersGroups) {
    const mkt = g.marketplace ?? 'UNKNOWN'
    const m = ensureMarket(mkt)
    const count = g._count?._all ?? 0
    const isFBA = g.fulfillmentMethod === 'FBA'
    const isFBM = g.fulfillmentMethod === 'FBM'
    const isUnshipped = g.status === 'PROCESSING' || g.status === 'ON_HOLD'
    const isPending = g.status === 'PENDING' || g.status === 'AWAITING_PAYMENT'
    if (isFBM && isUnshipped) { m.fbmUnshipped += count; totalFbmUnshipped += count }
    if (isFBM && isPending) { m.fbmPending += count; totalFbmPending += count }
    if (isFBA && isPending) { m.fbaPending += count; totalFbaPending += count }
    openTotal += count
  }

  // ── Sales rollup per marketplace (EUR-normalized for the
  // tile total; per-row preserves native currency). ─────────
  type SalesRow = {
    marketplace: string
    region: string
    currency: string
    valueCents: number
    units: number
    orderCount: number
    // GS-RT.1 — per-marketplace pending estimate, attached
    // after the pendingInWindow scan below. Lets the UI render
    // FR (or any market with PENDING+€0 orders) with the same
    // estimated total + `*` annotation the tile headline shows.
    // Optional in the response so old clients still render.
    pendingEstimateCents?: number
    pendingCount?: number
    // DA-RT.8b — populated only when baseCurrency=EUR_EQUIV AND
    // the row's currency has a rate in the daily FX snapshot.
    // The tile total now includes this; the row UI can show
    // "€X.XX (£Y.YY)" without re-computing on the client.
    eurEquivCents?: number
  }
  const salesRows: SalesRow[] = []
  let salesTotalCents = 0
  let salesUnitsTotal = 0
  // MS.3 — non-EUR currency rollup. Snapshot headline stays
  // EUR-only by default (mixing currencies in one figure is
  // misleading), but we surface a sibling chip per additional
  // currency so UK GBP / SE SEK / PL PLN / TR TRY orders don't
  // silently disappear.
  // DA-RT.8b — when baseCurrency=EUR_EQUIV, pre-fetch FX rates
  // for the distinct non-EUR currencies + fold each currency's
  // sum into salesTotalCents via the rate. Surfaces fxMissing
  // count so the UI can warn when a currency has no rate yet.
  const distinctNonEurCurrencies = Array.from(
    new Set(
      salesByMarketplace
        .map((g) => g.currencyCode ?? 'EUR')
        .filter((c) => c !== 'EUR'),
    ),
  )
  let fxLookup: { rates: Map<string, number>; asOf: Date } | null = null
  if (convertNonEur && distinctNonEurCurrencies.length > 0) {
    try {
      const { buildFxLookup } = await import(
        '../revenue/compute.js'
      )
      fxLookup = await buildFxLookup(distinctNonEurCurrencies)
    } catch (fxErr) {
      log.warn(
        { err: fxErr },
        '[dashboard/global-snapshot] DA-RT.8b FX lookup failed; falling back to EUR-only headline',
      )
    }
  }
  let fxMissingCount = 0
  const fxMissingCurrencies = new Set<string>()
  let fxConvertedCents = 0

  const additionalByCurrency = new Map<string, { valueCents: number; units: number; orderCount: number }>()
  for (const g of salesByMarketplace) {
    const mkt = g.marketplace ?? 'UNKNOWN'
    const cents = Math.round(Number(g._sum?.totalPrice ?? 0) * 100)
    const cur = g.currencyCode ?? 'EUR'
    const units = unitsByMarketplace.get(mkt) ?? 0
    // DA-RT.8b — surface per-row EUR-equivalent so the table can
    // render a single number even for non-EUR markets. Optional;
    // legacy clients ignore.
    let rowEurEquivCents: number | undefined
    if (convertNonEur && cur !== 'EUR') {
      const rate = fxLookup?.rates.get(cur)
      if (rate != null && rate > 0) {
        rowEurEquivCents = Math.round(cents * rate)
      }
    }
    salesRows.push({
      marketplace: mkt,
      region: REGION[mkt] ?? 'Other',
      currency: cur,
      valueCents: cents,
      units,
      orderCount: g._count?._all ?? 0,
      ...(rowEurEquivCents != null ? { eurEquivCents: rowEurEquivCents } : {}),
    })
    salesUnitsTotal += units
    if (cur === 'EUR') {
      salesTotalCents += cents
    } else if (convertNonEur && rowEurEquivCents != null) {
      // DA-RT.8b — fold into headline as EUR-equivalent. Chip
      // still rendered for transparency (native value visible).
      salesTotalCents += rowEurEquivCents
      fxConvertedCents += rowEurEquivCents
      // Also keep in additionalByCurrency for the chip render
      // — operator sees native + EUR-equivalent side by side.
      const existing = additionalByCurrency.get(cur) ?? { valueCents: 0, units: 0, orderCount: 0 }
      existing.valueCents += cents
      existing.units += units
      existing.orderCount += g._count?._all ?? 0
      additionalByCurrency.set(cur, existing)
    } else {
      // Either convertNonEur was off OR the FX rate was missing.
      // Surface as chip + flag missing-rate cases so UI can warn.
      if (convertNonEur) {
        fxMissingCount += g._count?._all ?? 0
        fxMissingCurrencies.add(cur)
      }
      const existing = additionalByCurrency.get(cur) ?? { valueCents: 0, units: 0, orderCount: 0 }
      existing.valueCents += cents
      existing.units += units
      existing.orderCount += g._count?._all ?? 0
      additionalByCurrency.set(cur, existing)
    }
  }
  const additionalCurrencies = [...additionalByCurrency.entries()].map(
    ([currency, v]) => ({ currency, ...v }),
  )

  // GS.7 — same-day-last-week comparison for the Sales tile.
  // Useful at-a-glance signal ("Today vs. same day last week").
  // Only computed when `period` resolves to a single calendar
  // day (today / yesterday) so the delta is meaningful.
  let comparePrevValueCents: number | null = null
  if (period === 'today' || period === 'yesterday') {
    const shiftMs = 7 * 24 * 60 * 60 * 1000
    const prevFrom = new Date(from.getTime() - shiftMs)
    const prevTo = new Date(to.getTime() - shiftMs)
    const prev = await prisma.order.aggregate({
      where: {
        deletedAt: null,
        // MS.6 — gross sales semantic
        purchaseDate: { gte: prevFrom, lt: prevTo },
        currencyCode: 'EUR',
        ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
      },
      _sum: { totalPrice: true },
    })
    comparePrevValueCents = Math.round(Number(prev._sum?.totalPrice ?? 0) * 100)

    // GS-RT.8 — fold the prev-day estimate into comparePrev so
    // the "vs same day last week" delta compares like-for-like
    // bases. Without this, last week's confirmed-only number is
    // compared against this week's confirmed+estimated number,
    // biasing the delta toward "up" purely from when we
    // estimate. We reuse the sparkEstimateMap (already covers
    // sparkStart..todayStart which includes prev windows up to
    // 7 days back) so no extra DB roundtrip. Falls back to 0
    // when the previous window is older than 7 days (rare for
    // today/yesterday periods).
    if (sparkEstimateMap.size > 0) {
      let prevEstCents = 0
      for (const [iso, cents] of sparkEstimateMap.entries()) {
        const isoMs = new Date(`${iso}T00:00:00Z`).getTime()
        if (isoMs >= prevFrom.getTime() && isoMs < prevTo.getTime()) {
          prevEstCents += cents
        }
      }
      comparePrevValueCents += prevEstCents
    }
  }
  const compareDeltaPct =
    comparePrevValueCents != null && comparePrevValueCents > 0
      ? ((salesTotalCents - comparePrevValueCents) / comparePrevValueCents) * 100
      : null

  // SA.1 — pending-order awareness. Even with SA.2's eager
  // getOrder, Amazon occasionally withholds OrderTotal for
  // truly-new PENDING orders. The Sales total exists from
  // confirmed (non-PENDING+€0) rows; we surface the pending
  // count so operators see why their tile total may lag Amazon
  // Seller Central by a few orders for a few minutes.
  //
  // GS-RT.6 — broadened scope. The 2026-05-23 audit found 13
  // SHIPPED+€0 orders (months old) where Amazon's getOrder ALSO
  // withholds OrderTotal — see GS-RT.7 for the real-data fix via
  // OrderItem.price summation. This estimate path is the UI
  // safety net while those backfills run: surface ANY €0 order
  // with units (not just PENDING) so the per-marketplace row +
  // headline don't lie. Once GS-RT.7 backfill repairs the row's
  // totalPrice, it drops out of this query naturally (no longer
  // matches totalPrice=0).
  const pendingInWindow = await prisma.order.findMany({
    where: {
      deletedAt: null,
      channel: 'AMAZON',
      totalPrice: 0,
      purchaseDate: { gte: from, lt: to },
      // GS-RT.6 — exclude CANCELLED (their €0 is correct, no
      // estimate needed). PENDING + SHIPPED + every other status
      // with €0 + units → ALL flow through estimate.
      status: { notIn: ['CANCELLED'] as any },
      items: { some: { quantity: { gt: 0 } } },
      ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
    },
    select: {
      id: true,
      purchaseDate: true,
      marketplace: true,
      status: true,
      items: {
        select: {
          quantity: true,
          productId: true,
        },
      },
    },
    orderBy: { purchaseDate: 'asc' },
    take: 100,
  })
  // GS-RT.6 — keep pendingCount semantics aligned with the
  // original SA.1 tile copy: count of orders Amazon-withheld
  // OrderTotal on. PENDING-only is the typical case; broader
  // €0+units captures the long-tail too.
  const pendingCount = pendingInWindow.length
  const oldestPendingAt = pendingInWindow[0]?.purchaseDate?.toISOString() ?? null

  // SR.1 — estimate the value of PENDING+€0 orders so the
  // headline matches Amazon Seller Central's UI. Amazon withholds
  // OrderTotal from SP-API for PENDING, but their internal UI
  // knows the price. We approximate by looking up each item's
  // ChannelListing price (per channel+marketplace) and summing
  // qty × price. Falls back to Product.basePrice when no
  // ChannelListing row exists for the marketplace.
  let pendingEstimateCents = 0
  const pendingEstimateBreakdown: Array<{ orderId: string; cents: number }> = []
  // GS-RT.1 — per-marketplace rollups for the byMarketplace UI.
  // Populated alongside the global accumulator in the same loop
  // below; emitted on each salesRows entry so the table + the
  // headline use the same source of truth and the `*` annotation
  // surfaces in every row that holds an estimate, not just the
  // tile total.
  const pendingEstimateByMarketplace = new Map<string, number>()
  const pendingCountByMarketplace = new Map<string, number>()
  if (pendingInWindow.length > 0) {
    const productIds = Array.from(
      new Set(
        pendingInWindow.flatMap((o) =>
          o.items.map((i) => i.productId).filter((p): p is string => !!p),
        ),
      ),
    )
    if (productIds.length > 0) {
      const listings = await prisma.channelListing.findMany({
        where: {
          productId: { in: productIds },
          channel: 'AMAZON',
          marketplace: { in: ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'PL', 'SE', 'BE', 'IE', 'TR', 'AE', 'SA', 'US', 'CA', 'JP'] },
        },
        select: { productId: true, marketplace: true, price: true, salePrice: true },
      })
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, basePrice: true },
      })
      const basePriceByProduct = new Map(products.map((p) => [p.id, Number(p.basePrice)]))
      const priceByPair = new Map<string, number>()
      for (const l of listings) {
        const eff = l.salePrice != null ? Number(l.salePrice) : l.price != null ? Number(l.price) : null
        if (eff != null && eff > 0) {
          priceByPair.set(`${l.productId}|${l.marketplace}`, eff)
        }
      }
      for (const o of pendingInWindow) {
        let orderCents = 0
        for (const it of o.items) {
          if (!it.productId) continue
          const pairKey = `${it.productId}|${o.marketplace ?? 'DEFAULT'}`
          const unit = priceByPair.get(pairKey) ?? basePriceByProduct.get(it.productId) ?? 0
          orderCents += Math.round(unit * 100) * it.quantity
        }
        pendingEstimateCents += orderCents
        if (orderCents > 0) pendingEstimateBreakdown.push({ orderId: o.id, cents: orderCents })
        // GS-RT.1 — per-marketplace pending estimate. Previously
        // the estimate lived as a single global number that the
        // headline used + the table ignored, so the FR row (or
        // any market with a PENDING order) showed €0 while the
        // headline showed €651.99* — visible split-brain. Now we
        // accumulate per-marketplace so the row + the headline
        // share the same number, with the same `*` annotation
        // marking it as estimated.
        const mkt = o.marketplace ?? 'UNKNOWN'
        pendingEstimateByMarketplace.set(
          mkt,
          (pendingEstimateByMarketplace.get(mkt) ?? 0) + orderCents,
        )
        pendingCountByMarketplace.set(
          mkt,
          (pendingCountByMarketplace.get(mkt) ?? 0) + 1,
        )
      }
    }
  }

  // GS-RT.1 — fold per-marketplace pending estimate into each
  // SalesRow now that both passes (orders groupBy + pendingInWindow)
  // have completed. For a marketplace that has ONLY a PENDING
  // order (e.g. France yesterday: 1 unit at €0), the row already
  // exists from salesByMarketplace because we DON'T exclude
  // PENDING from the gross-sales semantic — so we always have
  // a row to attach the estimate to. Only attach when there's
  // genuinely a non-zero estimate to share with the UI.
  for (const row of salesRows) {
    const est = pendingEstimateByMarketplace.get(row.marketplace) ?? 0
    const cnt = pendingCountByMarketplace.get(row.marketplace) ?? 0
    if (est > 0) row.pendingEstimateCents = est
    if (cnt > 0) row.pendingCount = cnt
  }

  // SA.3 — distinct list of marketplaces with order activity in
  // the rolling 90 days, so the UI dropdown can show only what
  // the seller actually sells on (not the full 17-marketplace map).
  const ninetyDaysAgo = new Date(todayStart.getTime() - 90 * 24 * 60 * 60 * 1000)
  const activeMktRows = await prisma.order.findMany({
    where: {
      deletedAt: null,
      marketplace: { not: null },
      purchaseDate: { gte: ninetyDaysAgo },
    },
    distinct: ['marketplace'],
    select: { marketplace: true },
  })
  const availableMarketplaces = activeMktRows
    .map((r) => r.marketplace)
    .filter((m): m is string => !!m)
    .sort()

  return {
    period: {
      key: period,
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: OPERATOR_TIMEZONE,
    },
    marketplace: marketplaceFilter,
    availableMarketplaces,
    sales: {
      total: {
        valueCents: salesTotalCents,
        currency: 'EUR',
        units: salesUnitsTotal,
        // GS.7 — vs. same day last week (only for single-day periods)
        comparePrevValueCents,
        compareDeltaPct,
        compareLabel: comparePrevValueCents != null ? 'vs. same day last week' : null,
        // SA.1 — Amazon-withheld PENDING orders in the window
        pending: {
          count: pendingCount,
          oldestAt: oldestPendingAt,
          // SR.1 — estimated value of those PENDING orders from
          // ChannelListing price (falls back to Product.basePrice).
          // Lets the UI render Amazon-style combined headline.
          estimateCents: pendingEstimateCents,
        },
        // MS.3 — orders ingested in currencies other than EUR.
        // Native amounts surface as chips beside the tile total
        // for transparency. When DA-RT.8b convertNonEur is on,
        // they're ALSO folded into the headline as EUR-equivalent
        // (via fx.convertedCents) so the operator sees a single
        // unified revenue number.
        additionalCurrencies,
        // DA-RT.8b — currency-conversion telemetry. When
        // baseCurrency=EUR_EQUIV, this carries the metadata UI
        // needs to render "Total: €X.XX (incl. €Y.YY converted
        // from N non-EUR markets · M orders awaiting FX rate)".
        fx: {
          basis: baseCurrency,
          convertedCents: convertNonEur ? fxConvertedCents : 0,
          fxMissingCount: convertNonEur ? fxMissingCount : 0,
          fxMissingCurrencies: convertNonEur
            ? [...fxMissingCurrencies].sort()
            : [],
          rateAsOf: fxLookup?.asOf?.toISOString() ?? null,
        },
      },
      sparkline,
      byMarketplace: salesRows.sort((a, b) => b.valueCents - a.valueCents),
    },
    openOrders: {
      total: openTotal,
      fbmUnshipped: totalFbmUnshipped,
      fbmPending: totalFbmPending,
      fbaPending: totalFbaPending,
      byMarketplace: [...openByMarket.values()].sort((a, b) => {
        const sumA = a.fbmUnshipped + a.fbmPending + a.fbaPending
        const sumB = b.fbmUnshipped + b.fbmPending + b.fbaPending
        return sumB - sumA
      }),
    },
    lastUpdatedAt: new Date().toISOString(),
  }
}

/**
 * MS.4 — per Amazon EU marketplace: the last order, orders in the last 24 hours and 7 days, and a status (active in
 * the last hour, quiet in the last day, silent beyond, never).
 */
export async function marketHealth() {
  // MS.5 — list ALL Amazon EU marketplaces from the Marketplace
  // table, including inactive ones, so the admin UI can show
  // toggles. Active=true rows are what the cron sweeps.
  const dbMarkets = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', region: 'EU', marketplaceId: { not: null } },
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      marketplaceId: true,
      currency: true,
      isActive: true,
      isParticipating: true,
    },
  })
  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000)
  const yesterday = new Date(now - 24 * 60 * 60 * 1000)
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000)

  // One query per axis is cheaper than per-market loops.
  const [lastByMarket, last24hByMarket, last7dByMarket] = await Promise.all([
    prisma.order.groupBy({
      by: ['marketplace'],
      where: { channel: 'AMAZON', deletedAt: null },
      _max: { purchaseDate: true },
    }),
    prisma.order.groupBy({
      by: ['marketplace'],
      where: { channel: 'AMAZON', deletedAt: null, purchaseDate: { gte: yesterday } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['marketplace'],
      where: { channel: 'AMAZON', deletedAt: null, purchaseDate: { gte: sevenDaysAgo } },
      _count: { _all: true },
    }),
  ])

  const lastMap = new Map(lastByMarket.map((r) => [r.marketplace, r._max.purchaseDate]))
  const c24Map = new Map(last24hByMarket.map((r) => [r.marketplace, r._count._all]))
  const c7Map = new Map(last7dByMarket.map((r) => [r.marketplace, r._count._all]))

  const markets = dbMarkets.map((m) => {
    const lastAt = lastMap.get(m.code) ?? null
    const ordersLast24h = c24Map.get(m.code) ?? 0
    const ordersLast7d = c7Map.get(m.code) ?? 0
    const seconds = lastAt ? Math.floor((now - lastAt.getTime()) / 1000) : null
    let status: 'active' | 'quiet' | 'silent' | 'never'
    if (!lastAt) status = 'never'
    else if (lastAt.getTime() >= oneHourAgo.getTime()) status = 'active'
    else if (lastAt.getTime() >= yesterday.getTime()) status = 'quiet'
    else status = 'silent'
    return {
      id: m.id,
      marketplaceId: m.marketplaceId!,
      code: m.code,
      name: m.name,
      currency: m.currency,
      isActive: m.isActive,
      isParticipating: m.isParticipating,
      lastOrderAt: lastAt?.toISOString() ?? null,
      ordersLast24h,
      ordersLast7d,
      secondsSinceLastOrder: seconds,
      status,
    }
  })
  const configuredIds = dbMarkets.filter((m) => m.isActive).map((m) => m.marketplaceId!)

  // Aggregate rollup so the UI can show "11 configured, 4 active,
  // 7 quiet, 0 silent" without re-aggregating client-side.
  const rollup = markets.reduce(
    (acc, m) => {
      acc[m.status] = (acc[m.status] ?? 0) + 1
      return acc
    },
    { active: 0, quiet: 0, silent: 0, never: 0 } as Record<string, number>,
  )

  return {
    configured: configuredIds.length,
    rollup,
    markets,
    checkedAt: new Date().toISOString(),
  }
}
