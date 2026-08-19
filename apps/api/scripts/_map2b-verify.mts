/** READ-ONLY. The question MAP.2b has to answer: does a caller using the NEW
 *  4-column key find the SAME row it found with the old 3-column key? If not, its
 *  upsert would INSERT a duplicate instead of updating. Checked on every row. */
const { default: prisma } = await import('../src/db.js')
const { primaryConnectionIds } = await import('../src/services/connection-resolver.service.js')

const rows = await prisma.channelListing.findMany({
  select: { id: true, productId: true, channel: true, marketplace: true, channelMarket: true, channelConnectionId: true },
})
const conn = await primaryConnectionIds([...new Set(rows.map(r => r.channel))])
console.log('primary per channel:', Object.fromEntries(conn))

let matched = 0, mismatched = 0, missed = 0
const bad: string[] = []
for (const r of rows) {
  const viaNewKey = await prisma.channelListing.findUnique({
    where: { productId_channel_marketplace: {
      productId: r.productId, channel: r.channel, marketplace: r.marketplace,
      channelConnectionId: conn.get(r.channel) ?? null } },
    select: { id: true },
  })
  if (!viaNewKey) { missed++; bad.push(`${r.id} NOT FOUND`) }
  else if (viaNewKey.id !== r.id) { mismatched++; bad.push(`${r.id} -> ${viaNewKey.id}`) }
  else matched++
}
console.log(`\nproductId_channel_marketplace (4-col): ${matched}/${rows.length} resolve to THE SAME row`)
console.log(`  not found: ${missed}   different row: ${mismatched}`)
if (bad.length) console.log('  ' + bad.slice(0, 10).join('\n  '))

// The legacy channelMarket key too.
let m2 = 0, x2 = 0
for (const r of rows) {
  const v = await prisma.channelListing.findUnique({
    where: { productId_channelMarket: { productId: r.productId, channelMarket: r.channelMarket, channelConnectionId: conn.get(r.channel) ?? null } },
    select: { id: true },
  })
  if (v?.id === r.id) m2++; else x2++
}
console.log(`productId_channelMarket      (3-col+conn): ${m2}/${rows.length} same row, ${x2} wrong`)

const idx = await prisma.$queryRaw<Array<{n:string}>>`
  SELECT indexname::text n FROM pg_indexes
  WHERE tablename IN ('ChannelListing','VariantChannelListing','SyncChannelPolicy') AND indexdef LIKE '%UNIQUE%' ORDER BY 1`
console.log('\nunique indexes now present (old + new coexist by design):')
for (const i of idx) console.log('  ' + i.n)
await prisma.$disconnect()
