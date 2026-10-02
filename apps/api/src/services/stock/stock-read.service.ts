/**
 * MCP full control 08 S3 — the stock reads, out of the routes, so the stock page and Claude's stock tools read the
 * same thing. Each function is the body of its route, moved as it was (stock-read-parity.vitest.test.ts holds the
 * routes' answers): the route keeps its status codes and error handling, and returns what the function returns.
 *
 *   listStockRows          GET /api/stock                     leaf stock rows with product and location, paged
 *   listStockLocations     GET /api/stock/locations           every location with its totals
 *   readProductStock       GET /api/stock/product/:productId  one product's stock bundle (null: not found)
 *   listStockTransfers     GET /api/stock/transfers           completed transfers, one row each
 *   listStockReservations  GET /api/stock/reservations        reservations with status, location and product
 *   listCycleCounts        GET /api/fulfillment/cycle-counts  counts with item totals
 *   readCycleCount         GET /api/fulfillment/cycle-counts/:id  one count with its items (null: not found)
 */
import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { listStockMovements } from '../stock-movement.service.js'
import { resolveAtp } from '../atp.service.js'
import { resolveAtpAcrossChannels } from '../atp-channel.service.js'
import { listLayers } from '../cost-layers.service.js'
import { loadPoolSources, summarizePoolSources, type PoolSource } from '../stock-pool/pool-sources.js'
import { lentUsage } from '../stock-pool/lent-usage.js'

