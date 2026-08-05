/** READ-ONLY: where do multi-language variation-theme columns come from? For a
 * few families, dump the aspect_* keys in each stored source + what the read-side
 * canonicalizeRowAspects fold produces. */
const { default: prisma } = await import('../src/db.js')
const { canonicalizeRowAspects } = await import('../src/services/ebay-theme-axes.js')
const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const aspectKeys = (o: unknown) => (isObj(o) ? Object.keys(o) : []).filter((k) => k.startsWith('aspect_'))
const themeish = (k: string) => /colo|color|tagl|size|marca|brand|gener|stagion|season|material/i.test(k)

for (const sku of ['GALE-JACKET', 'IT-GALE-JACKET', 'AIRMESH-JACKET', 'VENTRA-JACKET', 'IT-MOSS-JACKET']) {
  const p = await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true } })
  if (!p) { console.log(`\n${sku}: NOT FOUND`); continue }
  const cls = await prisma.channelListing.findMany({ where: { productId: p.id, channel: 'EBAY' }, select: { platformAttributes: true, flatFileSnapshot: true } })
  const memb = await prisma.sharedListingMembership.findMany({ where: { parentSku: sku, status: 'ACTIVE' }, select: { flatFileSnapshot: true, variationSpecifics: true } })

  const itemSpecKeys = new Set<string>(), snapKeys = new Set<string>(), vsKeys = new Set<string>()
  for (const c of cls) {
    const pa = isObj(c.platformAttributes) ? c.platformAttributes : {}
    for (const k of Object.keys(isObj(pa.itemSpecifics) ? pa.itemSpecifics : {})) itemSpecKeys.add(k)
    for (const k of aspectKeys(c.flatFileSnapshot)) snapKeys.add(k)
  }
  for (const m of memb) {
    for (const k of aspectKeys(m.flatFileSnapshot)) snapKeys.add(k)
    for (const k of Object.keys(isObj(m.variationSpecifics) ? m.variationSpecifics : {})) vsKeys.add(k)
  }
  console.log(`\n${sku}  (CLs=${cls.length}, active memberships=${memb.length})`)
  console.log('  CL itemSpecifics theme-ish keys:', JSON.stringify([...itemSpecKeys].filter(themeish)))
  console.log('  snapshot aspect theme-ish keys:', JSON.stringify([...snapKeys].filter(themeish)))
  console.log('  variationSpecifics keys       :', JSON.stringify([...vsKeys]))
  const sample = memb[0]?.flatFileSnapshot ?? cls[0]?.flatFileSnapshot
  if (isObj(sample)) {
    const s = { ...sample }
    canonicalizeRowAspects(s)
    console.log('  → after canonicalizeRowAspects :', JSON.stringify(aspectKeys(s).filter(themeish)))
  }
}
await prisma.$disconnect()
