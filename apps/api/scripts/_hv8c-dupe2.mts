/** Are the 9 harvest_and_negate cards nine proposals, or one proposal nine times? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.adsRuleSuggestion.findMany({
  where: { proposedKey: { startsWith: 'harvest_and_negate' } },
  select: { id:true, ruleName:true, entityType:true, entityId:true, entityName:true, proposedAction:true, createdAt:true, status:true },
  orderBy: { createdAt:'asc' },
})
console.log(`\n${rows.length} harvest_and_negate suggestion rows\n`)
const seen = new Map<string, number>()
for (const r of rows) {
  const sig = JSON.stringify(r.proposedAction)
  seen.set(sig, (seen.get(sig) ?? 0) + 1)
  console.log(`  ${r.createdAt.toISOString().slice(0,10)} ${String(r.ruleName).slice(0,26).padEnd(28)} ${r.entityType}:${String(r.entityName ?? r.entityId).slice(0,26).padEnd(28)} ${r.status}`)
}
console.log(`\n  distinct proposedAction payloads: ${seen.size} across ${rows.length} cards`)
for (const [sig,n] of seen) console.log(`    ×${n}  ${sig.slice(0,150)}`)
// compare against a per-entity action for contrast
const bd = await prisma.adsRuleSuggestion.findMany({ where:{ proposedKey:{ startsWith:'bid_down' } }, select:{ proposedAction:true }, take: 60 })
const bdSeen = new Set(bd.map(r=>JSON.stringify(r.proposedAction)))
console.log(`\n  contrast — bid_down: ${bdSeen.size} distinct payloads across ${bd.length} cards`)
await prisma.$disconnect()
