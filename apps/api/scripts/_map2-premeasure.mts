/** READ-ONLY. MAP.2 pre-migration measurement: exact row counts to verify the
 *  backfill against, plus the constraints the migration has to replace. */
const { default: prisma } = await import('../src/db.js')

const conns = await prisma.channelConnection.findMany({
  where: { isActive: true }, select: { id: true, channelType: true, managedBy: true },
})
console.log('ACTIVE CONNECTIONS'); for (const c of conns) console.log(`  ${c.channelType.padEnd(8)} ${c.managedBy.padEnd(6)} ${c.id}`)

const counts: Record<string, number> = {
  ChannelListing: await prisma.channelListing.count(),
  VariantChannelListing: await prisma.variantChannelListing.count(),
  SharedListingMembership: await prisma.sharedListingMembership.count(),
  Order: await prisma.order.count(),
  SyncChannelPolicy: await prisma.syncChannelPolicy.count(),
}
console.log('\nROW COUNTS'); for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(26)} ${v}`)

// Per-channel breakdown — the backfill maps by channel, so this is what must match.
for (const [label, rows] of [
  ['ChannelListing', await prisma.channelListing.groupBy({ by: ['channel'], _count: { _all: true } })],
  ['VariantChannelListing', await prisma.variantChannelListing.groupBy({ by: ['channel'], _count: { _all: true } })],
  ['Order', await prisma.order.groupBy({ by: ['channel'], _count: { _all: true } })],
  ['SyncChannelPolicy', await prisma.syncChannelPolicy.groupBy({ by: ['channel'], _count: { _all: true } })],
] as const) {
  console.log(`\n${label} by channel`)
  for (const r of rows as any[]) console.log(`  ${String(r.channel ?? 'NULL').padEnd(12)} ${r._count._all}`)
}

const vclSet = await prisma.variantChannelListing.count({ where: { channelConnectionId: { not: null } } })
console.log(`\nVariantChannelListing.channelConnectionId already set: ${vclSet} of ${counts.VariantChannelListing}`)

const idx = await prisma.$queryRaw<Array<{ t: string; name: string; def: string }>>`
  SELECT tablename::text AS t, indexname::text AS name, indexdef::text AS def FROM pg_indexes
  WHERE tablename IN ('ChannelListing','VariantChannelListing','SharedListingMembership','Order','SyncChannelPolicy','ChannelConnection')
    AND indexdef LIKE '%UNIQUE%' ORDER BY tablename, indexname`
console.log('\nUNIQUE INDEXES THE MIGRATION MUST REASON ABOUT')
for (const i of idx) console.log(`  ${i.t}.${i.name}\n      ${i.def}`)
await prisma.$disconnect()
