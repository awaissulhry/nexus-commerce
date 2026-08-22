/** READ-ONLY. The RIGHT comparison for budget drift: our stored dailyBudget against Amazon's
 *  CURRENT budget from the budget-usage API — not against a daily report row from three days ago,
 *  which a pacer has had three nights to move away from. */
const { default: prisma } = await import('../src/db.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })
let asked = 0, agree = 0
const drift: string[] = []
for (const mk of ['IT', 'DE', 'FR', 'ES']) {
  const c = conns.find(x => x.marketplace === mk); if (!c) continue
  const camps = await prisma.campaign.findMany({ where: { marketplace: mk, adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: { not: null } }, select: { name: true, externalCampaignId: true, dailyBudget: true, status: true } })
  for (let i = 0; i < camps.length; i += 100) {
    const chunk = camps.slice(i, i + 100)
    const res = await liveCall<{ success?: Array<Record<string, unknown>> }>({ profileId: c.profileId, region: 'EU', method: 'POST', path: '/sp/campaigns/budget/usage', body: { campaignIds: chunk.map(x => x.externalCampaignId!) }, contentType: 'application/vnd.spcampaignbudgetusage.v3+json', acceptHeader: 'application/vnd.spcampaignbudgetusage.v3+json', skipCallLog: true })
    const byId = new Map(chunk.map(x => [x.externalCampaignId!, x]))
    for (const r of res.success ?? []) {
      const camp = byId.get(String(r.campaignId)); if (!camp) continue
      asked++
      const ours = Number(camp.dailyBudget), amazon = Number(r.budget)
      if (Math.abs(ours - amazon) < 0.005) { agree++; continue }
      drift.push(`   ${mk} ${camp.name.slice(0, 32).padEnd(34)} ${String(camp.status).padEnd(8)} ours=EUR${ours.toFixed(2)}  amazon=EUR${amazon.toFixed(2)}`)
    }
  }
}
console.log(`=== our dailyBudget vs Amazon's CURRENT budget, ${new Date().toISOString()} ===`)
console.log(`   compared ${asked} · agree ${agree} · disagree ${drift.length}`)
drift.forEach(d => console.log(d))
await prisma.$disconnect()
