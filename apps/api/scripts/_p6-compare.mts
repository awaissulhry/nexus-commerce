/** READ-ONLY. The decisive comparison: Amazon's OWN budget-usage answer vs
 *  (a) our stored dailyBudget and (b) the hourly-derived Rome-day spend. */
const { default: prisma } = await import('../src/db.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })

// our side: Rome-local-day spend so far, per campaign, from the hourly feed
const spend = await prisma.$queryRawUnsafe<Array<{ cid: string; spend: number; last_created: Date }>>(`
  SELECT "localEntityId" AS cid, (SUM("costMicros")/1e6)::float8 AS spend, MAX("createdAt") AS last_created
  FROM "AmazonAdsHourlyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "date" >= CURRENT_DATE - 2 AND "localEntityId" IS NOT NULL
    AND (("date" + ("hour" || ' hours')::interval) AT TIME ZONE 'UTC') >= (date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome')
  GROUP BY 1`)
const spendById = new Map(spend.map((r) => [r.cid, r]))

let asked = 0, got = 0, missing = 0
const rows: Array<Record<string, unknown>> = []
for (const mk of ['IT', 'DE', 'FR', 'ES']) {
  const c = conns.find((x) => x.marketplace === mk)!
  const region = (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as 'EU'
  const camps = await prisma.campaign.findMany({ where: { marketplace: mk, externalCampaignId: { not: null } }, select: { id: true, externalCampaignId: true, name: true, dailyBudget: true, status: true, adProduct: true } })
  for (let i = 0; i < camps.length; i += 100) {
    const chunk = camps.slice(i, i + 100)
    const ids = chunk.map((x) => x.externalCampaignId!) 
    asked += ids.length
    let usage: { success?: Array<Record<string, unknown>>; error?: Array<Record<string, unknown>> }
    try {
      usage = await liveCall({ profileId: c.profileId, region, method: 'POST', path: '/sp/campaigns/budget/usage', body: { campaignIds: ids }, contentType: 'application/vnd.spcampaignbudgetusage.v3+json', acceptHeader: 'application/vnd.spcampaignbudgetusage.v3+json', skipCallLog: true })
    } catch (e) { console.log(`  ${mk} chunk ${i} FAILED`, (e as Error).message.slice(0, 200)); continue }
    const byExt = new Map(chunk.map((x) => [x.externalCampaignId!, x]))
    got += (usage.success ?? []).length
    missing += (usage.error ?? []).length
    for (const b of usage.error ?? []) {
      const camp = byExt.get(String(b.campaignId))
      rows.push({ kind: 'ERR', mk, name: camp?.name?.slice(0, 30), status: camp?.status, adProduct: camp?.adProduct, code: b.code })
    }
    for (const r of usage.success ?? []) {
      const camp = byExt.get(String(r.campaignId))
      if (!camp) continue
      const ourBudget = camp.dailyBudget != null ? Number(camp.dailyBudget) : null
      const amzBudget = Number(r.budget)
      const amzPct = Number(r.budgetUsagePercent)
      const hourly = spendById.get(camp.id)
      const ourSpend = hourly?.spend ?? null
      const amzSpend = Number.isFinite(amzPct) && Number.isFinite(amzBudget) ? (amzPct / 100) * amzBudget : null
      rows.push({
        kind: 'OK', mk, name: camp.name.slice(0, 30), status: camp.status,
        ourBudget, amzBudget, budgetDrift: ourBudget != null && amzBudget !== ourBudget ? +(amzBudget - ourBudget).toFixed(2) : 0,
        amzPct: +amzPct.toFixed(2), amzSpend: amzSpend != null ? +amzSpend.toFixed(2) : null,
        ourSpend: ourSpend != null ? +ourSpend.toFixed(2) : null,
        ourPct: ourSpend != null && ourBudget ? +(100 * ourSpend / ourBudget).toFixed(2) : null,
        asOf: String(r.usageUpdatedTimestamp ?? ''),
        hourlyAsOf: hourly?.last_created?.toISOString() ?? null,
      })
    }
  }
}
const ok = rows.filter((r) => r.kind === 'OK')
console.log(`\n== asked ${asked} · Amazon answered ${got} · refused ${missing} ==`)
const drift = ok.filter((r) => Math.abs(Number(r.budgetDrift)) > 0.001)
console.log(`\n== BUDGET DRIFT: our Campaign.dailyBudget vs Amazon's own budget ==`)
console.log(`   ${drift.length} of ${ok.length} campaigns disagree`)
for (const d of drift.slice(0, 15)) console.log(`   ${String(d.mk)} ${String(d.name).padEnd(32)} ours=${d.ourBudget}  amazon=${d.amzBudget}  drift=${d.budgetDrift}`)
console.log(`\n== SPENT TODAY: Amazon's percent vs our hourly-derived percent ==`)
const spent = ok.filter((r) => Number(r.amzPct) > 0 || (r.ourSpend != null && Number(r.ourSpend) > 0))
for (const s of spent) console.log(`   ${String(s.mk)} ${String(s.name).padEnd(30)} ${String(s.status).padEnd(8)} amzPct=${String(s.amzPct).padStart(6)} (=EUR${s.amzSpend} of ${s.amzBudget}) | ourPct=${String(s.ourPct).padStart(6)} (=EUR${s.ourSpend} of ${s.ourBudget}) | amzAsOf=${s.asOf} hourlyAsOf=${String(s.hourlyAsOf).slice(11, 19)}`)
console.log(`\n== REFUSED by Amazon (campaignId does not exist) ==`)
const errs = rows.filter((r) => r.kind === 'ERR')
const byStatus = new Map<string, number>()
for (const e of errs) byStatus.set(`${e.status}/${e.adProduct}`, (byStatus.get(`${e.status}/${e.adProduct}`) ?? 0) + 1)
for (const [k, v] of byStatus) console.log(`   ${k} × ${v}`)
console.log(`\n== usageUpdatedTimestamp age distribution ==`)
const now = Date.now()
const ages = ok.map((r) => (now - Date.parse(String(r.asOf))) / 60000).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
console.log(`   n=${ages.length} min=${ages[0]?.toFixed(0)}m p50=${ages[Math.floor(ages.length / 2)]?.toFixed(0)}m max=${ages[ages.length - 1]?.toFixed(0)}m`)
await prisma.$disconnect()
