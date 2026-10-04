/**
 * Sheet publish parity, step 4 — pushes from the old eBay flat file as publish history runs (Owner D1 = A).
 *
 * One run per `EbayPushJob`. A push can cover several markets; each stored result is one SKU in one market. The job
 * keeps no account and no person, so filters on those return no rows from this source. A family filter matches a push
 * whose results name any SKU of the family (a push still running has no results yet, so it cannot match one). The
 * exact request is not kept.
 *
 * Words: the flat file's own result codes never reach a reader. A row the flat file handed to shared stock, and a
 * family's main row whose sizes were pushed one by one, are "skipped" with a plain reason.
 *
 * State, decided in SQL so a filter pages correctly:
 *  - in_progress: running for less than 15 minutes (the flat file itself refuses a second push for that long);
 *  - needs_check: still "running" after that (the push stopped without a result), or a file handed to eBay whose
 *    result nothing reads;
 *  - succeeded / partial / failed: from the job's status.
 */
import { Prisma } from '@prisma/client'
import type { HistoryCoverage, HistoryProduct, HistoryProductResult, HistoryRun, HistoryRunDetail, HistoryState, HistoryStep } from '@nexus/shared/publication-history'
import prisma from '../../../db.js'
import { afterCursor, ago, byResult, countRelation, escapeLike, instant, iso, jsonArray, legacyCounts, onlyChecked, productsBySku, record, STALE, statesFilter, text, unanswerable, whole } from './legacy.js'
import { columnHintOf, emptyTotals, publicRunId, type HistoryFilters, type HistoryListInput, type HistorySourceRow, type PublicationHistoryAdapter } from './types.js'

export const EBAY_FLAT_FILE_RANK = 2

interface ListRow {
  localId: string
  status: string
  mode: string
  taskId: string | null
  markets: unknown
  skuCount: number
  pushedCol: number
  failedCol: number
  results: number
  ok: number
  refused: number
  skipped: number
  errorMessage: string | null
  state: HistoryState
  sortAt: number
  completedAt: number | null
  itemId: string | null
  familyId: string | null
  familySku: string | null
  familyTitle: string | null
}

const RESULTS = jsonArray(Prisma.sql`j."perSkuResults"`)
const MARKETS = jsonArray(Prisma.sql`j.markets`)

function stateSql(now: Date) {
  return Prisma.sql`CASE
    WHEN b.status = 'RUNNING' AND b.started > ${ago(now, STALE.ebayPushMs)} THEN 'in_progress'
    WHEN b.status = 'DONE' THEN 'succeeded'
    WHEN b.status = 'PARTIAL' THEN 'partial'
    WHEN b.status = 'FATAL' THEN 'failed'
    ELSE 'needs_check'
  END`
}

function matchText(q: string) {
  const pattern = `%${escapeLike(q)}%`
  return Prisma.sql`(
    j.id = ${q} OR j."taskId" = ${q}
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'sku' ILIKE ${pattern} OR e->>'itemId' = ${q})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${RESULTS}) e JOIN "Product" p ON p.sku = e->>'sku'
                 LEFT JOIN "Product" f ON f.id = p."parentId"
                WHERE p.name ILIKE ${pattern} OR f.name ILIKE ${pattern} OR f.sku ILIKE ${pattern}))`
}

/** No rows at all for these filters (a filter this source cannot answer). */
const answersNothing = (f: HistoryFilters) => unanswerable(f) || onlyChecked(f) || (!!f.channel && f.channel !== 'EBAY')

/**
 * This source's rows with their state — the one relation the list pages through and the count groups, so the two can
 * never disagree. `onlyId` narrows it to one run (the detail).
 */
