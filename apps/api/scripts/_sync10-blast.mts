/** SYNC.10 — live blast radius: which campaigns would an engine tick re-ENABLE? */
import prisma from '../src/db.js'

const scheds = await prisma.adSchedule.findMany({
  select: { id: true, campaignId: true, name: true, enabled: true, defaultTargetKey: true, lastApplied: true, lastEvaluatedAt: true, windows: true },
})
console.log(`=== AdSchedule rows: ${scheds.length} (${scheds.filter((s) => s.enabled).length} enabled) ===`)

const campIds = [...new Set(scheds.filter((s) => s.enabled).map((s) => s.campaignId))]
const camps = await prisma.campaign.findMany({
  where: { id: { in: campIds } },
  select: { id: true, name: true, status: true, marketplace: true, adProduct: true, bidsSuppressedAt: true },
})
const byId = new Map(camps.map((c) => [c.id, c]))

console.log(`\n=== Campaigns under an ENABLED schedule: ${camps.length} ===`)
const paused = camps.filter((c) => c.status === 'PAUSED')
console.log(`  ENABLED locally: ${camps.filter((c) => c.status === 'ENABLED').length}`)
console.log(`  PAUSED  locally: ${paused.length}   <-- every one of these is a re-enable candidate on the next tick`)
console.log(`  ARCHIVED       : ${camps.filter((c) => c.status === 'ARCHIVED').length}  (skipped - engine only touches PAUSED)`)

if (paused.length) {
  console.log('\n  -- PAUSED campaigns sitting under a live rank/dayparting schedule --')
  for (const c of paused) console.log(`     ${String(c.name).slice(0,44).padEnd(44)} ${c.marketplace} suppressed=${c.bidsSuppressedAt ? 'yes' : 'no'}`)
}

console.log('\n=== Schedules whose campaign no longer exists / is archived ===')
for (const s of scheds.filter((s) => s.enabled)) {
  const c = byId.get(s.campaignId)
  if (!c) console.log(`  schedule ${s.id.slice(0,20)} -> campaign ${s.campaignId} MISSING`)
}

console.log('\n=== Schedule evaluation freshness ===')
const evals = scheds.filter((s) => s.enabled && s.lastEvaluatedAt).map((s) => s.lastEvaluatedAt!.getTime())
if (evals.length) {
  const newest = Math.max(...evals), oldest = Math.min(...evals)
  console.log(`  newest lastEvaluatedAt: ${new Date(newest).toISOString()} (${((Date.now()-newest)/60000).toFixed(0)}m ago)`)
  console.log(`  oldest lastEvaluatedAt: ${new Date(oldest).toISOString()} (${((Date.now()-oldest)/60000).toFixed(0)}m ago)`)
}

console.log('\n=== The 20 campaigns re-enabled on 2026-08-21: are they under a live schedule NOW? ===')
const names = ['GALE | IT | Phrase | Competitor','IT-AIRMESH-SP-Competitor-Phrase','GALE | IT | Broad | Category','GALE EXACT DE','IT-AIRMESH-SP-Category-Broad','GALE | IT | Auto','IT-AIREON-SP-Category-Broad','GALE | IT | Exact | Category','GALE | IT | PAT','IT-AIRMESH-SP-Category-Phrase','IT-AIRMESH-SP-Competitor-Exact','IT-AIRMESH-SP-Brand-Broad','IT-AIRMESH-SP-Category-Exact','GALE | IT | Phrase | Category','IT-AIREON-SP-Auto','GALE | IT | Exact | Competitor','IT-AIREON-SP-Category-Exact','IT-AIRMESH-SP-Competitor-Broad','IT-AIREON-SP-Category-Phrase','IT-AIRMESH-SP-Auto']
const hit = await prisma.campaign.findMany({ where: { name: { in: names } }, select: { id: true, name: true, status: true } })
const schedCampIds = new Set(scheds.filter((s) => s.enabled).map((s) => s.campaignId))
for (const c of hit) console.log(`  ${String(c.name).slice(0,40).padEnd(40)} nowStatus=${String(c.status).padEnd(8)} underLiveSchedule=${schedCampIds.has(c.id) ? 'YES' : 'no'}`)

await prisma.$disconnect()
