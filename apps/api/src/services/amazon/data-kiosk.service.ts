/**
 * Phase 2 — SP-API Data Kiosk.
 *
 * Data Kiosk is SP-API's GraphQL analytics surface. Its value here is
 * `analytics_economics_2024_03_15`: Amazon's OWN per-SKU-day profitability
 * arithmetic (net proceeds after fees and ad spend), which the Reports API does
 * not expose in that form.
 *
 * Deliberately NOT integrating `analytics_salesAndTraffic_*` — it duplicates
 * sales-report-ingest.service.ts (GET_SALES_AND_TRAFFIC_REPORT).
 *
 * Flow: createQuery → poll → getDocument → download JSONL.
 *
 * ── Contract, probed live 2026-07-29 ──────────────────────────────────
 *
 *  1. The root field is `economics`, NOT `economicsByAsin`.
 *
 *  2. Documents are **JSONL** (one object per line), served PLAIN (not gzipped
 *     in practice) — decode handles gzip anyway.
 *
 *  3. The signed document URL carries `X-Amz-Expires=300`. Crucially it is
 *     minted at the DOCUMENT step, not the status step, so status can be polled
 *     cheaply across cron ticks and only the download must be prompt. That is
 *     why this uses a persistent job row while Brand Metrics cannot.
 *
 *  4. `economics` is SLOW — a 6-day / ~280-SKU query took >11 minutes to reach
 *     DONE (salesAndTraffic took 24s). Polling must be resumable.
 *
 *  5. createQuery is rate-limited to roughly 1/min and a VALIDATION-REJECTED
 *     query still consumes quota. Exhaustion surfaces with an EMPTY error
 *     detail, which is easily misread as a schema answer.
 *
 *  6. `fees` and `ads` are arrays with NO identifying field — three fees on a
 *     row are three bare amounts. Only the TOTAL is attributable. The labelled
 *     breakdown requires `economicsPreview(feeTypes:)`, a separate integration.
 *     `feeTypes` is NOT accepted on `economics` (tested: UnknownArgument).
 *
 *  7. Introspection is DISABLED, and any `__`-prefixed field triggers
 *     "Introspection is not supported." rather than a useful error.
 */

import { gunzipSync } from 'node:zlib'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export const ECONOMICS_SCHEMA = 'analytics_economics_2024_03_15'
export const DK_QUERY_TYPE_ECONOMICS = 'economics'

/** Amazon marketplaceId → the 2-letter code the rest of Nexus keys on. */
const MARKETPLACE_CODES: Record<string, string> = {
  APJ6JRA9NG5V4: 'IT',
  A1PA6795UKMFR9: 'DE',
  A13V1IB3VIYZZH: 'FR',
  A1RKKUPIHCS9HS: 'ES',
  A1F83G8C2ARO7P: 'UK',
  A1805IZSGTT6HS: 'NL',
  A1C3SOZRARQ6R3: 'PL',
  A2NODRKZP88ZB9: 'SE',
  A28R8C7NBKEWEA: 'IE',
  ATVPDKIKX0DER: 'US',
}
export function marketplaceCode(id: string): string {
  return MARKETPLACE_CODES[id] ?? id
}

// ── SP-API client ────────────────────────────────────────────────────

let cachedClient: unknown = null
async function getClient(): Promise<{ callAPI: (o: Record<string, unknown>) => Promise<any> }> {
  if (cachedClient) return cachedClient as never
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('[data-kiosk] missing AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_REFRESH_TOKEN')
  }
  const mod = await import('amazon-sp-api')
  const SellingPartner = (mod as unknown as { default: new (o: unknown) => unknown }).default
  cachedClient = new SellingPartner({
    region: (process.env.AMAZON_REGION ?? 'eu') as 'eu',
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
    },
    options: { auto_request_tokens: true, auto_request_throttled: false },
  })
  return cachedClient as never
}

/** True when the failure is Data Kiosk's create-query quota, which surfaces
 *  with an EMPTY detail field and must NOT be mistaken for a schema error. */
