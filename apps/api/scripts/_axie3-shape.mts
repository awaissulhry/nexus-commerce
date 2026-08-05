const { default: p } = await import('../src/db.js')
const q = async (l: string, sql: string) => {
  const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(sql)
  console.log(l, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
}
await q('NEGATIVES', `SELECT "negativeLevel", "expressionType", count(*)::bigint n FROM "AdTarget" WHERE "isNegative"=true GROUP BY 1,2 ORDER BY 3 DESC`)
await q('PRODUCT_ADS', `SELECT count(*)::bigint total, count(sku)::bigint with_sku, count(asin)::bigint with_asin, count("externalAdId")::bigint with_extid FROM "AdProductAd"`)
await q('PORTFOLIOS', `SELECT count(*)::bigint n FROM "AmazonAdsPortfolio"`)
await q('PLACEMENT_BIDS', `SELECT count(*)::bigint campaigns_with_placement_bidding FROM "Campaign"
  WHERE "dynamicBidding" IS NOT NULL AND jsonb_array_length(COALESCE(("dynamicBidding"->'placementBidding')::jsonb,'[]'::jsonb)) > 0`)
await q('POS_TARGET_KINDS', `SELECT kind, "expressionType", count(*)::bigint n FROM "AdTarget" WHERE "isNegative"=false GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`)
await p.$disconnect()
