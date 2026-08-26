/** ACR.6 — run the family cockpit against prod. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const ports = await prisma.$queryRawUnsafe<{ pid: string; name: string; camps: bigint }[]>(`
  SELECT p."externalPortfolioId" AS pid, p.name, COUNT(c.id) AS camps
  FROM "AmazonAdsPortfolio" p LEFT JOIN "Campaign" c ON c."portfolioId" = p."externalPortfolioId"
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`)
for (const p of ports) console.log(`  ${p.pid}  ${String(p.name).padEnd(24)} campaigns=${p.camps}`)
const { getFamilyCockpit } = await import('../src/services/advertising/ads-family-cockpit.service.js')
const top = ports[0]
const ck = await getFamilyCockpit(top.pid)
if (!ck) { console.log('NOT FOUND'); process.exit(1) }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
console.log(`\n═ ${ck.portfolio.name} (${ck.portfolio.marketplace}) state=${ck.portfolio.state} budget=${ck.portfolio.budgetAmountCents == null ? 'no cap' : eur(ck.portfolio.budgetAmountCents)}`)
console.log(`totals: ${ck.totals.campaigns} campaigns · ${ck.totals.enabled} enabled · ${ck.totals.allowlisted} allowlisted · 30d ${eur(ck.totals.spend30dCents)} → ${eur(ck.totals.sales30dCents)} (ACOS ${ck.totals.acos30d != null ? (ck.totals.acos30d * 100).toFixed(0) + '%' : '—'}) · €${ck.totals.dailyBudgetEur.toFixed(2)}/day`)
console.log(`products: ${ck.products.length} (${ck.products.slice(0, 3).map((p) => p.sku ?? p.asin).join(', ')}…)`)
console.log(`coverage: ${ck.coverage ? `${ck.coverage.rows.length} terms · pooled ${(ck.coverage.totals.share != null ? (ck.coverage.totals.share * 100).toFixed(2) + '%' : '—')} · week ${ck.coverage.week}` : 'none'}`)
for (const r of (ck.coverage?.rows ?? []).slice(0, 6)) {
  console.log(`   ${r.term.padEnd(30)} mkt=${r.marketImpressions.toLocaleString()} ours=${r.ourImpressions} share=${r.share != null ? (r.share * 100).toFixed(2) + '%' : '—'} asins=${r.ourAsins} kws=${r.targets}`)
}
console.log(`contests: ${ck.contests.length}`)
for (const c of ck.contests.slice(0, 4)) {
  console.log(`   "${c.term}" [${c.matchType}] × ${c.contenders.length} — champion: ${c.contenders.find((x) => x.campaignId === c.championCampaignId)?.campaignName} (${c.championReason})`)
}
console.log(`proposals: ${ck.proposals ? `${ck.proposals.pending} pending · recoverable ${eur(ck.proposals.recoverableCents)}` : 'none'}`)
console.log(`schedules: ${ck.automation.schedulesEnabled}/${ck.automation.schedulesTotal} enabled`)
await prisma.$disconnect()
