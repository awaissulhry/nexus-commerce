// READ-ONLY verification probe: does resolveFamilyAxes (uncanonicalized rows)
// differ from the GET /rows shape (canonicalized rows)?
const { default: prisma } = await import('../src/db.js')
const { buildEbayFamilyRows, resolveVariationAxes } = await import('../src/services/ebay-variation-push.service.js')
const { canonicalizeRowAspects, parseThemeAxes } = await import('../src/services/ebay-theme-axes.js')

const skus = ['IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3']
const wp = await prisma.product.findMany({
  where: { sku: { startsWith: 'WATERPROOF-OVERJACKET' }, deletedAt: null },
  select: { id: true, sku: true, parentId: true, isParent: true, productType: true },
})
console.log('WATERPROOF products:', JSON.stringify(wp, null, 1))

const named = await prisma.product.findMany({
  where: { sku: { in: skus }, deletedAt: null },
  select: { id: true, sku: true, parentId: true, isParent: true, productType: true, variationTheme: true, variationAxes: true },
})
console.log('named:', JSON.stringify(named, null, 1))

const parentIds = new Set<string>()
for (const p of [...named, ...wp]) parentIds.add(p.parentId ?? p.id)

for (const pid of parentIds) {
  const parent = await prisma.product.findUnique({ where: { id: pid }, select: { sku: true, variationTheme: true, variationAxes: true, imageAxisPreference: true } })
  const rows = await buildEbayFamilyRows(pid)
  const variants = rows.filter((r) => r._isParent !== true)
  const use = variants.length ? variants : rows
  const keys = new Set<string>()
  for (const r of use) for (const k of Object.keys(r)) if (k.startsWith('aspect_')) keys.add(k)
  const canon = use.map((r) => { const c = { ...r }; canonicalizeRowAspects(c); return c })
  const ckeys = new Set<string>()
  for (const r of canon) for (const k of Object.keys(r)) if (k.startsWith('aspect_')) ckeys.add(k)

  const listing = await prisma.channelListing.findFirst({ where: { productId: pid, channel: 'EBAY', marketplace: 'IT' }, select: { platformAttributes: true } })
  const pa = (listing?.platformAttributes ?? {}) as Record<string, any>
  const themeAxes = parseThemeAxes(parent?.variationTheme)
  const stored = Array.isArray(pa._variationAxes) ? pa._variationAxes.filter((s: any) => typeof s === 'string') : []
  const declared = themeAxes.length ? themeAxes : stored.length ? stored.slice() : null
  const opts = { nameLabels: pa._axisNameLabels ?? {}, valueLabels: pa._axisValueLabels ?? {}, storedAxisOrder: stored, pictureAxisOverride: (parent?.imageAxisPreference ?? '') || undefined }
  const raw = resolveVariationAxes(use, declared, opts)
  const fold = resolveVariationAxes(canon, declared, opts)
  const fmt = (r: any) => r.validSpecs.map((s: any) => `${s.name}[${[...s.values].sort().join(',')}]`).join(' | ')
  const same = fmt(raw) === fmt(fold)
  console.log(`\n=== ${parent?.sku} (${pid}) rows=${rows.length} variants=${variants.length} theme=${JSON.stringify(parent?.variationTheme)} declared=${JSON.stringify(declared)}`)
  console.log(' raw aspect keys :', [...keys].sort().join(', '))
  console.log(' canon keys      :', [...ckeys].sort().join(', '))
  console.log(' RAW  axes:', fmt(raw))
  console.log(' FOLD axes:', fmt(fold))
  console.log(' effectiveVarAxes RAW:', JSON.stringify(raw.effectiveVarAxes), ' FOLD:', JSON.stringify(fold.effectiveVarAxes))
  console.log(' DIVERGENT?', same ? 'NO' : '*** YES ***')
  console.log(' warnRAW:', JSON.stringify(raw.warnings), '\n warnFOLD:', JSON.stringify(fold.warnings))
  console.log(' suppRAW:', JSON.stringify(raw.suppressed), ' suppFOLD:', JSON.stringify(fold.suppressed))
}
process.exit(0)
