/** RA.1 — can we scope a rule to a product / product line today? Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const q = async (label: string, sql: string) => {
  try {
    const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql)
    console.log('\n' + label, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
  } catch (e) { console.log('\n' + label, 'ERR', (e as Error).message.slice(0, 200)) }
}

await q('AdProductAd — ASIN/SKU/Product coverage:', `
  SELECT COUNT(*)::int rows,
         COUNT(asin)::int with_asin,
         COUNT(sku)::int with_sku,
         COUNT("productId")::int linked_to_pim,
         COUNT(DISTINCT asin)::int distinct_asins
  FROM "AdProductAd"`)

await q('ASIN -> campaign fan-out (how many campaigns advertise one ASIN):', `
  SELECT reach, COUNT(*)::int asins FROM (
    SELECT pa.asin, COUNT(DISTINCT g."campaignId")::int reach
    FROM "AdProductAd" pa JOIN "AdGroup" g ON g.id = pa."adGroupId"
    WHERE pa.asin IS NOT NULL GROUP BY pa.asin
  ) t GROUP BY reach ORDER BY reach`)

await q('Campaigns reachable from an ASIN at all:', `
  SELECT COUNT(DISTINCT g."campaignId")::int campaigns_with_asin
  FROM "AdProductAd" pa JOIN "AdGroup" g ON g.id = pa."adGroupId"
  WHERE pa.asin IS NOT NULL`)

await q('Product line: do linked Products carry a family/parent?', `
  SELECT COUNT(*)::int linked,
         COUNT(p."parentSku")::int with_parent_sku
  FROM "AdProductAd" pa JOIN "Product" p ON p.id = pa."productId"`)

await q('Portfolio coverage of campaigns (is portfolio a usable grain?):', `
  SELECT COUNT(*)::int campaigns,
         COUNT("portfolioId")::int with_portfolio,
         COUNT(DISTINCT "portfolioId")::int distinct_portfolios
  FROM "Campaign"`)

await q('Campaigns per marketplace:', `
  SELECT marketplace, COUNT(*)::int n FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)

await prisma.$disconnect()
