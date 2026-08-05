/** READ-ONLY: when an English twin sits beside its Italian canonical, do the
 * VALUES actually differ (real data loss on fold) or are they translations/
 * duplicates (safe to fold)? Decides the Phase-1 fold policy empirically. */
const { default: prisma } = await import('../src/db.js')
const { aspectCanonicalName } = await import('../src/services/ebay-theme-axes.js')
const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)

let rowsScanned = 0, twinPairs = 0, sameValue = 0, differing = 0, oneEmpty = 0
const examples: string[] = []

function scan(tag: string, snap: unknown) {
  if (!isObj(snap)) return
  rowsScanned++
  const byCanon = new Map<string, Array<[string, string]>>()
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('aspect_')) continue
    const raw = k.slice('aspect_'.length).replace(/_/g, ' ').trim()
    if (!raw) continue
    const canon = aspectCanonicalName(raw)
    const arr = byCanon.get(canon) ?? []
    arr.push([k, typeof v === 'string' ? v.trim() : ''])
    byCanon.set(canon, arr)
  }
  for (const [canon, entries] of byCanon) {
    if (entries.length < 2) continue
    // only LANGUAGE twins (different spellings), not pure case-twins
    const spellings = new Set(entries.map(([k]) => k.slice('aspect_'.length).replace(/_/g, ' ').toLowerCase()))
    if (spellings.size < 2) continue
    twinPairs++
    const vals = entries.map(([, v]) => v)
    const filled = vals.filter((v) => v !== '')
    if (filled.length < 2) { oneEmpty++; continue }
    const uniq = new Set(filled)
    if (uniq.size === 1) sameValue++
    else {
      differing++
      if (examples.length < 12) examples.push(`${tag} · ${canon}: ${JSON.stringify(entries)}`)
    }
  }
}

for (const m of await prisma.sharedListingMembership.findMany({ select: { marketplace: true, parentSku: true, flatFileSnapshot: true } })) {
  scan(`MEMB ${m.marketplace}|${m.parentSku}`, m.flatFileSnapshot)
}
for (const c of await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { marketplace: true, flatFileSnapshot: true, product: { select: { sku: true } } } })) {
  scan(`CL ${c.marketplace}|${c.product?.sku}`, c.flatFileSnapshot)
}

console.log('rows scanned            :', rowsScanned)
console.log('language-twin pairs     :', twinPairs)
console.log('  one side empty (safe) :', oneEmpty)
console.log('  same value    (safe)  :', sameValue)
console.log('  DIFFERENT (data loss) :', differing)
console.log('\nexamples of DIFFERING twins:')
examples.forEach((e) => console.log('  ', e))
await prisma.$disconnect()
