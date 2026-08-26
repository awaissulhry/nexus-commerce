/** READ-ONLY. ADM-H part 2 — report COVERAGE per campaign (is a rendered 0 a reading
 *  or an absence?), plus the placement-multiplier and delivery sources. */
const { default: prisma } = await import('../src/db.js')
const sinceStr = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)

const camps = await prisma.campaign.findMany({
  select: { id: true, name: true, status: true, externalCampaignId: true, dynamicBidding: true,
            deliveryStatus: true, deliveryReasons: true, dailyBudget: true, marketplace: true },
})
const covered = await prisma.$queryRawUnsafe<Array<{ localEntityId: string | null; d: bigint; imp: bigint; cost: bigint }>>(`
  SELECT "localEntityId", COUNT(*)::bigint AS d, SUM("impressions")::bigint AS imp, SUM("costMicros")::bigint AS cost
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "date" >= '${sinceStr}'::date AND "localEntityId" IS NOT NULL
  GROUP BY "localEntityId"
`)
const covById = new Map(covered.map((r) => [r.localEntityId!, r]))
const byStatus: Record<string, { total: number; noRows: number; rowsZeroSpend: number }> = {}
for (const c of camps) {
  const s = String(c.status)
  byStatus[s] ??= { total: 0, noRows: 0, rowsZeroSpend: 0 }
  byStatus[s].total++
  const r = covById.get(c.id)
  if (!r) byStatus[s].noRows++
  else if (Number(r.cost) === 0) byStatus[s].rowsZeroSpend++
}
console.log(`\n== 30d report coverage by status (220 campaigns) ==`)
console.table(byStatus)
const enabledNoRows = camps.filter((c) => String(c.status) === 'ENABLED' && !covById.has(c.id))
console.log(`\n  ENABLED campaigns with NO daily rows in 30d → grid prints "EUR0.00 / 0 / 0": ${enabledNoRows.length}`)
for (const c of enabledNoRows.slice(0, 10)) console.log(`    ${c.name.slice(0, 52).padEnd(54)} delivery=${c.deliveryStatus ?? 'null'}`)

let withPb = 0; const shapes = new Map<string, number>()
for (const c of camps) {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const pb = db.placementBidding ?? []
  if (!pb.length) continue
  withPb++
  const key = pb.map((p) => `${p.placement}=${p.percentage}`).sort().join(' ')
  shapes.set(key, (shapes.get(key) ?? 0) + 1)
}
console.log(`\n== placementBidding present on ${withPb} of ${camps.length}; distinct shapes: ${shapes.size} ==`)
for (const [k, v] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(4)}x  ${k}`)

const ds = new Map<string, number>()
for (const c of camps) ds.set(String(c.deliveryStatus), (ds.get(String(c.deliveryStatus)) ?? 0) + 1)
console.log(`\n== Campaign.deliveryStatus ==`)
for (const [k, v] of [...ds.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

const rules = await prisma.adRule.findMany({ select: { id: true, name: true, enabled: true, scopeCampaignId: true, scopePortfolioId: true, scopeMarketplace: true } }).catch((e: Error) => { console.log('  adRule query failed:', e.message.slice(0, 80)); return null })
if (rules) console.log(`\n== AdRule: ${rules.length} total | enabled ${rules.filter((r) => r.enabled).length} | campaign-scoped ${rules.filter((r) => r.scopeCampaignId).length} | portfolio-scoped ${rules.filter((r) => r.scopePortfolioId).length} | market-scoped ${rules.filter((r) => r.scopeMarketplace).length}`)
await prisma.$disconnect()
