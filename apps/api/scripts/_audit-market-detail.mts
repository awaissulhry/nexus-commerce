/** READ-ONLY audit #2: DE rows, English twins, variationTheme drift. NO WRITES. */
const { default: prisma } = await import('../src/db.js')
const out: string[] = []
const p = (s: string) => out.push(s)

// ── A. All non-IT eBay ChannelListings, full detail ──────────────────────
const de = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', NOT: { marketplace: 'IT' } },
  select: {
    id: true, marketplace: true, region: true, channelMarket: true,
    externalListingId: true, platformProductId: true, listingStatus: true,
    variationTheme: true, flatFileSnapshot: true, platformAttributes: true,
    createdAt: true, updatedAt: true,
    product: { select: { id: true, sku: true, variationTheme: true, isParent: true, parentId: true, status: true } },
  },
  orderBy: [{ marketplace: 'asc' }],
})
p(`\n===== NON-IT eBay ChannelListings: ${de.length} =====`)
for (const c of de) {
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
  const isp = (pa.itemSpecifics ?? {}) as Record<string, unknown>
  const aspKeys = Object.keys(snap).filter((k) => k.startsWith('aspect_')).sort()
  p(`\n[${c.marketplace}] sku=${c.product?.sku} clId=${c.id}`)
  p(`   extListingId=${JSON.stringify(c.externalListingId)} platformProductId=${JSON.stringify(c.platformProductId)} listingStatus=${c.listingStatus}`)
  p(`   CL.variationTheme=${JSON.stringify(c.variationTheme)}  Product.variationTheme=${JSON.stringify(c.product?.variationTheme)}  snap.variation_theme=${JSON.stringify(snap.variation_theme)}`)
  p(`   product.isParent=${c.product?.isParent} parentId=${c.product?.parentId} product.status=${c.product?.status}  updatedAt=${c.updatedAt.toISOString()}`)
  p(`   snap aspect keys (${aspKeys.length}): ${aspKeys.join(', ')}`)
  const twin = aspKeys.filter((k) => /^aspect_(Size|Color|Colour|Brand|Season|Style|Material|Gender|Department)$/i.test(k))
  if (twin.length) {
    p(`   *** ENGLISH TWIN KEYS: ${twin.map((k) => `${k}=${JSON.stringify(snap[k])}`).join(' | ')}`)
    for (const t of twin) {
      const it = t === 'aspect_Size' ? 'aspect_Taglia' : t === 'aspect_Color' ? 'aspect_Colore' : t === 'aspect_Brand' ? 'aspect_Marca' : '?'
      p(`       italian twin ${it}=${JSON.stringify(snap[it])}`)
    }
  }
  p(`   itemSpecifics keys (${Object.keys(isp).length}): ${Object.keys(isp).sort().join(', ')}`)
  const ispTwin = Object.keys(isp).filter((k) => /^(Size|Color|Colour|Brand)$/i.test(k))
  if (ispTwin.length) p(`   *** itemSpecifics ENGLISH TWINS: ${ispTwin.map((k) => `${k}=${JSON.stringify(isp[k])}`).join(' | ')} vs Colore=${JSON.stringify(isp['Colore'])} Taglia=${JSON.stringify(isp['Taglia'])} Marca=${JSON.stringify(isp['Marca'])}`)
}

// ── B. IT ChannelListings carrying English twins ─────────────────────────
const itAll = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', marketplace: 'IT' },
  select: {
    id: true, externalListingId: true, listingStatus: true, variationTheme: true,
    flatFileSnapshot: true, platformAttributes: true, updatedAt: true,
    product: { select: { sku: true, variationTheme: true, isParent: true, status: true } },
  },
})
p(`\n\n===== IT eBay ChannelListings with English/odd aspect keys =====`)
const ENG = /^aspect_(Size|Color|Colour|Brand|Season|Gender|Department|Material|Style|Variantattributes|Body_type|Athlete|Team_name)$/i
for (const c of itAll) {
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  const bad = Object.keys(snap).filter((k) => ENG.test(k))
  if (!bad.length) continue
  const hard = bad.filter((k) => /^aspect_(Size|Color|Colour|Brand|Variantattributes)$/i.test(k))
  if (!hard.length) continue
  p(`\n[IT] sku=${c.product?.sku} clId=${c.id} ext=${JSON.stringify(c.externalListingId)} status=${c.listingStatus} theme=${JSON.stringify(c.variationTheme)} prodTheme=${JSON.stringify(c.product?.variationTheme)} updatedAt=${c.updatedAt.toISOString()}`)
  for (const k of hard) p(`    ${k} = ${JSON.stringify(snap[k])}`)
  p(`    aspect_Taglia=${JSON.stringify(snap['aspect_Taglia'])} aspect_Colore=${JSON.stringify(snap['aspect_Colore'])} aspect_Marca=${JSON.stringify(snap['aspect_Marca'])}`)
}

// ── C. SLM rows carrying English twins ───────────────────────────────────
const mems = await prisma.sharedListingMembership.findMany({
  select: { id: true, marketplace: true, sku: true, itemId: true, parentSku: true, status: true, variationSpecifics: true, flatFileSnapshot: true, updatedAt: true },
})
p(`\n\n===== SharedListingMembership with English twin aspect_ keys =====`)
const byItem = new Map<string, { skus: string[]; keys: Set<string>; status: Set<string>; parent: Set<string> }>()
for (const m of mems) {
  const snap = (m.flatFileSnapshot ?? {}) as Record<string, unknown>
  const bad = Object.keys(snap).filter((k) => /^aspect_(Size|Color|Colour|Brand|Variantattributes)$/i.test(k))
  if (!bad.length) continue
  const key = `${m.marketplace}|${m.itemId}`
  if (!byItem.has(key)) byItem.set(key, { skus: [], keys: new Set(), status: new Set(), parent: new Set() })
  const e = byItem.get(key)!
  e.skus.push(m.sku); bad.forEach((b) => e.keys.add(b)); e.status.add(m.status); e.parent.add(m.parentSku)
}
for (const [k, e] of [...byItem].sort()) {
  p(`\n${k}  rows=${e.skus.length} parentSku=[${[...e.parent].join(',')}] status=[${[...e.status].join(',')}]`)
  p(`   twin keys: ${[...e.keys].sort().join(', ')}`)
  p(`   skus: ${e.skus.sort().join(', ')}`)
}

// ── D. SLM variationSpecifics axis-name drift per itemId ─────────────────
p(`\n\n===== SLM variationSpecifics AXIS NAMES per (marketplace,itemId) =====`)
const axByItem = new Map<string, { names: Set<string>; rows: number; parent: Set<string>; status: Set<string> }>()
for (const m of mems) {
  const vs = (m.variationSpecifics ?? {}) as Record<string, unknown>
  const key = `${m.marketplace}|${m.itemId}`
  if (!axByItem.has(key)) axByItem.set(key, { names: new Set(), rows: 0, parent: new Set(), status: new Set() })
  const e = axByItem.get(key)!
  e.rows++; Object.keys(vs).forEach((n) => e.names.add(n)); e.parent.add(m.parentSku); e.status.add(m.status)
}
for (const [k, e] of [...axByItem].sort()) {
  p(`${k.padEnd(20)} rows=${String(e.rows).padStart(3)} axes=[${[...e.names].sort().join(' | ')}]  parent=[${[...e.parent].join(',')}] status=[${[...e.status].join(',')}]`)
}

await prisma.$disconnect()
console.log(out.join('\n'))
