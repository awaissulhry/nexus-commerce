/** Re-verify with the SYNONYM-AWARE resolver (mirrors the shipped fix). */
const { default: prisma } = await import('../src/db.js')
const { axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')
const { buildEbayFamilyRows } = await import('../src/services/ebay-variation-push.service.js')
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true, imageAxisPreference: true } })
const rows = await buildEbayFamilyRows(p!.id, 'IT')
const variants = rows.filter((r) => (r as Record<string, unknown>)._isParent !== true)
const pictureAxis = p!.imageAxisPreference || 'Color'
const axisValueOfRow = (row: Record<string, unknown>, axis: string): string => {
  const direct = row[`aspect_${axis.replace(/ /g, '_')}`]
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase()
  const want = axisSynonymKey(axis)
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('aspect_') || typeof v !== 'string' || !v.trim()) continue
    if (axisSynonymKey(k.slice('aspect_'.length).replace(/_/g, ' ')) === want) return v.trim().toLowerCase()
  }
  return ''
}
const curated = await prisma.listingImage.findMany({ where: { productId: p!.id, platform: 'EBAY' }, select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true }, orderBy: { position: 'asc' } })
const overrides = new Map<string, string[]>()
for (const r of curated) {
  if (r.variationId || !r.variantGroupKey) continue
  if (axisSynonymKey(r.variantGroupKey) !== axisSynonymKey(pictureAxis)) continue
  const k = String(r.variantGroupValue ?? '').toLowerCase(); if (!k) continue
  overrides.set(k, [...(overrides.get(k) ?? []), r.url])
}
let hit = 0, miss = 0
const per: Record<string, number> = {}
for (const v of variants) {
  const val = axisValueOfRow(v as Record<string, unknown>, pictureAxis)
  const u = val ? overrides.get(val) : undefined
  if (u?.length) { hit++; per[val] = u.length } else miss++
}
console.log(`pictureAxis="${pictureAxis}"  overrides=${JSON.stringify([...overrides.keys()])}`)
console.log(`RESULT: ${hit} variants use the CURATED set, ${miss} fall back`)
console.log('images per colour that will be sent:', JSON.stringify(per))
await prisma.$disconnect()
