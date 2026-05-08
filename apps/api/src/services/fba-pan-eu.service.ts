/**
 * S.25 — Pan-EU FBA distribution service.
 *
 * Reads + maintains FbaInventoryDetail rows. The 15-min FBA inventory
 * cron keeps the AGGREGATE AMAZON-EU-FBA StockLevel fresh; this
 * service adds the per-(marketplace × FC × condition) breakdown
 * needed for distribution visibility, aged-inventory tracking, and
 * unfulfillable triage.
 *
 *   syncFbaPanEuInventory(adapter)
 *     Cron entrypoint. Pulls the per-FC details from SP-API and
 *     upserts FbaInventoryDetail rows. Sets firstReceivedAt only on
 *     newly-created rows; preserves on update so age tracking is
 *     honest. Returns sync summary.
 *
 *   getPanEuSnapshot()
 *     Dashboard read. Returns:
 *       - per-FC totals (one row per (marketplace × FC) combo)
 *       - top-N aged sellable inventory (firstReceivedAt > thresholdDays)
 *       - top-N unfulfillable rows (by quantity)
 *
 *   getAgedInventory({ thresholdDays, limit })
 *     Aged-inventory drill. Default 180 days = LTSF warning band;
 *     365 days = LTSF critical band.
 *
 *   getUnfulfillable({ limit })
 *     Damaged / disposal-candidate units across the network.
 *
 * Adapter is parameter-injected: production wires the real SP-API
 * client; tests pass a mock with the same shape. Unconfigured
 * environments use the fbaPanEuUnconfiguredAdapter and return empty.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export interface PanEuRawRow {
  sku: string
  asin?: string
  marketplaceId: string
  fulfillmentCenterId: string
  /** Pre-mapped to one of our 5 conditions. Adapter does the
   *  Amazon-name → our-name translation. */
  condition: 'SELLABLE' | 'UNFULFILLABLE' | 'INBOUND' | 'RESERVED' | 'RESEARCHING'
  quantity: number
  /** ISO timestamp from Amazon when first received at this FC, if known. */
  firstReceivedAt?: string
  /** Raw payload preserved for audit. */
  raw?: unknown
}

export interface PanEuAdapter {
  getInventoryDetails(): Promise<PanEuRawRow[]>
}

export interface SyncSummary {
  rowsUpserted: number
  rowsCreated: number
  rowsUpdated: number
  productsTouched: number
  errors: Array<{ sku: string; error: string }>
  durationMs: number
}

/** Stub adapter — used when SP-API is not configured. Returns
 *  empty so the cron is a no-op without crashing. */
export const fbaPanEuUnconfiguredAdapter: PanEuAdapter = {
  async getInventoryDetails() {
    return []
  },
}

/**
 * Cron entrypoint. Pulls every per-FC row from the adapter and
 * upserts FbaInventoryDetail rows. Idempotent on the unique
 * (sku, marketplaceId, fulfillmentCenterId, condition) constraint.
 *
 * firstReceivedAt is set ONLY on creation. Updates preserve the
 * existing value so age computation reflects when the units actually
 * landed at the FC, not when we last polled.
 */
