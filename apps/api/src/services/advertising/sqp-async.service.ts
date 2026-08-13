/**
 * SQP.2 — Brand Analytics ingest, split into a REQUEST pass and a COLLECT pass.
 *
 * ── Why the synchronous version could not work ────────────────────────────────────────────────
 *
 * Amazon generates this account's reports **serially**. Measured across 104 samples: each report's
 * `processingStartTime` equals the previous report's `processingEndTime`, to the second. So a burst
 * of N requests queues; it does not fan out. On 2026-08-11 a 40-report batch took **14.6 hours** to
 * drain — one request waited 13.7h to start and then generated in 9 seconds.
 *
 * `fetchSpApiReport` waits at most `30 × 10s = 300s` per report. So the nightly job abandoned all 40,
 * wrote nothing, ran for 208 minutes (208.3 of which was the poll loop), and tripped the 2h stale
 * sweeper — while every one of those reports finished at Amazon with nobody listening.
 *
 * **No poll ceiling fixes that**, because the wait is queue depth and the queue is our own burst.
 * The only shape that works is to stop waiting: create the reports, write down the ids, and collect
 * on a later tick. See `docs/2026-08-12-sqp-feed.md` §3 and §10.
 *
 * ── The four outcomes, which must never collapse into one ─────────────────────────────────────
 *
 * A collect attempt ends in exactly one of: `INGESTED` (rows upserted — the only success), `DONE`
 * (Amazon finished, ingest failed on our side), `FATAL`/`CANCELLED` (Amazon ended it), `EXPIRED`
 * (past the ~72h document retention — we ran out of time, which is NOT the same as failing), or
 * still `PENDING` (genuinely not finished yet). Collapsing these is how the previous design's
 * `failedAsins` counter hid the fact that nothing had actually failed.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────────────────────────
 *
 * It does not widen coverage. The ASIN set and the window come from the caller, unchanged, so this
 * is the same request the old job made — made in a way that can be collected. Widening is gated on
 * the reader defect in `docs/2026-08-12-sqp-feed.md` §11.3.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { getSpApiClient } from '../sp-api-reports.service.js'
import { parseSqp, SQP_REPORT_TYPE, share, type SqpPeriod } from './sqp.service.js'

/**
 * Amazon's DOCUMENTED report-document retention, used only to report headroom — never to decide that
 * something has expired.
 *
 * 🔴 Measured 2026-08-12 (SQP.2): a report requested **87.7 hours** earlier downloaded fine, and so
 * did one requested 169 hours earlier. So the clock does not run from the REQUEST — it runs from when
 * Amazon created the document, which for a queued report can be many hours later. An age-based
 * `EXPIRED` verdict would therefore retire requests whose documents are still sitting there, and
 * quietly lose exactly the data this whole design exists to stop losing.
 *
 * So expiry is only ever concluded from an actual 404. Age is a warning.
 */
export const SQP_DOCUMENT_RETENTION_HOURS = 72

/** Stop polling a request that has clearly stalled, so one stuck id cannot occupy the queue forever. */
export const SQP_MAX_POLL_ATTEMPTS = 200

export interface SqpRequestResult {
  marketplace: string
  period: SqpPeriod
  startDate: string
  asinsRequested: number
  created: number
  failed: number
  alreadyOutstanding: number
  /** skipped because a re-fetch already confirmed this (asin, week) has stopped moving. */
  alreadySettled: number
}

/**
 * How far apart the two agreeing fetches must be before a week is called settled.
 *
 * 🔴 This constant is the difference between a measurement and an artefact. The rule is "fetched
 * twice, nothing moved", and without a minimum span that is satisfiable in three minutes — which is
 * exactly how the first prod cycle satisfied it, freezing a five-day-old week on evidence spanning
 * one coffee. SQP.3 §4.1 measured weeks frozen at 25 and at 46 days; it did NOT measure whether a
 * five-day-old week is still filling in on day ten, and that gap is real.
 *
 * 20 hours, so the confirmation has to span a day boundary. In production this costs nothing at all —
 * the request pass runs nightly, so consecutive fetches are ~24h apart already — but it makes the
 * rule mean "this week did not move overnight" rather than "we asked twice quickly".
 */
