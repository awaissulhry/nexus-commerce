/**
 * Apex E.1 — SQP ingest cron.
 *
 * Pulls Brand Analytics Search Query Performance (latest WEEK) for each active
 * Amazon marketplace into SearchQueryPerformance, so the competitive-share view
 * stays current. Idempotent upsert (re-fetching the same week is safe).
 *
 * 🔴 **Default ON.** `NEXUS_ENABLE_SQP_INGEST_CRON` does NOT gate this and never did — it has
 * zero readers anywhere in the repo, and this header used to claim it meant "default OFF". The
 * real switch is the inverted `NEXUS_DISABLE_SQP_INGEST_CRON=1` opt-out, read once in
 * `startSqpIngestCron` below. Registered in CRON_REGISTRY for manual triggering either way.
 *
 * ── What this job's summary is FOR (SQP.1, 2026-08-12) ────────────────────────────────────────
 * It used to report `markets=9 ok=4 failed=5 rows=0` — and did so for two consecutive nights
 * while writing nothing at all, on a row that read SUCCESS. Three separate things made a dead
 * feed indistinguishable from a healthy one, and all three are fixed here:
 *
 *   1. **`failed=5` was a constant.** The loop iterated every active AmazonAdsConnection, five of
 *      which (IE/NL/PL/SE/UK) have no Amazon listings at all, so `ingestSqp` threw instantly on
 *      each, every run, forever. A real market failure had nowhere to show. Markets are now chosen
 *      by whether we actually hold ASINs there, and the ones we skip are named as skipped.
 *   2. **`rows` summed only `upserted`.** `asinsRequested`, rows parsed and `failedAsins` were
 *      dropped, so "40 reports failed" and "40 reports came back empty" printed identically. The
 *      summary now carries all of it, per market, including how many reports we ABANDONED at the
 *      poll ceiling — which is the number that turned out to matter.
 *   3. **Zero rows still returned SUCCESS.** A run that writes nothing in every market is not a
 *      success, so it now throws, and the thrown message carries the whole per-market breakdown
 *      (`recordCronRun` writes `outputSummary` only on the success path, so the detail has to
 *      travel in the error or it is lost).
 *
 * See docs/2026-08-12-sqp-feed.md. Note what is NOT fixed here: the abandonment itself. Those
 * reports do finish at Amazon — 104 of 104 on record reached DONE — and collecting them needs an
 * asynchronous pass this job does not have. That is a design change awaiting a decision.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/** Per-ASIN reports are slow and serialised at Amazon, so the batch stays bounded. */
const SQP_ASINS_PER_MARKET = 10

/**
 * How deep into the pool rotation may look. NOT a widening — the nightly budget stays
 * `SQP_ASINS_PER_MARKET`; this only bounds the set rotation chooses from. Measured pool sizes are
 * DE 208 / ES 121 / FR 113 / IT 252, so 250 reaches all of them.
 */
const SQP_ROTATION_POOL = Math.max(SQP_ASINS_PER_MARKET, Number(process.env.NEXUS_SQP_ROTATION_POOL) || 250)

/** One market's outcome, as `ingestSqp` reports it — plus the case where the market itself threw. */
export interface SqpMarketOutcome {
  marketplace: string
  asinsRequested: number
  /** rows PARSED out of the reports (not the same as written). */
  rows: number
  upserted: number
  failedAsins: number
  abandonedAsins: number
  /** the whole market threw before any report — no ASINs, no marketplace id, auth */
  errored?: boolean
}

/**
 * SQP.1 — the summary and the verdict, as one pure function.
 *
 * Pure and exported because both halves are contracts rather than cosmetics, and neither could be
 * tested through `runSqpIngestOnce` without mocking Amazon:
 *
 *   · the `rows=` token is READ by `keyword-tracker.service.ts` (`/rows=(\d+)/`) to drive the KT
 *     page's feed-health line, so the token name is an interface;
 *   · `fatal` decides whether the run leaves a green row, which is the single thing that let a dead
 *     feed sit unnoticed for two weeks.
 *
 * Returns `fatal = null` when the run may report success.
 */
