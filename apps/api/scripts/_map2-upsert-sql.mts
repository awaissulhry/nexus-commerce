/** Does Prisma emit ON CONFLICT for a compound-unique upsert? If yes, dropping that
 *  index breaks the caller at RUNTIME (42P10), not at compile time.
 *  Runs inside a transaction that is ALWAYS rolled back — nothing is committed. */
const { PrismaClient } = await import('@prisma/client')
await import('../src/env.js')
const p = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
const sql: string[] = []
;(p as any).$on('query', (e: any) => sql.push(e.query))

const existing = await p.channelListing.findFirst({ select: { productId: true, channel: true, marketplace: true } })
console.log('probe row:', existing)

try {
  await p.$transaction(async (tx) => {
    sql.length = 0
    await tx.channelListing.upsert({
      where: { productId_channel_marketplace: { productId: existing!.productId, channel: existing!.channel, marketplace: existing!.marketplace } },
      update: { updatedAt: new Date() },
      create: { productId: existing!.productId, channel: existing!.channel, marketplace: existing!.marketplace, channelMarket: 'PROBE_NEVER', region: 'XX' },
    })
    throw new Error('__ROLLBACK__')
  })
} catch (e: any) {
  if (e?.message !== '__ROLLBACK__') console.log('upsert error:', e?.message?.split('\n')[0])
}
console.log('\nSQL emitted by the upsert:')
for (const s of sql) console.log('  ' + s.replace(/\s+/g, ' ').slice(0, 220))
console.log('\nON CONFLICT used:', sql.some(s => /ON CONFLICT/i.test(s)))
await p.$disconnect()