/** A query number: the fallback when absent or not a number (as the stock routes read them). */
function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Query of GET /api/stock: locationType, locationCode, status, search, page, pageSize. */
export async function listStockRows(q: Record<string, any>) {
  const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
  const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
  const skip = (page - 1) * pageSize

  // Only show leaf products (isParent: false). Parent/intermediate
  // products that somehow have their own StockLevel rows would appear
  // as children under the wrong synthetic parent, creating a merged
  // 3-level mess. isParent: false guarantees the stock table exactly
  // mirrors the variant-level product structure shown in /products.
  const where: any = { product: { isParent: false } }

  // locationType — 'AMAZON_FBA' | 'WAREHOUSE' | ... — filters by
  // location.type. Powers the FBA / Own warehouse tab strip.
  if (q.locationType) {
    where.location = { type: q.locationType }
  }

  if (q.locationCode) {
    const loc = await prisma.stockLocation.findUnique({
      where: { workspace_code: workspaceKey({ code: q.locationCode }) },
      select: { id: true },
    })
    if (!loc) {
      return { items: [], total: 0, page, pageSize, totalPages: 0 }
    }
    where.locationId = loc.id
  }

  if (q.status === 'OUT_OF_STOCK') where.quantity = 0
  else if (q.status === 'CRITICAL') where.quantity = { gt: 0, lte: 5 }
  else if (q.status === 'LOW') where.quantity = { gt: 5, lte: 15 }
  else if (q.status === 'IN_STOCK') where.quantity = { gt: 15 }

  if (q.search?.trim()) {
    const s = q.search.trim()
    // Merge with the existing product filter (isParent: false must
    // survive the search condition — overwriting where.product would
    // drop the isParent guard and let parent rows leak back in).
    where.product = {
      ...where.product,
      OR: [
        { sku: { contains: s, mode: 'insensitive' } },
        { name: { contains: s, mode: 'insensitive' } },
        { amazonAsin: { contains: s, mode: 'insensitive' } },
      ],
    }
  }

  const [total, rows] = await Promise.all([
    prisma.stockLevel.count({ where }),
    prisma.stockLevel.findMany({
      where,
      include: {
        location: { select: { id: true, code: true, name: true, type: true } },
        product: {
          select: {
            id: true, sku: true, name: true, amazonAsin: true,
            lowStockThreshold: true, costPrice: true, basePrice: true,
            abcClass: true,
            isParent: true,
            parentId: true,
            parent: {
              select: {
                id: true, sku: true, name: true,
                // Expose the direct parent's own parentId so the UI
                // can detect 3-level hierarchies (grandparent exists).
                parentId: true,
                images: { select: { url: true }, take: 1 },
              },
            },
            images: { select: { url: true }, take: 1 },
          },
        },
        variation: {
          select: { id: true, sku: true, variationAttributes: true },
        },
      },
      orderBy: [{ quantity: 'asc' }, { lastUpdatedAt: 'desc' }],
      skip,
      take: pageSize,
    }),
  ])

  return {
    items: rows.map((r) => ({
      id: r.id,
      quantity: r.quantity,
      reserved: r.reserved,
      available: r.available,
      reorderThreshold: r.reorderThreshold,
      // T.32 — surface EOQ alongside threshold so at-reorder rows
      // show "ROP 12 · +50" inline; operator can decide before
      // opening the drawer.
      reorderQuantity: r.reorderQuantity,
      syncStatus: r.syncStatus,
      lastUpdatedAt: r.lastUpdatedAt,
      lastSyncedAt: r.lastSyncedAt,
      location: r.location,
      product: {
        ...r.product,
        costPrice: r.product.costPrice == null ? null : Number(r.product.costPrice),
        basePrice: r.product.basePrice == null ? null : Number(r.product.basePrice),
        thumbnailUrl: r.product.images?.[0]?.url ?? null,
        parentId: r.product.parentId ?? null,
        parentProduct: r.product.parent ? {
          id: r.product.parent.id,
          sku: r.product.parent.sku,
          name: r.product.parent.name,
          thumbnailUrl: r.product.parent.images?.[0]?.url ?? null,
          // grandparentId lets the UI know this parent is itself a child
          // in a 3-level hierarchy (grandparent → FBA/FBM parent → variant).
          grandparentId: r.product.parent.parentId ?? null,
        } : null,
      },
      variation: r.variation,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function listStockLocations() {
  const locations = await prisma.stockLocation.findMany({
    orderBy: [{ type: 'asc' }, { code: 'asc' }],
    include: {
      _count: { select: { stockLevels: true } },
    },
  })

  // One aggregate per location — cheap (1 query per location).
  const summaries = await Promise.all(
    locations.map(async (loc) => {
      const agg = await prisma.stockLevel.aggregate({
        where: { locationId: loc.id },
        _sum: { quantity: true, reserved: true, available: true },
      })
      return {
        id: loc.id,
        code: loc.code,
        name: loc.name,
        type: loc.type,
        isActive: loc.isActive,
        servesMarketplaces: loc.servesMarketplaces,
        warehouseId: loc.warehouseId,
        skuCount: loc._count.stockLevels,
        totalQuantity: agg._sum.quantity ?? 0,
        totalReserved: agg._sum.reserved ?? 0,
        totalAvailable: agg._sum.available ?? 0,
      }
    }),
  )

  return { locations: summaries }
}

export async function readProductStock(productId: string, opts: { family: boolean }) {
  // family=true → fetch children's stock for parent rows so the drawer
  // shows a Variants breakdown instead of the (empty) parent's own stock.
  const wantFamily = opts.family

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      sku: true,
      name: true,
      amazonAsin: true,
      totalStock: true,
      lowStockThreshold: true,
      basePrice: true,
      costPrice: true,
      isParent: true,
      // S.20 — costing method + rolling WAC for the drawer header
      costingMethod: true,
      weightedAvgCostCents: true,
      images: { select: { url: true }, take: 1 },
    },
  })
  if (!product) return null

  // S.20 — layer history (top 30 by recency) attached to the
  // bundle so the drawer renders without a second roundtrip.
  const costLayers = await listLayers(productId, 30)

  const [stockLevels, channelListings, movements, atpMap] = await Promise.all([
    prisma.stockLevel.findMany({
      where: { productId },
      include: {
        location: { select: { id: true, code: true, name: true, type: true, isActive: true } },
        reservations: {
          where: { releasedAt: null, consumedAt: null },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { quantity: 'desc' },
    }),
    prisma.channelListing.findMany({
      where: { productId },
      select: {
        id: true, channel: true, marketplace: true, listingStatus: true,
        syncStatus: true, lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true,
        quantity: true, stockBuffer: true, externalListingId: true,
      },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
    }),
    listStockMovements({ productId, limit: 50 }),
    resolveAtp({ products: [{ id: product.id, sku: product.sku }] }),
  ])

  // Sales velocity: aggregate DailySalesAggregate for the last 90 days.
  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90)
  ninetyDaysAgo.setUTCHours(0, 0, 0, 0)
  const sales = await prisma.dailySalesAggregate.findMany({
    where: { sku: product.sku, day: { gte: ninetyDaysAgo } },
    select: { day: true, unitsSold: true, grossRevenue: true, ordersCount: true, channel: true },
    orderBy: { day: 'asc' },
  })

  // Roll up by day across channels
  const dailyMap = new Map<string, { units: number; revenueCents: number; orders: number }>()
  for (const s of sales) {
    const key = s.day.toISOString().slice(0, 10)
    const cur = dailyMap.get(key) ?? { units: 0, revenueCents: 0, orders: 0 }
    cur.units += s.unitsSold
    cur.revenueCents += Math.round(Number(s.grossRevenue) * 100)
    cur.orders += s.ordersCount
    dailyMap.set(key, cur)
  }
  const dailyHistory = Array.from(dailyMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, v]) => ({
      day,
      units: v.units,
      revenue: v.revenueCents / 100,
      orders: v.orders,
    }))

  const last30Cutoff = new Date()
  last30Cutoff.setUTCDate(last30Cutoff.getUTCDate() - 30)
  const last30 = sales.filter((s) => s.day >= last30Cutoff)
  const last30Units = last30.reduce((acc, s) => acc + s.unitsSold, 0)
  const last30Revenue = last30.reduce((acc, s) => acc + Number(s.grossRevenue), 0)
  const avgDailyUnits = last30Units / 30
  const totalAvailable = stockLevels.reduce((acc, sl) => acc + sl.available, 0)

  const atp = atpMap.get(product.id)

  // Family view: fetch all leaf-variant children with their stock levels.
  // Returned when ?family=true and the product is a master parent.
  let family: null | {
    totalStock: number; totalReserved: number; totalAvailable: number
    locations: Array<{ id: string; code: string; name: string; type: string }>
    children: Array<{
      id: string; sku: string; name: string
      thumbnailUrl: string | null; abcClass: string | null
      lowStockThreshold: number
      totalStock: number; totalReserved: number; totalAvailable: number
      /** Shared stock step 5 — the pool this variation sells from, or null (own stock). */
      poolSource: PoolSource | null
      stockLevels: Array<{
        locationId: string; locationCode: string; locationType: string
        quantity: number; reserved: number; available: number
        lastUpdatedAt: string
        syncStatus: string
      }>
    }>
  } = null

  if (wantFamily && product.isParent) {
    const [children, activeLocations] = await Promise.all([
      prisma.product.findMany({
        where: { parentId: productId, isParent: false },
        select: {
          id: true, sku: true, name: true, abcClass: true, lowStockThreshold: true,
          images: { select: { url: true }, take: 1 },
          stockLevels: {
            select: {
              quantity: true, reserved: true, available: true,
              lastUpdatedAt: true, syncStatus: true,
              location: { select: { id: true, code: true, name: true, type: true } },
            },
            orderBy: { quantity: 'desc' },
          },
        },
        orderBy: { sku: 'asc' },
      }),
      prisma.stockLocation.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true, type: true },
        orderBy: [{ type: 'asc' }, { code: 'asc' }],
      }),
    ])

    const childPools = await loadPoolSources(prisma, children.map((c) => c.id))
    family = {
      totalStock:     children.reduce((s, c) => s + c.stockLevels.reduce((ss, sl) => ss + sl.quantity, 0), 0),
      totalReserved:  children.reduce((s, c) => s + c.stockLevels.reduce((ss, sl) => ss + sl.reserved, 0), 0),
      totalAvailable: children.reduce((s, c) => s + c.stockLevels.reduce((ss, sl) => ss + sl.available, 0), 0),
      locations: activeLocations,
      children: children.map((c) => ({
        id: c.id,
        sku: c.sku,
        name: c.name,
        thumbnailUrl: c.images?.[0]?.url ?? null,
        abcClass: c.abcClass,
        lowStockThreshold: c.lowStockThreshold,
        totalStock:     c.stockLevels.reduce((s, sl) => s + sl.quantity, 0),
        totalReserved:  c.stockLevels.reduce((s, sl) => s + sl.reserved, 0),
        totalAvailable: c.stockLevels.reduce((s, sl) => s + sl.available, 0),
        poolSource: childPools.get(c.id) ?? null,
        stockLevels: c.stockLevels.map((sl) => ({
          locationId:   sl.location.id,
          locationCode: sl.location.code,
          locationType: sl.location.type,
          quantity:     sl.quantity,
          reserved:     sl.reserved,
          available:    sl.available,
          lastUpdatedAt: sl.lastUpdatedAt.toISOString(),
          syncStatus:   sl.syncStatus,
        })),
      })),
    }
  }

  // Shared stock step 5 — the pool this product sells from (a parent: its pooled variations added up),
  // beside its own numbers; never added to them.
  const poolSource = product.isParent
    ? summarizePoolSources((family?.children ?? []).map((c) => c.id),
        new Map((family?.children ?? []).flatMap((c) => c.poolSource ? [[c.id, c.poolSource] as const] : [])))
    : ((await loadPoolSources(prisma, [product.id])).get(product.id) ?? null)
  // Shared stock step 5 — "who sold what": for a LENDER, what each borrowing business holds and sold
  // from this product (a parent: with its variations). Each movement made for another business names it.
  const lent = await lentUsage(prisma, [product.id, ...(family?.children ?? []).map((c) => c.id)])
  // Days of stock: a product that sells from a pool is covered by the pool's free units, not by its own
  // shelf (empty by design in a borrowing business) — step 7: the drawer said "0 days of stock" in red.
  const coverUnits = !product.isParent && poolSource ? poolSource.available : totalAvailable
  const daysOfStock =
    avgDailyUnits > 0
      ? Math.floor(coverUnits / avgDailyUnits)
      : null

  return {
    poolSource,
    lentUsage: lent.usage,
    product: {
      ...product,
      basePrice: product.basePrice == null ? null : Number(product.basePrice),
      costPrice: product.costPrice == null ? null : Number(product.costPrice),
      thumbnailUrl: product.images?.[0]?.url ?? null,
    },
    stockLevels: stockLevels.map((sl) => ({
      id: sl.id,
      location: sl.location,
      quantity: sl.quantity,
      reserved: sl.reserved,
      available: sl.available,
      reorderThreshold: sl.reorderThreshold,
      lastUpdatedAt: sl.lastUpdatedAt,
      lastSyncedAt: sl.lastSyncedAt,
      syncStatus: sl.syncStatus,
      activeReservations: sl.reservations.length,
    })),
    channelListings,
    movements: movements.map((movement) => ({
      ...movement,
      usedBy: movement.consumerWorkspaceId
        ? { businessName: lent.names.get(movement.consumerWorkspaceId) ?? 'another business', orderRef: movement.consumerOrderRef }
        : null,
    })),
    salesVelocity: {
      last30Units,
      last30Revenue,
      avgDailyUnits: Math.round(avgDailyUnits * 100) / 100,
      daysOfStock,
      totalAvailable,
      dailyHistory,
    },
    atp: atp ?? null,
    // S.26 — per-channel ATP rollup. byLocation comes from the
    // resolveAtp call above (it computes the per-row breakdown
    // we feed back here). Empty when the product has no
    // ChannelListings.
    atpPerChannel: atp ? await resolveAtpAcrossChannels({
      productId: product.id,
      byLocation: atp.byLocation as any,
      // A parent's poolSource is its variations added up; its own listings are not sent stock from it.
      pool: product.isParent ? null : poolSource,
    }) : [],
    // S.20 — costing surface
    costing: {
      method: product.costingMethod,
      weightedAvgCostCents: product.weightedAvgCostCents,
      layers: costLayers,
    },
    reservations: stockLevels.flatMap((sl) =>
      sl.reservations.map((r) => ({
        ...r,
        quantity: r.quantity,
        location: { id: sl.location.id, code: sl.location.code },
        // Shared stock — a hold made for another business's order names it; it cannot be released here.
        usedBy: r.consumerWorkspaceId
          ? { businessName: lent.names.get(r.consumerWorkspaceId) ?? 'another business', orderRef: r.consumerOrderRef }
          : null,
      })),
    ),
    // L.10 — active lots for this product, FEFO-ordered. Includes
    // any OPEN recall so the drawer can flag recalled batches
    // even though they're suppressed from FEFO consume. Capped at
    // 50 — products with more lots than that need the dedicated
    // /api/stock/lots endpoint with filters.
    lots: await prisma.lot.findMany({
      where: { productId, unitsRemaining: { gt: 0 } },
      orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
      take: 50,
      select: {
        id: true, lotNumber: true, receivedAt: true, expiresAt: true,
        unitsReceived: true, unitsRemaining: true, supplierLotRef: true,
        recalls: {
          where: { status: 'OPEN' },
          select: { id: true, reason: true, openedAt: true },
          take: 1,
        },
      },
    }),
    // SR.4 — serial-tracked units for this product. Surfaced in
    // the drawer when present; empty for products without serials.
    // Capped at 50 + summary counts so the drawer doesn't
    // serialize 1000s of rows for high-volume products.
    serials: await prisma.serialNumber.findMany({
      where: { productId },
      orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
      take: 50,
      select: {
        id: true, serialNumber: true, status: true, receivedAt: true,
        currentOrderId: true, manufacturerRef: true,
        lot: { select: { id: true, lotNumber: true } },
      },
    }),
    serialCounts: await prisma.serialNumber.groupBy({
      by: ['status'],
      where: { productId },
      _count: { _all: true },
    }).then((rows: Array<{ status: string; _count: { _all: number } }>) => Object.fromEntries(rows.map((r) => [r.status, r._count._all]))),
    // F.3 — family view for parent rows. null for leaf/standalone products.
    family,
  }
}

