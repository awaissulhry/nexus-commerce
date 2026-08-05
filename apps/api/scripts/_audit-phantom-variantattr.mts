/** READ-ONLY: where does the phantom aspect_Variantattributes="[object Object]" live? */
const { default: prisma } = await import('../src/db.js')
const isObj = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o)
const hit = (o: unknown) => Object.entries(isObj(o) ? o : {}).filter(([k, v]) => /variantattribut/i.test(k) || String(v) === '[object Object]')

let membRows = 0, clRows = 0, clSpecs = 0
const keys = new Set<string>()
for (const m of await prisma.sharedListingMembership.findMany({ select: { flatFileSnapshot: true, variationSpecifics: true } })) {
  const h = [...hit(m.flatFileSnapshot), ...hit(m.variationSpecifics)]
  if (h.length) { membRows++; h.forEach(([k]) => keys.add(k)) }
}
for (const c of await prisma.channelListing.findMany({ where: { channel: 'EBAY' }, select: { flatFileSnapshot: true, platformAttributes: true } })) {
  if (hit(c.flatFileSnapshot).length) { clRows++; hit(c.flatFileSnapshot).forEach(([k]) => keys.add(k)) }
  const pa = isObj(c.platformAttributes) ? c.platformAttributes : {}
  if (hit(pa.itemSpecifics).length) { clSpecs++; hit(pa.itemSpecifics).forEach(([k]) => keys.add(k)) }
}
console.log(`membership rows affected      : ${membRows}`)
console.log(`ChannelListing snapshots      : ${clRows}`)
console.log(`ChannelListing itemSpecifics  : ${clSpecs}`)
console.log(`offending keys                : ${JSON.stringify([...keys])}`)
await prisma.$disconnect()