function relation(f: HistoryFilters, now: Date, onlyId?: string) {
  const where: Prisma.Sql[] = [onlyId ? Prisma.sql`j.id = ${onlyId}` : Prisma.sql`TRUE`]
  if (f.marketplace) where.push(Prisma.sql`${MARKETS} @> jsonb_build_array(${f.marketplace}::text)`)
  if (f.familyId) where.push(Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${RESULTS}) e JOIN "Product" p ON p.sku = e->>'sku'
    WHERE COALESCE(p."parentId", p.id) = ${f.familyId})`)
  if (f.from !== undefined) where.push(Prisma.sql`j."submittedAt" >= ${instant(f.from)}`)
  if (f.to !== undefined) where.push(Prisma.sql`j."submittedAt" <= ${instant(f.to)}`)
  if (f.q) where.push(matchText(f.q))
  return Prisma.sql`
    SELECT b.*, ${stateSql(now)} AS state FROM (
      SELECT j.id AS "localId", j.status, j.mode, j."taskId", j.markets, j."skuCount", j.pushed AS "pushedCol", j.failed AS "failedCol",
             j."perSkuResults", j."errorMessage", jsonb_array_length(${RESULTS})::int AS results,
             (SELECT count(*) FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'status' = 'PUSHED')::int AS ok,
             (SELECT count(*) FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'status' = 'ERROR')::int AS refused,
             (SELECT count(*) FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'status' NOT IN ('PUSHED', 'ERROR'))::int AS skipped,
             j."submittedAt" AS started,
             round(extract(epoch from j."submittedAt") * 1000)::float8 AS "sortAt",
             round(extract(epoch from j."completedAt") * 1000)::float8 AS "completedAt"
        FROM "EbayPushJob" j
       WHERE ${Prisma.join(where, ' AND ')}
    ) b`
}

/** `onlyId` reads one run by its id (the detail), through the same state and count rules as the list. */
async function listRows(input: HistoryListInput, onlyId?: string): Promise<ListRow[]> {
  const f = input.filters
  if (answersNothing(f)) return []
  return prisma.$queryRaw<ListRow[]>(Prisma.sql`
    SELECT page."localId", page.status, page.mode, page."taskId", page.markets, page."skuCount", page."pushedCol", page."failedCol", page.results,
           page.ok, page.refused, page.skipped, page."errorMessage", page.state, page."sortAt", page."completedAt",
           fam."itemId", fam."familyId", fp.sku AS "familySku", fp.name AS "familyTitle"
      FROM (
        SELECT r.* FROM (${relation(f, input.now, onlyId)}) r
        WHERE TRUE ${statesFilter(f)} ${afterCursor(EBAY_FLAT_FILE_RANK, input.cursor)}
        ORDER BY r.started DESC, r."localId" COLLATE "C" DESC
        LIMIT ${input.limit}
      ) page
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(DISTINCT COALESCE(p."parentId", p.id)) = 1 THEN min(COALESCE(p."parentId", p.id)) END AS "familyId",
               (SELECT CASE WHEN count(DISTINCT e2->>'itemId') = 1 THEN min(e2->>'itemId') END
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(page."perSkuResults") = 'array' THEN page."perSkuResults" ELSE '[]'::jsonb END) e2
                 WHERE COALESCE(e2->>'itemId', '') <> '') AS "itemId"
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(page."perSkuResults") = 'array' THEN page."perSkuResults" ELSE '[]'::jsonb END) e
          LEFT JOIN "Product" p ON p.sku = e->>'sku'
      ) fam ON TRUE
      LEFT JOIN "Product" fp ON fp.id = fam."familyId"
     ORDER BY page."sortAt" DESC, page."localId" COLLATE "C" DESC`)
}

const marketsOf = (value: unknown) => (Array.isArray(value) ? value.filter((m): m is string => typeof m === 'string' && m !== '') : [])

function messageOf(row: ListRow, total: number): string {
  if (row.state === 'in_progress') return 'Still sending to eBay.'
  if (row.status === 'RUNNING') return 'No result was recorded. The push may have stopped. Check the listings on eBay before you push again.'
  if (row.status === 'SUBMITTED') return 'eBay received the file. Nexus does not read its result. Check the listings on eBay.'
  if (row.status === 'FATAL' && !row.results) return row.errorMessage ?? 'The push stopped before anything reached eBay.'
  const sent = row.ok + row.refused
  if (row.refused) return row.ok ? `eBay refused ${row.refused} of ${sent}.` : `eBay refused ${row.refused === 1 ? 'it' : `all ${row.refused}`}.`
  if (!sent) return total ? 'Nothing needed sending: every row followed shared stock or its family.' : 'Nothing was sent.'
  return `eBay accepted ${row.ok === 1 ? 'it' : `all ${row.ok}`}.`
}

function toRow(row: ListRow): HistorySourceRow {
  const markets = marketsOf(row.markets)
  const ok = row.results ? row.ok : whole(row.pushedCol)
  const refused = row.results ? row.refused : whole(row.failedCol)
  const total = row.results || Math.max(whole(row.skuCount), ok + refused)
  const run: Omit<HistoryRun, 'userName' | 'checkedBy'> = {
    id: publicRunId('ebay-flat-file', row.localId), source: 'ebay-flat-file', batchId: null,
    startedAt: iso(row.sortAt)!, finishedAt: row.state === 'in_progress' || row.state === 'needs_check' ? null : iso(row.completedAt),
    state: row.state, status: row.status, kind: 'update',
    productId: row.familyId, familySku: row.familySku, familyTitle: row.familyTitle,
    channel: 'EBAY', marketplace: markets.length ? markets.join(', ') : null, accountId: null, accountLabel: null, aliasKey: null, aliasLabel: null,
    fieldCount: null, productCount: total,
    counts: legacyCounts({ total, accepted: ok, failed: refused, skipped: row.skipped, notSent: row.status === 'FATAL' && !row.results ? total : 0, state: row.state }),
    userId: null, reference: row.taskId ?? row.itemId, message: messageOf(row, total),
    lastCheckedAt: null, needsCheck: row.state === 'needs_check', checkedAt: null,
  }
  return { ...run, sortAt: row.sortAt, localId: row.localId, checkedByUserId: null }
}

function productResult(status: unknown): HistoryProductResult {
  if (status === 'PUSHED') return 'ACCEPTED'
  if (status === 'ERROR') return 'FAILED'
  if (status === 'POOL' || status === 'FAMILY') return 'SKIPPED'
  return 'UNKNOWN'
}

/** The flat file's own words for a row, rewritten for a reader. eBay's refusal text is kept as eBay wrote it. */
function plainMessage(status: unknown, message: string | null): string | null {
  if (status === 'POOL') return 'Not sent on its own: this row follows shared stock, so its price and quantity come from the shared listing.'
  if (status === 'FAMILY') return 'Not sent on its own: this is the main product of a family; its sizes were sent one by one.'
  if (status === 'PUSHED') return !message || /^pushed\b/i.test(message) ? 'Sent to eBay.' : message
  return message
}

async function detail(localId: string, now: Date): Promise<HistoryRunDetail | null> {
  const job = await prisma.ebayPushJob.findFirst({ where: { id: localId } })
  if (!job) return null
  const [row] = await listRows({ filters: {}, cursor: null, limit: 1, now }, job.id)
  if (!row) return null
  const { sortAt: _sortAt, localId: _localId, checkedByUserId: _checker, ...rest } = toRow(row)
  const run: HistoryRun = { ...rest, userName: null, checkedBy: null }

  const results = Array.isArray(job.perSkuResults) ? job.perSkuResults.map(record) : []
  const severalMarkets = new Set(results.map(r => text(r.market))).size > 1
  const products = await productsBySku(results.map(r => text(r.sku) ?? ''))
  const entries: HistoryProduct[] = results.map(r => {
    const sku = text(r.sku) ?? ''
    const product = products.get(sku)
    const market = text(r.market)
    const result = productResult(r.status)
    const variation = [product?.variationLabel, severalMarkets ? market : null].filter(Boolean).join(' · ')
    const issues = result === 'FAILED' && text(r.message) ? [{ code: '', severity: 'error' as const, message: text(r.message)!, attributeNames: [] }] : []
    return {
      productId: product?.productId ?? null, sku, variationLabel: variation || null, result, message: plainMessage(r.status, text(r.message)),
      code: null, fieldLabel: null, columnKey: null, columnHint: columnHintOf(issues), listingId: text(r.listingId), externalId: text(r.itemId), sentFields: [],
      issues,
    }
  })

  const markets = marketsOf(job.markets)
  const where = `eBay${markets.length ? ` · ${markets.join(', ')}` : ''}`
  const steps: HistoryStep[] = [{ key: 'sent', label: `Sent to ${where}`, at: run.startedAt, tone: 'info', detail: 'From the old eBay flat file.' }]
  if (job.taskId) steps.push({ key: 'received', label: 'eBay received the file', at: null, tone: 'info', detail: `Task ${job.taskId}` })
  if (row.state === 'in_progress') steps.push({ key: 'waiting', label: 'Still sending', at: null, tone: 'info', detail: 'The push runs in the background.' })
  if (row.state === 'succeeded' || row.state === 'partial' || row.state === 'failed') {
    const sent = row.ok + row.refused
    const label = row.state === 'failed' ? (row.results ? 'eBay refused it' : 'The push stopped') : row.refused ? `eBay refused ${row.refused} of ${sent}` : 'eBay accepted it'
    steps.push({ key: 'processed', label, at: run.finishedAt, tone: row.state === 'failed' ? 'danger' : row.state === 'partial' ? 'warning' : 'info', detail: run.message })
  }
  if (row.state === 'needs_check') steps.push({ key: 'needs_check', label: 'Needs a check', at: null, tone: 'warning', detail: run.message })

  return {
    run, steps, products: entries.sort(byResult), hasRequest: false,
    rawResponse: { status: job.status, results: job.perSkuResults ?? null, warnings: job.warnings ?? null, error: job.errorMessage ?? null },
  }
}

async function coverage(): Promise<HistoryCoverage> {
  const [oldest] = await prisma.$queryRaw<Array<{ since: number | null }>>(Prisma.sql`
    SELECT round(extract(epoch from MIN(j."submittedAt")) * 1000)::float8 AS since FROM "EbayPushJob" j`)
  return { source: 'ebay-flat-file', included: true, since: iso(oldest?.since ?? null), note: null }
}

export const ebayFlatFileHistorySource: PublicationHistoryAdapter = {
  source: 'ebay-flat-file',
  rank: EBAY_FLAT_FILE_RANK,
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