export async function syncFbaPanEuInventory(adapter: PanEuAdapter): Promise<SyncSummary> {
  const startedAt = Date.now()
  const summary: SyncSummary = {
    rowsUpserted: 0,
    rowsCreated: 0,
    rowsUpdated: 0,
    productsTouched: 0,
    errors: [],
    durationMs: 0,
  }

  let rows: PanEuRawRow[]
  try {
    rows = await adapter.getInventoryDetails()
  } catch (err) {
    logger.error('fba-pan-eu: getInventoryDetails failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    summary.durationMs = Date.now() - startedAt
    summary.errors.push({ sku: '*', error: err instanceof Error ? err.message : String(err) })
    return summary
  }

  if (rows.length === 0) {
    summary.durationMs = Date.now() - startedAt
    return summary
  }

  // Resolve productIds in one batched query so per-row writes don't
  // each hit Product.
  const skus = Array.from(new Set(rows.map((r) => r.sku)))
  const products = await prisma.product.findMany({
    where: { sku: { in: skus } },
    select: { id: true, sku: true },
  })
  const productIdBySku = new Map(products.map((p) => [p.sku, p.id]))
  const touchedProductIds = new Set<string>()

  const now = new Date()
  for (const r of rows) {
    try {
      const productId = productIdBySku.get(r.sku) ?? null
      const firstReceivedAt = r.firstReceivedAt ? new Date(r.firstReceivedAt) : null
      // Lookup-then-write so we can detect created vs updated and so
      // firstReceivedAt is preserved on update. The unique index
      // would let us use upsert(), but Prisma's upsert doesn't have
      // an idiomatic "preserve column on update" — explicit branch.
      const existing = await prisma.fbaInventoryDetail.findUnique({
        where: {
          sku_marketplaceId_fulfillmentCenterId_condition: {
            sku: r.sku,
            marketplaceId: r.marketplaceId,
            fulfillmentCenterId: r.fulfillmentCenterId,
            condition: r.condition,
          },
        },
        select: { id: true, firstReceivedAt: true },
      })
      if (existing) {
        await prisma.fbaInventoryDetail.update({
          where: { id: existing.id },
          data: {
            productId,
            asin: r.asin ?? undefined,
            quantity: r.quantity,
            // Preserve the original firstReceivedAt unless it was null
            // and the adapter just discovered it.
            firstReceivedAt: existing.firstReceivedAt ?? firstReceivedAt,
            lastSyncedAt: now,
            rawData: (r.raw ?? null) as object | null,
          },
        })
        summary.rowsUpdated++
      } else {
        await prisma.fbaInventoryDetail.create({
          data: {
            productId,
            sku: r.sku,
            asin: r.asin ?? null,
            marketplaceId: r.marketplaceId,
            fulfillmentCenterId: r.fulfillmentCenterId,
            condition: r.condition,
            quantity: r.quantity,
            firstReceivedAt: firstReceivedAt ?? now,
            lastSyncedAt: now,
            rawData: (r.raw ?? null) as object | null,
          },
        })
        summary.rowsCreated++
      }
      summary.rowsUpserted++
      if (productId) touchedProductIds.add(productId)
    } catch (err) {
      summary.errors.push({
        sku: r.sku,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  summary.productsTouched = touchedProductIds.size
  summary.durationMs = Date.now() - startedAt
  logger.info('fba-pan-eu: sync complete', {
    rowsUpserted: summary.rowsUpserted,
    rowsCreated: summary.rowsCreated,
    rowsUpdated: summary.rowsUpdated,
    productsTouched: summary.productsTouched,
    durationMs: summary.durationMs,
    errorCount: summary.errors.length,
  })
  return summary
}

/**
 * Per-FC summary cards for the dashboard. One row per
 * (marketplaceId × fulfillmentCenterId) combo.
 */
export async function listPerFcTotals(): Promise<Array<{
  marketplaceId: string
  fulfillmentCenterId: string
  skuCount: number
  sellable: number
  unfulfillable: number
  inbound: number
  reserved: number
  researching: number
}>> {
  const rows = await prisma.fbaInventoryDetail.findMany({
    select: {
      marketplaceId: true,
      fulfillmentCenterId: true,
      condition: true,
      quantity: true,
      sku: true,
    },
  })

  type Bucket = {
    marketplaceId: string
    fulfillmentCenterId: string
    skus: Set<string>
    sellable: number
    unfulfillable: number
    inbound: number
    reserved: number
    researching: number
  }
  const map = new Map<string, Bucket>()
  for (const r of rows) {
    const key = `${r.marketplaceId}|${r.fulfillmentCenterId}`
    let b = map.get(key)
    if (!b) {
      b = {
        marketplaceId: r.marketplaceId,
        fulfillmentCenterId: r.fulfillmentCenterId,
        skus: new Set(),
        sellable: 0,
        unfulfillable: 0,
        inbound: 0,
        reserved: 0,
        researching: 0,
      }
      map.set(key, b)
    }
    b.skus.add(r.sku)
    if (r.condition === 'SELLABLE') b.sellable += r.quantity
    else if (r.condition === 'UNFULFILLABLE') b.unfulfillable += r.quantity
    else if (r.condition === 'INBOUND') b.inbound += r.quantity
    else if (r.condition === 'RESERVED') b.reserved += r.quantity
    else if (r.condition === 'RESEARCHING') b.researching += r.quantity
  }

  return Array.from(map.values())
    .map((b) => ({
      marketplaceId: b.marketplaceId,
      fulfillmentCenterId: b.fulfillmentCenterId,
      skuCount: b.skus.size,
      sellable: b.sellable,
      unfulfillable: b.unfulfillable,
      inbound: b.inbound,
      reserved: b.reserved,
      researching: b.researching,
    }))
    .sort((a, b) =>
      a.marketplaceId.localeCompare(b.marketplaceId)
        || a.fulfillmentCenterId.localeCompare(b.fulfillmentCenterId),
    )
}

/**
 * Aged-inventory rows. Defaults to the LTSF warning threshold (180d);
 * UI exposes 90/180/365 chips so operators can adjust.
 */
export async function getAgedInventory(opts: {
  thresholdDays?: number
  limit?: number
} = {}): Promise<Array<{
  id: string
  productId: string | null
  sku: string
  asin: string | null
  marketplaceId: string
  fulfillmentCenterId: string
  condition: string
  quantity: number
  firstReceivedAt: Date | null
  ageDays: number | null
  productName: string | null
  thumbnailUrl: string | null
  // S.33 — surface the Pareto band per row so operators can prioritise
  // disposal of low-value (C/D) aged inventory and investigate why
  // high-value (A/B) is sitting > thresholdDays.
  abcClass: 'A' | 'B' | 'C' | 'D' | null
}>> {
  const thresholdDays = Math.max(1, opts.thresholdDays ?? 180)
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100))
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - thresholdDays)

  const rows = await prisma.fbaInventoryDetail.findMany({
    where: {
      condition: 'SELLABLE',
      quantity: { gt: 0 },
      firstReceivedAt: { lte: cutoff, not: null },
    },
    orderBy: { firstReceivedAt: 'asc' },
    take: limit,
    include: {
      product: {
        select: {
          name: true,
          abcClass: true,
          images: { select: { url: true }, take: 1 },
        },
      },
    },
  })

  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    sku: r.sku,
    asin: r.asin,
    marketplaceId: r.marketplaceId,
    fulfillmentCenterId: r.fulfillmentCenterId,
    condition: r.condition,
    quantity: r.quantity,
    firstReceivedAt: r.firstReceivedAt,
    ageDays: r.firstReceivedAt
      ? Math.floor((now - r.firstReceivedAt.getTime()) / 86400000)
      : null,
    productName: r.product?.name ?? null,
    thumbnailUrl: r.product?.images?.[0]?.url ?? null,
    abcClass: (r.product?.abcClass ?? null) as 'A' | 'B' | 'C' | 'D' | null,
  }))
}