/** Query of GET /api/stock/transfers: limit. */
export async function listStockTransfers(q: Record<string, any>) {
  const limit = Math.min(200, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))

  // Pull TRANSFER_IN rows (the canonical "destination" event); each
  // referenceId points at its paired OUT. Joining lets us return
  // both sides in one row to the client. Ordering by createdAt DESC
  // surfaces the most recent transfers first.
  const inRows = await prisma.stockMovement.findMany({
    where: { reason: 'TRANSFER_IN' as any },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      productId: true,
      change: true,
      createdAt: true,
      actor: true,
      notes: true,
      referenceId: true,
      fromLocationId: true,
      toLocationId: true,
      fromLocation: { select: { id: true, code: true, name: true, type: true } },
      toLocation:   { select: { id: true, code: true, name: true, type: true } },
    },
  })

  // Resolve sibling OUT rows + product info in two batched queries.
  const outIds = inRows.map((r) => r.referenceId).filter((v): v is string => !!v)
  const productIds = Array.from(new Set(inRows.map((r) => r.productId)))
  const [outRows, products] = await Promise.all([
    outIds.length === 0
      ? Promise.resolve([])
      : prisma.stockMovement.findMany({
          where: { id: { in: outIds } },
          select: { id: true, createdAt: true, actor: true, change: true },
        }),
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, name: true, amazonAsin: true,
        images: { select: { url: true }, take: 1 } },
    }),
  ])
  const outById = new Map(outRows.map((r) => [r.id, r]))
  const productById = new Map(products.map((p) => [p.id, p]))

  const transfers = inRows.map((r) => {
    const sibling = r.referenceId ? outById.get(r.referenceId) : null
    const p = productById.get(r.productId)
    return {
      id: r.id,
      siblingOutId: r.referenceId ?? null,
      quantity: r.change,
      createdAt: r.createdAt,
      startedAt: sibling?.createdAt ?? r.createdAt,
      actor: r.actor ?? sibling?.actor ?? null,
      notes: r.notes,
      from: r.fromLocation,
      to: r.toLocation ?? null,
      product: p ? {
        id: p.id, sku: p.sku, name: p.name, amazonAsin: p.amazonAsin,
        thumbnailUrl: p.images?.[0]?.url ?? null,
      } : null,
      // Status today is always COMPLETED — transferStock fires both
      // halves synchronously. A future TransferShipment table would
      // add IN_TRANSIT state; the API shape is forward-compatible.
      status: 'COMPLETED' as const,
    }
  })

  return { transfers, count: transfers.length }
}