export function isQuotaError(err: unknown): boolean {
  const e = err as { message?: string; code?: string }
  return /exceeded your quota|QuotaExceeded|TooManyRequests|429/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`)
}

// ── Query construction ───────────────────────────────────────────────

/** The verified production economics query. Pure — unit-tested. */
export function buildEconomicsQuery(args: {
  startDate: string
  endDate: string
  marketplaceIds: string[]
}): string {
  const ids = args.marketplaceIds.map((m) => `"${m}"`).join(', ')
  return `query NexusEconomics {
  ${ECONOMICS_SCHEMA} {
    economics(startDate: "${args.startDate}", endDate: "${args.endDate}", marketplaceIds: [${ids}]) {
      startDate
      endDate
      marketplaceId
      parentAsin
      childAsin
      msku
      sales {
        unitsOrdered
        netProductSales { amount currencyCode }
        averageSellingPrice { amount currencyCode }
      }
      fees { charge { aggregatedDetail { amount { amount currencyCode } quantity } } }
      ads { charge { amount { amount currencyCode } quantity } }
      netProceeds { total { amount currencyCode } perUnit { amount currencyCode } }
      cost { costOfGoodsSold { amount currencyCode } miscellaneousCost { amount currencyCode } }
    }
  }
}`
}

// ── Parsing ──────────────────────────────────────────────────────────

/** JSONL, optionally gzipped. Malformed lines are skipped rather than losing
 *  the whole document. */
export function decodeJsonl(buf: Buffer): unknown[] {
  const body = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf
  const text = body.toString('utf8').trim()
  if (!text) return []
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* skip malformed line */ }
  }
  return out
}

interface AmountLike { amount?: unknown; currencyCode?: unknown }

/**
 * Absent must stay absent. Number(null) is 0, and 0 is a REAL value for every
 * money field here — a missing COGS must not read as "this product costs
 * nothing to buy".
 */
export function money(v: AmountLike | null | undefined): number | null {
  if (v == null || typeof v !== 'object') return null
  const raw = (v as AmountLike).amount
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'object' || typeof raw === 'boolean') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export interface EconomicsRow {
  marketplaceId: string
  marketplace: string
  date: Date
  parentAsin: string
  childAsin: string
  msku: string
  currencyCode: string
  unitsOrdered: number
  netProductSales: number | null
  averageSellingPrice: number | null
  netProceedsTotal: number | null
  netProceedsPerUnit: number | null
  feesTotal: number | null
  feesCount: number
  adsTotal: number | null
  adsCount: number
  costOfGoodsSold: number | null
  miscellaneousCost: number | null
  raw: unknown
}

function toDay(v: unknown): Date | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim())
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
}

/**
 * Pure + unit-tested.
 *
 * Rows missing any part of the uniqueness key (date / marketplaceId /
 * childAsin / msku) are DROPPED. msku matters as much as childAsin here:
 * (date, childAsin) alone collides on 896 of 1127 real rows because one ASIN
 * carries several MSKUs, so a row without msku cannot be keyed safely.
 */
export function parseEconomicsRows(items: unknown[]): EconomicsRow[] {
  const out: EconomicsRow[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, any>

    const date = toDay(r.startDate)
    const marketplaceId = typeof r.marketplaceId === 'string' ? r.marketplaceId : ''
    const childAsin = typeof r.childAsin === 'string' ? r.childAsin : ''
    const msku = typeof r.msku === 'string' ? r.msku : ''
    if (!date || !marketplaceId || !childAsin || !msku) continue

    // fees/ads carry no label, so only the total is meaningful. Counts are
    // retained so a future labelled mapping can be reconciled.
    const feesArr: unknown[] = Array.isArray(r.fees) ? r.fees : []
    let feesTotal: number | null = null
    for (const f of feesArr) {
      const amt = money((f as any)?.charge?.aggregatedDetail?.amount)
      if (amt !== null) feesTotal = (feesTotal ?? 0) + amt
    }
    const adsArr: unknown[] = Array.isArray(r.ads) ? r.ads : []
    let adsTotal: number | null = null
    for (const a of adsArr) {
      const amt = money((a as any)?.charge?.amount)
      if (amt !== null) adsTotal = (adsTotal ?? 0) + amt
    }

    const currencyCode =
      (typeof r.sales?.netProductSales?.currencyCode === 'string' && r.sales.netProductSales.currencyCode) ||
      (typeof r.netProceeds?.total?.currencyCode === 'string' && r.netProceeds.total.currencyCode) ||
      'EUR'

    const units = Number(r.sales?.unitsOrdered)

    out.push({
      marketplaceId,
      marketplace: marketplaceCode(marketplaceId),
      date,
      parentAsin: typeof r.parentAsin === 'string' ? r.parentAsin : '',
      childAsin,
      msku,
      currencyCode,
      unitsOrdered: Number.isFinite(units) ? Math.round(units) : 0,
      netProductSales: money(r.sales?.netProductSales),
      averageSellingPrice: money(r.sales?.averageSellingPrice),
      netProceedsTotal: money(r.netProceeds?.total),
      // Null in ~9% of real rows — must not collapse to 0.
      netProceedsPerUnit: money(r.netProceeds?.perUnit),
      feesTotal: feesTotal === null ? null : Math.round(feesTotal * 100) / 100,
      feesCount: feesArr.length,
      adsTotal: adsTotal === null ? null : Math.round(adsTotal * 100) / 100,
      adsCount: adsArr.length,
      costOfGoodsSold: money(r.cost?.costOfGoodsSold),
      miscellaneousCost: money(r.cost?.miscellaneousCost),
      raw: item,
    })
  }
  return out
}

// ── Stage 1: create ──────────────────────────────────────────────────

export interface CreateEconomicsResult {
  jobId: string
  externalQueryId: string
  alreadyExisted?: boolean
}

export async function createEconomicsQuery(args: {
  startDate: string
  endDate: string
  marketplaceId: string
}): Promise<CreateEconomicsResult> {
  const existing = await prisma.dataKioskQueryJob.findFirst({
    where: {
      queryType: DK_QUERY_TYPE_ECONOMICS,
      marketplaceId: args.marketplaceId,
      startDate: new Date(args.startDate),
      endDate: new Date(args.endDate),
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    select: { id: true, externalQueryId: true },
  })
  if (existing) return { jobId: existing.id, externalQueryId: existing.externalQueryId, alreadyExisted: true }

  const query = buildEconomicsQuery({
    startDate: args.startDate,
    endDate: args.endDate,
    marketplaceIds: [args.marketplaceId],
  })
  const sp = await getClient()
  const res = await sp.callAPI({ api_path: '/dataKiosk/2023-11-15/queries', method: 'POST', body: { query } })
  if (!res?.queryId) throw new Error(`[data-kiosk] create returned no queryId: ${JSON.stringify(res).slice(0, 200)}`)

  const job = await prisma.dataKioskQueryJob.create({
    data: {
      queryType: DK_QUERY_TYPE_ECONOMICS,
      marketplaceId: args.marketplaceId,
      startDate: new Date(args.startDate),
      endDate: new Date(args.endDate),
      externalQueryId: String(res.queryId),
      query,
      status: 'IN_PROGRESS',
    },
    select: { id: true },
  })
  logger.info('[data-kiosk] economics query created', { jobId: job.id, queryId: res.queryId, marketplaceId: args.marketplaceId })
  return { jobId: job.id, externalQueryId: String(res.queryId) }
}

// ── Stage 2 + 3: poll, then download+ingest in the same tick ─────────

const DONE = new Set(['DONE'])
const FAILED = new Set(['FATAL', 'CANCELLED'])

export interface DataKioskCycleResult {
  polled: number
  completed: number
  failed: number
  stillRunning: number
  rowsIngested: number
  errors: string[]
}

export async function runDataKioskPollCycle(limit = 10): Promise<DataKioskCycleResult> {
  const result: DataKioskCycleResult = { polled: 0, completed: 0, failed: 0, stillRunning: 0, rowsIngested: 0, errors: [] }
  const sp = await getClient()

  const jobs = await prisma.dataKioskQueryJob.findMany({
    where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
    orderBy: [{ lastPolledAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  })

  for (const job of jobs) {
    result.polled += 1
    try {
      const s = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/queries/${job.externalQueryId}`, method: 'GET' })
      const status = String(s?.processingStatus ?? '').toUpperCase()

      if (FAILED.has(status)) {
        await prisma.dataKioskQueryJob.update({
          where: { id: job.id },
          data: { status: 'FATAL', errorDocumentId: s?.errorDocumentId ?? null, lastPolledAt: new Date(), attempts: { increment: 1 }, errorMessage: `processingStatus=${status}` },
        })
        result.failed += 1
        continue
      }
      if (!DONE.has(status)) {
        await prisma.dataKioskQueryJob.update({
          where: { id: job.id },
          data: { status: 'IN_PROGRESS', lastPolledAt: new Date(), attempts: { increment: 1 } },
        })
        result.stillRunning += 1
        continue
      }

      // DONE — fetch the document and download NOW. The signed URL is minted
      // here with a 300s TTL, so it must be consumed in this same tick.
      await prisma.dataKioskQueryJob.update({
        where: { id: job.id },
        data: { status: 'DONE', dataDocumentId: s?.dataDocumentId ?? null, errorDocumentId: s?.errorDocumentId ?? null, completedAt: new Date(), lastPolledAt: new Date() },
      })
      if (!s?.dataDocumentId) {
        result.completed += 1
        continue
      }
      const ingested = await ingestEconomicsDocument(job.id, String(s.dataDocumentId))
      result.rowsIngested += ingested
      result.completed += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`${job.id}: ${msg.slice(0, 300)}`)
      await prisma.dataKioskQueryJob
        .update({ where: { id: job.id }, data: { lastPolledAt: new Date(), attempts: { increment: 1 }, errorMessage: msg.slice(0, 500) } })
        .catch(() => {})
    }
  }

  return result
}

