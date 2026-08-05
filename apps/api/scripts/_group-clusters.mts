/** READ-ONLY: candidate canonical-grouping of MASTER products by SKU stem.
 *  Rule (from owner's description): strip trailing -ALT<n>, -FBM, -FBA and a
 *  leading market prefix (IT-/DE-/FR-/ES-). Products sharing a stem = one
 *  logical product. Shows every cluster with >1 master (the duplicates). */
const { default: prisma } = await import('../src/db.js')

function canonicalStem(sku: string): string {
  let s = sku
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')          // leading market prefix
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '') // trailing dup suffix
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')              // second pass (stacked)
  return s.toUpperCase()
}

const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true, name: true } })
const byStem = new Map<string, typeof masters>()
for (const m of masters) {
  const stem = canonicalStem(m.sku)
  const arr = byStem.get(stem) ?? []; arr.push(m); byStem.set(stem, arr)
}
const clusters = [...byStem.entries()].filter(([, ms]) => ms.length > 1).sort((a,b)=>b[1].length-a[1].length)
console.log(`total masters=${masters.length}  → distinct logical products=${byStem.size}  (clusters with duplicates=${clusters.length})`)
console.log(`\n=== clusters (>1 master merges into 1 logical product) ===`)
for (const [stem, ms] of clusters) {
  console.log(`\n[${ms.length}] canonical="${stem}"`)
  for (const m of ms) console.log(`     ${m.sku}   "${(m.name??'').slice(0,44)}"`)
}
await prisma.$disconnect()
