// READ-ONLY sweep: for EVERY eBay variation family, compare resolveVariationAxes
// over buildEbayFamilyRows output (what resolveFamilyAxes/cockpit/images use)
// vs the same rows after canonicalizeRowAspects (what GET /rows serves).
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows, resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { canonicalizeRowAspects, parseThemeAxes } = await import('../src/services/ebay-theme-axes.js')

const out: string[] = []
const parents = await prisma.product.findMany({
  where: { deletedAt: null, isParent: true, children: { some: { deletedAt: null, channelListings: { some: { channel: 'EBAY' } } } } },
  select: { id: true, sku: true, variationTheme: true, imageAxisPreference: true },
})
out.push(`families: ${parents.length}`)
let divergent = 0
let twinFamilies = 0
for (const parent of parents) {
  const rows = await buildEbayFamilyRows(parent.id)
  const variants = rows.filter((r) => r._isParent !== true)
  const use = variants.length ? variants : rows
  const canon = use.map((r) => { const c = { ...r }; canonicalizeRowAspects(c); return c })
  const kRaw = new Set<string>(); for (const r of use) for (const k of Object.keys(r)) if (k.startsWith('aspect_')) kRaw.add(k)
  const kCan = new Set<string>(); for (const r of canon) for (const k of Object.keys(r)) if (k.startsWith('aspect_')) kCan.add(k)
  const dropped = [...kRaw].filter((k) => !kCan.has(k))
  const listing = await prisma.channelListing.findFirst({ where: { productId: parent.id, channel: 'EBAY', marketplace: 'IT' }, select: { platformAttributes: true } })
  const pa = (listing?.platformAttributes ?? {}) as Record<string, any>
  const themeAxes = parseThemeAxes(parent.variationTheme)
  const stored = Array.isArray(pa._variationAxes) ? pa._variationAxes.filter((s: any) => typeof s === 'string') : []
  const declared = themeAxes.length ? themeAxes : stored.length ? stored.slice() : null
  const opts = { nameLabels: pa._axisNameLabels ?? {}, valueLabels: pa._axisValueLabels ?? {}, storedAxisOrder: stored, pictureAxisOverride: (parent.imageAxisPreference ?? '') || undefined }
  const raw = resolveVariationAxes(use, declared, opts)
  const fold = resolveVariationAxes(canon, declared, opts)
  const fmt = (r: any) => r.validSpecs.map((s: any) => `${s.name}[${[...s.values].sort().join('/')}]`).join(' | ')
  const same = fmt(raw) === fmt(fold)
    && JSON.stringify(raw.warnings) === JSON.stringify(fold.warnings)
    && JSON.stringify(raw.suppressed) === JSON.stringify(fold.suppressed)
  if (dropped.length) { twinFamilies++; out.push(`TWINS ${parent.sku}: folded-away keys = ${dropped.join(',')} | declared=${JSON.stringify(declared)} | mode=${declared ? 'DECLARED' : 'LEGACY'}`) }
  if (!same) {
    divergent++
    out.push(`*** DIVERGENT ${parent.sku} (${parent.id}) declared=${JSON.stringify(declared)} mode=${declared ? 'DECLARED' : 'LEGACY'}`)
    out.push(`    RAW : ${fmt(raw)}`)
    out.push(`    FOLD: ${fmt(fold)}`)
    out.push(`    warnRAW  ${JSON.stringify(raw.warnings)}`)
    out.push(`    warnFOLD ${JSON.stringify(fold.warnings)}`)
    out.push(`    suppRAW ${JSON.stringify(raw.suppressed)} suppFOLD ${JSON.stringify(fold.suppressed)}`)
  }
}
out.push(`\nfamilies with twin keys folded away: ${twinFamilies}`)
out.push(`families where resolver output DIVERGES: ${divergent}`)
const { writeFileSync } = await import('node:fs')
writeFileSync('/private/tmp/claude-501/-Users-awais-nexus-commerce/d027119c-29ec-42b4-9052-5dab9e08b3ce/scratchpad/axes-sweep.txt', out.join('\n'))
console.log('WROTE')
process.exit(0)
