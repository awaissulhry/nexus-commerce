/** APS.1 — backfill ProductReadCache.asin + rollupChannelKeys, then prove it.
 *
 *  Two set-based UPDATEs rather than 339 ProductReadCacheService.refresh()
 *  calls: refresh() fire-and-forgets a BullMQ parent re-enqueue, so running it
 *  in bulk from a laptop floods ioredis reconnects against an unreachable
 *  Upstash host. The SQL below mirrors refresh()'s semantics exactly —
 *
 *    asin              = Product.amazonAsin
 *    rollupChannelKeys = own channelKeys ∪ { channel_marketplace of every
 *                        non-deleted CHILD's ChannelListing }
 *
 *  — and refresh() remains the steady-state writer, so the two cannot drift
 *  for new writes. Safe to re-run; idempotent.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

L('══ BACKFILL ══════════════════════════════════════════════════════')

const nAsin = await p.$executeRawUnsafe(`
  UPDATE "ProductReadCache" prc
     SET "asin" = pr."amazonAsin"
    FROM "Product" pr
   WHERE pr.id = prc.id
     AND prc."asin" IS DISTINCT FROM pr."amazonAsin"
`)
L(`  asin:              ${nAsin} rows updated`)

const nRollup = await p.$executeRawUnsafe(`
  UPDATE "ProductReadCache" prc
     SET "rollupChannelKeys" = sub.keys
    FROM (
      SELECT base.id,
             COALESCE((
               SELECT array_agg(DISTINCT k ORDER BY k)
                 FROM (
                   SELECT unnest(base."channelKeys") AS k
                   UNION
                   SELECT cl.channel || '_' || COALESCE(cl.marketplace, cl.region, 'MAIN')
                     FROM "Product" c
                     JOIN "ChannelListing" cl ON cl."productId" = c.id
                    WHERE c."parentId" = base.id
                      AND c."deletedAt" IS NULL
                 ) u
             ), ARRAY[]::text[]) AS keys
        FROM "ProductReadCache" base
    ) sub
   WHERE prc.id = sub.id
     AND prc."rollupChannelKeys" IS DISTINCT FROM sub.keys
`)
L(`  rollupChannelKeys: ${nRollup} rows updated`)

L('\n══ asin COVERAGE IN THE CACHE ════════════════════════════════════')
const total = await p.productReadCache.count({ where: { deletedAt: null } })
const withAsin = await p.productReadCache.count({ where: { deletedAt: null, asin: { not: null } } })
const srcAsin = await p.product.count({ where: { deletedAt: null, amazonAsin: { not: null } } })
L(`  cache rows: ${total}   with asin: ${withAsin}  (${((withAsin / total) * 100).toFixed(1)}%)`)
L(`  Product.amazonAsin set: ${srcAsin}   ${withAsin === srcAsin ? '✓ mirrored exactly' : '✗ MISMATCH'}`)

L('\n══ THE ROLLUP FIX — parents whose own keys hide their children ═══')
const roots = await p.productReadCache.findMany({
  where: { deletedAt: null, parentId: null },
  select: { sku: true, channelKeys: true, rollupChannelKeys: true },
  orderBy: { sku: 'asc' },
})
const amz = (k: string[]) => k.some((x) => x.startsWith('AMAZON'))
const rescued = roots.filter((r: any) => !amz(r.channelKeys) && amz(r.rollupChannelKeys))
L(`  families a naive channelKeys filter would WRONGLY HIDE: ${rescued.length}`)
for (const r of rescued) {
  L(`    ${String(r.sku).padEnd(26)} own=[${r.channelKeys.join(',')}]  rollup=[${r.rollupChannelKeys.join(',')}]`)
}

L('\n══ WHAT THE PICKER WILL SEE ══════════════════════════════════════')
const where = (extra: any) => ({ deletedAt: null, parentId: null, ...extra })
const unscoped = await p.productReadCache.count({ where: where({}) })
const naive = await p.productReadCache.count({ where: where({ channelKeys: { hasSome: ['AMAZON_IT'] } }) })
const correct = await p.productReadCache.count({ where: where({ rollupChannelKeys: { hasSome: ['AMAZON_IT'] } }) })
L(`  unscoped (what it shows TODAY):                ${unscoped}`)
L(`  channels=AMAZON_IT       (naive, UNDER-shows): ${naive}`)
L(`  advertisableOn=AMAZON_IT (correct):            ${correct}`)

for (const mk of ['AMAZON_IT', 'AMAZON_DE', 'AMAZON_FR', 'AMAZON_ES']) {
  const c = await p.productReadCache.count({ where: where({ rollupChannelKeys: { hasSome: [mk] } }) })
  L(`    ${mk.padEnd(12)} ${c} families`)
}

L('\n══ REGRESSION: /products grid facet (channelKeys) UNCHANGED ══════')
for (const k of ['AMAZON_IT', 'EBAY_IT', 'AMAZON_DE']) {
  const c = await p.productReadCache.count({ where: { deletedAt: null, channelKeys: { hasSome: [k] } } })
  L(`    channelKeys hasSome ${k.padEnd(12)} ${c}`)
}

await prisma.$disconnect()
