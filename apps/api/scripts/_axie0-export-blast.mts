const { default: p } = await import('../src/db.js')
const q = async (label: string, sql: string) => {
  const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(sql)
  console.log(label, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
}
await q('CAMPAIGNS_TOTAL', `SELECT count(*)::bigint n FROM "Campaign"`)
await q('MAX_TARGETS_PER_ADGROUP', `SELECT max(c)::bigint mx, avg(c)::numeric(8,1) avg FROM (SELECT "adGroupId", count(*) c FROM "AdTarget" WHERE "isNegative"=false GROUP BY 1) x`)
await q('NEGATIVES_EXCLUDED', `SELECT count(*)::bigint n FROM "AdTarget" WHERE "isNegative"=true`)
await q('PRODUCT_ADS_MISSING', `SELECT count(*)::bigint n FROM "AdProductAd"`)
await q('BY_ADPRODUCT', `SELECT COALESCE("adProduct",'(null)') ap, count(*)::bigint n FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)
await q('PORTFOLIO_SET', `SELECT count(*) FILTER (WHERE "portfolioId" IS NOT NULL)::bigint with_pf, count(*)::bigint total FROM "Campaign"`)
await q('LONG_EXTERNAL_IDS', `SELECT max(length("externalCampaignId"))::int max_len, count(*) FILTER (WHERE length("externalCampaignId") >= 16)::bigint ge16 FROM "Campaign"`)
await p.$disconnect()