export async function ingestEconomicsDocument(jobId: string, documentId: string): Promise<number> {
  const sp = await getClient()
  const doc = await sp.callAPI({ api_path: `/dataKiosk/2023-11-15/documents/${documentId}`, method: 'GET' })
  if (!doc?.documentUrl) throw new Error(`[data-kiosk] document ${documentId} has no documentUrl`)

  const res = await fetch(doc.documentUrl)
  if (!res.ok) throw new Error(`[data-kiosk] document download failed ${res.status} (300s URL likely expired)`)
  const buf = Buffer.from(await res.arrayBuffer())
  const rows = parseEconomicsRows(decodeJsonl(buf))

  let upserted = 0
  for (const r of rows) {
    const data = {
      marketplace: r.marketplace,
      parentAsin: r.parentAsin,
      currencyCode: r.currencyCode,
      unitsOrdered: r.unitsOrdered,
      netProductSales: r.netProductSales,
      averageSellingPrice: r.averageSellingPrice,
      netProceedsTotal: r.netProceedsTotal,
      netProceedsPerUnit: r.netProceedsPerUnit,
      feesTotal: r.feesTotal,
      feesCount: r.feesCount,
      adsTotal: r.adsTotal,
      adsCount: r.adsCount,
      costOfGoodsSold: r.costOfGoodsSold,
      miscellaneousCost: r.miscellaneousCost,
      raw: r.raw as object,
      reportedAt: new Date(),
    }
    await prisma.amazonEconomicsDaily.upsert({
      where: {
        marketplaceId_date_childAsin_msku: {
          marketplaceId: r.marketplaceId,
          date: r.date,
          childAsin: r.childAsin,
          msku: r.msku,
        },
      },
      create: { marketplaceId: r.marketplaceId, date: r.date, childAsin: r.childAsin, msku: r.msku, ...data },
      update: data,
    })
    upserted += 1
  }

  await prisma.dataKioskQueryJob.update({ where: { id: jobId }, data: { rowsIngested: upserted } })
  logger.info('[data-kiosk] economics ingested', { jobId, parsed: rows.length, upserted })
  return upserted
}

// ── Cycle driver ─────────────────────────────────────────────────────

/**
 * One query per marketplace. Sequential with spacing: createQuery is limited to
 * roughly 1/min and a rejected query still costs quota, so firing all
 * marketplaces at once would throttle most of them.
 */
export async function runEconomicsCreateCycle(args: {
  startDate: string
  endDate: string
  marketplaceIds?: string[]
}): Promise<{ created: number; skipped: number; errors: string[] }> {
  const out = { created: 0, skipped: 0, errors: [] as string[] }
  const ids = args.marketplaceIds?.length
    ? args.marketplaceIds
    : [process.env.AMAZON_MARKETPLACE_ID].filter((v): v is string => !!v)

  for (const marketplaceId of ids) {
    try {
      const r = await createEconomicsQuery({ startDate: args.startDate, endDate: args.endDate, marketplaceId })
      if (r.alreadyExisted) out.skipped += 1
      else out.created += 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.errors.push(`${marketplaceId}: ${isQuotaError(err) ? 'QUOTA — retry next tick' : msg.slice(0, 300)}`)
    }
    if (ids.length > 1) await new Promise((r) => setTimeout(r, 65_000))
  }
  return out
}
