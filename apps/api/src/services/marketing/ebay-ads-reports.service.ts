/**
 * E2 (eBay Ads) — the async report pipeline (create → poll → download →
 * parse → ingest), implementing the ads-core ReportTaskDriver contract.
 *
 * Verified constraints baked in: one funding model per task; CPS tasks
 * enumerate campaignIds (≤1,000), CPC may run account-wide; TSV_GZIP only;
 * sales/fee figures reconcile within eBay's 72h "Reconciliation Period" →
 * the scheduler re-pulls the trailing window daily with rerun-safe absolute
 * upserts. Unknown TSV columns are preserved in `extra` (fail-loud when NO
 * known column maps — never silently ingest garbage).
 */

import { gunzipSync } from 'node:zlib'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { pollOrder, isReportTaskOpen } from '../ads-core/report-task-pipeline.js'
import {
  getActiveEbayAdsAuth,
  createReportTask,
  getReportTask,
  downloadReport,
  getReportMetadata,
  type CreateReportTaskSpec,
} from './ebay-ads-api.service.js'

// ── TSV parsing (pure, unit-tested) ─────────────────────────────────────────

/** Known header → fact-column mapping (live metadata vocabulary, verified
 *  2026-07-03). NB the trap: CPS `sales` and CPC `cpc_attributed_sales` are
 *  COUNTS; the money columns are `sale_amount` / `cpc_sale_amount_*`. */
export const HEADER_MAP: Record<string, string> = {
  // dimensions
  campaign_id: 'campaign_id',
  listing_id: 'listing_id',
  item_id: 'listing_id',
  keyword_id: 'keyword_id',
  seller_keyword_id: 'keyword_id',
  search_query: 'search_query', // ER1 — SEARCH_QUERY_PERFORMANCE_REPORT (CPC); ad_group_id stays unmapped → lands in extra
  date: 'date',
  day: 'date',
  // counts
  impressions: 'impressions',
  cpc_impressions: 'impressions',
  clicks: 'clicks',
  cpc_clicks: 'clicks',
  ctr: 'ctr',
  cpc_ctr: 'ctr',
  sales: 'sold_qty',
  cpc_attributed_sales: 'sold_qty',
  quantity_sold: 'sold_qty',
  cpc_quantity_sold: 'sold_qty',
  sold_quantity: 'sold_qty',
  // money
  avg_cost_per_click: 'avg_cpc',
  cost_per_click: 'avg_cpc',
  cost_per_click_listingsite_currency: 'avg_cpc',
  cpc_average_cost_per_click: 'avg_cpc',
  ad_fees: 'ad_fees',
  cpc_ad_fees: 'ad_fees',
  cpc_ad_fees_listingsite_currency: 'ad_fees',
  cost: 'ad_fees',
  sale_amount: 'sales',
  cpc_sale_amount: 'sales',
  cpc_sale_amount_listingsite_currency: 'sales',
}

export interface ParsedReportRow {
  entityId: string
  entityType: 'CAMPAIGN' | 'LISTING' | 'KEYWORD' | 'SEARCH_QUERY'
  date: string // YYYY-MM-DD
  impressions: number
  clicks: number
  ctr: number | null
  avgCpcCents: number | null
  adFeesCents: number
  salesCents: number
  soldQty: number
  extra: Record<string, string> | null
}

/** eBay money cells arrive locale-formatted with a currency prefix — the IT
 *  site emits `EUR 1.234,56` (comma decimal). Handle both conventions. */
