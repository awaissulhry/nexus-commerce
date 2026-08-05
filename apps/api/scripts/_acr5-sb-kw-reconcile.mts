/**
 * ACR Stage 5 — SB keyword reconcile harness. READ-ONLY unless APPLY=1.
 *
 * Amazon → local only. Never writes to Amazon: our rows are the stale side, and pushing them
 * would overwrite live bids with a 50c placeholder.
 *
 *   dry run:  cd apps/api && railway run npx tsx scripts/_acr5-sb-kw-reconcile.mts
 *   apply:    cd apps/api && APPLY=1 railway run npx tsx scripts/_acr5-sb-kw-reconcile.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { reconcileSbKeywords } = await import('../src/services/advertising/ads-sb-keyword-reconcile.service.js')

const apply = process.env.APPLY === '1'
console.log(`\n${apply ? '⚠️  APPLYING (Amazon → local)' : 'DRY RUN — nothing will be written'}\n`)

const before = await prisma.adTarget.groupBy({
  by: ['status'],
  where: { kind: 'KEYWORD', isNegative: false, adGroup: { campaign: { adProduct: 'SPONSORED_BRANDS' } } },
  _count: { _all: true },
})
console.log('local SB keyword rows BEFORE: ' + before.map(b => `${b.status}=${b._count._all}`).join(' '))

const r = await reconcileSbKeywords({ apply })

console.log(`\nchecked=${r.checked}  updated=${r.updated}`)
console.log('verdicts: ' + Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join('  '))

const drift = r.rows.filter(x => x.verdict === 'DRIFT')
if (drift.length) {
  console.log(`\nDRIFT — Amazon wins (showing ${Math.min(12, drift.length)} of ${drift.length}):`)
  console.log('  MKT  ' + 'KEYWORD'.padEnd(34) + 'LOCAL'.padEnd(20) + 'AMAZON')
  for (const d of drift.slice(0, 12)) {
    const l = `${d.localState} @ €${d.localBidEur?.toFixed(2) ?? '—'}`
    const a = `${d.amazonState} @ €${d.amazonBidEur?.toFixed(2) ?? '—'}`
    console.log(`  ${d.marketplace.padEnd(5)}${(d.keywordText.length > 32 ? d.keywordText.slice(0, 31) + '…' : d.keywordText).padEnd(34)}${l.padEnd(20)}${a}`)
  }
}
for (const v of ['MISSING_LOCALLY', 'NOT_ON_AMAZON'] as const) {
  const rowsV = r.rows.filter(x => x.verdict === v)
  if (rowsV.length) {
    console.log(`\n${v} (${rowsV.length}) — NOT auto-fixed:`)
    for (const x of rowsV.slice(0, 8)) console.log(`  ${x.marketplace}  ${x.keywordText}  local=${x.localState ?? '—'} amazon=${x.amazonState ?? '—'}`)
  }
}
if (r.errors.length) { console.log('\nERRORS:'); for (const e of r.errors) console.log(`  ${e}`) }

const after = await prisma.adTarget.groupBy({
  by: ['status'],
  where: { kind: 'KEYWORD', isNegative: false, adGroup: { campaign: { adProduct: 'SPONSORED_BRANDS' } } },
  _count: { _all: true },
})
console.log('\nlocal SB keyword rows AFTER:  ' + after.map(b => `${b.status}=${b._count._all}`).join(' '))
if (!apply) console.log('SAFETY — dry run: BEFORE and AFTER must be identical.')
await prisma.$disconnect(); process.exit(0)