/** Query of GET /api/stock/reservations: status (active | consumed | released | all), limit. */
export async function listStockReservations(q: Record<string, any>) {
  const status = (q.status as string | undefined) ?? 'all'
  const limit = Math.min(200, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))

  const where: any = {}
  if (status === 'active') {
    where.releasedAt = null
    where.consumedAt = null
  } else if (status === 'consumed') {
    where.consumedAt = { not: null }
  } else if (status === 'released') {
    where.releasedAt = { not: null }
  }

  const [rows, productMap] = await Promise.all([
    prisma.stockReservation.findMany({
      where,
      orderBy: [{ consumedAt: 'desc' }, { releasedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      include: {
        stockLevel: {
          select: {
            productId: true,
            quantity: true,
            reserved: true,
            available: true,
            location: { select: { id: true, code: true, name: true, type: true } },
          },
        },
      },
    }),
    // Product join is separate because StockReservation has no
    // direct relation to Product — it goes via StockLevel. Doing a
    // batched findMany keeps the per-row work cheap.
    Promise.resolve(null),
  ])

  const productIds = Array.from(new Set(rows.map((r) => r.stockLevel.productId)))
  const products = productIds.length === 0
    ? []
    : await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true, sku: true, name: true, amazonAsin: true,
          images: { select: { url: true }, take: 1 },
        },
      })
  const productById = new Map(products.map((p) => [p.id, p]))

  const now = new Date()
  const reservations = rows.map((r) => {
    const p = productById.get(r.stockLevel.productId)
    const live = r.releasedAt == null && r.consumedAt == null
    const expired = live && r.expiresAt < now
    const ttlMs = live ? r.expiresAt.getTime() - now.getTime() : null
    return {
      id: r.id,
      quantity: r.quantity,
      reason: r.reason,
      orderId: r.orderId,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      releasedAt: r.releasedAt,
      consumedAt: r.consumedAt,
      status: r.consumedAt
        ? 'consumed' as const
        : r.releasedAt
          ? 'released' as const
          : expired
            ? 'expired' as const
            : 'active' as const,
      ttlMs,
      location: r.stockLevel.location,
      stockLevel: {
        quantity: r.stockLevel.quantity,
        reserved: r.stockLevel.reserved,
        available: r.stockLevel.available,
      },
      product: p ? {
        id: p.id, sku: p.sku, name: p.name, amazonAsin: p.amazonAsin,
        thumbnailUrl: p.images?.[0]?.url ?? null,
      } : null,
    }
  })

  return { reservations, count: reservations.length, status }
}

