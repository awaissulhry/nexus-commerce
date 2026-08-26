/**
 * SOV page study — part D. READ-ONLY.
 *
 * Part B found the sqp-ingest cron runs daily and reports `markets=9 ok=4 failed=5` on EVERY run,
 * with runs that get swept as stale after 2.3h. This pins down:
 *   1. the true CronRun history (part B took only 8) — how far back, and the pass/fail pattern
 *   2. WHICH 5 markets fail, and why — ingestSqp throws on a missing Marketplace row or no ASINs
 *   3. the per-market ASIN budget (ourAsinsForMarketplace default 10) vs what we advertise
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ourAsinsForMarketplace } = await import('../src/services/advertising/sqp.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ SOV page study — D: the SQP feed, diagnosed ═══\n')

const total = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest' } })
const first = await prisma.cronRun.findFirst({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } })
const byStatus = await prisma.cronRun.groupBy({ by: ['status'], where: { jobName: 'sqp-ingest' }, _count: { _all: true } })
console.log(`CronRun 'sqp-ingest' : ${int(total)} rows · oldest ${first?.startedAt.toISOString() ?? '—'}`)
console.log(`  by status: ${byStatus.map((s) => `${s.status}=${s._count._all}`).join(' · ')}`)
// Retention: is the whole CronRun table this short, or just this job?
const cronTotal = await prisma.cronRun.count()
const cronFirst = await prisma.cronRun.findFirst({ orderBy: { startedAt: 'asc' }, select: { startedAt: true, jobName: true } })
console.log(`  whole CronRun table: ${int(cronTotal)} rows, oldest ${cronFirst?.startedAt.toISOString() ?? '—'} (${cronFirst?.jobName ?? '—'})`)
console.log(`  → if the oldest row for EVERY job is the same age, CronRun is pruned and "no row exists"`)
console.log(`    would be a retention artefact, not evidence the job never ran.`)

const all = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 40, select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true } })
console.log(`\n  every recorded run:`)
for (const r of all) {
  const mins = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 60000) : null
  console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 8)} ${pad(mins == null ? '—' : `${mins}m`, 6)} ${r.outputSummary ?? ''}${r.errorMessage ? ` ERR:${r.errorMessage}` : ''}`)
}

// ── which markets does the job try, and which can succeed? ────────────────────
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true, profileId: true } })
const markets = [...new Set(conns.map((c) => c.marketplace))].sort()
console.log(`\n── the 9 markets runSqpIngestOnce() iterates (active AmazonAdsConnection) ──`)
console.log(`  ${markets.join(' · ')}`)
console.log(`\n  ${pad('mkt', 5)} ${pad('Marketplace row?', 18)} ${pad('ASINs found (cap 10)', 21)} ${pad('SQP rows stored', 16)} verdict`)
for (const mk of markets) {
  const mrow = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code: mk } }, select: { marketplaceId: true } })
  const asins = await ourAsinsForMarketplace(mk, 10)
  const stored = await prisma.searchQueryPerformance.count({ where: { marketplace: mk } })
  const verdict = !mrow ? 'THROWS — no Marketplace row' : !asins.length ? 'THROWS — no ASIN' : 'can run'
  console.log(`  ${pad(mk, 5)} ${pad(mrow ? `yes (${mrow.marketplaceId})` : 'NO', 18)} ${pad(String(asins.length), 21)} ${pad(int(stored), 16)} ${verdict}`)
}

// ── the ASIN budget ───────────────────────────────────────────────────────────
console.log(`\n── the coverage cap: ingestSqp asks for 10 ASINs per market, per run ──`)
for (const mk of ['IT', 'DE', 'ES', 'FR']) {
  const asins = await ourAsinsForMarketplace(mk, 10)
  const listings = await prisma.channelListing.count({ where: { channel: 'AMAZON', OR: [{ marketplace: mk }, { region: mk }] } })
  const distinctStored = await prisma.searchQueryPerformance.groupBy({ by: ['asin'], where: { marketplace: mk } })
  console.log(`  ${pad(mk, 4)} requested-per-run ${pad(String(asins.length), 3)} · ChannelListing rows ${pad(int(listings), 6)} · distinct ASINs ever stored ${distinctStored.length}`)
  console.log(`       this run would request: ${asins.slice(0, 10).join(' ')}`)
}
console.log(`  → ourAsinsForMarketplace() has no rotation: the same top-10 are requested every day,`)
console.log(`    so coverage does NOT "cycle over days" the way the cron's comment claims.`)

await prisma.$disconnect()
console.log('\n═══ end D ═══\n')
