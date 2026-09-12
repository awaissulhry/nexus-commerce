/** READ-ONLY. GX.4 — does a figure in the Explorer equal the figure on the page it opens?
 *  Two known divergences to quantify: today's hourly overlay, and the detail page's ALLOCATION. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { hierarchyChildren } = await import('../src/services/advertising/ads-hierarchy.service.js')
const { campaignBreakdown } = await import('../src/services/advertising/ads-detail-metrics.service.js').catch(() => ({ campaignBreakdown: null as never }))

const q = (s: string, ...a: unknown[]) => prisma.$queryRawUnsafe<Record<string,unknown>[]>(s, ...a)
const camp = (await q(`
  SELECT c.id, c.name, c."externalCampaignId" AS ext
  FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id=p."localEntityId"
  WHERE p."entityType"='CAMPAIGN' AND p.marketplace='IT' AND p.date >= CURRENT_DATE - 56
    AND p."reportRunId" IS DISTINCT FROM 'ams-stream'
  GROUP BY 1,2,3 ORDER BY SUM(p."costMicros") DESC LIMIT 1`))[0]
console.log(`campaign: ${camp.name}`)

const to = new Date().toISOString().slice(0,10)
const from = new Date(Date.now() - 56*864e5).toISOString().slice(0,10)
const yest = new Date(Date.now() - 864e5).toISOString().slice(0,10)

for (const [label, end] of [['window ends TODAY', to], ['window ends YESTERDAY', yest]] as const) {
  const t = await hierarchyChildren({ level: 'campaign', parentId: `campaign:${camp.id}`, from, to: end, decompose: 'product', marketplaces: [] })
  const kids = t.nodes.filter(n => n.kind !== 'remainder')
  const rem = t.nodes.find(n => n.kind === 'remainder')
  console.log(`\n${label} (${from} → ${end})`)
  console.log(`  explorer parent   €${(t.parentMetrics?.cost ?? 0).toFixed(2)}`)
  console.log(`  explorer children €${kids.reduce((s,n)=>s+(n.metrics.cost??0),0).toFixed(2)} + remainder €${(rem?.metrics.cost ?? 0).toFixed(2)}`)
}

// What the campaign detail page would show for the same campaign over the same window.
if (campaignBreakdown) {
  const d = await campaignBreakdown({ campaignId: String(camp.id), externalCampaignId: camp.ext ? String(camp.ext) : undefined, windowDays: 56, since: new Date(`${from}T00:00:00Z`), until: new Date(`${to}T23:59:59Z`) } as never) as { campaign?: { spendCents?: number }, ads?: Array<{ spendCents?: number }> }
  console.log(`\ndetail page (same window, includes today)`)
  console.log(`  campaign  €${((d.campaign?.spendCents ?? 0)/100).toFixed(2)}`)
  if (d.ads?.length) console.log(`  Σ ads     €${(d.ads.reduce((s,a)=>s+(a.spendCents??0),0)/100).toFixed(2)}  (${d.ads.length} ads, ALLOCATED)`)
}
await prisma.$disconnect()