export const SQP_SETTLE_MIN_SPAN_HOURS = 20

/**
 * Which ASINs have stopped moving: fetched at least twice, the later fetch changed nothing, and the
 * two are far enough apart to be evidence rather than an echo.
 */
export function settledAsins(
  ingests: Array<{ asin: string; collectedAt: Date | null; rowsChanged: number | null }>,
  minSpanHours = SQP_SETTLE_MIN_SPAN_HOURS,
): Set<string> {
  const byAsin = new Map<string, Array<{ at: number; changed: number | null }>>()
  for (const i of ingests) {
    if (!i.collectedAt) continue
    const list = byAsin.get(i.asin) ?? []
    list.push({ at: i.collectedAt.getTime(), changed: i.rowsChanged })
    byAsin.set(i.asin, list)
  }
  const settled = new Set<string>()
  for (const [asin, list] of byAsin) {
    list.sort((a, b) => a.at - b.at)
    const first = list[0]!.at
    // A null rowsChanged is "we don't know" — it predates the measurement and must never be read as
    // "nothing changed", or the 41 requests that existed before this column would settle everything.
    const confirmed = list.find((l) => l.changed === 0 && (l.at - first) >= minSpanHours * 3600_000)
    if (confirmed) settled.add(asin)
  }
  return settled
}

/**
 * Which ASINs this pass should actually ask Amazon for — pure, so the rule can be tested without
 * touching Amazon or the database.
 *
 * Three outcomes, and they must not overlap or the summary double-counts: an ASIN is either already
 * OUTSTANDING (a report is in flight; asking again would queue behind it and make the drain strictly
 * worse), already SETTLED (a re-fetch confirmed the week has stopped moving — SQP.3 §4.1), or it is
 * requested. Outstanding wins over settled, because an in-flight report is a fact about right now
 * and settledness is a fact about the past.
 */
export function partitionRequestSet(args: {
  asins: string[]
  outstanding: string[]
  /** every INGESTED attempt at this (asin, week) — settledness is DERIVED, never passed in. */
  ingests: Array<{ asin: string; collectedAt: Date | null; rowsChanged: number | null }>
  nowMs?: number
}): { toRequest: string[]; alreadyOutstanding: string[]; alreadySettled: string[] } {
  const out = new Set(args.outstanding)
  const set = settledAsins(args.ingests)
  const toRequest: string[] = [], alreadyOutstanding: string[] = [], alreadySettled: string[] = []
  for (const asin of args.asins) {
    if (out.has(asin)) alreadyOutstanding.push(asin)
    else if (set.has(asin)) alreadySettled.push(asin)
    else toRequest.push(asin)
  }
  return { toRequest, alreadyOutstanding, alreadySettled }
}

/**
 * The REQUEST pass — `createReport` only, one per ASIN, recorded and returned. No polling, no
 * download, no ingest. This is what makes the nightly run short enough that the 2h stale sweeper
 * can no longer reach it.
 */
