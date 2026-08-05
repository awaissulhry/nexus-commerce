/** READ-ONLY: validate the canonical-stem rule against ALL master products,
 *  surfacing edge cases so the plan handles them (not just the happy path). */
const { default: prisma } = await import('../src/db.js')
function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { sku: true, name: true, variationAxes: true } })
const byStem = new Map<string, string[]>()
for (const m of masters) { const st=canonicalStem(m.sku); (byStem.get(st) ?? byStem.set(st,[]).get(st)!).push(m.sku) }
const clusters = [...byStem.entries()].filter(([,v])=>v.length>1)
const singletons = [...byStem.entries()].filter(([,v])=>v.length===1)
console.log(`masters=${masters.length} → stems=${byStem.size} (clusters=${clusters.length}, singletons=${singletons.length})`)
console.log('\n=== EDGE CASES to sanity-check ===')
// stems that are suspiciously short (risk of over-merge)
for (const [st,v] of byStem) if (st.length <= 4) console.log(`  SHORT STEM "${st}" ← ${v.join(', ')}`)
// singleton masters whose SKU still contains ALT/FBM/-IT (rule may have missed a variant of the pattern)
for (const [st,v] of singletons) if (/ALT|FBM|FBA/i.test(v[0]) && canonicalStem(v[0])===v[0].toUpperCase()) console.log(`  UNSTRIPPED? "${v[0]}" (stem=${st})`)
// case-only dup (test/TEST)
console.log('\n=== all singletons (each already 1 logical product) ===')
console.log(singletons.map(([,v])=>v[0]).sort().join(', '))
await prisma.$disconnect()
