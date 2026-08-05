/** ACR.3 — seed the GALE coverage set from measured evidence. */
import '../src/env.js'
const { seedCoverageSet, getCoverageSet } = await import('../src/services/advertising/ads-coverage-sets.service.js')
const PF = '255127157311072'
const r = await seedCoverageSet({ portfolioId: PF, createdBy: 'operator-approved-acr3' })
console.log('\nseed:', r)
const set = await getCoverageSet(PF)
if (set) {
  console.log(`\n${set.name} · enabled=${set.enabled} · ${set.terms.length} terms\n`)
  console.log(`  ${'term'.padEnd(32)}${'market'.padStart(9)}${'share'.padStart(8)}  lead ASIN   kws`)
  for (const t of set.terms.slice(0, 25)) {
    console.log(`  ${t.term.slice(0, 31).padEnd(32)}${String(t.marketImpressions ?? '—').padStart(9)}${(t.share != null ? (t.share * 100).toFixed(2) + '%' : '—').padStart(8)}  ${t.leadAsin ?? '—'}  ${t.familyKeywords ?? 0}`)
  }
}
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
