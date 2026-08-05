const { default: prisma } = await import('../src/db.js')

console.log('╔══ G: aspect_Variantattributes exact values ══╗')
const mems = await prisma.sharedListingMembership.findMany({ select: { marketplace: true, parentSku: true, sku: true, flatFileSnapshot: true } })
const va = mems.filter(m => m.flatFileSnapshot && 'aspect_Variantattributes' in (m.flatFileSnapshot as any))
const vals = new Map<string, number>()
for (const m of va) { const v = String((m.flatFileSnapshot as any).aspect_Variantattributes); vals.set(v, (vals.get(v) ?? 0) + 1) }
console.log(`  ${va.length} SLM rows; distinct values: ${JSON.stringify(Object.fromEntries(vals))}`)
const byP = new Map<string, number>()
for (const m of va) byP.set(m.parentSku, (byP.get(m.parentSku) ?? 0) + 1)
console.log(`  per parentSku: ${JSON.stringify(Object.fromEntries([...byP].sort()))}`)
console.log(`  SKUs: ${[...new Set(va.map(m=>m.sku))].sort().join(', ')}`)

console.log('\n╔══ H: where is _axisValueOrder / _axisSortOrder actually stored? ══╗')
const prodOrder = await prisma.product.findMany({ where: { deletedAt: null, NOT: { categoryAttributes: { equals: null as any } } }, select: { sku: true, categoryAttributes: true } })
let withOrder = 0; const orderKeys = new Map<string, number>(); const orderSkus: string[] = []
for (const p of prodOrder) {
  const ca = p.categoryAttributes as any
  if (!ca || typeof ca !== 'object') continue
  for (const k of ['_axisValueOrder','_axisSortOrder','axisValueOrder','axisSortOrder']) {
    if (ca[k] && typeof ca[k] === 'object') {
      withOrder++
      if (orderSkus.length < 8) orderSkus.push(`${p.sku}: ${k}=${JSON.stringify(ca[k]).slice(0,160)}`)
      for (const ak of Object.keys(ca[k])) orderKeys.set(`${k}:${ak}`, (orderKeys.get(`${k}:${ak}`) ?? 0) + 1)
    }
  }
}
console.log(`  Products with a stored axis order: ${withOrder}`)
console.log(`  keys: ${JSON.stringify(Object.fromEntries([...orderKeys].sort()))}`)
orderSkus.forEach(s => console.log(`    ${s}`))

console.log('\n╔══ I: lowercase itemSpecifics keys — which products? ══╗')
const cls = await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, platformAttributes: true, externalListingId: true, product: { select: { sku: true, parentId: true } } } })
const lowerRows = cls.filter(c => {
  const isp = (c.platformAttributes as any)?.itemSpecifics
  return isp && typeof isp === 'object' && Object.keys(isp).some(k => k !== k.toLowerCase() ? false : /^[a-zà-ÿ]/.test(k))
})
console.log(`  eBay CLs whose itemSpecifics keys start lowercase: ${lowerRows.length}`)
const fams = new Map<string, string[]>()
for (const c of lowerRows) {
  const root = (c.product?.sku ?? '').replace(/-(BLACK|YELLOW|RED|GREEN|BLUE)?-?(MEN|WOMEN)?-?(XXS|XS|S|M|L|XL|XXL|3XL|4XL|5XL)$/i, '')
  if (!fams.has(root)) fams.set(root, [])
  fams.get(root)!.push(c.product?.sku ?? '?')
}
for (const [r, v] of [...fams].sort()) console.log(`    ${r}: ${v.length} rows (${v.slice(0,4).join(', ')}${v.length>4?' …':''})`)

console.log('\n╔══ J: per-market summary counts ══╗')
const allCl = await prisma.channelListing.groupBy({ by: ['marketplace'], where: { channel: 'EBAY' }, _count: true })
console.log(`  eBay ChannelListing per market: ${JSON.stringify(allCl.map(r => [r.marketplace, r._count]))}`)
const allMem = await prisma.sharedListingMembership.groupBy({ by: ['marketplace'], _count: true })
console.log(`  SharedListingMembership per market: ${JSON.stringify(allMem.map(r => [r.marketplace, r._count]))}`)
await prisma.$disconnect()
