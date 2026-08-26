/** RD part 2 — the engine's ACTUAL feedback signal, and how stale it is. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { sqpImpressionShareForAsins } = await import('../src/services/advertising/sqp.service.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

// Every enabled schedule's campaign, and the SQP share the engine actually reads for the
// rest-of-search lane (which is the baseline on ALL 16 groups).
const scheds = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })
const camps = await prisma.campaign.findMany({
  where: { id: { in: [...new Set(scheds.map((s) => s.campaignId))] } },
  select: { id: true, name: true, marketplace: true },
})
console.log('\n── the rest-of-search lane signal the engine actually reads (SQP), per campaign ──')
console.log(`${pad('campaign', 44)} ${pad('mkt', 4)} ${pad('ASINs', 6)} SQP share`)
let withSignal = 0, without = 0
for (const c of camps) {
  const ads = await prisma.adProductAd.findMany({
    where: { adGroup: { campaign: { id: c.id } }, asin: { not: null } },
    select: { asin: true },
  })
  const asins = [...new Set(ads.map((a) => a.asin!).filter(Boolean))]
  const share = c.marketplace ? await sqpImpressionShareForAsins(c.marketplace, asins) : null
  if (share == null) without++; else withSignal++
  console.log(`${pad(c.name, 44)} ${pad(c.marketplace ?? '—', 4)} ${pad(String(asins.length), 6)} ${share == null ? 'NO SIGNAL' : `${(share * 100).toFixed(2)}%`}`)
}
console.log(`\n  campaigns with a usable rest-of-search signal : ${withSignal}`)
console.log(`  campaigns with NO signal (engine flies blind) : ${without}`)

const latest = await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } })
const days = Math.floor((Date.now() - (latest._max.startDate?.getTime() ?? 0)) / 86_400_000)
const n = await prisma.searchQueryPerformance.count({ where: { startDate: latest._max.startDate! } })
console.log(`\n  the signal's source week : ${latest._max.startDate?.toISOString().slice(0, 10)}  (${days} days old, ${n} rows)`)
console.log(`  sqpImpressionShareForAsins takes MAX(startDate) with no recency guard —`)
console.log(`  it cannot tell a fresh week from a stale one.`)
await prisma.$disconnect()
