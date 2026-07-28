/**
 * AX2.9 — normalise the marketplace on AMS rows already in the table.
 *
 * AX2.3 fixed ingestion so new rows store 'IT' rather than Amazon's raw
 * marketplaceId 'APJ6JRA9NG5V4'. The 9,728 hourly rows written before that fix
 * still carry the raw id, so any per-market query silently misses them.
 *
 * Reversible-by-construction: it only rewrites a marketplace value to its
 * documented 2-letter code, and only where the current value is a known raw id.
 * DRY RUN by default — pass --apply to write.
 */
const prisma = (await import('../src/db.js')).default
const { normalizeAmsMarketplace } = await import('../src/services/advertising/ads-marketing-stream.service.js')

const APPLY = process.argv.includes('--apply')
const L = (s = '') => console.log(s)
L(`── AMS marketplace backfill ${APPLY ? '(APPLY)' : '(DRY RUN — pass --apply)'} ──\n`)

for (const [label, model] of [
  ['AmazonAdsHourlyPerformance', prisma.amazonAdsHourlyPerformance],
  ['AmazonAdsDailyPerformance', prisma.amazonAdsDailyPerformance],
] as const) {
  const groups = await (model as { groupBy: (a: unknown) => Promise<Array<{ marketplace: string | null; _count: { _all: number } }>> })
    .groupBy({ by: ['marketplace'], _count: { _all: true } })
  L(`${label}:`)
  let changed = 0
  for (const g of groups) {
    const raw = g.marketplace
    if (!raw) { L(`   ${String(raw).padEnd(16)} ${g._count._all}  (null — left alone)`); continue }
    const normalised = normalizeAmsMarketplace(raw)
    if (normalised === raw) { L(`   ${raw.padEnd(16)} ${g._count._all}  ✓ already normalised`); continue }
    L(`   ${raw.padEnd(16)} ${g._count._all}  → ${normalised}`)
    if (APPLY) {
      const r = await (model as { updateMany: (a: unknown) => Promise<{ count: number }> })
        .updateMany({ where: { marketplace: raw }, data: { marketplace: normalised } })
      changed += r.count
    } else {
      changed += g._count._all
    }
  }
  L(`   ${APPLY ? 'REWROTE' : 'WOULD REWRITE'}: ${changed}\n`)
}

await prisma.$disconnect()
L('── done ──')
