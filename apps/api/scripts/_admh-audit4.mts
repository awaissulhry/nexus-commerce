/** READ-ONLY. ADM-H part 4 — what the UNWIRED columns would show over the page's own
 *  default 7-day window, so a proposal can be judged on real numbers. */
const { default: prisma } = await import('../src/db.js')
const s7 = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10)
const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "localEntityId" AS id,
         SUM("units7d")::bigint                     AS units,
         SUM("salesSameSku7dCents")::bigint         AS ssku_sales_c,
         SUM("ordersSameSku7d")::bigint             AS ssku_orders,
         SUM("unitsSameSku7d")::bigint              AS ssku_units,
         SUM(COALESCE("sales7dCents",0)+COALESCE("sales14dCents",0))::bigint AS sales_c,
         MAX("topOfSearchIS")                       AS tos_max,
         AVG("topOfSearchIS")                       AS tos_avg,
         COUNT("topOfSearchIS")                     AS tos_days,
         SUM("campaignBudgetCents")::bigint         AS budget_c_sum,
         COUNT("campaignBudgetCents")               AS budget_days,
         (SUM("costMicros")/10000)::bigint          AS spend_c,
         COUNT(*)::bigint                           AS days
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "date" >= '${s7}'::date AND "localEntityId" IS NOT NULL
  GROUP BY "localEntityId"
`)
const N = (v: unknown) => Number(v ?? 0)
console.log(`\n== 7-day window (since ${s7}) — ${rows.length} campaigns with rows ==`)
console.log(`  Sale Units > 0                 ${rows.filter(r => N(r.units) > 0).length}`)
console.log(`  SameSKU Sales > 0              ${rows.filter(r => N(r.ssku_sales_c) > 0).length}`)
console.log(`  SameSKU Orders > 0             ${rows.filter(r => N(r.ssku_orders) > 0).length}`)
console.log(`  Top-of-search IS reported      ${rows.filter(r => N(r.tos_days) > 0).length}  (>0 on ${rows.filter(r => N(r.tos_max) > 0).length})`)
console.log(`  campaignBudgetCents present    ${rows.filter(r => N(r.budget_days) > 0).length}  -> avg budget utilisation computable`)
console.log(`  Other Sales (halo = sales - sameSKU) > 0  ${rows.filter(r => N(r.sales_c) - N(r.ssku_sales_c) > 0).length}`)
console.log(`\n  sample rows (top by spend):`)
for (const r of [...rows].sort((a, b) => N(b.spend_c) - N(a.spend_c)).slice(0, 6)) {
  const util = N(r.budget_days) > 0 ? (N(r.spend_c) / (N(r.budget_c_sum) / N(r.budget_days)) / N(r.days)) * 100 : null
  console.log(`    spend EUR${(N(r.spend_c)/100).toFixed(2).padStart(8)}  units=${String(N(r.units)).padStart(3)}  ssku=EUR${(N(r.ssku_sales_c)/100).toFixed(2).padStart(8)}  tosIS avg=${r.tos_avg != null ? (Number(r.tos_avg)*100).toFixed(2)+'%' : 'n/a'}  avgUtil=${util != null ? util.toFixed(1)+'%' : 'n/a'}`)
}
await prisma.$disconnect()
