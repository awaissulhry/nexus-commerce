/** NEG.X action two — PRE-FLIGHT ONLY. Read-only: confirms protezioni is actionable under each
 *  single-campaign scope before any irreversible write. */
import '../src/env.js'
const { getWastefulWords } = await import('../src/services/advertising/negatives-ngrams.service.js')
const { default: prisma } = await import('../src/db.js')
const eur = (c:number)=>`€${(c/100).toFixed(2)}`
const NAMES = ['GALE PHRASE IT', 'IT_Auto_Substitute', 'GALE | IT | Phrase | Category']
const camps = await prisma.campaign.findMany({ where: { name: { in: NAMES } }, select: { id: true, name: true, marketplace: true, liveBidWritesEnabled: true, status: true } })
console.log(`resolved ${camps.length} of ${NAMES.length} campaigns\n`)
let totalAg = 0, totalSpend = 0
for (const c of camps) {
  const p = await getWastefulWords({ market: 'all', campaign: c.id, window: 60 })
  const g = p.wasteful.find(w => w.gram === 'protezioni')
  console.log(`${c.name}`)
  console.log(`   id ${c.id} · ${c.marketplace} · status ${c.status} · allowlisted ${c.liveBidWritesEnabled}`)
  if (!g) { console.log('   🔴 protezioni NOT in the wasteful list under this scope — would be refused\n'); continue }
  console.log(`   actionable ${g.actionable ? 'YES' : `🔴 NO — ${g.blockedBy.join(', ')}`}`)
  console.log(`   ${eur(g.costCents)} · ${g.clicks} clicks · blocks ${g.catches} terms · ${g.adGroups} ad group(s), ${g.adGroupsWritable} writable, ${g.adGroupsAlreadyNegated} already carry it`)
  console.log(`   rails: collision ${g.collisions.length} · converting ${g.convertingTerms.length} · protected ${g.protectedBy.length} · floor ${g.floorFailures.length}`)
  console.log(`   top terms it blocks: ${g.sampleTerms.slice(0,3).map(t=>`"${t.term}" ${eur(t.costCents)}`).join(' · ')}\n`)
  totalAg += g.adGroupsWritable; totalSpend += g.costCents
}
console.log(`🔴 TOTAL IF EXECUTED: ${totalAg} ad group(s), ${eur(totalSpend)} of spend removed`)
await prisma.$disconnect()
