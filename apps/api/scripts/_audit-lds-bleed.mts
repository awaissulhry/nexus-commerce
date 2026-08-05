/**
 * READ-ONLY: simulate what the DE file loads, and quantify cross-market
 * itemSpecifics bleed (buildFlatRow uses channelListings[0], not the market's).
 */
const { default: prisma } = await import('../src/db.js')
import { buildListingScopeWhere } from '../src/services/flat-file/listing-scope.js'
import { parseThemeAxes, aspectCanonicalName } from '../src/services/ebay-theme-axes.js'

for (const MKT of ['DE', 'IT']) {
  const region = MKT
  const products = await prisma.product.findMany({
    where: { deletedAt: null, ...buildListingScopeWhere({ channel: 'EBAY', marketplace: MKT, scope: 'listed' }) },
    include: { channelListings: { where: { channel: 'EBAY' }, select: { region: true, marketplace: true, platformAttributes: true, flatFileSnapshot: true, updatedAt: true, externalListingId: true, variationTheme: true } } },
    orderBy: { sku: 'asc' },
  })
  console.log(`\n\n╔══ MARKET ${MKT}: file scope loads ${products.length} products ══╗`)
  let noOwn = 0, bleedRows = 0
  const bleedSample: string[] = []
  for (const p of products) {
    const own = p.channelListings.find(l => l.region === region)
    if (!own) {
      noOwn++
      // buildFlatRow would take listings[0] after sort → freshest OTHER market
      const sorted = [...p.channelListings].sort((a, b) => (+new Date(b.updatedAt)) - (+new Date(a.updatedAt)))
      const first = sorted[0]
      const isp = (first?.platformAttributes as any)?.itemSpecifics
      const keys = isp && typeof isp === 'object' ? Object.keys(isp) : []
      if (keys.length) {
        bleedRows++
        if (bleedSample.length < 12) bleedSample.push(`   ${p.sku}  ← itemSpecifics from region=${first?.region} keys=${JSON.stringify(keys)}`)
      }
    }
  }
  console.log(`  products WITHOUT an own ${MKT} eBay ChannelListing: ${noOwn}`)
  console.log(`  …of which would render aspect_* columns sourced from ANOTHER market's itemSpecifics: ${bleedRows}`)
  bleedSample.forEach(s => console.log(s))
}

// ═══ Q5: theme drift per market ═══
console.log('\n\n╔══ Q5: variationTheme drift (Product vs ChannelListing vs snapshot) ══╗')
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, region: true, variationTheme: true, flatFileSnapshot: true, externalListingId: true,
    product: { select: { sku: true, variationTheme: true, parentId: true } } },
})
const driftCounts = new Map<string, number>()
const driftSample = new Map<string, string[]>()
for (const c of cls) {
  const pt = c.product?.variationTheme ?? null
  const ct = c.variationTheme ?? null
  const st = (c.flatFileSnapshot as any)?.variation_theme ?? null
  const norm = (t: unknown) => parseThemeAxes(t).map(a => aspectCanonicalName(a)).sort().join('+') || '(none)'
  const raw = (t: unknown) => (t == null ? 'null' : JSON.stringify(t))
  const agree = norm(pt) === norm(st) || st == null
  const key = `${c.marketplace} | P=${raw(pt)} CL=${raw(ct)} SNAP=${raw(st)} | canonAgree=${agree}`
  driftCounts.set(key, (driftCounts.get(key) ?? 0) + 1)
  if (!driftSample.has(key)) driftSample.set(key, [])
  const arr = driftSample.get(key)!
  if (arr.length < 4) arr.push(c.product?.sku ?? '?')
}
for (const [k, n] of [...driftCounts.entries()].sort()) {
  console.log(`  ${n.toString().padStart(4)} × ${k}\n         e.g. ${driftSample.get(k)!.join(', ')}`)
}

// ═══ Q5b: SLM snapshot theme per market ═══
console.log('\n╔══ Q5b: SharedListingMembership snapshot variation_theme per market/parent ══╗')
const mems = await prisma.sharedListingMembership.findMany({
  select: { marketplace: true, parentSku: true, itemId: true, sku: true, flatFileSnapshot: true, variationSpecifics: true, status: true, productId: true },
})
const memTheme = new Map<string, { n: number; themes: Map<string, number>; vsKeys: Set<string>; itemIds: Set<string>; nullProd: number }>()
for (const m of mems) {
  const id = `${m.marketplace}::${m.parentSku}`
  if (!memTheme.has(id)) memTheme.set(id, { n: 0, themes: new Map(), vsKeys: new Set(), itemIds: new Set(), nullProd: 0 })
  const g = memTheme.get(id)!
  g.n++
  const t = String((m.flatFileSnapshot as any)?.variation_theme ?? '(none)')
  g.themes.set(t, (g.themes.get(t) ?? 0) + 1)
  const vs = m.variationSpecifics as any
  if (vs && typeof vs === 'object') Object.keys(vs).forEach(k => g.vsKeys.add(k))
  g.itemIds.add(m.itemId)
  if (!m.productId) g.nullProd++
}
for (const [id, g] of [...memTheme.entries()].sort()) {
  console.log(`  ${id}  mems=${g.n} itemIds=${[...g.itemIds].join(',')} nullProductId=${g.nullProd}`)
  console.log(`      snapThemes=${JSON.stringify(Object.fromEntries(g.themes))}  variationSpecificsKeys=${JSON.stringify([...g.vsKeys])}`)
}

// ═══ Q4: TEST / junk / orphan rows ═══
console.log('\n╔══ Q4: TEST / junk products & orphans ══╗')
const junk = await prisma.product.findMany({
  where: { deletedAt: null, OR: [{ sku: { contains: 'TEST', mode: 'insensitive' } }, { sku: { startsWith: 'tmp' } }] },
  select: { id: true, sku: true, name: true, variationTheme: true, parentId: true, status: true, createdAt: true,
    channelListings: { where: { channel: 'EBAY' }, select: { marketplace: true, externalListingId: true, flatFileSnapshot: true } } },
})
for (const p of junk) {
  console.log(`  TESTish sku=${p.sku} status=${p.status} theme=${JSON.stringify(p.variationTheme)} parentId=${p.parentId} created=${p.createdAt.toISOString().slice(0,10)} ebayCLs=${p.channelListings.map(c=>`${c.marketplace}:${c.externalListingId||'(empty)'}`).join(',')||'none'}`)
}
const orphanMems = mems.filter(m => !m.productId)
console.log(`  SharedListingMembership rows with NULL productId: ${orphanMems.length}`)
const emptyItemIdCls = cls.filter(c => !c.externalListingId || c.externalListingId === '')
console.log(`  eBay ChannelListing rows with empty/null externalListingId: ${emptyItemIdCls.length} (${[...new Set(emptyItemIdCls.map(c=>c.marketplace))].join(',')})`)
const byMkt = new Map<string, number>()
for (const c of emptyItemIdCls) byMkt.set(c.marketplace, (byMkt.get(c.marketplace) ?? 0) + 1)
console.log(`     per market: ${JSON.stringify(Object.fromEntries(byMkt))}`)

await prisma.$disconnect()