/** Query of GET /api/fulfillment/cycle-counts: status (or all), limit. */
export async function listCycleCounts(q: { status?: string; limit?: string }) {
  const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
  const where: Prisma.CycleCountWhereInput = {}
  if (q.status && q.status !== 'all') where.status = q.status
  const counts = await prisma.cycleCount.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      location: { select: { id: true, code: true, name: true } },
      items: { select: { status: true } },
    },
  })
  const items = counts.map((c) => {
    const counts = { PENDING: 0, COUNTED: 0, RECONCILED: 0, IGNORED: 0 } as Record<string, number>
    for (const i of c.items) counts[i.status] = (counts[i.status] ?? 0) + 1
    return {
      ...c,
      itemTotals: counts,
      totalItems: c.items.length,
      items: undefined, // strip the array; counts are enough for the list
    }
  })
  return items
}

export async function readCycleCount(id: string) {
  const count = await prisma.cycleCount.findUnique({
    where: { id },
    include: {
      location: { select: { id: true, code: true, name: true } },
      items: { orderBy: { sku: 'asc' } },
    },
  })
  if (!count) return null
  // Join product names for the items.
  const productIds = Array.from(new Set(count.items.map((i) => i.productId)))
  const products = productIds.length > 0
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true },
      })
    : []
  const nameById = new Map(products.map((p) => [p.id, p.name] as const))

  // L.14 — fetch active lots for every counted product so the
  // session UI can show lot-level context inline. Variance
  // reconciliation stays at StockLevel grain (a count is
  // product-level, not lot-level), but the operator sees which
  // lots make up the expected qty so a discrepancy can be
  // attributed to a specific batch in the post-count audit.
  const lotsByProductId = new Map<string, Array<{
    id: string
    lotNumber: string
    unitsRemaining: number
    unitsReceived: number
    expiresAt: Date | null
    recalled: boolean
  }>>()
  if (productIds.length > 0) {
    const lots = await prisma.lot.findMany({
      where: { productId: { in: productIds }, unitsRemaining: { gt: 0 } },
      orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
      select: {
        id: true, productId: true, lotNumber: true,
        unitsRemaining: true, unitsReceived: true, expiresAt: true,
        recalls: { where: { status: 'OPEN' }, select: { id: true }, take: 1 },
      },
    })
    for (const lot of lots) {
      const arr = lotsByProductId.get(lot.productId) ?? []
      arr.push({
        id: lot.id,
        lotNumber: lot.lotNumber,
        unitsRemaining: lot.unitsRemaining,
        unitsReceived: lot.unitsReceived,
        expiresAt: lot.expiresAt,
        recalled: lot.recalls.length > 0,
      })
      lotsByProductId.set(lot.productId, arr)
    }
  }

  return {
    ...count,
    items: count.items.map((it) => ({
      ...it,
      productName: nameById.get(it.productId) ?? null,
      variance:
        it.countedQuantity != null
          ? it.countedQuantity - it.expectedQuantity
          : null,
      // L.14 — empty array for non-lot-tracked products
      // (operator UI hides the section when length === 0).
      lots: lotsByProductId.get(it.productId) ?? [],
    })),
  }
}

