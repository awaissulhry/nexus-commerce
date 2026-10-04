/**
 * Sheet publish parity, step 4 — uploads from the old Amazon flat file as publish history runs (Owner D1 = A: the old
 * pages still publish, so the history shows them).
 *
 * One run per `AmazonFlatFileFeedJob` (one feed, one market). The job keeps no account and no person, so filters on
 * those return no rows from this source. It keeps the SKUs it sent, so a family filter matches a run that sent any
 * SKU of the family. The feed body is not kept: there is no exact request to show.
 *
 * State, decided in SQL so a filter pages correctly (ok / refused come from the per-SKU report, else its summary):
 *  - in_progress: Amazon is still processing it, for at most 7 days (the product sheet sweep's limit);
 *  - failed: Amazon refused or cancelled the whole upload, or refused every SKU;
 *  - partial: Amazon refused some SKUs;
 *  - succeeded: Amazon accepted every SKU it reported on;
 *  - needs_check: no final answer — still processing after 7 days, or done with no result recorded.
 */
import { Prisma } from '@prisma/client'
import type { HistoryCoverage, HistoryProduct, HistoryProductResult, HistoryRun, HistoryRunDetail, HistoryState, HistoryStep } from '@nexus/shared/publication-history'
import prisma from '../../../db.js'
import { afterCursor, ago, byResult, countRelation, escapeLike, instant, iso, issuesOf, jsonArray, legacyCounts, onlyChecked, productsBySku, record, STALE, statesFilter, text, unanswerable, whole } from './legacy.js'
import { columnHintOf, emptyTotals, publicRunId, type HistoryFilters, type HistoryListInput, type HistorySourceRow, type PublicationHistoryAdapter } from './types.js'

export const AMAZON_FLAT_FILE_RANK = 1

interface ListRow {
  localId: string
  status: string
  marketplace: string
  feedId: string
  skuCount: number
  ok: number
  refused: number
  errorMessage: string | null
  state: HistoryState
  sortAt: number
  completedAt: number | null
  lastPolledAt: number | null
  familyId: string | null
  familySku: string | null
  familyTitle: string | null
}

const PER_SKU = jsonArray(Prisma.sql`j."perSkuResults"`)
const SKUS = jsonArray(Prisma.sql`j.skus`)

/** Accepted and refused SKUs: from the per-SKU report, else from the report summary. */
const OK_SQL = Prisma.sql`CASE WHEN jsonb_array_length(${PER_SKU}) > 0
  THEN (SELECT count(*) FROM jsonb_array_elements(${PER_SKU}) e WHERE e->>'status' IN ('success', 'warning'))::int
  ELSE COALESCE(NULLIF(j."resultSummary"->>'messagesSuccessful', '')::int, 0) END`
const REFUSED_SQL = Prisma.sql`CASE WHEN jsonb_array_length(${PER_SKU}) > 0
  THEN (SELECT count(*) FROM jsonb_array_elements(${PER_SKU}) e WHERE e->>'status' = 'error')::int
  ELSE COALESCE(NULLIF(j."resultSummary"->>'messagesWithError', '')::int, 0) END`

function stateSql(now: Date) {
  return Prisma.sql`CASE
    WHEN b.status IN ('IN_QUEUE', 'IN_PROGRESS') AND b.started > ${ago(now, STALE.amazonFeedMs)} THEN 'in_progress'
    WHEN b.status IN ('IN_QUEUE', 'IN_PROGRESS') THEN 'needs_check'
    WHEN b.status IN ('FATAL', 'CANCELLED') THEN 'failed'
    WHEN b.status = 'DONE' AND b.refused > 0 AND b.ok = 0 THEN 'failed'
    WHEN b.status = 'DONE' AND b.refused > 0 THEN 'partial'
    WHEN b.status = 'DONE' AND b.ok > 0 THEN 'succeeded'
    ELSE 'needs_check'
  END`
}

