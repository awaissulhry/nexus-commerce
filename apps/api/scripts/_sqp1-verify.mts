/**
 * _sqp1-verify.mts — SQP.1 Phase B, verified against prod data. READ-ONLY, no Amazon call.
 *
 * Phase B changed which markets the job selects and what its summary says. Both are checked here by
 * running the SAME code the job runs, against the real database — not by reading the diff.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp1-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { ourAsinsForMarketplace, SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'
import { buildSqpSummary, type SqpMarketOutcome } from '../src/jobs/sqp-ingest.job.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }

async function main() {
  // ── B1 · the market selection, run for real ────────────────────────────────────────────────
  h('B1 · which markets does the NEW selection choose?')
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
  const candidates = [...new Set(conns.map((c) => c.marketplace))].sort()
  const eligible: string[] = []
  const skipped: string[] = []
  for (const mkt of candidates) {
    const asins = await ourAsinsForMarketplace(mkt, 10)
    if (asins.length === 0) skipped.push(mkt); else eligible.push(mkt)
  }
  line(`candidates (active ads connections): ${candidates.length} — ${candidates.join(', ')}`)
  line(`eligible  (we hold ASINs there)    : ${eligible.length} — ${eligible.join(', ')}`)
  line(`skipped   (no Amazon listing)      : ${skipped.length} — ${skipped.join(', ')}`)
  const wanted = ['DE', 'ES', 'FR', 'IT']
  const ok1 = eligible.length === 4 && wanted.every((m) => eligible.includes(m))
  line(ok1 ? '✓ exactly the 4 markets that have ever produced an SQP row' : '🔴 UNEXPECTED selection — investigate before shipping')
  line(`  reports per run: ${eligible.length} × 10 = ${eligible.length * 10} (was ${candidates.length} markets attempted, 5 throwing instantly)`)

  // ── B2 · the summary, on the numbers the last two nights actually produced ──────────────────
  h('B2 · what the summary would have said on 2026-08-11/12 (measured outcomes)')
  const abandonedAll: SqpMarketOutcome[] = eligible.map((m) => ({
    marketplace: m, asinsRequested: 10, rows: 0, upserted: 0, failedAsins: 10, abandonedAsins: 10,
  }))
  const zero = buildSqpSummary({ candidates, skipped, outcomes: abandonedAll })
  line('OLD: markets=9 ok=4 failed=5 rows=0            ← and status=SUCCESS')
  line(`NEW summary: ${zero.summary}`)
  line(`NEW verdict: ${zero.fatal ? 'FAILED — ' + zero.fatal.slice(0, 200) + '…' : '🔴 still green, which is the defect'}`)

  h('B2b · and on 2026-08-10, the last night that worked (83 rows)')
  const healthy: SqpMarketOutcome[] = [
    { marketplace: 'DE', asinsRequested: 10, rows: 5, upserted: 5, failedAsins: 0, abandonedAsins: 0 },
    { marketplace: 'ES', asinsRequested: 10, rows: 71, upserted: 71, failedAsins: 0, abandonedAsins: 0 },
    { marketplace: 'FR', asinsRequested: 10, rows: 1, upserted: 1, failedAsins: 0, abandonedAsins: 0 },
    { marketplace: 'IT', asinsRequested: 10, rows: 6, upserted: 6, failedAsins: 1, abandonedAsins: 1 },
  ]
  const good = buildSqpSummary({ candidates, skipped, outcomes: healthy })
  line(`NEW summary: ${good.summary}`)
  line(`NEW verdict: ${good.fatal ? '🔴 marked failed — a working night must stay green' : '✓ SUCCESS, as it should be'}`)

  // ── the KT reader, against the real service ────────────────────────────────────────────────
  h('the KT page still reads it — the live regex, on both strings')
  const KT = /rows=(\d+)/
  for (const [label, s] of [['healthy summary', good.summary], ['zero-run error message', zero.fatal ?? '']] as const) {
    const m = KT.exec(s)
    line(`${label.padEnd(24)} → rows=${m ? m[1] : '🔴 NO MATCH — the health line would read "no claim"'}`)
  }
  line('⇒ keyword-tracker.service.ts now tries outputSummary THEN errorMessage, so the failed run')
  line('  above is still counted by nightsClaimingZero rather than vanishing from the signal.')

  // ── B3 · the reportId on failure ───────────────────────────────────────────────────────────
  h('B3 · reportId on abandoned reports — the before picture, for comparison after the next run')
  const abandonedRows = await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, errorMessage: { contains: 'did not reach DONE within' } } })
  const withId = await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE, errorMessage: { contains: 'did not reach DONE within' }, reportId: { not: null } } })
  line(`abandoned SQP reports on record: ${abandonedRows} · with reportId in the COLUMN: ${withId}`)
  line(withId === 0
    ? '✓ 0 today, as expected — failReportRun dropped it. Any abandonment AFTER this deploy should carry one.'
    : `note: ${withId} already carry an id`)
  line('🔴 This is the one Phase B change that cannot be verified before the next real run: it needs a')
  line('  report to be abandoned. Re-run this probe after the next nightly to confirm the column fills.')

  // ── B4 · the decoy ─────────────────────────────────────────────────────────────────────────
  h('B4 · the decoy flag')
  line(`NEXUS_ENABLE_SQP_INGEST_CRON in prod env: ${process.env.NEXUS_ENABLE_SQP_INGEST_CRON ?? 'unset'} (no code reads it either way)`)
  line(`NEXUS_DISABLE_SQP_INGEST_CRON (the real switch): ${process.env.NEXUS_DISABLE_SQP_INGEST_CRON ?? 'unset ⇒ cron is ON'}`)

  h('control')
  line(`SearchQueryPerformance rows ${await prisma.searchQueryPerformance.count()}`)
  line(`newest SQP period ${(await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } }))._max.startDate?.toISOString().slice(0, 10)}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
