// READ-ONLY: Lane-B (listing-shell) branch of resolveFamilyAxes — membership
// flatFileSnapshot rows, which the GET /rows path DOES canonicalize.
const { default: prisma } = await import('../src/db.js')
const { resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { canonicalizeRowAspects, parseThemeAxes } = await import('../src/services/ebay-theme-axes.js')
const { resolveFamilyAxes } = await import('../src/services/ebay-family-axes.service.js')

const out: string[] = []
const shells = await prisma.product.findMany({
  where: { deletedAt: null, productType: 'EBAY_LISTING_SHELL' },
  select: { id: true, sku: true, variationTheme: true, imageAxisPreference: true },
})
out.push(`shells: ${shells.map((s) => s.sku).join(', ')}`)
for (const shell of shells) {
  for (const mp of ['IT', 'DE']) {
    const memberships = await prisma.sharedListingMembership.findMany({
      where: { parentSku: shell.sku!, marketplace: mp },
      select: { sku: true, flatFileSnapshot: true, variationSpecifics: true },
    })
    if (memberships.length === 0) continue
    const rows = memberships.map((m) => {
      const snap = m.flatFileSnapshot && typeof m.flatFileSnapshot === 'object' ? { ...(m.flatFileSnapshot as Record<string, unknown>) } : {}
      const specs = (m.variationSpecifics ?? {}) as Record<string, string>
      for (const [name, value] of Object.entries(specs)) {
        const key = `aspect_${name.replace(/\s+/g, '_')}`
        if (!(key in snap) || String(snap[key] ?? '').trim() === '') snap[key] = value
      }
      snap.sku = m.sku; snap._isParent = false
      return snap
    })
    const canon = rows.map((r) => { const c = { ...r }; canonicalizeRowAspects(c); return c })
    const kRaw = new Set<string>(); for (const r of rows) for (const k of Object.keys(r)) if (k.startsWith('aspect_')) kRaw.add(k)
    const kCan = new Set<string>(); for (const r of canon) for (const k of Object.keys(r)) if (k.startsWith('aspect_')) kCan.add(k)
    const dropped = [...kRaw].filter((k) => !kCan.has(k))
    const listing = await prisma.channelListing.findFirst({ where: { productId: shell.id, channel: 'EBAY', marketplace: mp }, select: { platformAttributes: true } })
    const pa = (listing?.platformAttributes ?? {}) as Record<string, any>
    const themeAxes = parseThemeAxes(shell.variationTheme)
    const stored = Array.isArray(pa._variationAxes) ? pa._variationAxes.filter((s: any) => typeof s === 'string') : []
    const declared = themeAxes.length ? themeAxes : stored.length ? stored.slice() : null
    const opts = { nameLabels: pa._axisNameLabels ?? {}, valueLabels: pa._axisValueLabels ?? {}, storedAxisOrder: stored, pictureAxisOverride: (shell.imageAxisPreference ?? '') || undefined }
    const raw = resolveVariationAxes(rows, declared, opts)
    const fold = resolveVariationAxes(canon, declared, opts)
    const fmt = (r: any) => r.validSpecs.map((s: any) => `${s.name}[${[...s.values].sort().join('/')}]`).join(' | ')
    const same = fmt(raw) === fmt(fold) && JSON.stringify(raw.warnings) === JSON.stringify(fold.warnings)
    out.push(`\n=== ${shell.sku} / ${mp}  memberships=${memberships.length} declared=${JSON.stringify(declared)}`)
    out.push(`  folded-away keys: ${dropped.join(',') || '(none)'}`)
    out.push(`  RAW : ${fmt(raw)}`)
    out.push(`  FOLD: ${fmt(fold)}`)
    out.push(`  warnRAW  ${JSON.stringify(raw.warnings)}`)
    out.push(`  warnFOLD ${JSON.stringify(fold.warnings)}`)
    out.push(`  effRAW ${JSON.stringify(raw.effectiveVarAxes)} effFOLD ${JSON.stringify(fold.effectiveVarAxes)}`)
    out.push(`  DIVERGENT? ${same ? 'NO' : '*** YES ***'}`)
    const live = await resolveFamilyAxes(shell.id, mp)
    out.push(`  resolveFamilyAxes(): ${live.axes.map((a) => `${a.name}[${a.values.join('/')}]`).join(' | ')}`)
    out.push(`  warnings: ${JSON.stringify(live.warnings)}`)
  }
}
const { writeFileSync } = await import('node:fs')
writeFileSync('/private/tmp/claude-501/-Users-awais-nexus-commerce/d027119c-29ec-42b4-9052-5dab9e08b3ce/scratchpad/axes-shells.txt', out.join('\n'))
console.log('WROTE')
process.exit(0)
