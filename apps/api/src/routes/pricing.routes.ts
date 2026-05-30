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
import { priceChangeData } from '../services/price-history.service.js'
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

  // P.A — Hierarchy-aware matrix endpoint.
  //
  //   ?hierarchy=parents              → one row per parent product, with
  //                                     aggregated metrics across every
  //                                     snapshot underneath. Paginated by
  //                                     parent, not by snapshot.
  //   ?hierarchy=children&parentId=X  → one row per variant SKU of parent
  //                                     X, with the "primary channel"
  //                                     snapshot data inline plus a
  //                                     channelChips[] array describing
  //                                     every other channel for the same
  //                                     SKU. Primary channel defaults to
  //                                     Amazon IT FBA (Xavia primary) and
  //                                     is overridable via the
  //                                     ?primaryChannel / ?primaryMarketplace
  //                                     / ?primaryFulfillmentMethod query
  //                                     params.
  //   ?hierarchy=flat (or omitted)    → flat snapshots, enriched with
  //                                     productId / parentId / name /
  //                                     thumbnailUrl / amazonAsin so the
  //                                     existing matrix UI can render
  //                                     identity cells without a second
  //                                     round-trip. Back-compat default.
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
      const hierarchy = (q.hierarchy ?? 'flat').toLowerCase() as 'flat' | 'parents' | 'children'
      const parentIdFilter = q.parentId?.trim() || undefined
      const primaryChannel = (q.primaryChannel ?? 'AMAZON').toUpperCase()
      const primaryMarketplace = (q.primaryMarketplace ?? 'AMAZON_IT').toUpperCase()
      const primaryFulfillmentMethod = (q.primaryFulfillmentMethod ?? 'FBA').toUpperCase()

      const snapshotWhere: any = {}
      if (channel) snapshotWhere.channel = channel
      if (marketplace) snapshotWhere.marketplace = marketplace
      if (sourceFilter) snapshotWhere.source = sourceFilter
      if (isClampedFilter !== undefined) snapshotWhere.isClamped = isClampedFilter
      if (search) snapshotWhere.sku = { contains: search, mode: 'insensitive' }

      // ── Mode: parents ─────────────────────────────────────────────────
      if (hierarchy === 'parents') {
        // Step 1: pull the SKU universe from filtered snapshots.
        const allSkus = await prisma.pricingSnapshot
          .findMany({ where: snapshotWhere, select: { sku: true }, distinct: ['sku'] })
          .then((rows) => rows.map((r) => r.sku))

        if (allSkus.length === 0) {
          return { rows: [], total: 0, page, limit, hierarchy: 'parents' as const }
        }

        // Step 2: resolve every snapshot SKU to its owning Product id.
        // Variation.sku → Variation.productId (the parent Product), and
        // Product.sku → Product.id covers both standalone products and
        // self-ref parents whose own SKU has a snapshot.
        const [variants, products] = await Promise.all([
          prisma.productVariation.findMany({
            where: { sku: { in: allSkus } },
            select: { sku: true, productId: true },
          }),
          prisma.product.findMany({
            where: { sku: { in: allSkus } },
            select: { sku: true, id: true, parentId: true },
          }),
        ])
        const productIdBySku = new Map<string, string>()
        for (const v of variants) productIdBySku.set(v.sku, v.productId)
        for (const p of products) productIdBySku.set(p.sku, p.id)

        // Step 3: roll each productId up to the *root* parent so an
        // operator never sees the same variant tree split across two rows.
        const allProductIds = [...new Set(productIdBySku.values())]
        const productsForRollup = await prisma.product.findMany({
          where: { id: { in: allProductIds } },
          select: { id: true, parentId: true },
        })
        const parentByProductId = new Map<string, string>()
        for (const p of productsForRollup) {
          parentByProductId.set(p.id, p.parentId ?? p.id)
        }

        const rootIdBySku = new Map<string, string>()
        for (const [sku, pid] of productIdBySku) {
          rootIdBySku.set(sku, parentByProductId.get(pid) ?? pid)
        }

        // Orphan snapshots: SKUs with no matching Product or Variation.
        // We surface these as their own pseudo-root keyed on the SKU so
        // the operator can still see + fix them.
        for (const sku of allSkus) {
          if (!rootIdBySku.has(sku)) rootIdBySku.set(sku, `orphan:${sku}`)
        }

        // Step 4: fetch root product details for display.
        const rootIds = [...new Set(rootIdBySku.values())].filter((id) => !id.startsWith('orphan:'))
        const rootProducts = rootIds.length === 0
          ? []
          : await prisma.product.findMany({
              where: { id: { in: rootIds } },
              select: {
                id: true,
                sku: true,
                name: true,
                amazonAsin: true,
                parentId: true,
                images: {
                  select: { url: true },
                  orderBy: { sortOrder: 'asc' },
                  take: 1,
                },
                _count: { select: { children: true, variations: true } },
              },
            })

        const productById = new Map(rootProducts.map((p) => [p.id, p] as const))

        // Step 5: aggregate snapshot counts per root.
        const filteredSnapshots = await prisma.pricingSnapshot.findMany({
          where: snapshotWhere,
          select: { sku: true, isClamped: true, source: true, warnings: true, computedPrice: true },
        })

        const aggByRoot = new Map<string, {
          snapshotCount: number
          clampedCount: number
          fallbackCount: number
          warningsCount: number
          priceSum: bigint
          priceCount: number
        }>()
        for (const s of filteredSnapshots) {
          const rootId = rootIdBySku.get(s.sku)
          if (!rootId) continue
          let agg = aggByRoot.get(rootId)
          if (!agg) {
            agg = { snapshotCount: 0, clampedCount: 0, fallbackCount: 0, warningsCount: 0, priceSum: 0n, priceCount: 0 }
            aggByRoot.set(rootId, agg)
          }
          agg.snapshotCount += 1
          if (s.isClamped) agg.clampedCount += 1
          if (s.source === 'FALLBACK') agg.fallbackCount += 1
          if (Array.isArray(s.warnings) && s.warnings.length > 0) agg.warningsCount += 1
          // Price is Decimal — convert via .toString() → BigInt cents.
          const priceStr = s.computedPrice?.toString?.() ?? '0'
          const priceCents = BigInt(Math.round(Number(priceStr) * 100))
          agg.priceSum += priceCents
          agg.priceCount += 1
        }

        const allRootEntries = [...rootIdBySku.values()]
        const uniqueRoots = [...new Set(allRootEntries)]

        // Step 6: build parent rows.
        const parentRows = uniqueRoots.map((rootId) => {
          const isOrphan = rootId.startsWith('orphan:')
          const orphanSku = isOrphan ? rootId.slice('orphan:'.length) : null
          const p = isOrphan ? null : productById.get(rootId)
          const agg = aggByRoot.get(rootId) ?? {
            snapshotCount: 0, clampedCount: 0, fallbackCount: 0, warningsCount: 0, priceSum: 0n, priceCount: 0,
          }
          const childCount = (p?._count.children ?? 0) + (p?._count.variations ?? 0)
          return {
            id: rootId,
            isParent: childCount > 0,
            parentId: null as string | null,
            childCount,
            productId: isOrphan ? null : rootId,
            sku: p?.sku ?? orphanSku ?? rootId,
            name: p?.name ?? orphanSku ?? rootId,
            amazonAsin: p?.amazonAsin ?? null,
            thumbnailUrl: p?.images[0]?.url ?? null,
            isOrphan,
            // Aggregates across all snapshots underneath.
            snapshotCount: agg.snapshotCount,
            clampedCount: agg.clampedCount,
            fallbackCount: agg.fallbackCount,
            warningsCount: agg.warningsCount,
            avgPriceCents: agg.priceCount === 0 ? null : Number(agg.priceSum / BigInt(agg.priceCount)),
          }
        })

        // Step 7: sort + paginate.
        // Orphans last so they don't push real products off the first
        // page; then alpha by name so operators can scan.
        parentRows.sort((a, b) => {
          if (a.isOrphan !== b.isOrphan) return a.isOrphan ? 1 : -1
          return a.name.localeCompare(b.name)
        })

        const total = parentRows.length
        const start = page * limit
        const sliced = parentRows.slice(start, start + limit)
        return { rows: sliced, total, page, limit, hierarchy: 'parents' as const }
      }

      // ── Mode: children ────────────────────────────────────────────────
      if (hierarchy === 'children' && parentIdFilter) {
        // The parentId here is a root Product id. Discover the SKU set
        // that belongs underneath: the root's own SKU (if it's a leaf-
        // standalone), its ProductVariation children's SKUs, and any
        // self-ref Product children's SKUs.
        const root = await prisma.product.findUnique({
          where: { id: parentIdFilter },
          select: { id: true, sku: true },
        })
        if (!root) {
          return { rows: [], total: 0, page, limit, hierarchy: 'children' as const }
        }
        const [variationChildren, selfRefChildren] = await Promise.all([
          prisma.productVariation.findMany({
            where: { productId: parentIdFilter },
            select: { id: true, sku: true, productId: true, variationAttributes: true, name: true, value: true, amazonAsin: true },
          }),
          prisma.product.findMany({
            where: { parentId: parentIdFilter },
            select: {
              id: true,
              sku: true,
              name: true,
              amazonAsin: true,
              images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
            },
          }),
        ])

        const variantSkus = new Set<string>()
        variantSkus.add(root.sku)
        for (const v of variationChildren) variantSkus.add(v.sku)
        for (const c of selfRefChildren) variantSkus.add(c.sku)

        // Combine the snapshot filter with the variant-sku scope.
        const childWhere: any = { ...snapshotWhere, sku: { in: [...variantSkus] } }
        if (search) {
          // Drop the search filter inside a parent drill — operator already
          // scoped to a specific product by clicking the chevron. Re-apply
          // search at the parent level only.
          delete childWhere.sku
          childWhere.sku = { in: [...variantSkus] }
        }

        const snapshots = await prisma.pricingSnapshot.findMany({
          where: childWhere,
          orderBy: [{ sku: 'asc' }, { channel: 'asc' }, { marketplace: 'asc' }],
        })

        // Group snapshots per variant SKU.
        const bySku = new Map<string, typeof snapshots>()
        for (const s of snapshots) {
          const arr = bySku.get(s.sku) ?? []
          arr.push(s)
          bySku.set(s.sku, arr)
        }

        // Build one row per variant SKU. Primary channel = the snapshot
        // matching the operator's primary preference; channel chips =
        // every other snapshot for the same SKU.
        const rows: any[] = []
        for (const variantSku of variantSkus) {
          const snaps = bySku.get(variantSku) ?? []
          if (snaps.length === 0) continue // variant has no snapshot under the current filters

          // Identity fallback chain: ProductVariation → self-ref Product → root.
          const variation = variationChildren.find((v) => v.sku === variantSku)
          const selfRefChild = selfRefChildren.find((c) => c.sku === variantSku)
          const isRootRow = variantSku === root.sku

          const primary = snaps.find((s) =>
            s.channel === primaryChannel &&
            s.marketplace === primaryMarketplace &&
            (s.fulfillmentMethod ?? 'FBM') === primaryFulfillmentMethod,
          ) ?? snaps[0]

          const channelChips = snaps
            .filter((s) => s.id !== primary.id)
            .map((s) => ({
              id: s.id,
              channel: s.channel,
              marketplace: s.marketplace,
              fulfillmentMethod: s.fulfillmentMethod,
              computedPrice: s.computedPrice,
              currency: s.currency,
              source: s.source,
              isClamped: s.isClamped,
              warnings: s.warnings,
            }))

          rows.push({
            id: `variant:${variantSku}`,
            isParent: false,
            parentId: parentIdFilter,
            childCount: 0,
            productId: selfRefChild?.id ?? (isRootRow ? root.id : variation?.productId ?? null),
            variantSku,
            sku: variantSku,
            name: selfRefChild?.name ?? variation?.name ?? variation?.value ?? variantSku,
            amazonAsin: selfRefChild?.amazonAsin ?? variation?.amazonAsin ?? null,
            thumbnailUrl: selfRefChild?.images?.[0]?.url ?? null,
            variationAttributes: variation?.variationAttributes ?? null,
            // Primary-channel snapshot inline so the row reads scannably.
            primary: {
              id: primary.id,
              channel: primary.channel,
              marketplace: primary.marketplace,
              fulfillmentMethod: primary.fulfillmentMethod,
              computedPrice: primary.computedPrice,
              currency: primary.currency,
              source: primary.source,
              isClamped: primary.isClamped,
              warnings: primary.warnings,
              breakdown: primary.breakdown,
            },
            channelChips,
            snapshotCount: snaps.length,
            // Snapshot ids underneath so bulk-select cascades cleanly.
            snapshotIds: snaps.map((s) => s.id),
          })
        }

        rows.sort((a, b) => a.variantSku.localeCompare(b.variantSku))
        return {
          rows,
          total: rows.length,
          page: 0,
          limit: rows.length,
          hierarchy: 'children' as const,
        }
      }

      // ── Mode: flat (default, backwards compatible) ────────────────────
      const [rawRows, total] = await Promise.all([
        prisma.pricingSnapshot.findMany({
          where: snapshotWhere,
          orderBy: [{ sku: 'asc' }, { channel: 'asc' }, { marketplace: 'asc' }],
          skip: page * limit,
          take: limit,
        }),
        prisma.pricingSnapshot.count({ where: snapshotWhere }),
      ])

      // Enrich flat rows with hierarchy fields so the matrix UI can show
      // identity cells without a second round-trip.
      const skus = [...new Set(rawRows.map((r) => r.sku))]
      const [variants, products] = await Promise.all([
        prisma.productVariation.findMany({
          where: { sku: { in: skus } },
          select: { sku: true, productId: true },
        }),
        prisma.product.findMany({
          where: { sku: { in: skus } },
          select: { sku: true, id: true, parentId: true },
        }),
      ])
      const productIdBySku = new Map<string, string>()
      for (const v of variants) productIdBySku.set(v.sku, v.productId)
      for (const p of products) productIdBySku.set(p.sku, p.id)
      const productIds = [...new Set(productIdBySku.values())]
      const productMeta = productIds.length === 0
        ? []
        : await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              name: true,
              amazonAsin: true,
              parentId: true,
              images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 1 },
            },
          })
      const metaById = new Map(productMeta.map((p) => [p.id, p] as const))

      const rows = rawRows.map((r) => {
        const pid = productIdBySku.get(r.sku)
        const meta = pid ? metaById.get(pid) : undefined
        return {
          ...r,
          productId: pid ?? null,
          parentId: meta?.parentId ?? null,
          productName: meta?.name ?? null,
          thumbnailUrl: meta?.images[0]?.url ?? null,
          productAsin: meta?.amazonAsin ?? null,
        }
      })

      return { rows, total, page, limit, hierarchy: 'flat' as const }
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

  // F.2 — Buy Box drill-down. Per-marketplace win rate + top competitors
  // over a configurable window (default 7 days). Reads BuyBoxHistory
  // populated by sp-api-pricing.service. The /pricing KPI strip's tile
  // gives the headline %; this endpoint feeds the dedicated page.
  fastify.get('/pricing/buybox-stats', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const days = Math.min(90, Math.max(1, Number(q.days ?? '7')))
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      // Per-marketplace win rate. groupBy is cheap with the
      // (channel, marketplace, observedAt) index.
      const totals = await prisma.buyBoxHistory.groupBy({
        by: ['channel', 'marketplace'],
        where: { observedAt: { gte: since } },
        _count: { _all: true },
      })
      const wins = await prisma.buyBoxHistory.groupBy({
        by: ['channel', 'marketplace'],
        where: { observedAt: { gte: since }, isOurOffer: true },
        _count: { _all: true },
      })
      const winsByKey = new Map(
        wins.map((w) => [`${w.channel}|${w.marketplace}`, w._count._all]),
      )
      const byMarketplace = totals
        .map((t) => {
          const key = `${t.channel}|${t.marketplace}`
          const ourWins = winsByKey.get(key) ?? 0
          const observations = t._count._all
          return {
            channel: t.channel,
            marketplace: t.marketplace,
            observations,
            ourWins,
            winRatePct:
              observations > 0
                ? Math.round((ourWins / observations) * 1000) / 10
                : null,
          }
        })
        .sort((a, b) => b.observations - a.observations)

      // Top competitor sellers (where they won + we didn't).
      const topCompetitorsRaw = await prisma.buyBoxHistory.groupBy({
        by: ['winnerSellerId', 'fulfillmentMethod'],
        where: {
          observedAt: { gte: since },
          isOurOffer: false,
          winnerSellerId: { not: null },
        },
        _count: { _all: true },
        orderBy: { _count: { winnerSellerId: 'desc' } },
        take: 10,
      })
      const topCompetitors = topCompetitorsRaw.map((c) => ({
        winnerSellerId: c.winnerSellerId,
        fulfillmentMethod: c.fulfillmentMethod,
        timesWon: c._count._all,
      }))

      // Headline numbers across all marketplaces.
      const totalObservations = byMarketplace.reduce(
        (sum, m) => sum + m.observations,
        0,
      )
      const totalWins = byMarketplace.reduce((sum, m) => sum + m.ourWins, 0)
      const overallWinRatePct =
        totalObservations > 0
          ? Math.round((totalWins / totalObservations) * 1000) / 10
          : null

      return {
        windowDays: days,
        observations: totalObservations,
        ourWins: totalWins,
        winRatePct: overallWinRatePct,
        byMarketplace,
        topCompetitors,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/buybox-stats] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // E.1.b — Create RetailEvent + optional RetailEventPriceAction in one
  // shot. The scheduler picks up new events on its next hourly tick (or
  // immediately via the manual "Run scheduler now" button on the UI).
  fastify.post('/pricing/promotions', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        name?: string
        startDate?: string
        endDate?: string
        channel?: string | null
        marketplace?: string | null
        productType?: string | null
        description?: string | null
        expectedLift?: number
        action?: {
          type: 'PERCENT_OFF' | 'FIXED_PRICE'
          value: number
        }
      }
      if (!body.name?.trim()) {
        return reply.code(400).send({ error: 'name is required' })
      }
      if (!body.startDate || !body.endDate) {
        return reply.code(400).send({ error: 'startDate and endDate are required (YYYY-MM-DD)' })
      }
      const start = new Date(body.startDate)
      const end = new Date(body.endDate)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return reply.code(400).send({ error: 'invalid date' })
      }
      if (end < start) {
        return reply.code(400).send({ error: 'endDate must be ≥ startDate' })
      }
      if (body.action) {
        if (!['PERCENT_OFF', 'FIXED_PRICE'].includes(body.action.type)) {
          return reply
            .code(400)
            .send({ error: 'action.type must be PERCENT_OFF or FIXED_PRICE' })
        }
        if (
          !Number.isFinite(body.action.value) ||
          body.action.value <= 0 ||
          (body.action.type === 'PERCENT_OFF' && body.action.value >= 100)
        ) {
          return reply.code(400).send({
            error:
              'action.value must be > 0 (and < 100 for PERCENT_OFF)',
          })
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const event = await tx.retailEvent.create({
          data: {
            name: body.name!,
            startDate: start,
            endDate: end,
            channel: body.channel ?? null,
            marketplace: body.marketplace ?? null,
            productType: body.productType ?? null,
            description: body.description ?? null,
            expectedLift:
              body.expectedLift != null
                ? new Prisma.Decimal(body.expectedLift)
                : new Prisma.Decimal(1),
            source: 'CUSTOM',
            isActive: true,
          },
        })
        if (body.action) {
          await tx.retailEventPriceAction.create({
            data: {
              eventId: event.id,
              channel: body.channel ?? null,
              marketplace: body.marketplace ?? null,
              productType: body.productType ?? null,
              action: body.action.type,
              value: new Prisma.Decimal(body.action.value),
              isActive: true,
            },
          })
        }
        return tx.retailEvent.findUnique({
          where: { id: event.id },
          include: { priceActions: true },
        })
      })
      return created
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/promotions POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // UI.7 — Repricer status. Reads the last AuditLog rows the
  // G.1 scheduler wrote (entityType='RepricerRun') so /pricing can
  // show a live banner: "last tick: dry-run · would have enqueued 47
  // · 2 minutes ago". Operator validates dry-run behavior before
  // flipping NEXUS_REPRICER_LIVE.
  fastify.get('/pricing/repricer-status', async (_request, reply) => {
    try {
      const recent = await prisma.auditLog.findMany({
        where: { entityType: 'RepricerRun' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          entityId: true,
          action: true,
          after: true,
          createdAt: true,
        },
      })
      // Server can't reliably read the env vars on the client without
      // exposing them, but it CAN tell the client what state THIS process
      // sees — and that's what matters for "is the cron firing?".
      const liveMode = process.env.NEXUS_REPRICER_LIVE === '1'
      const cronEnabled = process.env.NEXUS_ENABLE_PRICING_CRON === '1'
      const thresholdPct = Math.max(
        0,
        Number(process.env.NEXUS_REPRICER_THRESHOLD_PCT ?? '1'),
      )
      return {
        config: { cronEnabled, liveMode, thresholdPct },
        ticks: recent.map((r) => {
          const after = (r.after ?? {}) as any
          return {
            runId: r.entityId,
            action: r.action,
            occurredAt: r.createdAt,
            liveMode: after.liveMode ?? false,
            snapshotsScanned: after.snapshotsScanned ?? 0,
            enqueued: after.enqueued ?? 0,
            dryRunWouldEnqueue: after.dryRunWouldEnqueue ?? 0,
            skippedSubThreshold: after.skippedSubThreshold ?? 0,
            durationMs: after.durationMs ?? 0,
          }
        }),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/repricer-status] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // E.2 — Prepare an Amazon Coupon spec. SP-API doesn't expose
  // createCoupon publicly; this validates the spec, normalizes the
  // payload, and returns a Seller Central deep-link the operator
  // clicks to finalize the coupon. When Amazon eventually exposes
  // the API (or the operator adopts a partner integration), the
  // dispatch step swaps in here.
  fastify.post('/pricing/coupons/prepare', async (request, reply) => {
    try {
      const { prepareAmazonCoupon } = await import(
        '../services/amazon-coupon.service.js'
      )
      const body = (request.body ?? {}) as Record<string, unknown>
      const draft = {
        name: String(body.name ?? ''),
        marketplace: String(body.marketplace ?? ''),
        asins: Array.isArray(body.asins) ? (body.asins as string[]) : [],
        discountType: body.discountType as 'PERCENTAGE' | 'AMOUNT',
        discountValue: Number(body.discountValue),
        startsAt: body.startsAt ? new Date(String(body.startsAt)) : new Date(NaN),
        endsAt: body.endsAt ? new Date(String(body.endsAt)) : new Date(NaN),
        budgetCap:
          body.budgetCap != null ? Number(body.budgetCap) : undefined,
        customerEligibility:
          (body.customerEligibility as 'ALL' | 'PRIME') ?? 'ALL',
      }
      const result = prepareAmazonCoupon(draft)
      return reply.code(result.ok ? 200 : 422).send(result)
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/coupons/prepare] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // E.3 — Push an EbayMarkdown row to eBay's Marketing API. Centralized
  // through ebay-markdown.service so every push respects the same
  // status guards + originalPrice drift check + dry-run gating.
  fastify.post<{ Params: { id: string } }>(
    '/pricing/markdowns/:id/push',
    async (request, reply) => {
      try {
        const { pushMarkdownToEbay } = await import(
          '../services/ebay-markdown.service.js'
        )
        const result = await pushMarkdownToEbay(prisma, request.params.id)
        return reply
          .code(result.ok ? 200 : result.error === 'markdown not found' ? 404 : 422)
          .send(result)
      } catch (error: any) {
        fastify.log.error({ err: error }, '[pricing/markdowns push] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  // E.1.b — Soft-delete a RetailEvent + cascade clear of any
  // ChannelListing.salePrice rows the scheduler stamped under its
  // promotion:<eventId> marker. Keeps audit trail (row preserved with
  // isActive=false) so a "what did we run last quarter" query stays
  // honest.
  fastify.delete<{ Params: { id: string } }>(
    '/pricing/promotions/:id',
    async (request, reply) => {
      try {
        await prisma.$transaction(async (tx) => {
          const event = await tx.retailEvent.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          })
          if (!event) {
            throw Object.assign(new Error('not found'), { code: 'P2025' })
          }
          await tx.retailEvent.update({
            where: { id: event.id },
            data: { isActive: false },
          })
          await tx.retailEventPriceAction.updateMany({
            where: { eventId: event.id },
            data: { isActive: false },
          })
          // Clear any salePrice rows the scheduler stamped under this
          // event's marker so the listings revert next snapshot refresh.
          await tx.channelListing.updateMany({
            where: { lastOverrideBy: `promotion:${event.id}` },
            data: {
              salePrice: null,
              lastOverrideAt: new Date(),
              lastOverrideBy: `promotion-clear:${event.id}`,
            },
          })
        })
        return { ok: true }
      } catch (error: any) {
        if (error?.code === 'P2025') {
          return reply.code(404).send({ error: 'event not found' })
        }
        fastify.log.error(
          { err: error },
          '[pricing/promotions DELETE] failed',
        )
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

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
          // PH.1 — unified timeline row, atomic with the override above.
          prisma.priceChangeEvent.create({
            data: priceChangeData({
              productId,
              sku: snap.sku,
              channel: snap.channel,
              marketplace: snap.marketplace,
              fulfillmentMethod: snap.fulfillmentMethod,
              oldPrice: previousOverride,
              newPrice: newOverride,
              currency: snap.currency,
              source: 'BULK_OVERRIDE',
              reason: reasonForMode,
              actor: 'bulk-override',
            }),
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

  // ── CE.3: Repricing decisions feed ──────────────────────────────────────
  // GET /api/pricing/repricing-decisions?limit=50&applied=true|false
  fastify.get('/pricing/repricing-decisions', async (request) => {
    const { limit = '50', applied, ruleId } = request.query as {
      limit?: string
      applied?: string
      ruleId?: string
    }

    const where: Record<string, unknown> = {}
    if (ruleId) where.ruleId = ruleId
    if (applied === 'true') where.applied = true
    if (applied === 'false') where.applied = false

    const decisions = await prisma.repricingDecision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 50, 200),
      include: {
        rule: {
          select: {
            id: true,
            channel: true,
            marketplace: true,
            strategy: true,
            product: { select: { id: true, name: true, brand: true } },
          },
        },
      },
    })

    return { decisions }
  })

  // ── PH.2: Price-change history feed ─────────────────────────────────────
  // GET /api/pricing/price-history
  //   ?productId= | sku=   (one required)
  //   &channel= &marketplace=   (optional coordinate filters)
  //   &from= &to=   (optional ISO date window)
  //   &limit=   (default 100, max 500)
  //
  // Read-only timeline read from PriceChangeEvent (PH.1). Powers the
  // /pricing matrix drawer: a chronological list of changes with source +
  // reason, plus per-coordinate sparkline series (chronological newPrice
  // points) so the UI can chart price-over-time without a second call.
  fastify.get('/pricing/price-history', async (request, reply) => {
    try {
      const q = request.query as {
        productId?: string
        sku?: string
        channel?: string
        marketplace?: string
        from?: string
        to?: string
        limit?: string
      }
      if (!q.productId && !q.sku) {
        return reply.code(400).send({ error: 'productId or sku required' })
      }

      const where: Prisma.PriceChangeEventWhereInput = {}
      if (q.productId) where.productId = q.productId
      if (q.sku) where.sku = q.sku
      if (q.channel) where.channel = q.channel.toUpperCase()
      if (q.marketplace) where.marketplace = q.marketplace.toUpperCase()
      if (q.from || q.to) {
        const changedAt: Prisma.DateTimeFilter = {}
        if (q.from) changedAt.gte = new Date(q.from)
        if (q.to) changedAt.lte = new Date(q.to)
        where.changedAt = changedAt
      }

      const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500)

      const rows = await prisma.priceChangeEvent.findMany({
        where,
        orderBy: { changedAt: 'desc' },
        take: limit,
      })

      // Per-coordinate sparkline series, oldest→newest so the chart reads
      // left-to-right. CLEARs (newPrice null) are skipped as points but
      // still appear in the events list below.
      const seriesMap = new Map<
        string,
        { channel: string; marketplace: string; points: Array<{ t: Date; price: number }> }
      >()
      for (const e of [...rows].reverse()) {
        if (e.newPrice == null) continue
        const key = `${e.channel}|${e.marketplace}`
        let s = seriesMap.get(key)
        if (!s) {
          s = { channel: e.channel, marketplace: e.marketplace, points: [] }
          seriesMap.set(key, s)
        }
        s.points.push({ t: e.changedAt, price: Number(e.newPrice) })
      }

      return {
        count: rows.length,
        events: rows.map((e) => ({
          id: e.id,
          channel: e.channel,
          marketplace: e.marketplace,
          fulfillmentMethod: e.fulfillmentMethod,
          oldPrice: e.oldPrice == null ? null : Number(e.oldPrice),
          newPrice: e.newPrice == null ? null : Number(e.newPrice),
          currency: e.currency,
          source: e.source,
          reason: e.reason,
          ruleId: e.ruleId,
          actor: e.actor,
          changedAt: e.changedAt,
        })),
        series: [...seriesMap.values()],
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pricing/price-history] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // AC.9 — Per-product Buy Box state for the Amazon Listing Cockpit.
  //
  // Returns the latest BuyBoxHistory observation for the product on a
  // specific marketplace plus a short tail of recent observations so
  // the cockpit can show a sparkline-style summary without pulling
  // the full /pricing/buybox-stats aggregate.
  //
  // Channel is hard-coded to AMAZON — Buy Box is an Amazon concept.
  fastify.get<{ Params: { id: string }; Querystring: { marketplace?: string } }>(
    '/products/:id/buybox',
    async (request, reply) => {
      const { id } = request.params
      const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()

      const product = await prisma.product.findUnique({
        where: { id },
        select: { id: true },
      })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found' })
      }

      const [current, history] = await Promise.all([
        prisma.buyBoxHistory.findFirst({
          where: { productId: id, channel: 'AMAZON', marketplace },
          orderBy: { observedAt: 'desc' },
        }),
        prisma.buyBoxHistory.findMany({
          where: { productId: id, channel: 'AMAZON', marketplace },
          orderBy: { observedAt: 'desc' },
          take: 10,
        }),
      ])

      // Active repricing rule (if any) for this (product, channel,
      // marketplace) — collapses to one extra DB read so the card
      // doesn't need a second round-trip.
      const rule = await prisma.repricingRule.findFirst({
        where: {
          productId: id,
          channel: 'AMAZON',
          OR: [{ marketplace }, { marketplace: null }],
        },
        orderBy: [
          { marketplace: 'desc' }, // exact marketplace first
          { updatedAt: 'desc' },
        ],
      })

      // Recent decisions (only when there's a rule).
      const decisions = rule
        ? await prisma.repricingDecision.findMany({
            where: { ruleId: rule.id },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : []

      return {
        productId: id,
        channel: 'AMAZON',
        marketplace,
        current,
        history,
        rule,
        decisions,
      }
    },
  )
}

export default pricingRoutes
