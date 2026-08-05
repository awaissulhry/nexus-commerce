const { default: prisma } = await import('../src/db.js')

const mems = await prisma.sharedListingMembership.findMany({ select: { marketplace: true, parentSku: true, sku: true, itemId: true, flatFileSnapshot: true } })
const hits = mems.filter(m => {
  const s = m.flatFileSnapshot as any
  return s && typeof s === 'object' && Object.keys(s).some(k => /^aspect_variantattributes$/i.test(k))
})
console.log('SLM rows carrying an aspect_variantattributes-ish key:', hits.length)
const byKey = new Map<string, number>()
const byVal = new Map<string, number>()
for (const m of hits) {
  const s = m.flatFileSnapshot as any
  for (const k of Object.keys(s)) {
    if (!/^aspect_variantattributes$/i.test(k)) continue
    byKey.set(k, (byKey.get(k) ?? 0) + 1)
    const v = s[k]
    const label = v === '' ? '<empty string>' : v == null ? '<null>' : typeof v === 'string' ? JSON.stringify(v) : `<${typeof v}> ${JSON.stringify(v).slice(0,120)}`
    byVal.set(label, (byVal.get(label) ?? 0) + 1)
  }
}
console.log('  exact keys:', JSON.stringify(Object.fromEntries(byKey)))
console.log('  values:', JSON.stringify(Object.fromEntries(byVal), null, 1))
const byP = new Map<string, number>()
for (const m of hits) byP.set(`${m.marketplace}/${m.parentSku}`, (byP.get(`${m.marketplace}/${m.parentSku}`) ?? 0) + 1)
console.log('  per market/parentSku:', JSON.stringify(Object.fromEntries([...byP].sort()), null, 1))
console.log('  non-empty-value rows:', hits.filter(m => { const s=m.flatFileSnapshot as any; return Object.keys(s).some(k=>/^aspect_variantattributes$/i.test(k) && String(s[k] ?? '').trim() !== '') }).map(m => `${m.marketplace}/${m.parentSku}/${m.sku}/${m.itemId}`).sort())

const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, externalListingId: true, flatFileSnapshot: true, product: { select: { sku: true } } } })
const clHits = cls.filter(c => { const s = c.flatFileSnapshot as any; return s && typeof s === 'object' && Object.keys(s).some(k => /^aspect_variantattributes$/i.test(k)) })
console.log('\nCL rows carrying it:', clHits.length)
for (const c of clHits) {
  const s = c.flatFileSnapshot as any
  const k = Object.keys(s).find(k => /^aspect_variantattributes$/i.test(k))!
  console.log(`  ${c.marketplace}/${c.product?.sku}/${c.externalListingId} key=${k} val=${JSON.stringify(s[k])}`)
}
await prisma.$disconnect()
