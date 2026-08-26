/** READ-ONLY. ADM-H — which of the Ad Manager's 45 columns have a REAL source on prod.
 *  Measures the daily-performance grain the campaigns route already groupBys, plus the
 *  Campaign columns the settings cells claim to show. Never writes. */
const { default: prisma } = await import('../src/db.js')

const since = new Date(Date.now() - 30 * 864e5)
const sinceStr = since.toISOString().slice(0, 10)

// ── 1 · daily-performance CAMPAIGN grain: what is actually populated ────────
const cov = await prisma.$queryRawUnsafe<Array<Record<string, bigint | number>>>(`
  SELECT
    COUNT(*)::bigint                                                        AS rows_total,
    COUNT(DISTINCT "entityId")::bigint                                      AS entities,
    COUNT("units7d")                                                        AS units7d_nonnull,
    SUM(CASE WHEN "units7d" > 0 THEN 1 ELSE 0 END)::bigint                  AS units7d_pos,
    COUNT("salesSameSku7dCents")                                            AS samesku_sales_nonnull,
    SUM(CASE WHEN "salesSameSku7dCents" > 0 THEN 1 ELSE 0 END)::bigint      AS samesku_sales_pos,
    COUNT("ordersSameSku7d")                                                AS samesku_orders_nonnull,
    SUM(CASE WHEN "ordersSameSku7d" > 0 THEN 1 ELSE 0 END)::bigint          AS samesku_orders_pos,
    COUNT("unitsSameSku7d")                                                 AS samesku_units_nonnull,
    SUM(CASE WHEN "unitsSameSku7d" > 0 THEN 1 ELSE 0 END)::bigint           AS samesku_units_pos,
    COUNT("topOfSearchIS")                                                  AS tos_is_nonnull,
    SUM(CASE WHEN "topOfSearchIS" > 0 THEN 1 ELSE 0 END)::bigint            AS tos_is_pos,
    COUNT("ntbOrders14d")                                                   AS ntb_orders_nonnull,
    SUM(CASE WHEN "ntbOrders14d" > 0 THEN 1 ELSE 0 END)::bigint             AS ntb_orders_pos,
    COUNT("ntbSalesCents14d")                                               AS ntb_sales_nonnull,
    SUM(CASE WHEN "ntbSalesCents14d" > 0 THEN 1 ELSE 0 END)::bigint         AS ntb_sales_pos,
    COUNT("viewableImpressions")                                            AS viewimpr_nonnull,
    SUM(CASE WHEN "viewableImpressions" > 0 THEN 1 ELSE 0 END)::bigint      AS viewimpr_pos,
    COUNT("campaignBudgetCents")                                            AS campbudget_nonnull,
    SUM(CASE WHEN "campaignBudgetCents" > 0 THEN 1 ELSE 0 END)::bigint      AS campbudget_pos,
    COUNT("detailPageViews7d")                                              AS dpv_nonnull,
    SUM(CASE WHEN "detailPageViews7d" > 0 THEN 1 ELSE 0 END)::bigint        AS dpv_pos,
    COUNT("orders7d")                                                       AS orders7d_nonnull,
    SUM(CASE WHEN "orders7d" > 0 THEN 1 ELSE 0 END)::bigint                 AS orders7d_pos
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN' AND "date" >= '${sinceStr}'::date
`)
console.log(`\n== AmazonAdsDailyPerformance CAMPAIGN rows, last 30d (since ${sinceStr}) ==`)
for (const [k, v] of Object.entries(cov[0] ?? {})) console.log(`  ${k.padEnd(26)} ${String(v)}`)

// per adProduct, so "SB/SD only" claims can be checked
const byProd = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "adProduct",
         COUNT(*)::bigint AS rows,
         SUM(CASE WHEN "ntbOrders14d" > 0 THEN 1 ELSE 0 END)::bigint AS ntb_pos,
         SUM(CASE WHEN "topOfSearchIS" > 0 THEN 1 ELSE 0 END)::bigint AS tos_pos,
         SUM(CASE WHEN "units7d" > 0 THEN 1 ELSE 0 END)::bigint AS units_pos,
         SUM(CASE WHEN "salesSameSku7dCents" > 0 THEN 1 ELSE 0 END)::bigint AS samesku_pos,
         SUM(CASE WHEN "viewableImpressions" > 0 THEN 1 ELSE 0 END)::bigint AS vimpr_pos
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN' AND "date" >= '${sinceStr}'::date
  GROUP BY "adProduct" ORDER BY 2 DESC
