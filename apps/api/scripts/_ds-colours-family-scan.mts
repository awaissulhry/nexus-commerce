/** READ-ONLY: scan every eBay-curated family and report how many per-colour
 *  images the description's {{gallery_groups}} drops because they also live in
 *  the shared "cover & common" bucket (the filter at
 *  ebay-description-render.ts groupsGallery/groupedGallery). */
const { default: prisma } = await import('../src/db.js')

const prefix = process.argv[2]
const parents = await prisma.product.findMany({
  where: { parentId: null, deletedAt: null, ...(prefix ? { sku: { startsWith: prefix } } : {}) },
  select: { id: true, sku: true },
})

let familiesWithGroups = 0
let familiesDegraded = 0
let familiesEmptied = 0
let curatedTotal = 0
let renderedTotal = 0
const worst: Array<{ sku: string; curated: number; rendered: number; emptied: number; groups: number }> = []

for (const p of parents) {
  const curated = await prisma.listingImage.findMany({
    where: { productId: p.id, platform: 'EBAY', mediaType: 'IMAGE' },
    orderBy: { position: 'asc' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true },
  })
  if (curated.length === 0) continue
  const shared: string[] = []
  const groups = new Map<string, string[]>()
  for (const r of curated) {
    if (r.variationId) continue
    if (r.variantGroupKey && r.variantGroupValue) {
      const k = `${r.variantGroupKey}::${r.variantGroupValue}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(r.url)
    } else shared.push(r.url)
  }
  if (groups.size === 0) continue
  familiesWithGroups++
  let cur = 0, ren = 0, emptied = 0
  for (const [, urls] of groups) {
    const kept = urls.filter((u) => !shared.includes(u))
    cur += urls.length
    ren += kept.length
    if (urls.length > 0 && kept.length === 0) emptied++
  }
  curatedTotal += cur
  renderedTotal += ren
  if (ren < cur) {
    familiesDegraded++
    if (emptied > 0) familiesEmptied++
    worst.push({ sku: p.sku, curated: cur, rendered: ren, emptied, groups: groups.size })
  }
}

worst.sort((a, b) => (b.curated - b.rendered) - (a.curated - a.rendered))
console.log(`\nFamilies with per-colour buckets: ${familiesWithGroups}`)
console.log(`  degraded (≥1 image dropped):    ${familiesDegraded}`)
console.log(`  with a colour rendering ZERO:   ${familiesEmptied}`)
console.log(`  images curated ${curatedTotal} → rendered ${renderedTotal}  (DROPPED ${curatedTotal - renderedTotal})`)
console.log(`\nWorst 25:`)
for (const w of worst.slice(0, 25)) {
  console.log(`  ${w.sku.padEnd(28)} ${String(w.curated).padStart(3)} → ${String(w.rendered).padStart(3)}` +
    `  (${w.groups} colours${w.emptied > 0 ? `, ${w.emptied} render EMPTY` : ''})`)
}
await prisma.$disconnect()
