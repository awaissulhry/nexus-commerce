/** READ-ONLY verifier: does the DECLARED-name display change the 25013 pre-check
 *  or the wire axis names for any real family today? No writes, no eBay calls. */
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows, resolveVariationAxes, buildVariesBySpecifications } = await import('../src/services/ebay-variation-push.service.js')
const { parseThemeAxes, axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')

const parents = await prisma.product.findMany({
  where: { parentId: null, deletedAt: null, children: { some: { deletedAt: null } } },
  select: { id: true, sku: true, variationTheme: true, imageAxisPreference: true },
})

let checked = 0
for (const p of parents) {
  const cls = await prisma.channelListing.findMany({
    where: { product: { OR: [{ id: p.id }, { parentId: p.id }] }, channel: 'EBAY' },
    select: { marketplace: true, platformAttributes: true },
  })
  if (cls.length === 0) continue
  const markets = [...new Set(cls.map((c) => c.marketplace).filter(Boolean))] as string[]
  const familyRows = await buildEbayFamilyRows(p.id)
  const variantRows = familyRows.filter((r) => r._isParent !== true)
  if (variantRows.length === 0) continue
  for (const mp of markets) {
    const parentCl = await prisma.channelListing.findFirst({
      where: { productId: p.id, channel: 'EBAY', marketplace: mp },
      select: { platformAttributes: true },
    })
    const pa = (parentCl?.platformAttributes ?? {}) as Record<string, unknown>
    const nameLabels = (pa._axisNameLabels ?? {}) as Record<string, string>
    const valueLabels = (pa._axisValueLabels ?? {}) as Record<string, Record<string, string>>
    const storedAxisOrder = Array.isArray(pa._variationAxes) ? (pa._variationAxes as string[]) : []
    const theme = parseThemeAxes(p.variationTheme)
    const declared: string[] | null = theme.length > 0 ? theme : storedAxisOrder.length > 0 ? storedAxisOrder.slice() : null
    if (declared == null) continue
    const opts = { nameLabels, valueLabels, storedAxisOrder, pictureAxisOverride: p.imageAxisPreference || undefined }
    const dec = resolveVariationAxes(variantRows.map((r) => ({ ...r })), declared, opts)
    const leg = resolveVariationAxes(variantRows.map((r) => ({ ...r })), null, opts)
    checked++

    // simulate row normalisation + 25013 pre-check exactly as the push does
    const rows = variantRows.map((r) => ({ ...r })) as Array<Record<string, unknown>>
    for (const spec of dec.validSpecs) {
      const dimKey = axisSynonymKey(spec.name)
      if (!dimKey.startsWith('__dim')) continue
      const canonKey = `aspect_${spec.name.replace(/\s+/g, '_')}`
      const canonLower = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
      for (const vRow of rows) {
        if (vRow[canonKey] || vRow[canonLower]) continue
        for (const [rk, rv] of Object.entries(vRow)) {
          if (!rk.startsWith('aspect_') || !rv) continue
          const an = rk.slice('aspect_'.length).replace(/_/g, ' ')
          if (axisSynonymKey(an) === dimKey) { vRow[canonKey] = rv; break }
        }
      }
    }
    const specs = buildVariesBySpecifications(dec.validSpecs, {}, [])
    const legSpecs = buildVariesBySpecifications(leg.validSpecs, {}, [])
    const missing: string[] = []
    if (!(specs.length === 1 && specs[0].name === 'Custom Bundle')) {
      for (const row of rows) {
        for (const spec of specs) {
          const k1 = `aspect_${spec.name.replace(/\s+/g, '_')}`
          const k2 = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
          if (!String((row[k1] ?? row[k2]) ?? '').trim()) missing.push(`${row.sku}:${spec.name}`)
        }
      }
    }
    // same check under LEGACY (observed) names for comparison
    const missingLegacy: string[] = []
    if (!(legSpecs.length === 1 && legSpecs[0].name === 'Custom Bundle')) {
      for (const row of variantRows as Array<Record<string, unknown>>) {
        for (const spec of legSpecs) {
          const k1 = `aspect_${spec.name.replace(/\s+/g, '_')}`
          const k2 = `aspect_${spec.name.toLowerCase().replace(/\s+/g, '_')}`
          if (!String((row[k1] ?? row[k2]) ?? '').trim()) missingLegacy.push(`${row.sku}:${spec.name}`)
        }
      }
    }
    const nameDiff = dec.validSpecs.filter((s) => s.name !== s.rawName).map((s) => `${s.name}<-${s.rawName}`)
    const wireChanged = JSON.stringify(specs.map((s) => s.name)) !== JSON.stringify(legSpecs.map((s) => s.name))
    const offers = (pa.__offerIds ?? null) ? 'OFFERS' : ''
    if (nameDiff.length || wireChanged || missing.length) {
      console.log(`[${mp}] ${p.sku} ${offers} theme=${JSON.stringify(p.variationTheme)}`)
      console.log(`   DECLARED=[${specs.map((s) => s.name).join('|')}] LEGACY=[${legSpecs.map((s) => s.name).join('|')}]${wireChanged ? '  <<WIRE CHANGED' : ''}`)
      if (nameDiff.length) console.log(`   NAME!=RAW ${JSON.stringify(nameDiff)}`)
      if (missing.length) console.log(`   *** 25013 BLOCK (declared): ${missing.slice(0, 6).join(', ')} (${missing.length})`)
      if (missingLegacy.length) console.log(`   (legacy would also block: ${missingLegacy.slice(0, 4).join(', ')} (${missingLegacy.length}))`)
      // unmapped-dimension declared axes = the un-rescued class
      const unmapped = dec.validSpecs.filter((s) => !axisSynonymKey(s.name).startsWith('__dim'))
      if (unmapped.length) console.log(`   UNMAPPED-DIM axes: ${JSON.stringify(unmapped.map((s) => `${s.name}<-${s.rawName}`))}`)
    }
  }
}
console.log(`\nchecked ${checked} parent×market combos (declared mode)`)
await prisma.$disconnect()
