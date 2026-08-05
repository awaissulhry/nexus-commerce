/** READ-ONLY part 2: replicate resolveFamilyAxes' row sourcing (incl. Lane-B
 * membership snapshots) and report axis value sets + same-physical-value dups.
 * Also dump raw stored axis-dimension twins with DIFFERING values. */
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows, resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { parseThemeAxes, axisValueSynonymKey, axisSynonymKey } = await import('../src/services/ebay-theme-axes.js')
const isObj = (o: any): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)

const parents = await prisma.product.findMany({ where: { isParent: true }, select: { id: true, sku: true, variationTheme: true, imageAxisPreference: true } })
let flagged = 0
for (const p of parents) {
  const familyRows = await buildEbayFamilyRows(p.id).catch(() => [] as any[])
  let variantRows = familyRows.filter((r: any) => r._isParent !== true)
  for (const mp of ['IT', 'DE']) {
    let rows = variantRows
    if (rows.length === 0 && p.sku) {
      const memb = await prisma.sharedListingMembership.findMany({ where: { parentSku: p.sku, marketplace: mp }, select: { sku: true, flatFileSnapshot: true, variationSpecifics: true } })
      rows = memb.map((m) => {
        const snap: any = isObj(m.flatFileSnapshot) ? { ...m.flatFileSnapshot } : {}
        const specs = (m.variationSpecifics ?? {}) as Record<string, string>
        for (const [n, v] of Object.entries(specs)) { const k = `aspect_${n.replace(/\s+/g, '_')}`; if (!(k in snap) || String(snap[k] ?? '').trim() === '') snap[k] = v }
        snap.sku = m.sku; snap._isParent = false; return snap
      })
    }
    if (rows.length === 0) rows = familyRows
    if (rows.length === 0) continue
    const pl = await prisma.channelListing.findFirst({ where: { productId: p.id, channel: 'EBAY', marketplace: mp }, select: { platformAttributes: true } })
    const pa = (pl?.platformAttributes ?? {}) as any
    const storedAxisOrder = Array.isArray(pa._variationAxes) ? pa._variationAxes.filter((s: any) => typeof s === 'string') : []
    const themeAxes = parseThemeAxes(p.variationTheme)
    const declared = themeAxes.length ? themeAxes : (storedAxisOrder.length ? storedAxisOrder.slice() : null)
    const res = resolveVariationAxes(rows, declared, { nameLabels: pa._axisNameLabels ?? {}, valueLabels: pa._axisValueLabels ?? {}, storedAxisOrder, pictureAxisOverride: p.imageAxisPreference || undefined })
    for (const spec of res.validSpecs) {
      const byKey = new Map<string, string[]>()
      for (const v of spec.values) {
        const k = String(v).split('|').map((s) => axisValueSynonymKey(s.trim())).join('|')
        byKey.set(k, [...(byKey.get(k) ?? []), v])
      }
      const dups = [...byKey.entries()].filter(([, vs]) => vs.length > 1)
      if (dups.length) { flagged++; console.log(`DUP ${mp} ${p.sku} axis="${spec.name}" values=${JSON.stringify([...spec.values])}`) }
    }
    console.log(`OK  ${mp} ${p.sku} rows=${rows.length} axes=${res.validSpecs.map((s) => `${s.name}[${[...s.values].join(',')}]`).join(' | ')}`)
  }
}
console.log('flagged:', flagged)

// raw stored twins on AXIS dimensions with differing values
console.log('--- raw stored axis-dimension twins (differing values) ---')
const scan = (label: string, snap: any) => {
  if (!isObj(snap)) return
  const byDim = new Map<string, Array<[string, string]>>()
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('aspect_') || typeof v !== 'string' || !v) continue
    const name = k.slice(7).replace(/_/g, ' ')
    const dim = axisSynonymKey(name)
    if (!dim.startsWith('__dim')) continue
    byDim.set(dim, [...(byDim.get(dim) ?? []), [k, v]])
  }
  for (const [dim, pairs] of byDim) {
    const distinct = new Set(pairs.map(([, v]) => v))
    if (pairs.length > 1 && distinct.size > 1) console.log(`  ${label} ${dim} ${JSON.stringify(pairs)}`)
  }
}
for (const m of await prisma.sharedListingMembership.findMany({ select: { sku: true, marketplace: true, parentSku: true, status: true, flatFileSnapshot: true } })) scan(`MEMB ${m.marketplace} ${m.parentSku}/${m.sku} ${m.status}`, m.flatFileSnapshot)
for (const c of await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, flatFileSnapshot: true, product: { select: { sku: true } } } })) scan(`CL ${c.marketplace} ${c.product?.sku}`, c.flatFileSnapshot)
await prisma.$disconnect()