`)
console.log(`\n== by adProduct ==`)
console.table(byProd.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))))

// ── 2 · Campaign columns the settings cells read ────────────────────────────
const camps = await prisma.campaign.findMany({
  select: {
    id: true, name: true, status: true, marketplace: true, adProduct: true,
    dailyBudget: true, minBidCents: true, maxBidCents: true,
    minBudgetCents: true, maxBudgetCents: true, budgetBaselineCents: true,
    liveBidWritesEnabled: true, dynamicBidding: true, acos: true, roas: true,
    spend: true, sales: true, impressions: true, clicks: true,
    startDate: true, endDate: true, biddingStrategy: true, deliveryStatus: true,
  },
})
const n = camps.length
const db = (c: (typeof camps)[number]) => (c.dynamicBidding ?? {}) as Record<string, unknown>
const count = (f: (c: (typeof camps)[number]) => boolean) => camps.filter(f).length
console.log(`\n== Campaign table (${n} rows) ==`)
console.log(`  minBudgetCents set        ${count((c) => c.minBudgetCents != null)}`)
console.log(`  maxBudgetCents set        ${count((c) => c.maxBudgetCents != null)}`)
console.log(`  budgetBaselineCents set   ${count((c) => c.budgetBaselineCents != null)}`)
console.log(`  minBidCents set           ${count((c) => c.minBidCents != null)}`)
console.log(`  maxBidCents set           ${count((c) => c.maxBidCents != null)}`)
console.log(`  liveBidWritesEnabled      ${count((c) => c.liveBidWritesEnabled)}`)
console.log(`  dynamicBidding.bidAutomation true   ${count((c) => db(c).bidAutomation === true)}`)
console.log(`  dynamicBidding.targetAcos set       ${count((c) => db(c).targetAcos != null)}`)
console.log(`  dynamicBidding.bidAlgorithm set     ${count((c) => db(c).bidAlgorithm != null)}`)
console.log(`  placementBidding present            ${count((c) => Array.isArray(db(c).placementBidding) && (db(c).placementBidding as unknown[]).length > 0)}`)
console.log(`  endDate set               ${count((c) => c.endDate != null)}`)
console.log(`  startDate set             ${count((c) => c.startDate != null)}`)
console.log(`  biddingStrategy null      ${count((c) => c.biddingStrategy == null)}`)
console.log(`  deliveryStatus null       ${count((c) => c.deliveryStatus == null)}`)

// ── 3 · the >100% ACoS render trap (pct(): n<=1 ? n*100 : n) ────────────────
const win = await prisma.$queryRawUnsafe<Array<{ localEntityId: string | null; spend_cents: bigint; sales_cents: bigint }>>(`
  SELECT "localEntityId",
         (SUM("costMicros")/10000)::bigint AS spend_cents,
         (SUM(COALESCE("sales7dCents",0)) + SUM(COALESCE("sales14dCents",0)))::bigint AS sales_cents
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN' AND "date" >= '${sinceStr}'::date AND "localEntityId" IS NOT NULL
  GROUP BY "localEntityId"
`)
const overOne = win.filter((r) => Number(r.sales_cents) > 0 && Number(r.spend_cents) / Number(r.sales_cents) > 1)
console.log(`\n== ACoS render trap: window-derived acos fraction > 1 (renders as "1.xx%") ==`)
console.log(`  campaigns with sales>0 in 30d: ${win.filter((r) => Number(r.sales_cents) > 0).length}`)
console.log(`  of those, ACoS > 100%:         ${overOne.length}`)
for (const r of overOne.slice(0, 8)) {
  const frac = Number(r.spend_cents) / Number(r.sales_cents)
  const name = camps.find((c) => c.id === r.localEntityId)?.name ?? r.localEntityId
  console.log(`    ${String(name).slice(0, 44).padEnd(46)} true ${(frac * 100).toFixed(2)}%  →  renders "${frac.toFixed(2)}%"`)
}
// stored column, for the no-date-params callers
const storedOver = camps.filter((c) => c.acos != null && Number(c.acos) > 1)
console.log(`  stored Campaign.acos > 1:      ${storedOver.length} of ${camps.filter((c) => c.acos != null).length} non-null`)

await prisma.$disconnect()
