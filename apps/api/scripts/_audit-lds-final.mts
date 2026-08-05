const { default: prisma } = await import('../src/db.js')

// ═══ A: itemId 257584954808 — claimed by DE ChannelListing AND IT shared listing? ═══
console.log('╔══ A: cross-market itemId collision check ══╗')
for (const iid of ['257584954808', '257608449467']) {
  const cl = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', externalListingId: iid },
    select: { marketplace: true, region: true, listingStatus: true, offerActive: true, updatedAt: true, product: { select: { sku: true } } },
  })
  const mem = await prisma.sharedListingMembership.findMany({
    where: { itemId: iid }, select: { marketplace: true, parentSku: true, sku: true, status: true },
  })
  console.log(`  itemId=${iid}`)
  console.log(`    ChannelListings: ${cl.map(c => `${c.marketplace}/${c.region} sku=${c.product?.sku} st=${c.listingStatus} active=${c.offerActive} upd=${c.updatedAt.toISOString().slice(0,10)}`).join(' | ') || 'none'}`)
  console.log(`    Memberships    : ${mem.length} rows, markets=${[...new Set(mem.map(m=>m.marketplace))].join(',')}, parents=${[...new Set(mem.map(m=>m.parentSku))].join(',')}`)
}

// ═══ B: exact TEST-family inventory ═══
console.log('\n╔══ B: TEST family ══╗')
const testish = await prisma.product.findMany({
  where: { OR: [{ sku: { startsWith: 'TEST' } }, { name: { startsWith: 'TEST' } }] },
  select: { id: true, sku: true, name: true, variationTheme: true, parentId: true, status: true, deletedAt: true, createdAt: true,
    channelListings: { where: { channel: 'EBAY' }, select: { marketplace: true, externalListingId: true, flatFileSnapshot: true, platformAttributes: true } } },
})
for (const p of testish) {
  console.log(`  sku=${p.sku} id=${p.id} name=${JSON.stringify(p.name)} theme=${JSON.stringify(p.variationTheme)} parentId=${p.parentId} status=${p.status} deletedAt=${p.deletedAt} created=${p.createdAt.toISOString().slice(0,10)}`)
  for (const c of p.channelListings) {
    const s = c.flatFileSnapshot as any
    const aspects = s ? Object.keys(s).filter(k => k.startsWith('aspect_')) : []
    console.log(`     CL ${c.marketplace} itemId=${JSON.stringify(c.externalListingId)} snapAspects=${JSON.stringify(aspects)} isp=${JSON.stringify((c.platformAttributes as any)?.itemSpecifics)}`)
  }
}

// ═══ C: lowercase vs Sentence-case twins inside platformAttributes.itemSpecifics ═══
console.log('\n╔══ C: CASE twins inside platformAttributes.itemSpecifics (NOT folded — canonicalize only runs on ROWS) ══╗')
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, platformAttributes: true, product: { select: { sku: true } } } })
let caseTwinRows = 0
const twinKeyTally = new Map<string, number>()
const twinSkus: string[] = []
for (const c of cls) {
  const isp = (c.platformAttributes as any)?.itemSpecifics
  if (!isp || typeof isp !== 'object' || Array.isArray(isp)) continue
  const keys = Object.keys(isp)
  const lower = new Map<string, string[]>()
  for (const k of keys) {
    const lk = k.toLowerCase()
    if (!lower.has(lk)) lower.set(lk, [])
    lower.get(lk)!.push(k)
  }
  const dups = [...lower.entries()].filter(([, v]) => v.length > 1)
  if (dups.length) {
    caseTwinRows++
    if (twinSkus.length < 5) twinSkus.push(`${c.marketplace}/${c.product?.sku}: ${dups.map(([lk,v])=>`${lk}→${JSON.stringify(v)}`).join(', ')}`)
    for (const [lk] of dups) twinKeyTally.set(lk, (twinKeyTally.get(lk) ?? 0) + 1)
  }
}
console.log(`  ChannelListing rows whose itemSpecifics hold same-name CASE twins: ${caseTwinRows}`)
console.log(`  keys: ${JSON.stringify(Object.fromEntries([...twinKeyTally.entries()].sort((a,b)=>b[1]-a[1])))}`)
twinSkus.forEach(s => console.log(`    ${s}`))

