/** READ-ONLY against Amazon. Per-PROFILE subscriptions + per-profile budget-usage pull. */
const { default: prisma } = await import('../src/db.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })

console.log('=== subscriptions per profile ===')
for (const c of conns) {
  const region = (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as 'EU' | 'NA' | 'FE'
  try {
    const subs = await liveCall<{ subscriptions?: Array<{ dataSetId: string; status: string; createdDate: string }> }>({ profileId: c.profileId, region, method: 'GET', path: '/streams/subscriptions', skipCallLog: true })
    const list = subs.subscriptions ?? []
    console.log(`  ${c.marketplace} (${c.profileId}): ${list.length ? list.map(s => `${s.dataSetId}:${s.status}`).join(' ') : '(none)'}`)
  } catch (e) {
    const err = e as Error & { statusCode?: number }
    console.log(`  ${c.marketplace} (${c.profileId}): ERROR ${err.statusCode ?? ''} ${err.message.slice(0, 120)}`)
  }
}

console.log('\n=== budget usage pull, per marketplace profile ===')
for (const mk of ['IT', 'DE', 'FR', 'ES']) {
  const c = conns.find((x) => x.marketplace === mk)
  if (!c) { console.log(`  ${mk}: no connection`); continue }
  const region = (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as 'EU' | 'NA' | 'FE'
  const camps = await prisma.campaign.findMany({ where: { marketplace: mk, externalCampaignId: { not: null } }, select: { externalCampaignId: true, name: true, dailyBudget: true, status: true }, take: 100 })
  const ids = camps.map((x) => x.externalCampaignId!).filter(Boolean)
  if (!ids.length) { console.log(`  ${mk}: no campaigns`); continue }
  try {
    const usage = await liveCall<{ success?: Array<Record<string, unknown>>; error?: Array<Record<string, unknown>> }>({
      profileId: c.profileId, region, method: 'POST', path: '/sp/campaigns/budget/usage',
      body: { campaignIds: ids },
      contentType: 'application/vnd.spcampaignbudgetusage.v3+json',
      acceptHeader: 'application/vnd.spcampaignbudgetusage.v3+json',
      skipCallLog: true,
    })
    const ok = usage.success ?? []
    const bad = usage.error ?? []
    console.log(`  ${mk}: asked ${ids.length} → success ${ok.length}, error ${bad.length}`)
    const byId = new Map(camps.map((x) => [x.externalCampaignId!, x]))
    for (const r of ok.slice(0, 8)) {
      const camp = byId.get(String(r.campaignId))
      console.log(`     ${String(camp?.name ?? r.campaignId).slice(0, 32).padEnd(34)} status=${camp?.status ?? '?'} ourBudget=${camp?.dailyBudget ?? '?'}  ${JSON.stringify(r)}`)
    }
    const codes = new Map<string, number>()
    for (const b of bad) codes.set(String(b.code) + '/' + String(b.details), (codes.get(String(b.code) + '/' + String(b.details)) ?? 0) + 1)
    for (const [k, v] of codes) console.log(`     ERR ${k} × ${v}`)
  } catch (e) {
    const err = e as Error & { statusCode?: number; body?: string }
    console.log(`  ${mk}: CALL FAILED ${err.statusCode ?? ''} ${(err.body ?? err.message).slice(0, 300)}`)
  }
}
await prisma.$disconnect()
