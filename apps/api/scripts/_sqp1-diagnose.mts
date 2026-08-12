/**
 * _sqp1-diagnose.mts — SQP.1 Phase A. Why has the Brand Analytics feed written nothing?
 *
 * 🔴 READ-ONLY. No Amazon call, no write. Every Amazon fact here comes from a LEDGER that a
 * previous real run left behind (AmazonReportRun, OutboundApiCallLog, CronRun) — which is the
 * point: the ledgers already recorded what the last two nightly runs did, so Phase A does not
 * need to spend a single report request to find out.
 *
 * The two real functions are IMPORTED, never re-implemented — `periodWindow` and
 * `ourAsinsForMarketplace` are the things under suspicion, so the probe has to run the same
 * code the cron runs, under the same prod env.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp1-diagnose.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import {
  SQP_REPORT_TYPE,
  periodWindow,
  ourAsinsForMarketplace,
} from '../src/services/advertising/sqp.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const ts = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const mins = (ms: number) => `${(ms / 60_000).toFixed(1)}m`
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const hist = (xs: number[]) => {
  const m = new Map<number, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' · ')
}

async function main() {
  const NOW = new Date()
  line(`probe clock (UTC): ${ts(NOW)}`)
  line(`report type: ${SQP_REPORT_TYPE}`)

  // ── §7 · the stop conditions, before anything else ──────────────────────────────────────────
  h('§7 · STOP CONDITIONS')

  const periods = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'startDate'],
    _count: { _all: true },
    orderBy: { startDate: 'desc' },
  })
  const newest = periods.length ? new Date(Math.max(...periods.map((p) => +p.startDate))) : null
  const unchanged = d10(newest) === '2026-07-26'
  line(`1 · newest SQP period anywhere = ${d10(newest)} — ${unchanged ? '✓ unchanged; the feed has NOT restarted on its own' : '🔴 A NEWER PERIOD EXISTS — the feed produced without me; STOP and re-read'}`)

  const mode = process.env.NEXUS_COVERAGE_ENGINE_MODE
  line(`2 · NEXUS_COVERAGE_ENGINE_MODE = ${mode === undefined ? 'UNSET ✓ (engine defaults to observe; it writes nothing)' : `🔴 "${mode}" — SET. STOP`}`)

  const enabledSets = await prisma.keywordCoverageSet.count({ where: { enabled: true } })
  const allSets = await prisma.keywordCoverageSet.count()
  line(`3 · KeywordCoverageSet enabled = ${enabledSets} of ${allSets} — ${enabledSets === 0 ? '✓ none armed' : '🔴 A SET IS ARMED. STOP'}`)

  // ── A2 · the sweeper. Answered in code; confirmed here. ─────────────────────────────────────
  h('A2 · the green row that carries an error — the sweeper, confirmed')
  line('Mechanism, from reading the code (cron-orphan-sweeper.job.ts + utils/cron-observability.ts):')
  line('  1. recordCronRun INSERTs the row as RUNNING.')
  line('  2. cron-orphan-sweeper runs every 30min; anything RUNNING older than 2h is declared orphaned')
  line("     and UPDATEd to status=FAILED + errorMessage='stale (auto-swept after Nh)'. It does NOT")
  line('     kill the process — it only relabels the row. The run keeps going.')
  line('  3. The run eventually finishes. The success branch UPDATEs status=SUCCESS, finishedAt,')
  line('     outputSummary — and NEVER clears errorMessage. The sweeper\'s text stays attached.')
  line('  ⇒ SUCCESS + "stale (auto-swept after 2.3h)" is not a contradiction: it is a run that took')
  line('    LONGER THAN 2 HOURS and then completed. The error message is a LATENCY MEASUREMENT.')
  line()

  const swept = await prisma.cronRun.findMany({
    where: { status: 'SUCCESS', errorMessage: { not: null } },
    select: { jobName: true, startedAt: true, finishedAt: true, errorMessage: true },
    orderBy: { startedAt: 'desc' },
    take: 25,
  })
  line(`SUCCESS rows still carrying an errorMessage: ${swept.length} (newest 25)`)
  line(`${padr('job', 26)} ${padr('started', 20)} ${padr('finished', 20)} true-dur  errorMessage`)
  for (const r of swept) {
    const dur = r.finishedAt ? mins(+r.finishedAt - +r.startedAt) : '—'
    line(`${padr(r.jobName.slice(0, 25), 26)} ${padr(ts(r.startedAt), 20)} ${padr(ts(r.finishedAt), 20)} ${pad(dur, 8)}  ${String(r.errorMessage).slice(0, 60)}`)
  }
  const sweptJobs = new Set(swept.map((r) => r.jobName))
  line()
  line(`⇒ ${sweptJobs.size} distinct job(s) affected: ${[...sweptJobs].join(', ') || '—'}`)
  line('  Every one of these reads GREEN on the cron dashboard while having blown the 2h budget.')

  // ── A1 · the cron's own history ─────────────────────────────────────────────────────────────
  h("A1 · sqp-ingest's own run history — what did the last runs actually claim?")
  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest' },
    select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true, triggeredBy: true },
    orderBy: { startedAt: 'desc' },
    take: 20,
  })
  line(`${padr('started (UTC)', 20)} ${padr('status', 8)} ${pad('dur', 7)} ${padr('by', 7)} summary / error`)
  for (const r of runs) {
    const dur = r.finishedAt ? mins(+r.finishedAt - +r.startedAt) : 'RUNNING'
    line(`${padr(ts(r.startedAt), 20)} ${padr(r.status, 8)} ${pad(dur, 7)} ${padr(r.triggeredBy, 7)} ${r.outputSummary ?? ''}${r.errorMessage ? `  ⚠ ${r.errorMessage.slice(0, 70)}` : ''}`)
  }
  const durs = runs.filter((r) => r.finishedAt).map((r) => +r.finishedAt! - +r.startedAt)
  if (durs.length) {
    line()
    line(`duration: min ${mins(Math.min(...durs))} · median ${mins(pctl(durs, 50)!)} · max ${mins(Math.max(...durs))} — the 2h sweeper threshold is ${Math.max(...durs) > 7.2e6 ? 'BLOWN' : 'not blown'}`)
  }
  line()
  line('🔴 The summary shape is `markets=N ok=N failed=N rows=N`, and `rows` sums only r.upserted.')
  line('   asinsRequested, rows-parsed and failedAsins are all DISCARDED by runSqpIngestOnce, so')
  line('   "rows=0" cannot distinguish 50 reports that FAILED from 50 that came back EMPTY.')
  line('   The next two sections recover that distinction from the ledgers.')

  // ── A3 · the report ledger: failed, or empty? ───────────────────────────────────────────────
  h('A3 · AmazonReportRun — did the reports FAIL or return NOTHING?')
  const mkts = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON' },
    select: { code: true, marketplaceId: true },
  })
  const codeOf = new Map(mkts.filter((m) => m.marketplaceId).map((m) => [m.marketplaceId!, m.code]))

  const reportRuns = await prisma.amazonReportRun.findMany({
    where: { reportType: SQP_REPORT_TYPE },
    select: {
      marketplace: true, status: true, rowCount: true, errorMessage: true,
      dataStartTime: true, dataEndTime: true, requestedAt: true, completedAt: true, triggeredBy: true,
    },
    orderBy: { requestedAt: 'desc' },
    take: 2000,
  })
  line(`SQP report attempts on record: ${reportRuns.length}`)
  if (reportRuns.length === 0) {
    line('🔴 ZERO report attempts ever registered for this reportType. Either the registry write is')
    line('   failing silently (startReportRun swallows), or ingestSqp never reached fetchSpApiJsonReport.')
  } else {
    const byStatus = new Map<string, number>()
    for (const r of reportRuns) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    line(`status: ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(' · ')}`)

    const done = reportRuns.filter((r) => r.status === 'DONE')
    const empty = done.filter((r) => (r.rowCount ?? 0) === 0)
    line(`DONE reports: ${done.length} · of those EMPTY (rowCount 0/null): ${empty.length} · populated: ${done.length - empty.length}`)
    line(`rowCount histogram (DONE only): ${hist(done.map((r) => r.rowCount ?? 0))}`)
    line()
    line('⇒ THE ANSWER TO PHASE A ITEM 1 IS WHICHEVER SIDE THIS SPLIT FALLS ON:')
    line(`   reports that never came back        : ${reportRuns.length - done.length}`)
    line(`   reports that came back with 0 rows  : ${empty.length}`)

    const errs = new Map<string, number>()
    for (const r of reportRuns) {
      if (!r.errorMessage) continue
      const key = r.errorMessage.slice(0, 110)
      errs.set(key, (errs.get(key) ?? 0) + 1)
    }
    if (errs.size) {
      line()
      line('distinct error messages (top 12):')
      for (const [msg, n] of [...errs].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`  ${pad(n, 4)} × ${msg}`)
    } else {
      line()
      line('no errorMessage on any attempt — nothing THREW; the reports returned.')
    }

    // per-market, per-window
    line()
    line(`${padr('market', 8)} ${padr('window', 24)} ${pad('att', 4)} ${pad('DONE', 5)} ${pad('rows', 6)} ${pad('empty', 6)}`)
    const key = (r: typeof reportRuns[number]) => `${codeOf.get(r.marketplace ?? '') ?? r.marketplace ?? '?'}|${d10(r.dataStartTime)}→${d10(r.dataEndTime)}`
    const groups = new Map<string, typeof reportRuns>()
    for (const r of reportRuns) { const k = key(r); const g = groups.get(k) ?? []; g.push(r); groups.set(k, g as any) }
    for (const [k, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [mk, win] = k.split('|')
      const dn = g.filter((r) => r.status === 'DONE')
      line(`${padr(mk, 8)} ${padr(win, 24)} ${pad(g.length, 4)} ${pad(dn.length, 5)} ${pad(dn.reduce((a, r) => a + (r.rowCount ?? 0), 0), 6)} ${pad(dn.filter((r) => (r.rowCount ?? 0) === 0).length, 6)}`)
    }

    // ── A4 latency, measured ──────────────────────────────────────────────────────────────────
    const lat = reportRuns.filter((r) => r.completedAt).map((r) => +r.completedAt! - +r.requestedAt)
    if (lat.length) {
      line()
      line(`per-report latency (n=${lat.length}): p50 ${(pctl(lat, 50)! / 1000).toFixed(0)}s · p90 ${(pctl(lat, 90)! / 1000).toFixed(0)}s · max ${(Math.max(...lat) / 1000).toFixed(0)}s`)
      const p50 = pctl(lat, 50)!
      line(`⇒ the poll loop sleeps 10s BEFORE its first status check and allows 30 attempts (~5min ceiling),`)
      line(`  so no report can return faster than 10s. At p50=${(p50 / 1000).toFixed(0)}s and 10 ASINs × markets, SEQUENTIALLY:`)
      for (const n of [4, 5, 10]) line(`    ${n} markets × 10 ASINs = ${n * 10} reports ⇒ ${mins(p50 * n * 10)} (p50) / ${mins(Math.max(...lat) * n * 10)} (worst)`)
    }
  }

  // ── A3b · the outbound call ledger, as a cross-check ────────────────────────────────────────
  h('A3b · OutboundApiCallLog — the same runs seen from the HTTP side')
  const since = new Date(+NOW - 30 * 86_400_000)
  const calls = await prisma.outboundApiCallLog.findMany({
    where: { channel: 'AMAZON', operation: { in: ['createReport', 'getReport', 'getReportDocument'] }, createdAt: { gte: since } },
    select: { operation: true, success: true, statusCode: true, latencyMs: true, errorType: true, errorMessage: true, requestId: true, createdAt: true, triggeredBy: true },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  })
  line(`report-flow calls in the last 30d: ${calls.length}`)
  const byOp = new Map<string, { n: number; ok: number; lat: number[] }>()
  for (const c of calls) {
    const e = byOp.get(c.operation) ?? { n: 0, ok: 0, lat: [] }
    e.n++; if (c.success) e.ok++; e.lat.push(c.latencyMs); byOp.set(c.operation, e)
  }
  line(`${padr('operation', 20)} ${pad('n', 6)} ${pad('ok', 6)} ${pad('p50ms', 7)} ${pad('max', 7)}`)
  for (const [op, e] of byOp) line(`${padr(op, 20)} ${pad(e.n, 6)} ${pad(e.ok, 6)} ${pad(pctl(e.lat, 50) ?? 0, 7)} ${pad(Math.max(...e.lat), 7)}`)
  const failedCalls = calls.filter((c) => !c.success)
  if (failedCalls.length) {
    const em = new Map<string, number>()
    for (const c of failedCalls) { const k = `${c.statusCode ?? '—'} ${c.errorType ?? ''} ${String(c.errorMessage ?? '').slice(0, 90)}`; em.set(k, (em.get(k) ?? 0) + 1) }
    line()
    line('failed report-flow calls (top 10):')
    for (const [k, n] of [...em].sort((a, b) => b[1] - a[1]).slice(0, 10)) line(`  ${pad(n, 4)} × ${k}`)
  }
  // group by cron tick so we can see how many reports one nightly run actually attempted
  const ticks = new Map<string, { create: number; poll: number; doc: number; first: Date; last: Date }>()
  for (const c of calls) {
    if (!c.requestId) continue
    const e = ticks.get(c.requestId) ?? { create: 0, poll: 0, doc: 0, first: c.createdAt, last: c.createdAt }
    if (c.operation === 'createReport') e.create++
    else if (c.operation === 'getReport') e.poll++
    else e.doc++
    if (+c.createdAt < +e.first) e.first = c.createdAt
    if (+c.createdAt > +e.last) e.last = c.createdAt
    ticks.set(c.requestId, e)
  }
  line()
  line(`grouped by cron tick (requestId): ${ticks.size} ticks`)
  line(`${padr('first call (UTC)', 20)} ${pad('creates', 8)} ${pad('polls', 6)} ${pad('docs', 5)} ${pad('span', 8)} polls/report`)
  for (const [, e] of [...ticks].sort((a, b) => +b[1].first - +a[1].first).slice(0, 12)) {
    line(`${padr(ts(e.first), 20)} ${pad(e.create, 8)} ${pad(e.poll, 6)} ${pad(e.doc, 5)} ${pad(mins(+e.last - +e.first), 8)} ${e.create ? (e.poll / e.create).toFixed(1) : '—'}`)
  }
  line()
  line('⇒ createReport count = reports ATTEMPTED. getReportDocument count = reports that reached DONE.')
  line('  polls/report near 30 means the report timed out in the poll loop rather than failing outright.')

  // ── A4 · which week does the cron ask for? ──────────────────────────────────────────────────
  h('A4 · NEXUS_SQP_LOOKBACK — which week does the cron actually request?')
  line(`NEXUS_SQP_LOOKBACK env = ${process.env.NEXUS_SQP_LOOKBACK ?? 'UNSET (defaults to 2)'}`)
  const lookback = Math.max(1, Number(process.env.NEXUS_SQP_LOOKBACK) || 2)
  for (const lb of [...new Set([1, 2, 3, lookback])].sort((a, b) => a - b)) {
    const w = periodWindow('WEEK', NOW, lb)
    const ageDays = Math.floor((+NOW - +w.end) / 86_400_000)
    line(`  lookback=${lb}${lb === lookback ? ' ← LIVE' : '       '} → ${d10(w.start)} … ${d10(w.end)} (window closed ${ageDays}d ago)`)
  }
  const live = periodWindow('WEEK', NOW, lookback)
  const storedForWindow = periods.filter((p) => +p.startDate === +new Date(d10(live.start)))
  line()
  line(`rows already stored for the LIVE window (${d10(live.start)}): ${storedForWindow.map((p) => `${p.marketplace}=${p._count._all}`).join(' · ') || 'NONE'}`)
  line('⇒ Every period stored, newest first, so "which week is thin" is visible rather than argued:')
  const byPeriod = new Map<string, Map<string, number>>()
  for (const p of periods) {
    const k = d10(p.startDate)
    const m = byPeriod.get(k) ?? new Map<string, number>()
    m.set(p.marketplace, p._count._all); byPeriod.set(k, m)
  }
  const allMkts = [...new Set(periods.map((p) => p.marketplace))].sort()
  line(`${padr('week', 12)} ${allMkts.map((m) => pad(m, 6)).join(' ')} ${pad('total', 7)}`)
  for (const [wk, m] of [...byPeriod].sort((a, b) => b[0].localeCompare(a[0]))) {
    const tot = [...m.values()].reduce((a, b) => a + b, 0)
    line(`${padr(wk, 12)} ${allMkts.map((k) => pad(m.get(k) ?? 0, 6)).join(' ')} ${pad(tot, 7)}`)
  }

  // ── A5 · which markets does the job iterate? ────────────────────────────────────────────────
  h('A5 · the markets runSqpIngestOnce iterates — and whether they are real')
  const conns = await prisma.amazonAdsConnection.findMany({
    select: { marketplace: true, isActive: true, mode: true, profileId: true, accountLabel: true, lastVerifiedAt: true, lastError: true },
    orderBy: { marketplace: 'asc' },
  })
  const activeMkts = [...new Set(conns.filter((c) => c.isActive).map((c) => c.marketplace))]
  line(`the job's loop is: AmazonAdsConnection where isActive=true → distinct marketplace`)
  line(`⇒ it iterates ${activeMkts.length} markets: ${activeMkts.join(', ')}`)
  line()
  line(`${padr('market', 8)} ${padr('active', 7)} ${padr('mode', 12)} ${padr('label', 22)} ${padr('verified', 20)} SP-API id?`)
  for (const c of conns) {
    const hasId = mkts.find((m) => m.code === c.marketplace)?.marketplaceId
    line(`${padr(c.marketplace, 8)} ${padr(String(c.isActive), 7)} ${padr(c.mode, 12)} ${padr((c.accountLabel ?? '—').slice(0, 21), 22)} ${padr(ts(c.lastVerifiedAt), 20)} ${hasId ?? '🔴 none — ingestSqp THROWS'}`)
  }
  const sandbox = conns.filter((c) => c.isActive && c.mode !== 'production').map((c) => c.marketplace)
  line()
  line(`🔴 active but NOT mode=production: ${sandbox.length} — ${sandbox.join(', ') || 'none'}`)
  line('   Each one costs a full per-ASIN report sweep. Note the ads connection\'s mode gates ADS')
  line('   writes, not SP-API reads — so this is about wasted runtime, not a wrong answer.')

  // ── A6 · the ASINs it asks about — the crux ─────────────────────────────────────────────────
  h('A6 · WHICH ASINs does the cron request, and have those ASINs ever produced a row?')
  line('ingestSqp calls ourAsinsForMarketplace(market, limit ?? 10) — so 10 reports per market, and')
  line('WHICH 10 decides the entire yield. ourAsinsForMarketplace takes 1000 ChannelListings ordered')
  line('by listingStatus in the DB, THEN re-sorts ACTIVE-first in JS: if a market has >1000 listings')
  line('the ACTIVE ones may never be in the page that got fetched.')
  line()
  const asinsWithRows = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'asin'],
    _count: { _all: true },
  })
  const rowsByMktAsin = new Map<string, number>()
  for (const r of asinsWithRows) rowsByMktAsin.set(`${r.marketplace}|${r.asin ?? ''}`, r._count._all)

  for (const mkt of activeMkts.length ? activeMkts : ['IT', 'DE', 'ES', 'FR']) {
    const listings = await prisma.channelListing.count({ where: { channel: 'AMAZON', OR: [{ marketplace: mkt }, { region: mkt }] } })
    const asins = await ourAsinsForMarketplace(mkt, 10)
    const producing = [...rowsByMktAsin.entries()].filter(([k]) => k.startsWith(`${mkt}|`) && k.slice(mkt.length + 1))
    const hit = asins.filter((a) => (rowsByMktAsin.get(`${mkt}|${a}`) ?? 0) > 0)
    line(`${mkt}: ${listings} matching ChannelListings${listings > 1000 ? ' 🔴 >1000 — the take:1000 page may exclude ACTIVE rows' : ''}`)
    line(`    the 10 ASINs the cron WILL request: ${asins.join(' ') || '🔴 NONE — ingestSqp throws'}`)
    line(`    of those 10, ASINs that have EVER produced an SQP row: ${hit.length} (${hit.join(' ') || 'none'})`)
    line(`    ASINs in this market that HAVE produced rows: ${producing.length}${producing.length ? ` (top: ${producing.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.slice(mkt.length + 1)}:${v}`).join(' ')})` : ''}`)
    const overlap = producing.filter(([k]) => asins.includes(k.slice(mkt.length + 1))).length
    line(`    ⇒ overlap between "what we ask for" and "what has ever answered": ${overlap}/${Math.min(10, asins.length)}${overlap === 0 && producing.length > 0 ? '  🔴 DISJOINT — the cron asks about ASINs that have never returned a row' : ''}`)
  }

  // ── control ────────────────────────────────────────────────────────────────────────────────
  h('control — prove the zeros above are measurements, not empty queries')
  line(`SearchQueryPerformance rows ${await prisma.searchQueryPerformance.count()}`)
  line(`CronRun rows ${await prisma.cronRun.count()} · sqp-ingest rows ${await prisma.cronRun.count({ where: { jobName: 'sqp-ingest' } })}`)
  line(`AmazonReportRun rows ${await prisma.amazonReportRun.count()} · of type SQP ${await prisma.amazonReportRun.count({ where: { reportType: SQP_REPORT_TYPE } })}`)
  line(`distinct reportTypes in the registry: ${(await prisma.amazonReportRun.groupBy({ by: ['reportType'], _count: { _all: true } })).map((r) => `${r.reportType.replace('GET_', '').slice(0, 34)}=${r._count._all}`).join(' · ')}`)
  line(`OutboundApiCallLog AMAZON rows (30d) ${await prisma.outboundApiCallLog.count({ where: { channel: 'AMAZON', createdAt: { gte: since } } })}`)
  line(`ChannelListing AMAZON rows ${await prisma.channelListing.count({ where: { channel: 'AMAZON' } })}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