function matchText(q: string) {
  const pattern = `%${escapeLike(q)}%`
  return Prisma.sql`(
    j.id = ${q} OR j."feedId" ILIKE ${pattern}
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${SKUS}) s(sku) WHERE s.sku ILIKE ${pattern})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${SKUS}) s(sku) JOIN "Product" p ON p.sku = s.sku
                 LEFT JOIN "Product" f ON f.id = p."parentId"
                WHERE p.name ILIKE ${pattern} OR f.name ILIKE ${pattern} OR f.sku ILIKE ${pattern}))`
}

/** No rows at all for these filters (a filter this source cannot answer). */
const answersNothing = (f: HistoryFilters) => unanswerable(f) || onlyChecked(f) || (!!f.channel && f.channel !== 'AMAZON')

/**
 * This source's rows with their state — the one relation the list pages through and the count groups, so the two can
 * never disagree. `onlyId` narrows it to one run (the detail).
 */
function relation(f: HistoryFilters, now: Date, onlyId?: string) {
  const where: Prisma.Sql[] = [onlyId ? Prisma.sql`j.id = ${onlyId}` : Prisma.sql`TRUE`]
  if (f.marketplace) where.push(Prisma.sql`j.marketplace = ${f.marketplace}`)
  if (f.familyId) where.push(Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${SKUS}) s(sku) JOIN "Product" p ON p.sku = s.sku
    WHERE COALESCE(p."parentId", p.id) = ${f.familyId})`)
  if (f.from !== undefined) where.push(Prisma.sql`j."submittedAt" >= ${instant(f.from)}`)
  if (f.to !== undefined) where.push(Prisma.sql`j."submittedAt" <= ${instant(f.to)}`)
  if (f.q) where.push(matchText(f.q))
  return Prisma.sql`
    SELECT b.*, ${stateSql(now)} AS state FROM (
      SELECT j.id AS "localId", j.status, j.marketplace, j."feedId", j."skuCount", j.skus, j."errorMessage",
             ${OK_SQL} AS ok, ${REFUSED_SQL} AS refused, j."submittedAt" AS started,
             round(extract(epoch from j."submittedAt") * 1000)::float8 AS "sortAt",
             round(extract(epoch from j."completedAt") * 1000)::float8 AS "completedAt",
             round(extract(epoch from j."lastPolledAt") * 1000)::float8 AS "lastPolledAt"
        FROM "AmazonFlatFileFeedJob" j
       WHERE ${Prisma.join(where, ' AND ')}
    ) b`
}

/** `onlyId` reads one run by its id (the detail), through the same state and count rules as the list. */
async function listRows(input: HistoryListInput, onlyId?: string): Promise<ListRow[]> {
  const f = input.filters
  if (answersNothing(f)) return []
  return prisma.$queryRaw<ListRow[]>(Prisma.sql`
    SELECT page."localId", page.status, page.marketplace, page."feedId", page."skuCount", page.ok, page.refused, page."errorMessage", page.state,
           page."sortAt", page."completedAt", page."lastPolledAt", fam."familyId", fp.sku AS "familySku", fp.name AS "familyTitle"
      FROM (
        SELECT r.* FROM (${relation(f, input.now, onlyId)}) r
        WHERE TRUE ${statesFilter(f)} ${afterCursor(AMAZON_FLAT_FILE_RANK, input.cursor)}
        ORDER BY r.started DESC, r."localId" COLLATE "C" DESC
        LIMIT ${input.limit}
      ) page
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(DISTINCT COALESCE(p."parentId", p.id)) = 1 THEN min(COALESCE(p."parentId", p.id)) END AS "familyId"
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(page.skus) = 'array' THEN page.skus ELSE '[]'::jsonb END) s(sku)
          JOIN "Product" p ON p.sku = s.sku
      ) fam ON TRUE
      LEFT JOIN "Product" fp ON fp.id = fam."familyId"
     ORDER BY page."sortAt" DESC, page."localId" COLLATE "C" DESC`)
}

function messageOf(row: { state: HistoryState; status: string; ok: number; refused: number; total: number; errorMessage: string | null }): string {
  if (row.state === 'in_progress') return 'Amazon is still processing this upload.'
  if (row.status === 'FATAL') return row.errorMessage ?? 'Amazon refused the whole upload.'
  if (row.status === 'CANCELLED') return 'Amazon cancelled this upload.'
  if (row.state === 'needs_check') return row.errorMessage ?? 'Nexus has no final answer from Amazon. Check the listings on Amazon before you upload again.'
  if (row.refused) return row.ok ? `Amazon refused ${row.refused} of ${row.ok + row.refused}.` : `Amazon refused ${row.refused === 1 ? 'it' : `all ${row.refused}`}.`
  return row.ok === row.total ? `Amazon accepted ${row.ok === 1 ? 'it' : `all ${row.ok}`}.` : `Amazon accepted ${row.ok} of ${row.total}.`
}

function toRow(row: ListRow): HistorySourceRow {
  const total = Math.max(whole(row.skuCount), row.ok + row.refused)
  const run: Omit<HistoryRun, 'userName' | 'checkedBy'> = {
    id: publicRunId('amazon-flat-file', row.localId), source: 'amazon-flat-file', batchId: null,
    startedAt: iso(row.sortAt)!, finishedAt: row.state === 'in_progress' || row.state === 'needs_check' ? null : iso(row.completedAt),
    state: row.state, status: row.status, kind: 'update',
    productId: row.familyId, familySku: row.familySku, familyTitle: row.familyTitle,
    channel: 'AMAZON', marketplace: row.marketplace, accountId: null, accountLabel: null, aliasKey: null, aliasLabel: null,
    fieldCount: null, productCount: total,
    counts: legacyCounts({ total, accepted: row.ok, failed: row.refused, state: row.state }),
    userId: null, reference: row.feedId, message: messageOf({ ...row, total }),
    lastCheckedAt: iso(row.lastPolledAt), needsCheck: row.state === 'needs_check', checkedAt: null,
  }
  return { ...run, sortAt: row.sortAt, localId: row.localId, checkedByUserId: null }
}

function productResult(status: unknown, jobStatus: string, state: HistoryState): HistoryProductResult {
  if (status === 'success' || status === 'warning') return 'ACCEPTED'
  if (status === 'error') return 'FAILED'
  if (jobStatus === 'FATAL' || jobStatus === 'CANCELLED') return 'FAILED'
  return state === 'in_progress' ? 'WAITING' : 'UNKNOWN'
}

async function detail(localId: string, now: Date): Promise<HistoryRunDetail | null> {
  const job = await prisma.amazonFlatFileFeedJob.findFirst({ where: { id: localId } })
  if (!job) return null
  const [row] = await listRows({ filters: {}, cursor: null, limit: 1, now }, job.id)
  if (!row) return null
  const base = toRow(row)
  const { sortAt: _sortAt, localId: _localId, checkedByUserId: _checker, ...rest } = base
  const run: HistoryRun = { ...rest, userName: null, checkedBy: null }

  const reports = Array.isArray(job.perSkuResults) ? job.perSkuResults.map(record) : []
  const sentSkus = Array.isArray(job.skus) ? job.skus.filter((s): s is string => typeof s === 'string') : []
  const skus = [...new Set([...reports.map(r => text(r.sku)).filter((s): s is string => !!s), ...sentSkus])]
  const products = await productsBySku(skus)
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: [...products.values()].map(p => p.productId) }, channel: 'AMAZON', marketplace: job.marketplace },
    select: { id: true, productId: true, externalListingId: true },
  })
  // A product with listings on several Amazon accounts in this market: the job does not say which one it sent to.
  const listingOf = new Map<string, { id: string; externalListingId: string | null } | null>()
  for (const listing of listings) listingOf.set(listing.productId, listingOf.has(listing.productId) ? null : listing)

  const reportOf = new Map(reports.map(r => [text(r.sku) ?? '', r]))
  const entries: HistoryProduct[] = skus.map(sku => {
    const report = reportOf.get(sku)
    const product = products.get(sku)
    const listing = product ? listingOf.get(product.productId) ?? null : null
    const result = productResult(report?.status, job.status, row.state)
    const issues = issuesOf(report?.issues, { code: report?.code, message: report?.message, fields: report?.fields, severity: report?.status === 'error' ? 'error' : 'warning' })
    const message = result === 'FAILED' && !report ? (job.status === 'CANCELLED' ? 'Amazon cancelled this upload.' : job.errorMessage ?? 'Amazon refused the whole upload.')
      : issues.find(issue => issue.severity === 'error')?.message ?? issues[0]?.message ?? null
    return {
      productId: product?.productId ?? null, sku, variationLabel: product?.variationLabel ?? null, result, message,
      code: issues.find(issue => issue.code)?.code ?? null, fieldLabel: issues.find(issue => issue.attributeNames.length)?.attributeNames[0] ?? null, columnKey: null,
      columnHint: columnHintOf(issues), listingId: listing?.id ?? null, externalId: listing?.externalListingId ?? null, sentFields: [], issues,
    }
  })

  const where = `Amazon · ${job.marketplace}`
  const steps: HistoryStep[] = [
    { key: 'sent', label: `Sent to ${where}`, at: run.startedAt, tone: 'info', detail: 'From the old Amazon flat file.' },
    { key: 'received', label: 'Amazon received it', at: null, tone: 'info', detail: `Feed ${job.feedId}` },
  ]
  if (row.state === 'in_progress') steps.push({ key: 'waiting', label: 'Waiting for Amazon', at: null, tone: 'info', detail: 'Nexus looks again by itself.' })
  if (job.status === 'FATAL' || job.status === 'CANCELLED' || (job.status === 'DONE' && row.state !== 'needs_check')) {
    const label = job.status === 'FATAL' ? 'Amazon refused the upload' : job.status === 'CANCELLED' ? 'Amazon cancelled the upload'
      : row.state === 'failed' ? 'Amazon refused it' : row.refused ? `Amazon refused ${row.refused} of ${row.ok + row.refused}` : 'Amazon accepted it'
    steps.push({ key: 'processed', label, at: run.finishedAt, tone: row.state === 'failed' ? 'danger' : row.state === 'partial' ? 'warning' : 'info', detail: run.message })
  }
  if (row.state === 'needs_check') steps.push({ key: 'needs_check', label: 'Needs a check', at: null, tone: 'warning', detail: run.message })

  return {
    run, steps, products: entries.sort(byResult), hasRequest: false,
    rawResponse: { status: job.status, summary: job.resultSummary ?? null, error: job.errorMessage ?? null, results: job.perSkuResults ?? null },
  }
}

async function coverage(): Promise<HistoryCoverage> {
  const [oldest] = await prisma.$queryRaw<Array<{ since: number | null }>>(Prisma.sql`
    SELECT round(extract(epoch from MIN(j."submittedAt")) * 1000)::float8 AS since FROM "AmazonFlatFileFeedJob" j`)
  return { source: 'amazon-flat-file', included: true, since: iso(oldest?.since ?? null), note: null }
}

export const amazonFlatFileHistorySource: PublicationHistoryAdapter = {
  source: 'amazon-flat-file',
  rank: AMAZON_FLAT_FILE_RANK,
  async list(input) {
    return (await listRows(input)).map(toRow)
  },
  async count(input) {
    const f = { ...input.filters, states: undefined, checked: undefined }
    return answersNothing(f) ? emptyTotals() : countRelation(relation(f, input.now), input.doneSince)
  },
  detail,
  coverage,
}
