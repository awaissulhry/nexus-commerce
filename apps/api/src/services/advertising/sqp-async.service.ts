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
  const skip = new Set(outstanding.map((o) => o.asin))

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
    asinsRequested: args.asins.length, created, failed, alreadyOutstanding: skip.size,
  }
}

export interface SqpCollectResult {
  polled: number
  ingested: number
  rowsUpserted: number
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
    polled: 0, ingested: 0, rowsUpserted: 0, rowsParsed: 0,
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
      for (const row of rows) {
        const a = row.asin || req.asin
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
      await mark(req.id, { status: 'INGESTED', rowsParsed: rows.length, rowsUpserted: upserted, collectedAt, doneAt: doneAt ?? undefined })
      out.ingested++
      out.rowsUpserted += upserted
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