// ── Reads for Claude's stock tools (no route had them) ───────────────────────────────────────────────────

/** Who owns a location's number: Nexus, Amazon (the FBA mirror) or Shopify. Only Nexus's own can change in Nexus. */
export function locationOwner(type: string): { managedBy: 'nexus' | 'amazon-fba' | 'shopify'; readOnly: boolean } {
  if (type === 'AMAZON_FBA') return { managedBy: 'amazon-fba', readOnly: true }
  if (type === 'SHOPIFY_LOCATION') return { managedBy: 'shopify', readOnly: true }
  return { managedBy: 'nexus', readOnly: false }
}

/** The quantity bands of the stock page's status filter (GET /api/stock): out 0, critical 1–5, low 6–15, in stock >15. */
export const STOCK_BANDS = {
  out: { quantity: 0 },
  critical: { quantity: { gt: 0, lte: 5 } },
  low: { quantity: { gt: 5, lte: 15 } },
  'in-stock': { quantity: { gt: 15 } },
} as const satisfies Record<string, Prisma.StockLevelWhereInput>
export type StockBand = keyof typeof STOCK_BANDS

export function stockBand(quantity: number): StockBand {
  return quantity <= 0 ? 'out' : quantity <= 5 ? 'critical' : quantity <= 15 ? 'low' : 'in-stock'
}

