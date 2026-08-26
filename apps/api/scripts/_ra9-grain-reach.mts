/**
 * RA.GRAIN — the reach of all four grains, and the size of a product picker. READ-ONLY.
 *
 * Extends `_ra1-grain.mts`. Re-confirms its numbers (they are days old) and adds the three the
 * proposal needs and it did not answer:
 *   · how many distinct `Product` PARENTS the advertised ASINs roll up to  → picker size
 *   · the campaign reach of each product parent                            → the number the UI must show
 *   · whether the flat `AdProductAd.asin` column under-reports a multi-ASIN creative
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
  prisma.$queryRawUnsafe<T[]>(sql)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

console.log('\n═══ 1 · REACH OF EACH GRAIN (campaigns it can bind) ═══')
const totalCampaigns = (await q<{ n: number }>(`SELECT COUNT(*)::int n FROM "Campaign"`))[0].n
console.log(`total campaigns: ${totalCampaigns}`)

const byMarket = await q(`SELECT marketplace, COUNT(*)::int n FROM "Campaign" GROUP BY marketplace ORDER BY n DESC`)
console.log(`MARKET   — every campaign has one: ${j(byMarket)}`)

const pf = await q<{ with_pf: number; without_pf: number; distinct_pf: number }>(`
  SELECT COUNT("portfolioId")::int with_pf,
         (COUNT(*) - COUNT("portfolioId"))::int without_pf,
         COUNT(DISTINCT "portfolioId")::int distinct_pf
  FROM "Campaign"`)
console.log(`PORTFOLIO — ${j(pf[0])}  ← campaigns with no portfolio are unreachable by any portfolio binding`)
const emptyPf = await q(`
  SELECT p."externalPortfolioId", p.name, COUNT(c.id)::int campaigns
  FROM "AmazonAdsPortfolio" p LEFT JOIN "Campaign" c ON c."portfolioId" = p."externalPortfolioId"
  GROUP BY p."externalPortfolioId", p.name ORDER BY campaigns ASC`)
console.log(`  per portfolio: ${j(emptyPf)}`)

const prodReach = await q<{ n: number }>(`
  SELECT COUNT(DISTINCT g."campaignId")::int n
  FROM "AdProductAd" pa JOIN "AdGroup" g ON g.id = pa."adGroupId"
  WHERE pa.asin IS NOT NULL`)
console.log(`PRODUCT  — campaigns reachable via AdProductAd→AdGroup→Campaign: ${prodReach[0].n}`)

console.log('\n═══ 2 · THE PRODUCT PICKER — how many rows would it hold? ═══')
const asins = await q<{ distinct_asins: number; rows: number; with_product: number; without_product: number }>(`
  SELECT COUNT(DISTINCT asin)::int distinct_asins, COUNT(*)::int rows,
         COUNT("productId")::int with_product, (COUNT(*) - COUNT("productId"))::int without_product
  FROM "AdProductAd"`)
console.log(`AdProductAd: ${j(asins[0])}`)

const parents = await q<{ distinct_parents: number }>(`
  SELECT COUNT(DISTINCT "productId")::int distinct_parents FROM "AdProductAd" WHERE "productId" IS NOT NULL`)
console.log(`distinct Product PARENTS advertised (the picker's row count): ${parents[0].distinct_parents}`)

// Could an ASIN→ProductVariation lookup name any of the currently-unlinked rows?
const rescue = await q<{ unlinked_rows: number; unlinked_asins: number; rescuable_by_variation: number; rescuable_by_parent_asin: number }>(`
  WITH unl AS (SELECT DISTINCT asin FROM "AdProductAd" WHERE "productId" IS NULL AND asin IS NOT NULL)
  SELECT (SELECT COUNT(*)::int FROM "AdProductAd" WHERE "productId" IS NULL) unlinked_rows,
         (SELECT COUNT(*)::int FROM unl) unlinked_asins,
         (SELECT COUNT(*)::int FROM unl WHERE asin IN (SELECT "amazonAsin" FROM "ProductVariation" WHERE "amazonAsin" IS NOT NULL)) rescuable_by_variation,
         (SELECT COUNT(*)::int FROM unl WHERE asin IN (SELECT "amazonAsin" FROM "Product" WHERE "amazonAsin" IS NOT NULL)) rescuable_by_parent_asin`)
console.log(`unlinked: ${j(rescue[0])}`)
console.log('  ↑ if rescuable_* are 0, the catalogue genuinely lacks them and only the Amazon import fixes it')

const sampleUnlinked = await q(`
  SELECT DISTINCT asin FROM "AdProductAd" WHERE "productId" IS NULL AND asin IS NOT NULL ORDER BY asin LIMIT 8`)
console.log(`  sample unlinked ASINs: ${j(sampleUnlinked)}`)

console.log('\n═══ 3 · PRODUCT-PARENT REACH — the number the UI must state before a bind ═══')
const parentReach = await q(`
  SELECT p.name, COUNT(DISTINCT g."campaignId")::int campaigns, COUNT(DISTINCT pa.asin)::int asins
  FROM "AdProductAd" pa
  JOIN "AdGroup" g ON g.id = pa."adGroupId"
  JOIN "Product" p ON p.id = pa."productId"
  GROUP BY p.id, p.name ORDER BY campaigns DESC`)
console.log(`per product parent (name · campaigns · asins):`)
for (const r of parentReach as Array<{ name: string; campaigns: number; asins: number }>) {
  console.log(`   ${String(r.campaigns).padStart(4)} campaigns · ${String(r.asins).padStart(3)} asins  ${String(r.name).slice(0, 66)}`)
}

const asinReach = await q(`
  SELECT reach, COUNT(*)::int asins FROM (
    SELECT pa.asin, COUNT(DISTINCT g."campaignId")::int reach
    FROM "AdProductAd" pa JOIN "AdGroup" g ON g.id = pa."adGroupId"
    WHERE pa.asin IS NOT NULL GROUP BY pa.asin
  ) t GROUP BY reach ORDER BY reach DESC LIMIT 12`)
console.log(`\nsingle-ASIN fan-out (top): ${j(asinReach)}`)

console.log('\n═══ 4 · THE MULTI-ASIN CREATIVE TRAP ═══')
// AdProductAd has @@unique([adGroupId, asin]) and the flat asin column holds only the FIRST
// product of a v1 creative.products[] array. If creatives routinely carry more, the flat column
// under-reports which products an ad actually advertises — and a product-scoped rule built on it
// would miss campaigns it should match.
const multi = await q<{ rows_with_creative: number; rows_multi_product: number; max_products: number }>(`
  SELECT COUNT(*)::int rows_with_creative,
         COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE("creativeJson"->'products', '[]'::jsonb)) > 1)::int rows_multi_product,
         COALESCE(MAX(jsonb_array_length(COALESCE("creativeJson"->'products', '[]'::jsonb))), 0)::int max_products
  FROM "AdProductAd" WHERE "creativeJson" IS NOT NULL`)
console.log(`creativeJson->products: ${j(multi[0])}`)

console.log('\n═══ 5 · WHAT SCOPE THE 51 RULES ACTUALLY CARRY ═══')
const scoped = await q(`
  SELECT COUNT(*)::int total,
         COUNT("scopeMarketplace")::int with_market,
         COUNT("scopePortfolioId")::int with_portfolio,
         COUNT("scopeCampaignId")::int with_campaign,
         COUNT(*) FILTER (WHERE "scopeMarketplace" IS NOT NULL AND ("scopePortfolioId" IS NOT NULL OR "scopeCampaignId" IS NOT NULL))::int composed
  FROM "AutomationRule" WHERE domain = 'advertising'`)
console.log(`${j(scoped[0])}`)
console.log('  `composed` > 0 would prove market AND portfolio/campaign already coexist on a row')
const marketScoped = await q(`
  SELECT "scopeMarketplace", COUNT(*)::int n FROM "AutomationRule"
  WHERE domain='advertising' AND "scopeMarketplace" IS NOT NULL GROUP BY "scopeMarketplace"`)
console.log(`  market-scoped rules: ${j(marketScoped)}`)

console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
