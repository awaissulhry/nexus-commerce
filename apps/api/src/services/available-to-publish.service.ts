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
  /** Sum of own-warehouse StockLevel.available (= quantity − reserved). */
  warehouseAvailable: number
  /** Sum of FBA SELLABLE quantity for this sku + marketplace. */
  fbaSellable: number
  /** ChannelListing.stockBuffer — units hidden from the marketplace. */
  stockBuffer: number
}

export type AvailableToPublishResult = {
  /** Final publishable quantity (>= 0). */
  available: number
  /** Which pool fed it. */
  pool: 'FBA' | 'FBM_WAREHOUSE'
  /** Raw pool quantity before the buffer. */
  poolQuantity: number
  /** Buffer actually applied (clamped to >= 0). */
  bufferApplied: number
}

export function computeAvailableToPublish(input: AvailableToPublishInput): AvailableToPublishResult {
  const pool: 'FBA' | 'FBM_WAREHOUSE' =
    input.fulfillmentMethod === 'FBA' ? 'FBA' : 'FBM_WAREHOUSE'
  const poolQuantity = pool === 'FBA' ? input.fbaSellable : input.warehouseAvailable
  const bufferApplied = Math.max(0, input.stockBuffer)
  const available = Math.max(0, poolQuantity - bufferApplied)
  return { available, pool, poolQuantity, bufferApplied }
}
