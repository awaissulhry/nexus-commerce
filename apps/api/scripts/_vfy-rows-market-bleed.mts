/** READ-ONLY verifier: does GET /rows source aspect_* from a FOREIGN market's listing?
 * Replicates the route's product query + listing sort, then reports rows whose
 * listings[0] (buildFlatRow's itemSpecifics source) is NOT the active market. */
const { default: prisma } = await import('../src/db.js')

function buildListingScopeWhere(opts: { channel: string; marketplace?: string; scope: 'listed' | 'all' }) {
  if (opts.scope === 'all') return {}
  const listingWhere = { channel: opts.channel, ...(opts.marketplace ? { marketplace: opts.marketplace } : {}) }
  const hasListing = { channelListings: { some: listingWhere } }
  return { OR: [hasListing, { parent: hasListing }, { children: { some: hasListing } }] }
}

for (const marketplace of ['IT', 'DE']) {
  const activeRegion = marketplace === 'UK' ? 'GB' : marketplace
  const products = await prisma.product.findMany({
    where: { deletedAt: null, ...(buildListingScopeWhere({ channel: 'EBAY', marketplace, scope: 'listed' }) as object) },
    include: { channelListings: { where: { channel: 'EBAY' } } },
    orderBy: { sku: 'asc' },
  })
  const ts = (l: any) => (l?.updatedAt ? new Date(l.updatedAt).getTime() : 0)
  let noListingAtAll = 0
  const bleeders: Array<{ sku: string; from: string; keys: string[] }> = []
  const foreignFirstNoSpecifics: string[] = []
  for (const p of products as any[]) {
    const ls = [...p.channelListings]
    ls.sort((a: any, b: any) => {
      const aA = a?.region === activeRegion ? 1 : 0
      const bA = b?.region === activeRegion ? 1 : 0
      if (aA !== bA) return bA - aA
      return ts(b) - ts(a)
    })
    const first = ls[0]
    if (!first) { noListingAtAll++; continue }
    if (first.region === activeRegion) continue
    const attrs = (first.platformAttributes ?? {}) as Record<string, unknown>
    const spec = (attrs.itemSpecifics ?? {}) as Record<string, string>
    const keys = Object.keys(spec)
    if (keys.length) bleeders.push({ sku: p.sku, from: first.region, keys })
    else foreignFirstNoSpecifics.push(`${p.sku}:${first.region}`)
  }
  console.log(`\n=== marketplace=${marketplace} scope=listed ===`)
  console.log('products loaded:', products.length, '| no eBay listing at all:', noListingAtAll)
  console.log('FOREIGN-market listings[0] with itemSpecifics (BLEED):', bleeders.length)
  for (const b of bleeders.slice(0, 25)) console.log('  ', b.sku, '<-', b.from, JSON.stringify(b.keys))
  console.log('foreign listings[0] but NO itemSpecifics:', foreignFirstNoSpecifics.length, foreignFirstNoSpecifics.slice(0, 15))
}

// Cross-market key-set comparison for products that HAVE both IT and DE eBay listings
const both = await prisma.product.findMany({
  where: { deletedAt: null, channelListings: { some: { channel: 'EBAY', region: 'DE' } } },
  select: { sku: true, channelListings: { where: { channel: 'EBAY' }, select: { region: true, platformAttributes: true, flatFileSnapshot: true, externalListingId: true, listingStatus: true } } },
})
console.log('\n=== products with a DE eBay listing ===', both.length)
for (const p of both as any[]) {
  const per = p.channelListings.map((l: any) => {
    const spec = ((l.platformAttributes ?? {}).itemSpecifics ?? {}) as Record<string, string>
    const snap = (l.flatFileSnapshot ?? {}) as Record<string, unknown>
    const snapAspects = Object.keys(snap).filter((k) => k.startsWith('aspect_'))
    return `${l.region}[item=${l.externalListingId ?? '-'}|${l.listingStatus}] spec=${JSON.stringify(Object.keys(spec))} snapAspects=${snapAspects.length}`
  })
  console.log(' ', p.sku, '\n    ', per.join('\n     '))
}
await prisma.$disconnect()
