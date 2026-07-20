// FCF.2 — available-to-publish per fulfillment pool.
//
// Pure function: given a listing's fulfillment method, the candidate stock
// pools, and its overselling buffer, return how many units may be published
// to that listing. No I/O — callers run the queries and pass the buckets
// (mirrors fulfillment-derivation.service.ts).
//
// The pools are physically distinct:
//   - FBM listing (eBay + Amazon-FBM): backed by the OWN-warehouse pool
//     (StockLevel.available across WAREHOUSE locations — already
//     reserved-adjusted). FBA stock sits at Amazon and cannot ship these.
//   - FBA listing: backed by Amazon FBA SELLABLE inventory
//     (FbaInventoryDetail condition='SELLABLE' for the sku+marketplace).
//     INBOUND / UNFULFILLABLE / RESERVED are deliberately excluded.
//
// The stockBuffer is subtracted from whichever pool feeds the listing so the
// marketplace never sees the last `buffer` units (overselling protection).

export type AvailableToPublishInput = {
  fulfillmentMethod: 'FBA' | 'FBM'
  /** Sum of own-warehouse StockLevel.available (= quantity − reserved). Already
   *  nets HARD reservations, so FBM callers pass pendingReserved = 0. */
  warehouseAvailable: number
  /** Sum of FBA SELLABLE quantity for this sku + marketplace. This is Amazon's
   *  number and does NOT net our in-flight MCF reservations — pass those via
   *  pendingReserved (FCF.6). */
  fbaSellable: number
  /** ChannelListing.stockBuffer — units hidden from the marketplace. */
  stockBuffer: number
  /** FCF.6 — units already committed against the chosen pool but still counted
   *  in its quantity (e.g. pending MCF reservations still in FBA SELLABLE).
   *  Subtracted before the buffer. Defaults to 0. */
  pendingReserved?: number
}

export type AvailableToPublishResult = {
  /** Final publishable quantity (>= 0). */
  available: number
  /** Which pool fed it. */
  pool: 'FBA' | 'FBM_WAREHOUSE'
  /** Raw pool quantity before reservations + buffer. */
  poolQuantity: number
  /** Pending reservations actually applied (clamped to >= 0). */
  reservedApplied: number
  /** Buffer actually applied (clamped to >= 0). */
  bufferApplied: number
}

// ── FFT-I3 (GAP 1) — feed-path pool clamp for FOLLOWING FBM rows ─────────────
//
// The direct feed submit shipped the grid cell verbatim: a qty typed into a
// Following row went to Amazon as-is while the row still said Follow. For
// Following rows the POOL is the only truth — this mirrors the dispatch-time
// clamp for the feed path. Pinned rows keep their typed value (explicit
// intent); FBA never ships a qty at all (hard-blocked upstream).

export interface FollowingClampInfo {
  followMasterQuantity: boolean
  fulfillmentMethod: string | null
  stockBuffer: number
  warehouseAvailable: number
  pendingReserved?: number
}

/** Pure planner — mutates the rows' qty cell to pool truth; returns the changes. */
export function planFollowingQtyClamp(
  rows: Array<Record<string, unknown>>,
  infoBySku: ReadonlyMap<string, FollowingClampInfo>,
): Array<{ sku: string; from: string; to: string }> {
  const out: Array<{ sku: string; from: string; to: string }> = []
  for (const row of rows) {
    const sku = String(row.item_sku ?? '').trim()
    if (!sku) continue
    const info = infoBySku.get(sku)
    if (!info || !info.followMasterQuantity || info.fulfillmentMethod === 'FBA') continue
    const cell = String(row['fulfillment_availability__quantity'] ?? '').trim()
    if (cell === '') continue // no qty in the feed row → nothing to clamp
    const { available } = computeAvailableToPublish({
      fulfillmentMethod: 'FBM',
      warehouseAvailable: info.warehouseAvailable,
      fbaSellable: 0,
      pendingReserved: info.pendingReserved ?? 0,
      stockBuffer: info.stockBuffer,
    })
    const to = String(available)
    if (cell !== to) {
      row['fulfillment_availability__quantity'] = to
      out.push({ sku, from: cell, to })
    }
  }
  return out
}

interface ClampDb {
  channelListing: { findMany: (args: unknown) => Promise<any[]> }
  stockLevel: { findMany: (args: unknown) => Promise<any[]> }
}

/** Prisma wrapper: resolves Following/pool state for the rows' SKUs, then clamps. */
export async function clampFollowingQtyRowsForFeed(
  db: ClampDb,
  rows: Array<Record<string, unknown>>,
  marketplace: string,
): Promise<Array<{ sku: string; from: string; to: string }>> {
  const skus = [...new Set(rows.map((r) => String(r.item_sku ?? '').trim()).filter(Boolean))]
  if (!skus.length) return []
  const listings = await db.channelListing.findMany({
    where: { channel: 'AMAZON', marketplace: marketplace.toUpperCase(), product: { sku: { in: skus }, deletedAt: null } },
    select: {
      followMasterQuantity: true,
      stockBuffer: true,
      productId: true,
      product: { select: { sku: true, fulfillmentMethod: true } },
    },
  })
  const pids = [...new Set(listings.map((l) => l.productId).filter(Boolean))]
  const stock = pids.length
    ? await db.stockLevel.findMany({
        where: { productId: { in: pids } },
        select: { productId: true, available: true, location: { select: { type: true } } },
      })
    : []
  const warehouseByPid = new Map<string, number>()
  for (const s of stock) {
    if (s.location?.type !== 'WAREHOUSE') continue
    warehouseByPid.set(s.productId, (warehouseByPid.get(s.productId) ?? 0) + (s.available ?? 0))
  }
  const infoBySku = new Map<string, FollowingClampInfo>()
  for (const l of listings) {
    infoBySku.set(l.product.sku, {
      followMasterQuantity: l.followMasterQuantity === true,
      fulfillmentMethod: l.product.fulfillmentMethod ?? null,
      stockBuffer: Number(l.stockBuffer ?? 0),
      warehouseAvailable: warehouseByPid.get(l.productId) ?? 0,
    })
  }
  return planFollowingQtyClamp(rows, infoBySku)
}

export function computeAvailableToPublish(input: AvailableToPublishInput): AvailableToPublishResult {
  const pool: 'FBA' | 'FBM_WAREHOUSE' =
    input.fulfillmentMethod === 'FBA' ? 'FBA' : 'FBM_WAREHOUSE'
  const poolQuantity = pool === 'FBA' ? input.fbaSellable : input.warehouseAvailable
  const reservedApplied = Math.max(0, input.pendingReserved ?? 0)
  const bufferApplied = Math.max(0, input.stockBuffer)
  const available = Math.max(0, poolQuantity - reservedApplied - bufferApplied)
  return { available, pool, poolQuantity, reservedApplied, bufferApplied }
}