export const moneyToCents = (v: string | undefined): number => {
  if (!v) return 0
  let s = String(v).replace(/[^\d.,\-]/g, '')
  if (!s) return 0
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.') // 1.234,56 → 1234.56
  else s = s.replace(/,/g, '') // 1,234.56 → 1234.56
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
const toInt = (v: string | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/**
 * Parse a TSV report into fact rows. Returns null when the schema is
 * unrecognizable — no entity column, or no date column AND no fallbackDate.
 * (eBay's LISTING reports reject the `day` dimension despite metadata
 * listing it, so single-day tasks pass their window date as fallbackDate.)
 */
export function parseReportTsv(tsv: string, fallbackDate?: string): ParsedReportRow[] | null {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 1) return []
  const rawHeaders = lines[0]!.split('\t').map((h) => h.trim())
  const norm = rawHeaders.map((h) => h.toLowerCase().replace(/\s+/g, '_'))
  const mapped = norm.map((h) => HEADER_MAP[h] ?? null)

  const idxOf = (key: string) => mapped.indexOf(key)
  // ER1: search_query outranks campaign_id (search rows carry campaign lineage)
  const entityIdx = ['listing_id', 'keyword_id', 'search_query', 'campaign_id'].map((k) => ({ k, i: idxOf(k) })).find((e) => e.i >= 0)
  const dateIdx = idxOf('date')
  if (!entityIdx || (dateIdx < 0 && !fallbackDate)) return null
  const entityType = entityIdx.k === 'listing_id' ? 'LISTING' : entityIdx.k === 'keyword_id' ? 'KEYWORD' : entityIdx.k === 'search_query' ? 'SEARCH_QUERY' : 'CAMPAIGN'

  const rows: ParsedReportRow[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split('\t')
    const cell = (key: string): string | undefined => {
      const i = idxOf(key)
      return i >= 0 ? cells[i]?.trim() : undefined
    }
    const entityId = cells[entityIdx.i]?.trim()
    const dateRaw = dateIdx >= 0 ? cells[dateIdx]?.trim() : fallbackDate
    if (!entityId || !dateRaw) continue
    const date = dateRaw.slice(0, 10)
    const extra: Record<string, string> = {}
    norm.forEach((h, i) => {
      const cellVal = cells[i]?.trim()
      if (cellVal == null || cellVal === '') return
      // unmapped columns AND non-entity dimension columns (lineage) both kept
      const isSecondaryDim = mapped[i] !== null && i !== entityIdx.i && ['campaign_id', 'listing_id', 'keyword_id'].includes(mapped[i]!)
      if (mapped[i] === null || isSecondaryDim) extra[h] = cellVal
    })
    const ctrRaw = cell('ctr')
    rows.push({
      entityId,
      entityType,
      date,
      impressions: toInt(cell('impressions')),
      clicks: toInt(cell('clicks')),
      ctr: ctrRaw != null && ctrRaw !== '' ? Number(ctrRaw.replace('%', '')) : null,
      avgCpcCents: cell('avg_cpc') ? moneyToCents(cell('avg_cpc')) : null,
      adFeesCents: moneyToCents(cell('ad_fees')),
      salesCents: moneyToCents(cell('sales')),
      soldQty: toInt(cell('sold_qty')),
      extra: Object.keys(extra).length ? extra : null,
    })
  }
  return rows
}

// ── Scheduler ────────────────────────────────────────────────────────────────

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d }

export interface ScheduleReport { created: number; skippedOpen: number; errors: string[] }

/** eBay hard limit (error 35090): a report task spans at most 7 days. */
export function chunkDateWindow(fromYmd: string, toYmd: string, maxDays = 7): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = []
  let cursor = new Date(`${fromYmd}T00:00:00Z`)
  const end = new Date(`${toYmd}T00:00:00Z`)
  while (cursor <= end) {
    const chunkEnd = new Date(cursor)
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1)
    const to = chunkEnd <= end ? chunkEnd : end
    chunks.push({ from: ymd(cursor), to: ymd(to) })
    cursor = new Date(to)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return chunks
}

/**
 * Daily task creation per fundingModel × grain, chunked into ≤7-day windows
 * (verified eBay cap). First run (empty facts) backfills
 * NEXUS_EBAY_ADS_BACKFILL_DAYS (default 28); thereafter the trailing 4-day
 * window (yesterday + the 72h Reconciliation Period). Idempotent per chunk.
 */
