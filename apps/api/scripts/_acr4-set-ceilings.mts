/**
 * ACR.4 — set a CPC ceiling on the three rank modes that have none.
 *
 * Operator-approved 2026-08-05. Numbers derived from measured CPC, not chosen:
 *   median EUR 0.49 · p90 EUR 0.80 · p99 EUR 2.08 · max EUR 2.50
 *   highest bid any keyword actually holds: 96c (p95 44c)
 * So all three ceilings sit ABOVE everything the account does today and bind nothing now;
 * what they cap is the placement multiplier's climb, which an ACOS cap cannot do because it
 * reacts after the spend. Tiered by placement value — rest-of-search is the least valuable
 * slot and the most scheduled (825 windows), so it gets the tightest cap.
 *
 * `own-top-allout` already carries EUR 2.00 and is untouched.
 * `pause` is untouched — it only drives bids down.
 *
 * Usage: npx tsx scripts/_acr4-set-ceilings.mts [--apply]
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const CEILINGS: Record<string, number> = {
  'rest-of-search': 80,
  'defend-top': 120,
  'own-top': 150,
}
const APPLY = process.argv.includes('--apply')

const before = await p.rankTarget.findMany({
  where: { key: { in: Object.keys(CEILINGS) } },
  select: { key: true, name: true, maxCpcCents: true, acosCapPct: true },
  orderBy: { sortOrder: 'asc' },
})

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — CPC ceilings\n`)
for (const t of before) {
  console.log(`  ${t.name.padEnd(22)} maxCpc ${t.maxCpcCents == null ? 'none' : `${t.maxCpcCents}c`} → €${(CEILINGS[t.key] / 100).toFixed(2)}   (ACOS cap ${t.acosCapPct ?? '—'}%)`)
}
if (!APPLY) { await p.$disconnect(); console.log('\nNothing changed. Re-run with --apply.\n'); process.exit(0) }

for (const [key, cents] of Object.entries(CEILINGS)) {
  await p.rankTarget.updateMany({ where: { key, maxCpcCents: null }, data: { maxCpcCents: cents } })
}
const after = await p.rankTarget.findMany({
  where: {}, select: { key: true, name: true, maxCpcCents: true, allOut: true }, orderBy: { sortOrder: 'asc' },
})
console.log('\nAfter:')
for (const t of after) {
  console.log(`  ${t.name.padEnd(22)} maxCpc ${t.maxCpcCents == null ? 'NONE' : `${t.maxCpcCents}c`}${t.allOut ? '  (all-out)' : ''}`)
}
await p.$disconnect()
console.log('')