/**
 * Unfulfillable rows — damaged, expired, customer-returned-not-
 * sellable. Sorted by quantity DESC so the biggest pools surface
 * first.
 */
export async function getUnfulfillable(opts: {
  limit?: number
} = {}): Promise<Array<{
  id: string
  productId: string | null
  sku: string
  asin: string | null
  marketplaceId: string
  fulfillmentCenterId: string
  quantity: number
  firstReceivedAt: Date | null
  productName: string | null
  thumbnailUrl: string | null
  // S.33 — see getAgedInventory.
  abcClass: 'A' | 'B' | 'C' | 'D' | null
}>> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100))
  const rows = await prisma.fbaInventoryDetail.findMany({
    where: { condition: 'UNFULFILLABLE', quantity: { gt: 0 } },
    orderBy: { quantity: 'desc' },
    take: limit,
    include: {
      product: {
        select: {
          name: true,
          abcClass: true,
          images: { select: { url: true }, take: 1 },
        },
      },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    sku: r.sku,
    asin: r.asin,
    marketplaceId: r.marketplaceId,
    fulfillmentCenterId: r.fulfillmentCenterId,
    quantity: r.quantity,
    firstReceivedAt: r.firstReceivedAt,
    productName: r.product?.name ?? null,
    thumbnailUrl: r.product?.images?.[0]?.url ?? null,
    abcClass: (r.product?.abcClass ?? null) as 'A' | 'B' | 'C' | 'D' | null,
  }))
}

/**
 * Single-shot dashboard read. Combines per-FC totals + top aged +
 * top unfulfillable so the page renders with one fetch.
 */
export async function getPanEuSnapshot(): Promise<{
  perFc: Awaited<ReturnType<typeof listPerFcTotals>>
  aged: Awaited<ReturnType<typeof getAgedInventory>>
  unfulfillable: Awaited<ReturnType<typeof getUnfulfillable>>
  generatedAt: Date
}> {
  const [perFc, aged, unfulfillable] = await Promise.all([
    listPerFcTotals(),
    getAgedInventory({ thresholdDays: 180, limit: 50 }),
    getUnfulfillable({ limit: 50 }),
  ])
  return { perFc, aged, unfulfillable, generatedAt: new Date() }
}
