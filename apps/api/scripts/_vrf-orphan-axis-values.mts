/** READ-ONLY: does any resolved axis carry a value NO variant actually uses?
 * (mirrors pushVariationGroup's per-variant lookup at ~1151-1170) */
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows, resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { parseThemeAxes, axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')
const parents = await prisma.product.findMany({ where: { isParent: true }, select: { id: true, sku: true, variationTheme: true, imageAxisPreference: true } })
let orphans = 0
for (const p of parents) {
  const familyRows = await buildEbayFamilyRows(p.id).catch(() => [] as any[])
  const variantRows = familyRows.filter((r: any) => r._isParent !== true)
  const rows = variantRows.length ? variantRows : familyRows
  if (!rows.length) continue
  for (const mp of ['IT', 'DE']) {
    const pl = await prisma.channelListing.findFirst({ where: { productId: p.id, channel: 'EBAY', marketplace: mp }, select: { platformAttributes: true } })
    const pa = (pl?.platformAttributes ?? {}) as any
    const storedAxisOrder = Array.isArray(pa._variationAxes) ? pa._variationAxes.filter((s: any) => typeof s === 'string') : []
    const themeAxes = parseThemeAxes(p.variationTheme)
    const declared = themeAxes.length ? themeAxes : (storedAxisOrder.length ? storedAxisOrder.slice() : null)
    const res = resolveVariationAxes(rows, declared, { nameLabels: pa._axisNameLabels ?? {}, valueLabels: pa._axisValueLabels ?? {}, storedAxisOrder, pictureAxisOverride: p.imageAxisPreference || undefined })
    for (const spec of res.validSpecs) {
      const used = new Set<string>()
      const dimKey = axisSynonymKey(spec.name)
      for (const row of rows as any[]) {
        const canonKey = `aspect_${spec.name.replace(/\s+/g, '_')}`
        const canonLower = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
        let found = String((row[canonKey] ?? row[canonLower]) ?? '').trim()
        if (!found && dimKey.startsWith('__dim')) {
          for (const [rk, rv] of Object.entries(row)) {
            if (!rk.startsWith('aspect_') || !rv) continue
            if (axisSynonymKey(rk.slice(7).replace(/_/g, ' ')) === dimKey) { found = String(rv).trim(); break }
          }
        }
        if (found) used.add(found)
      }
      const orphan = [...spec.values].filter((v) => !used.has(v))
      if (orphan.length) { orphans++; console.log(`ORPHAN ${mp} ${p.sku} axis="${spec.name}" orphanValues=${JSON.stringify(orphan)} all=${JSON.stringify([...spec.values])}`) }
    }
  }
}
console.log('orphan specs:', orphans)
await prisma.$disconnect()