// ═══ D: aspect_Variantattributes — phantom column source ═══
console.log('\n╔══ D: aspect_Variantattributes phantom ══╗')
const mems2 = await prisma.sharedListingMembership.findMany({ select: { marketplace: true, parentSku: true, sku: true, flatFileSnapshot: true } })
const va = mems2.filter(m => m.flatFileSnapshot && typeof m.flatFileSnapshot === 'object' && 'aspect_Variantattributes' in (m.flatFileSnapshot as any))
console.log(`  SLM rows carrying aspect_Variantattributes: ${va.length}`)
if (va.length) console.log(`  parents=${[...new Set(va.map(m=>m.parentSku))].join(',')}  sampleValue=${JSON.stringify((va[0].flatFileSnapshot as any).aspect_Variantattributes).slice(0,300)}`)
const vaCl = cls.filter(c => false)
const cls2 = await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, flatFileSnapshot: true, product: { select: { sku: true } } } })
const vaCl2 = cls2.filter(c => c.flatFileSnapshot && typeof c.flatFileSnapshot === 'object' && 'aspect_Variantattributes' in (c.flatFileSnapshot as any))
console.log(`  CL rows carrying aspect_Variantattributes: ${vaCl2.length} → ${vaCl2.map(c=>`${c.marketplace}/${c.product?.sku}`).join(', ')}`)

// ═══ E: _axisValueOrder per market ═══
console.log('\n╔══ E: stored axis value order keys per market ══╗')
const orderTally = new Map<string, number>()
for (const c of cls2) {
  const s = c.flatFileSnapshot as any
  if (!s) continue
  for (const k of ['_axisValueOrder', '_axisSortOrder']) {
    if (s[k] && typeof s[k] === 'object') {
      for (const ak of Object.keys(s[k])) orderTally.set(`CL ${c.marketplace} ${k}:${ak}`, (orderTally.get(`CL ${c.marketplace} ${k}:${ak}`) ?? 0) + 1)
    }
  }
}
for (const m of mems2) {
  const s = m.flatFileSnapshot as any
  if (!s) continue
  for (const k of ['_axisValueOrder', '_axisSortOrder']) {
    if (s[k] && typeof s[k] === 'object') {
      for (const ak of Object.keys(s[k])) orderTally.set(`SLM ${m.marketplace} ${k}:${ak}`, (orderTally.get(`SLM ${m.marketplace} ${k}:${ak}`) ?? 0) + 1)
    }
  }
}
for (const [k, n] of [...orderTally.entries()].sort()) console.log(`  ${n.toString().padStart(4)} × ${k}`)

// ═══ F: DE file — what the operator actually sees as aspect columns ═══
console.log('\n╔══ F: union of aspect_* column ids the DE file would render ══╗')
const deCls = await prisma.channelListing.findMany({ where: { channel: 'EBAY', marketplace: 'DE' }, select: { flatFileSnapshot: true, platformAttributes: true, product: { select: { sku: true } } } })
const deCols = new Set<string>()
for (const c of deCls) {
  const s = c.flatFileSnapshot as any
  if (s) Object.keys(s).filter(k => k.startsWith('aspect_')).forEach(k => deCols.add(k))
  const isp = (c.platformAttributes as any)?.itemSpecifics
  if (isp && typeof isp === 'object') Object.keys(isp).forEach(k => deCols.add(`aspect_${k.replace(/ /g,'_')}`))
}
console.log(`  ${deCols.size} distinct: ${[...deCols].sort().join(', ')}`)
console.log(`  GERMAN-named columns among them: ${[...deCols].filter(k => /Farbe|Größe|Grosse|Marke|Zustand|Stil|Material_|Geschlecht/i.test(k)).length}`)

await prisma.$disconnect()