export function buildSqpSummary(args: {
  candidates: string[]
  skipped: string[]
  outcomes: SqpMarketOutcome[]
}): { summary: string; fatal: string | null } {
  const { candidates, skipped, outcomes } = args
  const sum = (f: (o: SqpMarketOutcome) => number) => outcomes.reduce((a, o) => a + f(o), 0)
  const requested = sum((o) => o.asinsRequested)
  const parsed = sum((o) => o.rows)
  const upserted = sum((o) => o.upserted)
  const failedReports = sum((o) => o.failedAsins)
  const abandoned = sum((o) => o.abandonedAsins)
  const marketErrors = outcomes.filter((o) => o.errored).length

  const detail = outcomes.map((o) =>
    o.errored
      ? `${o.marketplace} ERROR`
      : `${o.marketplace} ${o.asinsRequested - o.failedAsins}/${o.asinsRequested} done${o.abandonedAsins ? ` (${o.abandonedAsins} abandoned)` : ''} ${o.upserted} rows`,
  )

  // 🔴 `rows=` keeps its old name and its old meaning (rows WRITTEN), because
  // keyword-tracker.service.ts parses `/rows=(\d+)/` out of this string. Renaming it to `upserted=`
  // would have left that regex matching nothing and silently zeroed a defect signal — a summary is
  // an interface the moment something reads it. `parsed=` is the new, separate number.
  const summary =
    `markets=${outcomes.length}${skipped.length ? ` skipped=${skipped.length}[${skipped.join(',')}]` : ''}` +
    ` · reports=${requested} failed=${failedReports}${abandoned ? ` abandoned=${abandoned}` : ''}` +
    ` · parsed=${parsed} rows=${upserted}` +
    (marketErrors ? ` · marketErrors=${marketErrors}` : '') +
    (detail.length ? ` · ${detail.join(' · ')}` : '')

  // A run that wrote nothing anywhere is a failure and must not leave a green row behind. The
  // summary travels INSIDE the message because recordCronRun persists outputSummary only on success.
  if (outcomes.length === 0) {
    return { summary, fatal: `sqp-ingest: no eligible marketplace — none of ${candidates.length} active ads markets (${candidates.join(',')}) holds an Amazon ASIN. ${summary}` }
  }
  if (upserted === 0) {
    const because = requested > 0 && abandoned === requested
      ? `every one of the ${requested} reports was ABANDONED at the ~300s poll ceiling; they do finish at Amazon afterwards, so this is a collection failure and not an Amazon failure (docs/2026-08-12-sqp-feed.md)`
      : `${failedReports} of ${requested} reports failed (${abandoned} abandoned at the poll ceiling), ${parsed} rows parsed`
    return { summary, fatal: `sqp-ingest wrote 0 rows across all ${outcomes.length} markets: ${because}. ${summary}` }
  }
  return { summary, fatal: null }
}

/**
 * ACR.1.2d — the tick's work AND its summary, without the CronRun wrapper, so the
 * manual-trigger registry can call it and produce ONE honest row. See the same note on
 * ads-sync-drain.job.ts.
 */
