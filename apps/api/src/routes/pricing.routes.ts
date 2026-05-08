/**
 * G.1 + G.2 — Pricing engine read + recompute endpoints.
 *
 *   GET  /api/pricing/explain?sku=&channel=&marketplace=&fulfillmentMethod=
 *        Returns the engine's resolution chain + final price + breakdown
 *        + reasoning. Used by the matrix UI's row-detail drawer.
 *
 *   GET  /api/pricing/matrix
 *        Reads PricingSnapshot for the matrix UI; supports filter, paginate.
 *
 *   POST /api/pricing/refresh-snapshots
 *        Body { skus?: string[] } — refresh specific SKUs or omit for all.
 *        Useful after manual data corrections; nightly cron handles the
 *        rest automatically.
 *
 *   POST /api/pricing/refresh-fx
 *        Pulls latest rates from frankfurter.app. Daily cron runs this
 *        too; manual trigger is a debugging convenience.
 */
import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { resolvePrice } from '../services/pricing-engine.service.js'
import {
  refreshSnapshotsForSkus,
  refreshAllSnapshots,
} from '../services/pricing-snapshot.service.js'
import { refreshFxRates } from '../services/fx-rate.service.js'
import {
  refreshFeeEstimates,
  refreshCompetitivePricing,
} from '../services/sp-api-pricing.service.js'
import { pushPriceUpdate } from '../services/pricing-outbound.service.js'
import { runPromotionScheduler } from '../services/promotion-scheduler.service.js'
import { Prisma } from '@prisma/client'