/** A position in the stock rows' order (SKU, location code, row id). */
export interface StockRowPosition { sku: string; locationCode: string; id: string }

/**
 * Stock rows of products that are not deleted and not parents (as the stock page lists them), in one fixed order
 * (SKU, location code, id). `next` is where the following page starts (strictly after it), or null on the last page.
 * "Below its own threshold" compares two columns, so it is filtered while reading: a page may hold fewer rows and
 * still have a next one.
 */
export async function stockRowPage(args: {
  text?: string
  locationCode?: string
  locationType?: string
  band?: StockBand
  belowThreshold?: boolean
  after?: StockRowPosition | null
  take: number
}) {
  const where: Prisma.StockLevelWhereInput[] = [{ product: { isParent: false, deletedAt: null } }]
  if (args.text) {
    where.push({ product: { OR: [
      { sku: { contains: args.text, mode: 'insensitive' } },
      { name: { contains: args.text, mode: 'insensitive' } },
      { amazonAsin: { contains: args.text, mode: 'insensitive' } },
    ] } })
  }
  if (args.locationCode) where.push({ location: { code: args.locationCode } })
  if (args.locationType) where.push({ location: { type: args.locationType as never } })
  if (args.band) where.push(STOCK_BANDS[args.band])
  const a = args.after
  if (a) {
    where.push({ OR: [
      { product: { sku: { gt: a.sku } } },
      { product: { sku: a.sku }, location: { code: { gt: a.locationCode } } },
      { product: { sku: a.sku }, location: { code: a.locationCode }, id: { gt: a.id } },
    ] })
  }
  const window = args.belowThreshold ? Math.max(args.take * 5, 200) : args.take + 1
  const rows = await prisma.stockLevel.findMany({
    where: { AND: where },
    orderBy: [{ product: { sku: 'asc' } }, { location: { code: 'asc' } }, { id: 'asc' }],
    take: window,
    select: {
      id: true, quantity: true, reserved: true, available: true, variationId: true,
      location: { select: { code: true, name: true, type: true } },
      product: { select: { id: true, sku: true, name: true, lowStockThreshold: true } },
    },
  })
  const position = (r: (typeof rows)[number]): StockRowPosition => ({ sku: r.product.sku, locationCode: r.location.code, id: r.id })
  const kept = args.belowThreshold ? rows.filter((r) => r.quantity <= r.product.lowStockThreshold) : rows
  if (kept.length > args.take) return { items: kept.slice(0, args.take), next: position(kept[args.take - 1]) }
  // Every row read was kept and there were no more; or the scan window ended: go on after the last row scanned.
  const more = args.belowThreshold && rows.length === window
  return { items: kept, next: more ? position(rows[rows.length - 1]) : null }
}