export async function runSqpIngestOnce(): Promise<string> {
  const { ingestSqp, ourAsinsForMarketplace } = await import('../services/advertising/sqp.service.js')
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
  const candidates = [...new Set(conns.map((c) => c.marketplace))].sort()

  // Choose markets by whether we hold ASINs there, not by whether an ads connection is active.
  // Resolve once and pass the list through, so the market filter and the reports it requests can
  // never disagree — and skipping is REPORTED, because a silently-dropped market is how the old
  // constant `failed=5` hid everything behind it.
  const eligible: Array<{ mkt: string; asins: string[] }> = []
  const skipped: string[] = []
  for (const mkt of candidates) {
    const asins = await ourAsinsForMarketplace(mkt, SQP_ASINS_PER_MARKET)
    if (asins.length === 0) skipped.push(mkt)
    else eligible.push({ mkt, asins })
  }
  if (skipped.length) {
    logger.info('[sqp-ingest] markets skipped — no Amazon ASINs held there', { skipped, candidates: candidates.length })
  }

  // ── SQP.2 — ASYNCHRONOUS by default ──────────────────────────────────────────────────────────
  // This tick REQUESTS and returns; `sqp-collect` picks the reports up on a later tick. The
  // synchronous path is kept behind an opt-in because it is the only way to reproduce the old
  // behaviour if the async path ever needs to be compared against it — but it is not the default,
  // because it provably cannot work: Amazon generates this account's reports serially, so waiting
  // 300s per report abandoned 40 of 40 on two consecutive nights.
  if (!envEnabled('NEXUS_SQP_SYNCHRONOUS_INGEST')) {
    const { requestSqpReports } = await import('../services/advertising/sqp-async.service.js')
    // 🔴 Imported, never re-derived. This line used to carry its OWN `|| 2`, so the lookback had two
    // independent defaults and changing the one in sqp.service.ts would have had no effect on the
    // job that actually requests the reports. Same constant, one definition.
    const { periodWindow, SQP_LOOKBACK } = await import('../services/advertising/sqp.service.js')
    const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
    const mkRows = await prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, marketplaceId: true } })
    const idOf = new Map(mkRows.filter((m) => m.marketplaceId).map((m) => [m.code, m.marketplaceId!]))

    // ── SQP.3 Phase C — rotation, OFF by default ────────────────────────────────────────────────
    // Measured 2026-08-13: the pool is 694 distinct ASINs across the four live markets and this pass
    // asks for the same 40 every night — 5.8% coverage, with ~654 ASINs never sampled once. Phase B's
    // settle rule frees slots, and rotation spends them on ASINs that have never been asked for, at
    // the SAME nightly budget.
    //
    // 🔴 Default OFF because it changes which ASINs the account samples, and the brief gates widening
    // on approval. Turning it on is one env var; nothing else has to change.
    const rotationOn = envEnabled('NEXUS_SQP_ROTATION')
    const { selectNightlyAsins, selectionSummary } = await import('../services/advertising/sqp-selection.js')
    const { settledAsins } = await import('../services/advertising/sqp-async.service.js')

    const parts: string[] = []
    let created = 0, failed = 0, outstanding = 0, settled = 0, rotated = 0
    for (const { mkt, asins: coreAsins } of eligible) {
      const marketplaceId = idOf.get(mkt)
      if (!marketplaceId) { parts.push(`${mkt} NO-MARKETPLACE-ID`); failed += coreAsins.length; continue }

      let asins = coreAsins
      if (rotationOn) {
        const pool = await ourAsinsForMarketplace(mkt, SQP_ROTATION_POOL)
        const hist = await prisma.sqpReportRequest.groupBy({
          by: ['asin'], where: { marketplace: mkt, reportPeriod: 'WEEK', asin: { in: pool } },
          _max: { requestedAt: true },
        })
        const lastAsked = new Map(hist.map((h) => [h.asin, h._max.requestedAt ?? null]))
        const forWeek = await prisma.sqpReportRequest.findMany({
          where: { marketplace: mkt, reportPeriod: 'WEEK', startDate: win.start, asin: { in: pool } },
          select: { asin: true, status: true, collectedAt: true, rowsChanged: true },
        })
        const sel = selectNightlyAsins({
          candidates: pool.map((asin, rank) => ({ asin, rank, lastRequestedAt: lastAsked.get(asin) ?? null })),
          budget: coreAsins.length,
          coreCount: coreAsins.length,
          settled: settledAsins(forWeek.filter((r) => r.status === 'INGESTED')),
          outstanding: new Set(forWeek.filter((r) => r.status === 'PENDING' || r.status === 'DONE').map((r) => r.asin)),
        })
        asins = sel.chosen
        rotated += sel.slotsFreedToRotation
        parts.push(selectionSummary(mkt, sel, pool.length))
      }

      const r = await requestSqpReports({ marketplaceCode: mkt, marketplaceId, asins, period: 'WEEK', start: win.start, end: win.end })
      created += r.created; failed += r.failed; outstanding += r.alreadyOutstanding; settled += r.alreadySettled
      parts.push(`${mkt} ${r.created}/${r.asinsRequested}${r.alreadyOutstanding ? ` (${r.alreadyOutstanding} already outstanding)` : ''}${r.alreadySettled ? ` (${r.alreadySettled} settled)` : ''}${r.failed ? ` ${r.failed} failed` : ''}`)
    }
    const summary =
      `mode=async · markets=${eligible.length}${skipped.length ? ` skipped=${skipped.length}[${skipped.join(',')}]` : ''}` +
      ` · requested=${created} failed=${failed}${outstanding ? ` alreadyOutstanding=${outstanding}` : ''}${settled ? ` settled=${settled}` : ''}` +
      ` · rotation=${rotationOn ? `on(${rotated} freed slots reused)` : 'off'}` +
      ` · week=${win.start.toISOString().slice(0, 10)} · rows=0 (collected by sqp-collect)` +
      (parts.length ? ` · ${parts.join(' · ')}` : '')
    // 🔴 `rows=0` here is CORRECT and must not be treated as the old zero-row failure: this pass
    // writes no SearchQueryPerformance rows by design. So this branch does NOT throw on rows=0 —
    // the honest failure for a request pass is "created nothing", which is what is checked.
    // 🔴 `settled` belongs in this condition, not outside it. Once a week has been confirmed frozen
    // for every ASIN, the correct behaviour is to request nothing — and without this term that
    // success would throw every single night, exactly as if the feed had broken.
    if (created === 0 && outstanding === 0 && settled === 0) {
      throw new Error(`sqp-ingest (async): created 0 report requests across ${eligible.length} markets, nothing was already outstanding, and no week was settled. ${summary}`)
    }
    logger.info('[sqp-ingest] request pass complete', { created, failed, outstanding, settled, week: win.start.toISOString().slice(0, 10) })
    return summary
  }

  const outcomes: SqpMarketOutcome[] = []
  for (const { mkt, asins } of eligible) {
    try {
      const r = await ingestSqp({ marketplaceCode: mkt, period: 'WEEK', asins })
      outcomes.push({
        marketplace: mkt, asinsRequested: r.asinsRequested, rows: r.rows,
        upserted: r.upserted, failedAsins: r.failedAsins, abandonedAsins: r.abandonedAsins,
      })
    } catch (err) {
      outcomes.push({ marketplace: mkt, asinsRequested: 0, rows: 0, upserted: 0, failedAsins: 0, abandonedAsins: 0, errored: true })
      logger.warn('[sqp-ingest] marketplace failed', { marketplace: mkt, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const { summary, fatal } = buildSqpSummary({ candidates, skipped, outcomes })
  if (fatal) throw new Error(fatal)
  return summary
}

export async function runSqpIngestCron(): Promise<void> {
  try {
    await recordCronRun('sqp-ingest', runSqpIngestOnce)
  } catch (err) {
    logger.error('sqp-ingest cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startSqpIngestCron(): void {
  if (scheduledTask) {
    logger.warn('sqp-ingest cron already started')
    return
  }
  // RM2 — Brand Analytics SQP access is confirmed (probe = available), so this is default-ON now;
  // it powers the Rest-of-Search feedback signal + the SQP insights. Opt out with NEXUS_DISABLE_SQP_INGEST_CRON=1.
  if (envEnabled('NEXUS_DISABLE_SQP_INGEST_CRON')) {
    logger.info('sqp-ingest cron disabled (NEXUS_DISABLE_SQP_INGEST_CRON=1)')
    return
  }
  // Daily 03:45 UTC (after sales-report at 02:00); fetches the current WEEK each
  // run — idempotent upsert keeps it fresh as Amazon finalises the week.
  scheduledTask = cron.schedule('45 3 * * *', () => void runSqpIngestCron())
  logger.info('sqp-ingest cron scheduled (45 3 * * *)')
}
