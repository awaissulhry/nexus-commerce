/** READ-ONLY: does resolveVariationAxes' step-3 synonym merge ever produce an
 * axis value list containing TWO spellings of the same physical value? */
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows, resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { parseThemeAxes, axisValueSynonymKey, axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')

const parents = await prisma.product.findMany({
  where: { isParent: true },
  select: { id: true, sku: true, variationTheme: true, imageAxisPreference: true },
})
console.log('parents:', parents.length)
let flagged = 0
for (const p of parents) {
  let familyRows: any[] = []
  try { familyRows = await buildEbayFamilyRows(p.id) } catch (e) { continue }
  const variantRows = familyRows.filter((r: any) => r._isParent !== true)
  const rows = variantRows.length ? variantRows : familyRows
  if (!rows.length) continue
  for (const mp of ['IT', 'DE']) {
    const pl = await prisma.channelListing.findFirst({ where: { productId: p.id, channel: 'EBAY', marketplace: mp }, select: { platformAttributes: true } })
    const pa = (pl?.platformAttributes ?? {}) as any
    const nameLabels = pa._axisNameLabels ?? {}
    const valueLabels = pa._axisValueLabels ?? {}
    const storedAxisOrder = Array.isArray(pa._variationAxes) ? pa._variationAxes.filter((s: any) => typeof s === 'string') : []
    const themeAxes = parseThemeAxes(p.variationTheme)
    const declaredAxes = themeAxes.length ? themeAxes : (storedAxisOrder.length ? storedAxisOrder.slice() : null)
    const res = resolveVariationAxes(rows, declaredAxes, { nameLabels, valueLabels, storedAxisOrder, pictureAxisOverride: p.imageAxisPreference || undefined })
    for (const spec of res.validSpecs) {
      const byKey = new Map<string, string[]>()
      for (const v of spec.values) {
        // pipe-encoded: key each segment
        const k = String(v).split('|').map(s => axisValueSynonymKey(s.trim())).join('|')
        byKey.set(k, [...(byKey.get(k) ?? []), v])
      }
      const dups = [...byKey.entries()].filter(([, vs]) => vs.length > 1)
      if (dups.length) {
        flagged++
        console.log(`DUP  ${mp} ${p.sku} declared=${JSON.stringify(declaredAxes)} axis="${spec.name}" raw="${spec.rawName}" values=${JSON.stringify([...spec.values])} dupGroups=${JSON.stringify(dups)}`)
      }
    }
  }
}
console.log('flagged spec/market combos:', flagged)
await prisma.$disconnect()
