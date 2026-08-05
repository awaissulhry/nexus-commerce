/** READ-ONLY verifier: does aspect_Variantattributes (and other off-schema aspect
 *  keys) actually exist in prod with a NON-EMPTY value, and would it surface as a
 *  ghost column in the grid? No writes. */
const { default: prisma } = await import('../src/db.js')

const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { id: true, region: true, flatFileSnapshot: true, platformAttributes: true, product: { select: { sku: true, parentId: true } } },
})
console.log('EBAY ChannelListing rows:', cls.length)

const keyCount = new Map<string, number>()
const keyNonEmpty = new Map<string, number>()
const hits: Array<{ sku: string; region: string; key: string; val: string }> = []
for (const cl of cls) {
  const snap = (cl.flatFileSnapshot ?? {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('aspect_')) continue
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
    const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
    if (s) {
      keyNonEmpty.set(k, (keyNonEmpty.get(k) ?? 0) + 1)
      if (/variant|body|athlete|team|^aspect_Size$|^aspect_Color$/i.test(k)) {
        hits.push({ sku: cl.product?.sku ?? '?', region: cl.region ?? '?', key: k, val: s.slice(0, 40) })
      }
    }
  }
}
console.log('\n--- snapshot aspect_* keys (total / non-empty) ---')
for (const [k, c] of [...keyCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${k}  total=${c}  nonEmpty=${keyNonEmpty.get(k) ?? 0}`)
}
console.log('\n--- suspicious non-empty hits (first 30) ---')
for (const h of hits.slice(0, 30)) console.log(JSON.stringify(h))
console.log('total suspicious non-empty hits:', hits.length)

// itemSpecifics side
const specCount = new Map<string, number>()
for (const cl of cls) {
  const pa = (cl.platformAttributes ?? {}) as Record<string, unknown>
  const sp = (pa.itemSpecifics ?? {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(sp)) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) continue
    specCount.set(k, (specCount.get(k) ?? 0) + 1)
  }
}
console.log('\n--- platformAttributes.itemSpecifics keys (non-empty) ---')
for (const [k, c] of [...specCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`${JSON.stringify(k)} x${c}`)

// membership snapshots
const mem = await prisma.sharedListingMembership.findMany({ select: { sku: true, marketplace: true, flatFileSnapshot: true } })
const memKeys = new Map<string, number>()
for (const m of mem) {
  const snap = (m.flatFileSnapshot ?? {}) as Record<string, unknown>
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('aspect_')) continue
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) continue
    memKeys.set(k, (memKeys.get(k) ?? 0) + 1)
  }
}
console.log('\n--- membership snapshot aspect_* keys (non-empty), n=', mem.length, '---')
for (const [k, c] of [...memKeys.entries()].sort((a, b) => b[1] - a[1])) console.log(`${k} x${c}`)

// stored category schemas
const schemas = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `select table_name from information_schema.tables where table_name ilike '%categor%'`)
console.log('\ncategory-ish tables:', JSON.stringify(schemas))
await prisma.$disconnect()