/** A position in the ledger's order (newest first: time, then id). */
export interface MovementPosition { at: string; id: string }

/**
 * The stock ledger, newest first. A deleted product's movements stay in the ledger but are left out here, as the
 * product is (StockMovement has no product relation to filter on, so they are dropped while reading).
 */
export async function stockMovementPage(args: {
  productId?: string
  sku?: string
  locationCode?: string
  reasons?: string[]
  since?: Date
  after?: MovementPosition | null
  take: number
}) {
  const where: Prisma.StockMovementWhereInput[] = []
  const productIds = args.productId
    ? [args.productId]
    : args.sku
      ? (await prisma.product.findMany({ where: { sku: args.sku, deletedAt: null }, select: { id: true } })).map((p) => p.id)
      : null
  if (productIds) where.push({ productId: { in: productIds } })
  if (args.locationCode) {
    where.push({ OR: [{ location: { code: args.locationCode } }, { fromLocation: { code: args.locationCode } }, { toLocation: { code: args.locationCode } }] })
  }
  if (args.reasons?.length) where.push({ reason: { in: args.reasons as never[] } })
  if (args.since) where.push({ createdAt: { gte: args.since } })
  if (args.after) {
    const at = new Date(args.after.at)
    where.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: args.after.id } }] })
  }
  const rows = await prisma.stockMovement.findMany({
    where: { AND: where },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: args.take + 1,
    select: {
      id: true, productId: true, change: true, balanceAfter: true, quantityBefore: true, reason: true,
      referenceType: true, referenceId: true, notes: true, actor: true, createdAt: true, orderId: true,
      consumerWorkspaceId: true, consumerOrderRef: true,
      location: { select: { code: true, type: true } },
      fromLocation: { select: { code: true } },
      toLocation: { select: { code: true } },
    },
  })
  const page = rows.slice(0, args.take)
  const last = page.at(-1)
  const next: MovementPosition | null = rows.length > args.take && last ? { at: last.createdAt.toISOString(), id: last.id } : null
  const ids = [...new Set(page.map((r) => r.productId))]
  const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, name: true, deletedAt: true } }) : []
  const byId = new Map(products.map((p) => [p.id, p]))
  const items = page.flatMap((r) => {
    const product = byId.get(r.productId)
    return product && !product.deletedAt ? [{ ...r, product: { sku: product.sku, name: product.name } }] : []
  })
  return { items, next }
}