export async function scheduleEbayReportTasks(): Promise<ScheduleReport> {
  const report: ScheduleReport = { created: 0, skippedOpen: 0, errors: [] }
  const auth = await getActiveEbayAdsAuth()
  if (!auth) { report.errors.push('no active eBay connection'); return report }

  const campaigns = await prisma.ebayCampaign.findMany({
    select: { externalCampaignId: true, fundingModel: true, marketplace: true },
  })
  if (campaigns.length === 0) { report.errors.push('no campaigns synced yet — run entity sync first'); return report }

  const backfillDays = Math.max(4, Number(process.env.NEXUS_EBAY_ADS_BACKFILL_DAYS ?? 28))
  const anyFacts = await prisma.ebayAdsDailyPerformance.findFirst({ select: { id: true } })
  const windowFrom = ymd(anyFacts ? daysAgo(4) : daysAgo(backfillDays))
  const windowTo = ymd(daysAgo(1))
  const marketplaces = [...new Set(campaigns.map((c) => c.marketplace))]

  const models: { fundingModel: string; campaignIds: string[] }[] = []
  for (const fm of ['COST_PER_SALE', 'COST_PER_CLICK']) {
    const ids = campaigns.filter((c) => (c.fundingModel ?? 'COST_PER_SALE') === fm).map((c) => c.externalCampaignId)
    if (ids.length) models.push({ fundingModel: fm, campaignIds: fm === 'COST_PER_SALE' ? ids.slice(0, 1000) : [] })
  }

  // Dimensions verified against live ad_report_metadata + error 35119's
  // minimum sets, which differ BY FUNDING MODEL (CPC grains require the
  // campaign_id + ad_group_id lineage; CPS accepts entity+day).
  // Campaign grain is CPS-only for now: eBay's CPC minimum-dimension set
  // forces listing lineage onto every CPC report, which lands those rows at
  // LISTING grain anyway (all 4 CPC campaigns are PAUSED/historical; the E3
  // console derives CPC campaign rollups from listing facts × EbayAd).
  // chunkDays=1 where eBay rejects the `day` dimension (LISTING — error
  // 35107 despite metadata listing it): single-day tasks make the window
  // date the fact date via the parser's fallbackDate.
  const GRAINS: { reportType: string; dims: (fm: string) => string[]; chunkDays: number; cpcOnly?: boolean; cpsOnly?: boolean; perCampaign?: boolean; trailingDays?: number }[] = [
    // No CAMPAIGN_PERFORMANCE_REPORT task: eBay's minimum dims force listing
    // lineage onto it anyway (verified: min = listing_id,campaign_id), so the
    // LISTING report IS the atomic truth. Campaign-grain facts + the
    // CampaignMetric rollup are DERIVED from listing rows at ingest.
    {
      reportType: 'LISTING_PERFORMANCE_REPORT',
      dims: (fm) => (fm === 'COST_PER_CLICK' ? ['campaign_id', 'ad_group_id', 'listing_id'] : ['campaign_id', 'listing_id']),
      chunkDays: 1,
    },
    { reportType: 'KEYWORD_PERFORMANCE_REPORT', dims: () => ['campaign_id', 'ad_group_id', 'seller_keyword_id', 'keyword_match_type', 'day'], chunkDays: 7, cpcOnly: true },
    // ER1 — search-term grain (verified: CPC-only, ONE campaign per task, no
    // `day` dim ⇒ window totals dated at dateTo via fallbackDate). Scheduled
    // per RUNNING/PAUSED CPC campaign over a trailing 30-day window.
    { reportType: 'SEARCH_QUERY_PERFORMANCE_REPORT', dims: () => ['campaign_id', 'ad_group_id', 'search_query'], chunkDays: 0, cpcOnly: true, perCampaign: true, trailingDays: 30 },
  ]

  // Desired metric sets per funding model (live metadata vocabulary; the
  // scheduler still intersects with what metadata actually offers).
  const DESIRED_METRICS: Record<string, string[]> = {
    COST_PER_SALE: ['impressions', 'clicks', 'ctr', 'ad_fees', 'sale_amount', 'sales'],
    COST_PER_CLICK: [
      'cpc_impressions', 'cpc_clicks', 'cpc_ctr',
      'cpc_ad_fees_listingsite_currency', 'cpc_sale_amount_listingsite_currency',
      'cpc_attributed_sales', 'cost_per_click_listingsite_currency',
    ],
  }

  for (const m of models) {
    for (const g of GRAINS) {
      if (g.cpcOnly && m.fundingModel !== 'COST_PER_CLICK') continue
      if (g.cpsOnly && m.fundingModel !== 'COST_PER_SALE') continue

      // ER1 — per-campaign grains (search-query): one task per campaign over
      // a trailing window; dedupe includes the campaignIds array.
      if (g.perCampaign) {
        const from = new Date(new Date(`${windowTo}T00:00:00Z`).getTime() - ((g.trailingDays ?? 30) - 1) * 86_400_000).toISOString().slice(0, 10)
        const cIds = campaigns.filter((c) => (c.fundingModel ?? 'COST_PER_SALE') === m.fundingModel).map((c) => c.externalCampaignId)
        if (!cIds.length) continue
        const metaRaw = await getReportMetadata(auth.token, g.reportType).catch(() => null)
        const meta = ((metaRaw as { reportMetadata?: Record<string, unknown> } | null)?.reportMetadata ?? metaRaw) as { metricMetadata?: { metricKey?: string; key?: string }[] } | null
        const available = new Set<string>((meta?.metricMetadata ?? []).map((mm) => mm.metricKey ?? mm.key ?? '').filter(Boolean))
        const desired = DESIRED_METRICS[m.fundingModel] ?? []
        const metricKeys = available.size ? desired.filter((k) => available.has(k)) : desired
        if (metricKeys.length === 0) { report.errors.push(`${g.reportType}/${m.fundingModel}: no usable metrics in metadata`); continue }
        for (const extId of cIds) {
          const open = await prisma.ebayAdsReportTask.findFirst({
            where: { reportType: g.reportType, fundingModel: m.fundingModel, campaignIds: { equals: [extId] }, dateFrom: new Date(`${from}T00:00:00Z`), dateTo: new Date(`${windowTo}T00:00:00Z`), status: { in: ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'INGESTED'] } },
            select: { id: true },
          })
          if (open) { report.skippedOpen++; continue }
          try {
            const spec: CreateReportTaskSpec = {
              reportType: g.reportType, fundingModel: m.fundingModel, dateFrom: from, dateTo: windowTo,
              marketplaceIds: marketplaces, campaignIds: [extId],
              dimensions: g.dims(m.fundingModel).map((dimensionKey) => ({ dimensionKey })), metricKeys,
            }
            const externalTaskId = await createReportTask(auth.token, spec)
            await prisma.ebayAdsReportTask.create({
              data: {
                reportType: g.reportType, fundingModel: m.fundingModel, marketplaces, campaignIds: [extId],
                dateFrom: new Date(`${from}T00:00:00Z`), dateTo: new Date(`${windowTo}T00:00:00Z`),
                dimensions: spec.dimensions as object, metrics: metricKeys as unknown as object,
                externalTaskId, status: 'PENDING',
              },
            })
            report.created++
          } catch (e) {
            report.errors.push(`${g.reportType}/${extId} ${from}..${windowTo}: ${(e as Error).message}`)
          }
        }
        continue
      }

      for (const w of chunkDateWindow(windowFrom, windowTo, g.chunkDays)) {
      const dateFrom = w.from
      const dateTo = w.to
      const open = await prisma.ebayAdsReportTask.findFirst({
        where: { reportType: g.reportType, fundingModel: m.fundingModel, dateFrom: new Date(`${dateFrom}T00:00:00Z`), dateTo: new Date(`${dateTo}T00:00:00Z`), status: { in: ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'INGESTED'] } },
        select: { id: true },
      })
      if (open) { report.skippedOpen++; continue }

      try {
        // Metric keys: intersect our desired set with what metadata allows.
        const metaRaw = await getReportMetadata(auth.token, g.reportType).catch(() => null)
        const meta = ((metaRaw as { reportMetadata?: Record<string, unknown> } | null)?.reportMetadata ?? metaRaw) as
          | { metricMetadata?: { metricKey?: string; key?: string }[] }
          | null
        const available = new Set<string>(
          (meta?.metricMetadata ?? []).map((mm) => mm.metricKey ?? mm.key ?? '').filter(Boolean),
        )
        const desired = DESIRED_METRICS[m.fundingModel] ?? []
        const metricKeys = available.size ? desired.filter((k) => available.has(k)) : desired
        if (metricKeys.length === 0) { report.errors.push(`${g.reportType}/${m.fundingModel}: no usable metrics in metadata`); continue }

        const spec: CreateReportTaskSpec = {
          reportType: g.reportType,
          fundingModel: m.fundingModel,
          dateFrom,
          dateTo,
          marketplaceIds: marketplaces,
          campaignIds: m.campaignIds,
          dimensions: g.dims(m.fundingModel).map((dimensionKey) => ({ dimensionKey })),
          metricKeys,
        }
        const externalTaskId = await createReportTask(auth.token, spec)
        await prisma.ebayAdsReportTask.create({
          data: {
            reportType: g.reportType,
            fundingModel: m.fundingModel,
            marketplaces,
            campaignIds: m.campaignIds,
            dateFrom: new Date(`${dateFrom}T00:00:00Z`),
            dateTo: new Date(`${dateTo}T00:00:00Z`),
            dimensions: spec.dimensions as object,
            metrics: metricKeys as unknown as object,
            externalTaskId,
            status: 'PENDING',
          },
        })
        report.created++
      } catch (e) {
        report.errors.push(`${g.reportType}/${m.fundingModel} ${dateFrom}..${dateTo}: ${(e as Error).message}`)
      }
      }
    }
  }
  logger.info('[E2][ebay-ads] report scheduling complete', report as unknown as Record<string, unknown>)
  return report
}

