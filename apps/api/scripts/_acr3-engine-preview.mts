/** ACR.3 — what WOULD the engine do to the GALE draft set right now? READ-ONLY preview. */
import '../src/env.js'
const { runCoverageEngineOnce } = await import('../src/services/advertising/ads-coverage-engine.service.js')
const { default: prisma } = await import('../src/db.js')

const set = await prisma.keywordCoverageSet.findFirst({ where: { portfolioId: '255127157311072' }, select: { id: true, name: true, enabled: true } })
if (!set) throw new Error('no GALE set')
console.log(`\npreviewing "${set.name}" (enabled=${set.enabled}) — preview never applies\n`)

const r = await runCoverageEngineOnce({ previewSetId: set.id })
console.log(`mode=${r.mode} terms=${r.termsEvaluated} up=${r.ups} down=${r.downs} hold=${r.holds}\n`)
const interesting = r.decisions.filter((d) => d.decision.action !== 'hold')
console.log(`WOULD MOVE (${interesting.length}):`)
for (const d of interesting.slice(0, 15)) {
  console.log(`  ${d.decision.action.toUpperCase().padEnd(5)} "${d.term}" ${d.currentBidCents}¢ → ${d.decision.nextBidCents}¢  (${d.decision.reason})  [${d.campaignName}]`)
}
const holdReasons = new Map<string, number>()
for (const d of r.decisions.filter((x) => x.decision.action === 'hold')) {
  const k = d.decision.reason.replace(/[\d.]+/g, 'N')
  holdReasons.set(k, (holdReasons.get(k) ?? 0) + 1)
}
console.log(`\nHOLDS by reason:`)
for (const [k, n] of [...holdReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${k}`)
await prisma.$disconnect()
