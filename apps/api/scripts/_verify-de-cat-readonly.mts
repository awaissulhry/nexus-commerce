// READ-ONLY. No writes.
const { default: prisma } = await import('../src/db.js')
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { region: true, productId: true, platformAttributes: true },
})
const byRegion: Record<string, { n: number; cats: Set<string>; specKeys: Set<string> }> = {}
for (const cl of cls) {
  const pa = (cl.platformAttributes ?? {}) as Record<string, unknown>
  const r = cl.region ?? '?'
  byRegion[r] ??= { n: 0, cats: new Set(), specKeys: new Set() }
  byRegion[r].n++
  byRegion[r].cats.add(String(pa.categoryId ?? ''))
  for (const k of Object.keys((pa.itemSpecifics ?? {}) as object)) byRegion[r].specKeys.add(k)
}
for (const [r, v] of Object.entries(byRegion)) {
  console.log(`region=${r} listings=${v.n} categoryIds=${JSON.stringify([...v.cats])}`)
  console.log(`   itemSpecifics keys: ${[...v.specKeys].sort().join(' | ')}`)
}
await prisma.$disconnect()