const pricingRoutes: FastifyPluginAsync = async (fastify) => {
  // B.1 + F.1.b — KPI strip on /pricing index. Single endpoint serves the
  // counts so the matrix UI can render the strip without firing parallel
  // requests. Each count is independent + cheap (indexed COUNTs /
  // single-row aggregates / one BuyBoxHistory aggregate over the last 7
  // days), so the endpoint stays well under p95 budget.
  fastify.get('/pricing/kpis', async (_request, reply) => {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const [
        driftCount,
        alertCount,
        salesCount,
        snapshotAgg,
        marginAtRiskCount,
        buyBoxAgg,
      ] = await Promise.all([
        // Drift: master cascade gone wrong (sync-drift-detection.job.ts logs
        // these as PRICE_MISMATCH SyncHealthLog rows).
        prisma.syncHealthLog.count({
          where: { conflictType: 'PRICE_MISMATCH', resolutionStatus: 'UNRESOLVED' },
        }),
        // Alerts: clamped / fallback / warnings on PricingSnapshot — same set
        // /pricing/alerts surfaces.
        prisma.pricingSnapshot.count({
          where: {
            OR: [
              { isClamped: true },
              { source: 'FALLBACK' },
              { warnings: { isEmpty: false } },
            ],
          },
        }),
        // Sales: RetailEventPriceAction in an active window. Engine sources
        // SCHEDULED_SALE from the materialized salePrice these rows produce.
        prisma.retailEventPriceAction.count({
          where: {
            isActive: true,
            event: {
              isActive: true,
              startDate: { lte: new Date() },
              endDate: { gte: new Date() },
            },
          },
        }),
        // Snapshot total + oldest computedAt → hours. With the A.5 hourly
        // cron a healthy state shows oldest_age_hours ≤ 1; >2 means cron
        // hasn't ticked recently and the matrix is stale.
        prisma.pricingSnapshot.aggregate({
          _count: { _all: true },
          _min: { computedAt: true },
        }),
        // Margin floor unenforceable — every "no cost price" warning hits
        // this. Useful to surface the "fix costs first" call-to-action.
        prisma.product.count({
          where: { isParent: false, costPrice: null, basePrice: { gt: 0 } },
        }),
        // F.1.b — Buy Box win rate over the last 7 days. count(*) FILTER
        // (WHERE isOurOffer=true) / count(*) — two parallel counts so the
        // ratio falls out at the API layer without a streaming aggregate.
        // Returns { observations, ourWins } so the frontend can render
        // the rate as text + the denominator as a hover hint.
        Promise.all([
          prisma.buyBoxHistory.count({
            where: { observedAt: { gte: sevenDaysAgo } },
          }),
          prisma.buyBoxHistory.count({
            where: { observedAt: { gte: sevenDaysAgo }, isOurOffer: true },
          }),
        ]).then(([observations, ourWins]) => ({ observations, ourWins })),
      ])

      const oldest = snapshotAgg._min.computedAt
      const snapshotAgeHours = oldest
        ? Math.max(0, (Date.now() - oldest.getTime()) / (60 * 60 * 1000))
        : null
      const buyBoxWinRatePct =
        buyBoxAgg.observations > 0
          ? Math.round((buyBoxAgg.ourWins / buyBoxAgg.observations) * 1000) / 10
          : null

      return {
        drift: driftCount,
        alerts: alertCount,
        salesActive: salesCount,
        snapshots: {
          total: snapshotAgg._count._all,
          oldestAgeHours: snapshotAgeHours,
        },
        marginAtRisk: marginAtRiskCount,
        buyBox: {
          winRatePct: buyBoxWinRatePct,
          observations: buyBoxAgg.observations,
          ourWins: buyBoxAgg.ourWins,
        },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/kpis] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/pricing/explain', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      if (!q.sku || !q.channel || !q.marketplace) {
        return reply.code(400).send({
          error: 'sku, channel, marketplace are all required',
        })
      }
      const fm =
        q.fulfillmentMethod === 'FBA' || q.fulfillmentMethod === 'FBM'
          ? q.fulfillmentMethod
          : null
      const result = await resolvePrice(prisma, {
        sku: q.sku,
        channel: q.channel.toUpperCase(),
        marketplace: q.marketplace.toUpperCase(),
        fulfillmentMethod: fm,
      })
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/explain] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.4.2 + B.2 + C.2 — Outlier alerts. Surfaces SKUs that need the user's
  // attention: clamped to a floor (margin / MAP), no master price, FX-stale,
  // master cascade drift (from SyncHealthLog), and low-margin rows (computed
  // post-fees + tax-adjusted from PricingSnapshot.breakdown).
  fastify.get('/pricing/alerts', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      // Configurable margin threshold. Default 10% — matches engine's
      // DEFAULT_MIN_MARGIN_PERCENT but here it's a SOFT alert (the engine
      // already enforces a HARD floor via clamping). Operator can ratchet
      // up to flag thinning margins before they hit the floor.
      const lowMarginThreshold = Math.max(
        0,
        Math.min(100, Number(q.lowMarginThreshold ?? '10')),
      )
      // Read all materialized snapshots — we need the breakdown JSON to
      // compute marginPct, not just the rows already failing other checks.
      // Cap at 5K to keep p95 latency bounded; expected catalog × markets
      // ≈ 19K eventually, so chunked aggregation will follow once needed.
      const snapshotWhere: Prisma.PricingSnapshotWhereInput = {}
      const [rows, driftLogs] = await Promise.all([
        prisma.pricingSnapshot.findMany({
          where: snapshotWhere,
          orderBy: [{ source: 'asc' }, { sku: 'asc' }],
          take: 5000,
        }),
        // B.2 — Drift rows from sync-drift-detection.job.ts. We pull the
        // last 24h of UNRESOLVED PRICE_MISMATCH conflicts; older rows
        // either got resolved or fell out of the dedupe window. Joining
        // through productId → sku keeps the row shape consistent with the
        // snapshot rows the UI already renders.
        prisma.syncHealthLog.findMany({
          where: {
            conflictType: 'PRICE_MISMATCH',
            resolutionStatus: 'UNRESOLVED',
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            id: true,
            channel: true,
            createdAt: true,
            productId: true,
            conflictData: true,
            errorMessage: true,
            product: { select: { sku: true } },
          },
        }),
      ])
      const buckets = {
        fallback: rows.filter((r) => r.source === 'FALLBACK'),
        clamped: rows.filter((r) => r.isClamped),
        warningsOnly: rows.filter(
          (r) => !r.isClamped && r.source !== 'FALLBACK' && r.warnings.length > 0,
        ),
      }

      // C.2 — Compute post-fee, tax-adjusted margin per snapshot. Skip
      // rows that have no cost basis (engine couldn't enforce the floor
      // anyway — they're caught by the warningsOnly bucket already).
      // marginPct = (taxNet - cost - fbaFee - referralFee) / taxNet × 100
      // where taxNet = grossPrice when tax-exclusive, else grossPrice / (1+vatRate/100).
      const lowMarginRows: Array<{
        id: string
        sku: string
        channel: string
        marketplace: string
        fulfillmentMethod: string | null
        computedPrice: string
        currency: string
        marginPct: number
        netProfit: number
      }> = []
      for (const r of rows) {
        const b = (r.breakdown ?? {}) as {
          effectiveCostBasis?: number | null
          fxRate?: number
          fbaFee?: number
          referralFee?: number
          vatRate?: number
          taxInclusive?: boolean
        }
        const cost = b.effectiveCostBasis ?? null
        const fxRate = b.fxRate ?? 1
        if (cost == null || cost <= 0) continue
        const grossPrice = Number(r.computedPrice)
        if (!Number.isFinite(grossPrice) || grossPrice <= 0) continue
        const vatRate = b.vatRate ?? 0
        const taxNet = b.taxInclusive
          ? grossPrice / (1 + vatRate / 100)
          : grossPrice
        const costInMp = cost * fxRate
        const fbaFee = b.fbaFee ?? 0
        const referralFee = b.referralFee ?? 0
        const netProfit = taxNet - costInMp - fbaFee - referralFee
        const marginPct = (netProfit / taxNet) * 100
        if (marginPct < lowMarginThreshold) {
          lowMarginRows.push({
            id: r.id,
            sku: r.sku,
            channel: r.channel,
            marketplace: r.marketplace,
            fulfillmentMethod: r.fulfillmentMethod,
            computedPrice: r.computedPrice.toString(),
            currency: r.currency,
            marginPct: Math.round(marginPct * 100) / 100,
            netProfit: Math.round(netProfit * 100) / 100,
          })
        }
      }
      // Sort lowest margin first — most urgent at the top.
      lowMarginRows.sort((a, b) => a.marginPct - b.marginPct)

      // The existing rows array previously was filtered server-side. With C.2
      // we read all snapshots so the margin compute can run; restrict the
      // returned `rows` array back to the original filter so the existing
      // table doesn't suddenly show every snapshot.
      const filteredRows = rows.filter(
        (r) => r.isClamped || r.source === 'FALLBACK' || r.warnings.length > 0,
      )

      // Shape drift rows so the client can render them in the same table
      // as snapshot rows, with a distinct severity. conflictData is shaped
      // by syncHealthService.logConflict as { local, remote } where local
      // carries the master value and remote carries the listing value.
      const driftRows = driftLogs.map((log) => {
        const cd = (log.conflictData ?? {}) as {
          local?: { value?: string }
          remote?: { value?: string; marketplace?: string }
        }
        return {
          id: `drift:${log.id}`,
          kind: 'DRIFT' as const,
          sku: log.product?.sku ?? '(no sku)',
          channel: log.channel,
          marketplace: cd.remote?.marketplace ?? '—',
          masterPrice: cd.local?.value ?? null,
          listingPrice: cd.remote?.value ?? null,
          message: log.errorMessage,
          createdAt: log.createdAt,
        }
      })

      return {
        total: filteredRows.length + driftRows.length + lowMarginRows.length,
        counts: {
          fallback: buckets.fallback.length,
          clamped: buckets.clamped.length,
          warnings: buckets.warningsOnly.length,
          drift: driftRows.length,
          lowMargin: lowMarginRows.length,
        },
        thresholds: {
          lowMarginPct: lowMarginThreshold,
        },
        rows: filteredRows,
        driftRows,
        lowMarginRows,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/alerts] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/pricing/matrix', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const channel = q.channel?.toUpperCase()
      const marketplace = q.marketplace?.toUpperCase()
      const sourceFilter = q.source
      const isClampedFilter = q.isClamped === 'true' ? true : q.isClamped === 'false' ? false : undefined
      const search = q.search?.trim()
      const page = Math.max(0, parseInt(q.page ?? '0', 10) || 0)
      const limit = Math.min(500, Math.max(1, parseInt(q.limit ?? '50', 10) || 50))

      const where: any = {}
      if (channel) where.channel = channel
      if (marketplace) where.marketplace = marketplace
      if (sourceFilter) where.source = sourceFilter
      if (isClampedFilter !== undefined) where.isClamped = isClampedFilter
      if (search) where.sku = { contains: search, mode: 'insensitive' }

      const [rows, total] = await Promise.all([
        prisma.pricingSnapshot.findMany({
          where,
          orderBy: [{ sku: 'asc' }, { channel: 'asc' }, { marketplace: 'asc' }],
          skip: page * limit,
          take: limit,
        }),
        prisma.pricingSnapshot.count({ where }),
      ])

      return { rows, total, page, limit }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/matrix] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/pricing/refresh-snapshots', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { skus?: string[] }
      const result = body.skus && body.skus.length > 0
        ? await refreshSnapshotsForSkus(prisma, body.skus)
        : await refreshAllSnapshots(prisma)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-snapshots] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/pricing/refresh-fx', async (_request, reply) => {
    try {
      const result = await refreshFxRates(prisma)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-fx] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.3.1 — Manual fee-estimate refresh per marketplace.
  fastify.post('/pricing/refresh-fees', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { marketplace?: string }
      if (!body.marketplace) {
        return reply.code(400).send({ error: 'marketplace required (e.g. "IT")' })
      }
      const result = await refreshFeeEstimates(prisma, body.marketplace)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-fees] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.5.2 — Manual promotion scheduler tick (enter/exit + snapshot refresh).
  fastify.post('/pricing/run-promotions', async (_request, reply) => {
    try {
      const result = await runPromotionScheduler(prisma)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/run-promotions] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // E.1 — Promotion calendar surface. Lists RetailEvent rows with their
  // RetailEventPriceAction children so the operator can see "what's active,
  // what's queued, what just ended" without firing the scheduler manually.
  // Bucket boundaries match the scheduler's own ENTER/EXIT logic
  // (promotion-scheduler.service.ts:35-36): now ± 12h.
  fastify.get('/pricing/promotions', async (_request, reply) => {
    try {
      const now = new Date()
      const events = await prisma.retailEvent.findMany({
        orderBy: [{ startDate: 'asc' }],
        include: {
          priceActions: {
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      const buckets = {
        active: [] as typeof events,
        upcoming: [] as typeof events,
        ended: [] as typeof events,
      }
      for (const e of events) {
        if (e.startDate <= now && e.endDate >= now) buckets.active.push(e)
        else if (e.startDate > now) buckets.upcoming.push(e)
        else buckets.ended.push(e)
      }
      return {
        counts: {
          active: buckets.active.length,
          upcoming: buckets.upcoming.length,
          ended: buckets.ended.length,
          total: events.length,
        },
        active: buckets.active,
        // Cap upcoming at next 25 — calendar view fits ~3 months ahead
        // without overwhelming the operator.
        upcoming: buckets.upcoming.slice(0, 25),
        // Last 25 ended for "did the lift land" lookback.
        ended: buckets.ended.slice(-25).reverse(),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/promotions] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.5.1 — Push the latest snapshot price to the marketplace API.
  fastify.post('/pricing/push', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        sku?: string
        channel?: string
        marketplace?: string
        fulfillmentMethod?: 'FBA' | 'FBM'
      }
      if (!body.sku || !body.channel || !body.marketplace) {
        return reply
          .code(400)
          .send({ error: 'sku, channel, marketplace are all required' })
      }
      const result = await pushPriceUpdate(prisma, {
        sku: body.sku,
        channel: body.channel,
        marketplace: body.marketplace,
        fulfillmentMethod: body.fulfillmentMethod ?? null,
      })
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/push] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.6 — Bulk price override: set/adjust/clear priceOverride on ChannelListings
  // matched by PricingSnapshot ids, then refresh those SKUs' snapshots.
  fastify.post('/pricing/bulk-override', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        snapshotIds?: string[]
        mode?: 'SET_FIXED' | 'SET_PERCENT_DISCOUNT' | 'CLEAR'
        value?: number
      }
      if (!body.snapshotIds?.length) {
        return reply.code(400).send({ error: 'snapshotIds required' })
      }
      if (!body.mode || !['SET_FIXED', 'SET_PERCENT_DISCOUNT', 'CLEAR'].includes(body.mode)) {
        return reply.code(400).send({ error: 'mode must be SET_FIXED | SET_PERCENT_DISCOUNT | CLEAR' })
      }
      if (body.mode !== 'CLEAR' && (body.value == null || Number.isNaN(Number(body.value)))) {
        return reply.code(400).send({ error: 'value required for SET_FIXED and SET_PERCENT_DISCOUNT' })
      }
      if (body.mode === 'SET_PERCENT_DISCOUNT') {
        const pct = Number(body.value)
        if (pct < 0 || pct >= 100) {
          return reply.code(400).send({ error: 'value must be 0–99.99 for SET_PERCENT_DISCOUNT' })
        }
      }

      const snapshots = await prisma.pricingSnapshot.findMany({
        where: { id: { in: body.snapshotIds } },
      })

      const skus = [...new Set(snapshots.map((s) => s.sku))]
      const [variants, products] = await Promise.all([
        prisma.productVariation.findMany({
          where: { sku: { in: skus } },
          select: { sku: true, productId: true },
        }),
        prisma.product.findMany({
          where: { sku: { in: skus } },
          select: { sku: true, id: true },
        }),
      ])
      const productIdBySku = new Map<string, string>()
      for (const v of variants) productIdBySku.set(v.sku, v.productId)
      for (const p of products) productIdBySku.set(p.sku, p.id)

      let updated = 0
      const skusTouched = new Set<string>()

      // A.4 — Audit-trail reason describes the operation. The drawer copy
      // claims bulk-override "Logs to ChannelListingOverride for audit"; this
      // makes that true. The Amazon push path (pricing-outbound.service.ts:178)
      // already writes ChannelListingOverride rows for fieldName='price'; we
      // mirror that convention.
      const reasonForMode =
        body.mode === 'CLEAR'
          ? 'bulk-override CLEAR'
          : body.mode === 'SET_FIXED'
          ? `bulk-override SET_FIXED ${Number(body.value).toFixed(2)}`
          : `bulk-override SET_PERCENT_DISCOUNT ${body.value}%`

      for (const snap of snapshots) {
        const productId = productIdBySku.get(snap.sku)
        if (!productId) continue
        // Read priceOverride alongside id so we can capture the before value
        // for the audit row.
        const listing = await prisma.channelListing.findFirst({
          where: { productId, channel: snap.channel, marketplace: snap.marketplace },
          select: { id: true, priceOverride: true },
        })
        if (!listing) continue

        let newOverride: string | null
        if (body.mode === 'CLEAR') {
          newOverride = null
        } else if (body.mode === 'SET_FIXED') {
          newOverride = Number(body.value).toFixed(2)
        } else {
          // SET_PERCENT_DISCOUNT — apply % off the current snapshot price
          const base = Number(snap.computedPrice)
          if (base <= 0) continue
          newOverride = (base * (1 - Number(body.value) / 100)).toFixed(2)
        }

        const previousOverride =
          listing.priceOverride != null ? listing.priceOverride.toString() : null

        // No-op short-circuit. Repeating an identical bulk apply (e.g. user
        // double-clicked) shouldn't generate audit noise.
        if (previousOverride === newOverride) continue

        // Atomic: ChannelListing update + audit row land together. If the
        // audit write fails the override write rolls back, keeping the two
        // sources of truth aligned.
        await prisma.$transaction([
          prisma.channelListing.update({
            where: { id: listing.id },
            data: {
              priceOverride: newOverride,
              lastOverrideAt: new Date(),
              lastOverrideBy: 'bulk-override',
            },
          }),
          prisma.channelListingOverride.create({
            data: {
              channelListingId: listing.id,
              fieldName: 'price',
              previousValue: previousOverride,
              newValue: newOverride,
              reason: reasonForMode,
              changedBy: 'bulk-override',
            },
          }),
        ])
        updated++
        skusTouched.add(snap.sku)
      }

      let snapshotsRefreshed = 0
      if (skusTouched.size > 0) {
        const result = await refreshSnapshotsForSkus(prisma, [...skusTouched])
        snapshotsRefreshed = result.rowsRefreshed
      }

      return { ok: true, updated, snapshotsRefreshed }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/bulk-override] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // G.3.2 — Manual competitive-pricing refresh per marketplace.
  fastify.post('/pricing/refresh-competitive', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { marketplace?: string }
      if (!body.marketplace) {
        return reply.code(400).send({ error: 'marketplace required (e.g. "IT")' })
      }
      const result = await refreshCompetitivePricing(prisma, body.marketplace)
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/refresh-competitive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })
}

export default pricingRoutes