// ── Poller + ingester ────────────────────────────────────────────────────────

const EBAY_TASK_STATUS: Record<string, string> = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  PROCESSING: 'IN_PROGRESS',
  SUCCESS: 'SUCCESS',
  COMPLETED: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
}

export interface PollReport { polled: number; succeeded: number; ingested: number; rows: number; failed: number; errors: string[] }

export async function pollAndIngestEbayReports(limit = 10): Promise<PollReport> {
  const report: PollReport = { polled: 0, succeeded: 0, ingested: 0, rows: 0, failed: 0, errors: [] }
  const auth = await getActiveEbayAdsAuth()
  if (!auth) { report.errors.push('no active eBay connection'); return report }

  const open = await prisma.ebayAdsReportTask.findMany({
    where: { status: { in: ['PENDING', 'IN_PROGRESS', 'SUCCESS'] } },
  })
  const toPoll = pollOrder(open.filter((t) => isReportTaskOpen(t.status as never))).slice(0, limit)

  for (const task of toPoll) {
    if (!task.externalTaskId) continue
    report.polled++
    try {
      const dto = await getReportTask(auth.token, task.externalTaskId)
      const mapped = EBAY_TASK_STATUS[dto.reportTaskStatus ?? ''] ?? 'IN_PROGRESS'
      await prisma.ebayAdsReportTask.update({
        where: { id: task.id },
        data: {
          status: mapped,
          reportHref: dto.reportHref ?? task.reportHref,
          attempts: { increment: 1 },
          lastPolledAt: new Date(),
          failureReason: mapped === 'FAILED' ? (dto.reportTaskStatusMessage ?? 'eBay reported FAILED') : null,
        },
      })
      if (mapped === 'SUCCESS') report.succeeded++
      if (mapped === 'FAILED') report.failed++
    } catch (e) {
      report.errors.push(`poll ${task.externalTaskId}: ${(e as Error).message}`)
    }
  }

  // Ingest every SUCCESS task with an href
  const ready = await prisma.ebayAdsReportTask.findMany({ where: { status: 'SUCCESS', reportHref: { not: null } } })
  for (const task of ready) {
    try {
      const raw = await downloadReport(auth.token, task.reportHref!)
      const tsv = gunzipSync(raw).toString('utf8')
      const singleDay = task.dateFrom.getTime() === task.dateTo.getTime()
      // ER1: search-query tasks are window totals (no day dim) — date them at
      // the window END so "latest snapshot" queries are natural.
      const isSearch = task.reportType === 'SEARCH_QUERY_PERFORMANCE_REPORT'
      const rows = parseReportTsv(tsv, singleDay ? task.dateFrom.toISOString().slice(0, 10) : isSearch ? task.dateTo.toISOString().slice(0, 10) : undefined)
      if (rows === null) {
        await prisma.ebayAdsReportTask.update({ where: { id: task.id }, data: { status: 'FAILED', failureReason: 'unrecognized TSV schema (no entity/date column)' } })
        report.failed++
        logger.error(`[E2][ebay-ads] report ${task.id} has unrecognized schema — FAILED loud, nothing ingested`)
        continue
      }
      const marketplace = task.marketplaces[0] ?? 'EBAY_IT'
      const now = new Date()
      // Campaign-grain derivation: aggregate this task's listing rows by
      // their campaign_id lineage (kept in extra). A task = one day × one
      // funding model, so per-campaign sums are absolute ⇒ rerun-safe.
      // ER1: search-query rows never derive campaign facts (they'd double-count
      // on top of the listing-derived campaign grain) and get a composite
      // entityId — the same query can exist in several campaigns.
      for (const r of rows) {
        if (r.entityType !== 'SEARCH_QUERY') continue
        const cid = r.extra?.campaign_id ?? task.campaignIds[0] ?? ''
        r.extra = { ...(r.extra ?? {}), search_query: r.entityId }
        r.entityId = `${cid}::${r.entityId}`.slice(0, 500)
      }
      const byCampaign = new Map<string, { date: string; impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }>()
      for (const r of rows) {
        if (r.entityType === 'SEARCH_QUERY') continue
        const cid = r.entityType === 'CAMPAIGN' ? r.entityId : r.extra?.campaign_id
        if (!cid) continue
        const k = `${cid}|${r.date}`
        const agg = byCampaign.get(k) ?? { date: r.date, impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0 }
        agg.impressions += r.impressions
        agg.clicks += r.clicks
        agg.adFeesCents += r.adFeesCents
        agg.salesCents += r.salesCents
        agg.soldQty += r.soldQty
        byCampaign.set(k, agg)
      }
      for (const r of rows) {
        const key = { marketplace, fundingModel: task.fundingModel, entityType: r.entityType, entityId: r.entityId, date: new Date(`${r.date}T00:00:00Z`) }
        const data = {
          impressions: r.impressions,
          clicks: r.clicks,
          ctr: r.ctr != null ? r.ctr.toFixed(5) : null,
          avgCostPerClickCents: r.avgCpcCents,
          adFeesCents: r.adFeesCents,
          salesCents: r.salesCents,
          soldQty: r.soldQty,
          currency: 'EUR',
          extra: (r.extra as object | null) ?? undefined,
          reportTaskId: task.id,
          reportedAt: now,
        }
        await prisma.ebayAdsDailyPerformance.upsert({
          where: { marketplace_fundingModel_entityType_entityId_date: key },
          create: { ...key, ...data },
          update: data,
        })
      }
      // Derived campaign-grain facts + cross-channel rollup (EUR base).
      for (const [k, agg] of byCampaign) {
        const cid = k.split('|')[0]!
        const cDate = new Date(`${agg.date}T00:00:00Z`)
        const cKey = { marketplace, fundingModel: task.fundingModel, entityType: 'CAMPAIGN', entityId: cid, date: cDate }
        const cData = {
          impressions: agg.impressions, clicks: agg.clicks,
          adFeesCents: agg.adFeesCents, salesCents: agg.salesCents, soldQty: agg.soldQty,
          currency: 'EUR', reportTaskId: task.id, reportedAt: now,
        }
        await prisma.ebayAdsDailyPerformance.upsert({
          where: { marketplace_fundingModel_entityType_entityId_date: cKey },
          create: { ...cKey, ...cData },
          update: cData,
        })
        await prisma.campaignMetric.upsert({
          where: { channel_entityType_entityId_date: { channel: 'EBAY', entityType: 'CAMPAIGN', entityId: cid, date: cDate } },
          create: {
            channel: 'EBAY', entityType: 'CAMPAIGN', entityId: cid, date: cDate,
            marketplace, reportedAt: now,
            impressions: agg.impressions, clicks: agg.clicks,
            costMicros: BigInt(agg.adFeesCents) * 10_000n, costEurCents: BigInt(agg.adFeesCents),
            currencyCode: 'EUR', sales7dCents: agg.salesCents, attributionModel: 'ebay-any-click',
          },
          update: {
            marketplace, reportedAt: now,
            impressions: agg.impressions, clicks: agg.clicks,
            costMicros: BigInt(agg.adFeesCents) * 10_000n, costEurCents: BigInt(agg.adFeesCents),
            sales7dCents: agg.salesCents, attributionModel: 'ebay-any-click',
          },
        })
      }
      await prisma.ebayAdsReportTask.update({
        where: { id: task.id },
        data: { status: 'INGESTED', downloadedAt: now, ingestedAt: now, rowsIngested: rows.length },
      })
      report.ingested++
      report.rows += rows.length
    } catch (e) {
      report.errors.push(`ingest ${task.id}: ${(e as Error).message}`)
      await prisma.ebayAdsReportTask.update({ where: { id: task.id }, data: { failureReason: (e as Error).message.slice(0, 500) } }).catch(() => {})
    }
  }

  if (report.polled + report.ingested > 0) {
    logger.info('[E2][ebay-ads] report poll/ingest', report as unknown as Record<string, unknown>)
  }
  return report
}
