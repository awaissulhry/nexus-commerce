/** READ-ONLY. (a) what timezone does Amazon say each profile is in?
 *  (b) is /sp/campaigns/budget/usage deterministic across two consecutive calls? */
const { default: prisma } = await import('../src/db.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })

console.log('=== profiles (timezone is the budget-day anchor Amazon documents) ===')
try {
  const profs = await liveCall<Array<Record<string, unknown>>>({ profileId: 'n/a', region: 'EU', method: 'GET', path: '/v2/profiles', skipCallLog: true })
  for (const p of profs) console.log(`   ${String(p.profileId).padEnd(18)} cc=${(p.countryCode as string) ?? '?'}  tz=${String(p.timezone)}  currency=${String(p.currencyCode)}`)
} catch (e) { console.log('   ERROR', (e as Error).message.slice(0, 200)) }

console.log('\n=== same 38 DE campaigns, two calls back to back ===')
const c = conns.find((x) => x.marketplace === 'DE')!
const camps = await prisma.campaign.findMany({ where: { marketplace: 'DE', externalCampaignId: { not: null } }, select: { externalCampaignId: true, name: true } })
const ids = camps.map((x) => x.externalCampaignId!)
const byExt = new Map(camps.map((x) => [x.externalCampaignId!, x.name]))
const call = async () => {
  const u = await liveCall<{ success?: Array<Record<string, unknown>> }>({ profileId: c.profileId, region: 'EU', method: 'POST', path: '/sp/campaigns/budget/usage', body: { campaignIds: ids }, contentType: 'application/vnd.spcampaignbudgetusage.v3+json', acceptHeader: 'application/vnd.spcampaignbudgetusage.v3+json', skipCallLog: true })
  return new Map((u.success ?? []).map((r) => [String(r.campaignId), r]))
}
const a = await call()
const b = await call()
let diffs = 0
for (const [id, ra] of a) {
  const rb = b.get(id)
  if (!rb) { console.log(`   ${byExt.get(id)}: present in call A, absent in call B`); diffs++; continue }
  if (ra.budgetUsagePercent !== rb.budgetUsagePercent || ra.usageUpdatedTimestamp !== rb.usageUpdatedTimestamp || ra.budget !== rb.budget) {
    console.log(`   ${String(byExt.get(id)).slice(0, 30).padEnd(32)} A: ${ra.budgetUsagePercent}% of ${ra.budget} @${ra.usageUpdatedTimestamp}   B: ${rb.budgetUsagePercent}% of ${rb.budget} @${rb.usageUpdatedTimestamp}`)
    diffs++
  }
}
console.log(`   ${diffs} of ${a.size} campaigns differed between two immediately consecutive calls`)
await prisma.$disconnect()
