/** READ-ONLY: replicate the override lookup for GALE and show WHY it matches or misses. */
const { default: prisma } = await import('../src/db.js')
const { axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')
const { buildEbayFamilyRows } = await import('../src/services/ebay-variation-push.service.js')

const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true, imageAxisPreference: true } })
const rows = await buildEbayFamilyRows(p!.id, 'IT')
const variants = rows.filter((r) => (r as Record<string, unknown>)._isParent !== true)
console.log('imageAxisPreference (pictureAxisOverride):', JSON.stringify(p!.imageAxisPreference))
console.log('variant rows:', variants.length)
const sample = variants[0] as Record<string, unknown>
console.log('sample row aspect keys:', JSON.stringify(Object.keys(sample).filter((k) => k.startsWith('aspect_'))))

// curated rows → the override map, exactly as the service builds it
const curated = await prisma.listingImage.findMany({
  where: { productId: p!.id, platform: 'EBAY' },
  select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true, position: true },
  orderBy: { position: 'asc' },
})
const pictureAxis = p!.imageAxisPreference || 'Color'
const overrides = new Map<string, string[]>()
for (const r of curated) {
  if (r.variationId || !r.variantGroupKey) continue
  if (axisSynonymKey(r.variantGroupKey) !== axisSynonymKey(pictureAxis)) { console.log('  SKIP (axis mismatch):', r.variantGroupKey); continue }
  const k = String(r.variantGroupValue ?? '').toLowerCase()
  if (!k) continue
  overrides.set(k, [...(overrides.get(k) ?? []), r.url])
}
console.log('override keys:', JSON.stringify([...overrides.keys()]), '→ sizes', JSON.stringify([...overrides.values()].map((v) => v.length)))

// the per-variant lookup
const axisKey = `aspect_${pictureAxis.replace(/ /g, '_')}`
console.log('lookup axisKey:', axisKey)
let hit = 0, miss = 0
for (const v of variants) {
  const val = String((v as Record<string, unknown>)[axisKey] ?? '').toLowerCase()
  if (val && overrides.get(val)?.length) hit++; else { miss++; if (miss <= 3) console.log(`  MISS sku=${(v as any).sku} axisVal="${val}"`) }
}
console.log(`RESULT: ${hit} variants would use the CURATED set, ${miss} would fall back`)
await prisma.$disconnect()