export async function requestSqpReports(args: {
  marketplaceCode: string
  marketplaceId: string
  asins: string[]
  period?: SqpPeriod
  start: Date
  end: Date
  /** ms between createReport calls. See `measurePacing` — pacing does not raise throughput, but it
   *  does make each report collectable sooner, which matters when documents expire. */
  paceMs?: number
}): Promise<SqpRequestResult> {
  const period = args.period ?? 'WEEK'
  const startDateOnly = new Date(args.start); startDateOnly.setUTCHours(0, 0, 0, 0)
  const endDateOnly = new Date(args.end); endDateOnly.setUTCHours(0, 0, 0, 0)
  const sp = getSpApiClient()

  // Don't re-request something already outstanding for the same (asin, window) — the report would
  // queue behind the one we are already waiting for and make the drain strictly worse.
  const outstanding = await prisma.sqpReportRequest.findMany({
    where: {
      marketplace: args.marketplaceCode, reportPeriod: period, startDate: startDateOnly,
      asin: { in: args.asins }, status: { in: ['PENDING', 'DONE'] },
    },
    select: { asin: true },
  })
  // 🔴 And skip what has STOPPED MOVING. SQP.3 §4.1: a settled week comes back byte-identical —
  // 0 of 100 fields differed at 25 days and again at 46 days. Yet this pass re-requested the same
  // week every night for as long as the calendar pointed at it; 2026-07-26 was fetched five times.
  // At ~65s per `createReport` that is the request pass's entire budget spent re-reading data we
  // already hold, while the weeks we do NOT hold go unfetched.
  //
  // The rule is "fetch a week until it stops moving, then leave it": one ingest establishes the
  // rows, a second confirms nothing moved (`rowsChanged = 0`), and from then on it is skipped. It
  // takes TWO ingests, never one, because the first fetch of a week necessarily changes everything
  // and so can never prove the week is settled.
  const ingests = await prisma.sqpReportRequest.findMany({
    where: {
      marketplace: args.marketplaceCode, reportPeriod: period, startDate: startDateOnly,
      asin: { in: args.asins }, status: 'INGESTED',
    },
    select: { asin: true, collectedAt: true, rowsChanged: true },
  })
  const part = partitionRequestSet({
    asins: args.asins,
    outstanding: outstanding.map((o) => o.asin),
    ingests,
  })
  const skip = new Set([...part.alreadyOutstanding, ...part.alreadySettled])

  let created = 0, failed = 0
  for (const asin of args.asins) {
    if (skip.has(asin)) continue
    try {
      const res: any = await (sp as any).callAPI({
        operation: 'createReport',
        endpoint: 'reports',
        body: {
          reportType: SQP_REPORT_TYPE,
          marketplaceIds: [args.marketplaceId],
          dataStartTime: args.start.toISOString(),
          dataEndTime: args.end.toISOString(),
          reportOptions: { reportPeriod: period, asin },
        },
      })
      const reportId: string | undefined = res?.reportId
      if (!reportId) { failed++; logger.warn('[sqp-async] createReport returned no reportId', { marketplace: args.marketplaceCode, asin }); continue }
      await prisma.sqpReportRequest.create({
        data: {
          reportId, marketplace: args.marketplaceCode, marketplaceId: args.marketplaceId, asin,
          reportPeriod: period, startDate: startDateOnly, endDate: endDateOnly, status: 'PENDING',
        },
      }).catch(async (e) => {
        // reportId is @unique. A collision means we already hold it; never lose the report over it.
        logger.warn('[sqp-async] request row not stored (duplicate reportId?)', { reportId, error: (e as Error).message })
      })
      created++
      if (args.paceMs) await sleep(args.paceMs)
    } catch (err) {
      failed++
      logger.warn('[sqp-async] createReport failed', { marketplace: args.marketplaceCode, asin, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return {
    marketplace: args.marketplaceCode, period, startDate: startDateOnly.toISOString().slice(0, 10),
    asinsRequested: args.asins.length, created, failed,
    alreadyOutstanding: part.alreadyOutstanding.length, alreadySettled: part.alreadySettled.length,
  }
}

export interface SqpCollectResult {
  polled: number
  ingested: number
  rowsUpserted: number
  /** of those, how many actually moved a stored value — see SqpReportRequest.rowsChanged */
  rowsChanged: number
  rowsParsed: number
  stillPending: number
  expired: number
  terminal: number
  errors: number
  /** polled despite being older than the documented retention — measured to still work. */
  pastRetentionStillTrying: number
  /** ms from Amazon reporting DONE to us ingesting — the latency this design exists to expose. */
  collectionLagMsP50: number | null
}

/**
 * The COLLECT pass — poll outstanding ids, ingest whatever Amazon has finished.
 *
 * Ordered oldest-first so the requests closest to the 72h retention edge are collected before the
 * ones with time to spare. That ordering is the whole point of tracking `requestedAt`.
 */
export async function collectSqpReports(args: { limit?: number; paceMs?: number } = {}): Promise<SqpCollectResult> {
  const limit = args.limit ?? 60
  const sp = getSpApiClient()
  const now = Date.now()

  const outstanding = await prisma.sqpReportRequest.findMany({
    where: { status: { in: ['PENDING', 'DONE'] }, pollAttempts: { lt: SQP_MAX_POLL_ATTEMPTS } },
    orderBy: { requestedAt: 'asc' },
    take: limit,
  })

  const out: SqpCollectResult = {
    polled: 0, ingested: 0, rowsUpserted: 0, rowsChanged: 0, rowsParsed: 0,
    stillPending: 0, expired: 0, terminal: 0, errors: 0, pastRetentionStillTrying: 0,
    collectionLagMsP50: null,
  }
  const lags: number[] = []

  for (const req of outstanding) {
    const ageH = (now - +req.requestedAt) / 3_600_000

    // 🔴 NO age-based expiry. Measured: documents requested 87.7h and 169h earlier still downloaded,
    // so the retention clock does not start at the request and an age test would retire live
    // documents. Every request is polled on its merits; only a 404 concludes expiry. `pastRetention`
    // is carried into the summary as a warning so the headroom is still visible.
    if (ageH > SQP_DOCUMENT_RETENTION_HOURS) out.pastRetentionStillTrying++

    out.polled++
    let docId = req.reportDocumentId
    let doneAt = req.doneAt
    if (!docId) {
      try {
        const res: any = await (sp as any).callAPI({ operation: 'getReport', endpoint: 'reports', path: { reportId: req.reportId } })
        const st: string = res?.processingStatus
        await prisma.sqpReportRequest.update({ where: { id: req.id }, data: { pollAttempts: { increment: 1 }, lastPolledAt: new Date() } }).catch(() => {})
        if (st === 'DONE') {
          docId = res?.reportDocumentId ?? null
          doneAt = res?.processingEndTime ? new Date(res.processingEndTime) : new Date()
          if (!docId) { await mark(req.id, { status: 'ERROR', errorMessage: 'DONE with no reportDocumentId' }); out.errors++; continue }
          await prisma.sqpReportRequest.update({ where: { id: req.id }, data: { status: 'DONE', doneAt, reportDocumentId: docId } }).catch(() => {})
        } else if (st === 'FATAL' || st === 'CANCELLED') {
          await mark(req.id, { status: st, errorMessage: `Amazon ended the report: ${st}` })
          out.terminal++
          continue
        } else {
          out.stillPending++
          continue
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/404|not ?found|NotFound/i.test(msg)) { await mark(req.id, { status: 'EXPIRED', errorMessage: `getReport 404 at ${ageH.toFixed(1)}h old` }); out.expired++ }
        else { await mark(req.id, { status: 'ERROR', errorMessage: msg.slice(0, 500) }); out.errors++ }
        continue
      }
      if (args.paceMs) await sleep(args.paceMs)
    }

    // ── download + parse + upsert ──────────────────────────────────────────────────────────────
    try {
      const docRes: any = await (sp as any).callAPI({ operation: 'getReportDocument', endpoint: 'reports', path: { reportDocumentId: docId } })
      const raw: string = typeof docRes === 'string' ? docRes : await (sp as any).download(docRes)
      let payload: unknown
      try { payload = JSON.parse(raw) } catch { payload = raw }
      const rows = parseSqp(payload)
      out.rowsParsed += rows.length

      let upserted = 0
      let changed = 0

      // 🔴 Read the existing rows FIRST, so a re-fetch can be told from a revision.
      //
      // SQP.3 §4.1 measured a settled week coming back byte-identical while `updatedAt` moved on every
      // row — Prisma's `@updatedAt` fires on the update path whether or not a value changed, and this
      // update branch writes every field every time. Neither the row count nor the timestamp can say
      // whether a fetch was worth making. Comparing values can, and that is what lets the request pass
      // stop asking for a week that has stopped moving.
      const existing = await prisma.searchQueryPerformance.findMany({
        where: {
          marketplace: req.marketplace, reportPeriod: req.reportPeriod, startDate: req.startDate,
          searchQuery: { in: rows.map((r) => r.searchQuery) },
        },
        select: {
          searchQuery: true, asin: true, searchQueryVolume: true, searchQueryRank: true,
          impressionsTotal: true, impressionsBrand: true, clicksTotal: true, clicksBrand: true,
          cartAddsTotal: true, cartAddsBrand: true, purchasesTotal: true, purchasesBrand: true,
        },
      })
      const priorByKey = new Map(existing.map((e) => [`${e.searchQuery}|${e.asin ?? ''}`, e]))

      for (const row of rows) {
        const a = row.asin || req.asin
        const prior = priorByKey.get(`${row.searchQuery}|${a}`)
        if (!prior) changed++
        else if (
          prior.searchQueryVolume !== row.searchQueryVolume ||
          (prior.searchQueryRank ?? null) !== (row.searchQueryRank ?? null) ||
          prior.impressionsTotal !== row.impressionsTotal || prior.impressionsBrand !== row.impressionsBrand ||
          prior.clicksTotal !== row.clicksTotal || prior.clicksBrand !== row.clicksBrand ||
          prior.cartAddsTotal !== row.cartAddsTotal || prior.cartAddsBrand !== row.cartAddsBrand ||
          prior.purchasesTotal !== row.purchasesTotal || prior.purchasesBrand !== row.purchasesBrand
        ) changed++

        await prisma.searchQueryPerformance.upsert({
          where: { marketplace_reportPeriod_startDate_searchQuery_asin: { marketplace: req.marketplace, reportPeriod: req.reportPeriod, startDate: req.startDate, searchQuery: row.searchQuery, asin: a } },
          create: {
            marketplace: req.marketplace, reportPeriod: req.reportPeriod, startDate: req.startDate,
            searchQuery: row.searchQuery, asin: a,
            searchQueryVolume: row.searchQueryVolume, searchQueryRank: row.searchQueryRank,
            impressionsTotal: row.impressionsTotal, impressionsBrand: row.impressionsBrand, impressionShare: share(row.impressionsBrand, row.impressionsTotal),
            clicksTotal: row.clicksTotal, clicksBrand: row.clicksBrand, clickShare: share(row.clicksBrand, row.clicksTotal),
            cartAddsTotal: row.cartAddsTotal, cartAddsBrand: row.cartAddsBrand, cartAddShare: share(row.cartAddsBrand, row.cartAddsTotal),
            purchasesTotal: row.purchasesTotal, purchasesBrand: row.purchasesBrand, purchaseShare: share(row.purchasesBrand, row.purchasesTotal),
            sourceReportId: req.reportId,
          },
          update: {
            searchQueryVolume: row.searchQueryVolume, searchQueryRank: row.searchQueryRank,
            impressionsTotal: row.impressionsTotal, impressionsBrand: row.impressionsBrand, impressionShare: share(row.impressionsBrand, row.impressionsTotal),
            clicksTotal: row.clicksTotal, clicksBrand: row.clicksBrand, clickShare: share(row.clicksBrand, row.clicksTotal),
            cartAddsTotal: row.cartAddsTotal, cartAddsBrand: row.cartAddsBrand, cartAddShare: share(row.cartAddsBrand, row.cartAddsTotal),
            purchasesTotal: row.purchasesTotal, purchasesBrand: row.purchasesBrand, purchaseShare: share(row.purchasesBrand, row.purchasesTotal),
            sourceReportId: req.reportId,
          },
        })
        upserted += 1
      }
      const collectedAt = new Date()
      // 🔴 INGESTED with 0 rows is a legitimate, common outcome: 25 of 40 reports a night come back
      // genuinely empty because the ASIN has no Brand Analytics data (feed doc §6.2). It is recorded
      // as ingested-with-zero, never as a failure — the previous design's conflation of the two is
      // what made a dead feed indistinguishable from a healthy one.
      await mark(req.id, { status: 'INGESTED', rowsParsed: rows.length, rowsUpserted: upserted, rowsChanged: changed, collectedAt, doneAt: doneAt ?? undefined })
      out.ingested++
      out.rowsUpserted += upserted
      out.rowsChanged += changed
      if (doneAt) lags.push(+collectedAt - +doneAt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/404|not ?found|NotFound|expire|gone/i.test(msg)) { await mark(req.id, { status: 'EXPIRED', errorMessage: `document gone at ${ageH.toFixed(1)}h old: ${msg.slice(0, 200)}` }); out.expired++ }
      else { await mark(req.id, { status: 'ERROR', errorMessage: msg.slice(0, 500) }); out.errors++ }
    }
    if (args.paceMs) await sleep(args.paceMs)
  }

  if (lags.length) {
    const s = [...lags].sort((a, b) => a - b)
    out.collectionLagMsP50 = s[Math.floor(s.length / 2)]
  }
  return out
}

async function mark(id: string, data: Record<string, unknown>): Promise<void> {
  await prisma.sqpReportRequest.update({ where: { id }, data: data as never }).catch(() => {})
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * The capacity bound — the number nobody had, and the hard ceiling on any future widening.
 *
 * 🔴 Derived EMPIRICALLY from an observed drain, not modelled from generation times.
 *
 * The first version of this modelled it: take the per-report generation time, multiply the competing
 * report count by it, subtract from 24h. It produced **0 sustainable reports per day and a capacity
 * of −17**, because it applied SQP's p90 generation time (1,450 s — the distribution is bimodal, 55
 * of 90 samples under 60 s and 35 over ten minutes) to report types whose generation time was never
 * measured at all. Flat-file returns reports do not take 24 minutes. A model whose inputs come from
 * the wrong distribution returns a confident negative number, which is worse than no number.
 *
 * So the bound comes from the one thing that WAS observed end to end: on 2026-08-11 a batch of 40
 * reports drained in 14.6 h, alongside the normal competing load. That is a throughput measurement
 * of the whole system under real conditions, and it needs no assumption about anyone's generation
 * time.
 *
 * The binding constraint is then **the batch must drain before the next batch is requested.** If a
 * nightly batch cannot clear in 24 h the queue grows without bound and each night's reports are
 * collected later than the last — which is exactly the runaway that produced two zero-yield nights.
 * Retention is NOT the constraint: measured, a document requested 170 h earlier still downloaded,
 * because the retention clock starts when Amazon creates the document, not when we ask.
 */
export function sqpCapacity(args: {
  /** reports in the observed batch (2026-08-11: 40). */
  observedDrainReports: number
  /** hours that batch took to drain, first generation start → last generation end (14.6). */
  observedDrainHours: number
  /** SQP reports/day currently pulled, from the report registry. */
  sqpReportsPerDayNow: number
  /** non-SQP reports/day sharing the same serial slot — context for the observation, not an input. */
  competingReportsPerDay: number
}): {
  reportsPerHour: number
  sustainablePerDay: number
  headroomPerDay: number
  drainHoursFor: (n: number) => number
  note: string
} {
  const reportsPerHour = args.observedDrainReports / args.observedDrainHours
  // A batch has to clear within the 24h before the next one lands, or the backlog compounds.
  const sustainablePerDay = Math.floor(reportsPerHour * 24)
  return {
    reportsPerHour,
    sustainablePerDay,
    headroomPerDay: sustainablePerDay - args.sqpReportsPerDayNow,
    drainHoursFor: (n: number) => n / reportsPerHour,
    note: `measured under a competing load of ~${Math.round(args.competingReportsPerDay)} non-SQP reports/day; the ceiling moves if that load does`,
  }
}
