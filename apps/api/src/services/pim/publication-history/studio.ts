/**
 * Sheet publish parity, step 4 — product sheet publications as publish history runs.
 *
 * The list reads the BulkOperation COLUMNS (step 1) and the small `summary`, never the `changes` document: that holds
 * the whole change plan and can be large. Three facts exist only inside `changes` (create or update, photos only, the
 * channel reference); they are read as single JSON paths for the rows of the page being returned — at most one page
 * — never for the rows a filter scans. A free-text search for a channel reference is the one exception, documented
 * at `matchText`.
 *
 * A review that was never sent (PREVIEW, expired or not) is not a run and never appears.
 *
 * State, decided in SQL so a filter pages correctly:
 *  - a run still waiting for a result that a person marked checked (D3: `summary.checkedAt`, `completedAt` = the check
 *    time) stays needs_check — Nexus never invents its result — with `checkedAt`/`checkedBy` filled, `needsCheck` false
 *    and no `finishedAt` (the check is not a channel result);
 *  - succeeded / partial / failed: from the status.
 *  - needs_check: the sweep gave up (`summary.needsCheck`), or nothing will look again by itself — no `nextCheckAt`
 *    (a publication from before the sweep, an UNVERIFIED that is not polled) — except a PUBLISHING row still inside
 *    its 30-minute receipt window.
 *  - in_progress: everything still waiting that Nexus will look at again by itself.
 */
import { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import type { HistoryCounts, HistoryCoverage, HistoryProduct, HistoryProductResult, HistoryRun, HistoryRunDetail, HistoryState, HistoryStep } from '@nexus/shared/publication-history'
import type { StudioChannelIssue, StudioPublishChange, StudioPublishResult, StudioPublishReview } from '@nexus/shared/studio-publication'
import prisma from '../../../db.js'
import { CREATE_FIELD } from '../publication-status.service.js'
import { userNames } from './users.js'
import { columnHintOf, kindOf, totalsOf, type HistoryCountInput, type HistoryFilters, type HistoryListInput, type HistorySourceRow,
  type HistorySourceTotals, type PublicationHistoryAdapter } from './types.js'

export const STUDIO_KIND = 'studio-publication'
/** Statuses of a publication that was sent. PREVIEW (and anything else) was never sent. */
export const SENT_STATUSES = ['PUBLISHING', 'SUBMITTED', 'UNVERIFIED', 'ACCEPTED', 'VERIFIED', 'PARTIAL', 'FAILED']
/** Still waiting for the channel's result (the settle core's IN_FLIGHT). */
const WAITING = ['PUBLISHING', 'SUBMITTED', 'UNVERIFIED']
const STUDIO_RANK = 0
/** A PUBLISHING row inside its receipt window (30 minutes + the sweep's minute) is still being sent. */
const RECEIPT_WINDOW_MINUTES = 31

interface ListRow {
  id: string
  status: string
  userId: string | null
  batchId: string | null
  productId: string | null
  channel: string | null
  marketplace: string | null
  accountId: string | null
  aliasKey: string | null
  changeCount: number
  productCount: number
  summary: unknown
  state: HistoryState
  sortAt: number
  completedAt: number | null
  familySku: string | null
  familyTitle: string | null
  accountLabel: string | null
  aliasLabel: string | null
}

interface PageFacts {
  id: string
  action: string | null
  photosOnly: boolean | null
  reference: string | null
}

const iso = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null)
/** An exact UTC instant as the timestamp-without-time-zone the columns store. */
const instant = (ms: number) => Prisma.sql`(${new Date(ms).toISOString()}::timestamptz AT TIME ZONE 'UTC')`
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
const escapeLike = (text: string) => text.replace(/[\\%_]/g, match => `\\${match}`)

const STARTED = Prisma.sql`COALESCE(b."submittedAt", b."createdAt")`
/** A run still waiting for its result that a person marked as checked (D3). Its state is needs_check. */
const CHECKED = Prisma.sql`(b.status IN ('PUBLISHING', 'SUBMITTED', 'UNVERIFIED') AND COALESCE(b.summary->>'checkedAt', '') <> '')`

/** The state CASE (see the file header). `now` is a parameter so the receipt window is testable. */
function stateSql(now: Date) {
  return Prisma.sql`CASE
    WHEN ${CHECKED} THEN 'needs_check'
    WHEN b.status IN ('ACCEPTED', 'VERIFIED') THEN 'succeeded'
    WHEN b.status = 'PARTIAL' THEN 'partial'
    WHEN b.status = 'FAILED' THEN 'failed'
    WHEN COALESCE(b.summary->>'needsCheck', '') = 'true' THEN 'needs_check'
    WHEN b."nextCheckAt" IS NOT NULL THEN 'in_progress'
    WHEN b.status = 'PUBLISHING' AND ${STARTED} > ${instant(now.getTime())} - ${Prisma.raw(`interval '${RECEIPT_WINDOW_MINUTES} minutes'`)} THEN 'in_progress'
    ELSE 'needs_check'
  END`
}

/**
 * Free text: the family's SKU or title, any family member's SKU, the publication id, or a channel reference. The
 * reference lives only in the stored result, so that one branch reads a JSON path of the rows the cheaper branches
 * did not already match; a search is a person typing, not a page load.
 */
function matchText(q: string) {
  const pattern = `%${escapeLike(q)}%`
  return Prisma.sql`(
    p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern} OR b.id = ${q}
    OR EXISTS (SELECT 1 FROM "Product" c WHERE c."parentId" = b."productId" AND c.sku ILIKE ${pattern})
    OR (jsonb_typeof(b.changes->'result'->'results') = 'array'
        AND b.changes->'result'->'results' @> jsonb_build_array(jsonb_build_object('reference', ${q}::text))))`
}

/** Strictly after the cursor in the global order (sortAt DESC, rank ASC, id DESC) — for this source's fixed rank. */
function afterCursor(cursor: HistoryListInput['cursor']) {
  if (!cursor) return Prisma.empty
  const at = instant(cursor.at)
  if (STUDIO_RANK > cursor.rank) return Prisma.sql`AND r.started <= ${at}`
  if (STUDIO_RANK < cursor.rank) return Prisma.sql`AND r.started < ${at}`
  return Prisma.sql`AND (r.started < ${at} OR (r.started = ${at} AND r.id COLLATE "C" < ${cursor.id} COLLATE "C"))`
}

export function countsOf(status: string, summary: unknown, productCount: number): HistoryCounts {
  const s = record(summary)
  const counts: HistoryCounts = { accepted: count(s.accepted), verified: count(s.verified), failed: count(s.failed), waiting: count(s.submitted),
    notSent: 0, skipped: 0, unknown: 0 }
  const rest = Math.max(0, count(productCount) - counts.accepted - counts.verified - counts.failed - counts.waiting)
  if (status === 'FAILED' && counts.accepted + counts.verified + counts.failed + counts.waiting === 0) counts.notSent = rest
  else if (status === 'PUBLISHING') counts.waiting += rest
  else counts.unknown = rest
  return counts
}

function toRow(row: ListRow, facts: PageFacts | undefined): HistorySourceRow {
  const summary = record(row.summary)
  const checkedAt = typeof summary.checkedAt === 'string' && summary.checkedAt ? summary.checkedAt : null
  // A check closes a waiting run (`completedAt` = when it was checked) but is not the channel's result.
  const checkedWhileWaiting = !!checkedAt && WAITING.includes(row.status)
  const kind = facts?.photosOnly ? 'photos' : kindOf(facts?.action, 'update')
  const run: Omit<HistoryRun, 'userName' | 'checkedBy'> = {
    id: row.id, source: 'studio', batchId: row.batchId, startedAt: iso(row.sortAt)!, finishedAt: checkedWhileWaiting ? null : iso(row.completedAt),
    state: row.state, status: row.status,
    kind, productId: row.productId, familySku: row.familySku, familyTitle: row.familyTitle,
    channel: row.channel ?? '', marketplace: row.marketplace, accountId: row.accountId, accountLabel: row.accountLabel,
    aliasKey: row.aliasKey, aliasLabel: row.aliasKey ? row.aliasLabel ?? 'Other listing' : null,
    fieldCount: row.changeCount > 0 ? row.changeCount : null, productCount: row.productCount,
    counts: countsOf(row.status, row.summary, row.productCount), userId: row.userId,
    reference: facts?.reference ?? null, message: typeof summary.message === 'string' && summary.message ? summary.message : null,
    lastCheckedAt: typeof summary.lastCheckedAt === 'string' ? summary.lastCheckedAt : null,
    needsCheck: row.state === 'needs_check' && !checkedAt, checkedAt,
  }
  return { ...run, sortAt: row.sortAt, localId: row.id, checkedByUserId: checkedAt && typeof summary.checkedBy === 'string' ? summary.checkedBy : null }
}

const SELECT_ROWS = (now: Date) => Prisma.sql`
  SELECT b.id, b.status, b."userId", b."batchId", b."productId", b.channel, b.marketplace, b."channelConnectionId" AS "accountId", b."aliasKey",
         b."changeCount", b."productCount", b.summary, ${stateSql(now)} AS state, ${STARTED} AS started,
         round(extract(epoch from ${STARTED}) * 1000)::float8 AS "sortAt",
         round(extract(epoch from b."completedAt") * 1000)::float8 AS "completedAt",
         p.sku AS "familySku", p.name AS "familyTitle",
         COALESCE(NULLIF(cc."accountLabel", ''), NULLIF(cc."displayName", '')) AS "accountLabel",
         a.label AS "aliasLabel"
    FROM "BulkOperation" b
    LEFT JOIN "Product" p ON p.id = b."productId"
    LEFT JOIN "ChannelConnection" cc ON cc.id = b."channelConnectionId"
    LEFT JOIN "ProductListingAlias" a ON b."aliasKey" <> '' AND a.id = b."aliasKey"`

/**
 * The row conditions every read shares (list and count), on `b` and — for free text — `p` (the family product). The
 * filters a count ignores (`states`) are applied by the list on top; `checked` is a row condition here.
 */
function studioWhere(f: HistoryFilters): Prisma.Sql[] {
  const where: Prisma.Sql[] = [Prisma.sql`b.kind = ${STUDIO_KIND}`, Prisma.sql`b.status IN (${Prisma.join(SENT_STATUSES)})`]
  if (f.channel) where.push(Prisma.sql`b.channel = ${f.channel}`)
  if (f.marketplace) where.push(Prisma.sql`b.marketplace = ${f.marketplace}`)
  if (f.accountId) where.push(Prisma.sql`b."channelConnectionId" = ${f.accountId}`)
  if (f.familyId) where.push(Prisma.sql`b."productId" = ${f.familyId}`)
  if (f.userId) where.push(Prisma.sql`b."userId" = ${f.userId}`)
  if (f.from !== undefined) where.push(Prisma.sql`${STARTED} >= ${instant(f.from)}`)
  if (f.to !== undefined) where.push(Prisma.sql`${STARTED} <= ${instant(f.to)}`)
  if (f.checked === true) where.push(CHECKED)
  if (f.checked === false) where.push(Prisma.sql`NOT ${CHECKED}`)
  if (f.q) where.push(matchText(f.q))
  return where
}

async function listRows(input: HistoryListInput): Promise<ListRow[]> {
  const f = input.filters
  const states = f.states?.length ? Prisma.sql`AND r.state IN (${Prisma.join(f.states)})` : Prisma.empty
  return prisma.$queryRaw<ListRow[]>(Prisma.sql`
    SELECT r.* FROM (${SELECT_ROWS(input.now)} WHERE ${Prisma.join(studioWhere(f), ' AND ')}) r
     WHERE TRUE ${states} ${afterCursor(input.cursor)}
     ORDER BY r.started DESC, r.id COLLATE "C" DESC
     LIMIT ${input.limit}`)
}

/**
 * Exact counts over the rows `listRows` would return for the same filters (every state, no cursor). It reads only
 * BulkOperation columns (the list's indexed `kind` / `productId` / `channel`…); the family product is joined only for a
 * free-text search, which matches on it.
 */
export async function countStudioRuns(input: HistoryCountInput): Promise<HistorySourceTotals> {
  const f = { ...input.filters, states: undefined, checked: undefined }
  const family = f.q ? Prisma.sql`LEFT JOIN "Product" p ON p.id = b."productId"` : Prisma.empty
  const rows = await prisma.$queryRaw<Array<{ state: string; n: number; checked: number; done: number }>>(Prisma.sql`
    SELECT r.state, count(*)::int AS n, count(*) FILTER (WHERE r.checked)::int AS checked,
           count(*) FILTER (WHERE r.state IN ('succeeded', 'partial', 'failed') AND r.started >= ${instant(input.doneSince)})::int AS done
      FROM (SELECT ${stateSql(input.now)} AS state, ${STARTED} AS started, ${CHECKED} AS checked
              FROM "BulkOperation" b ${family}
             WHERE ${Prisma.join(studioWhere(f), ' AND ')}) r
     GROUP BY r.state`)
  return totalsOf(rows)
}

/** Create-or-update, photos-only and the channel reference — JSON paths of the page's rows only. */
async function pageFacts(ids: string[]): Promise<Map<string, PageFacts>> {
  if (!ids.length) return new Map()
  const rows = await prisma.$queryRaw<PageFacts[]>(Prisma.sql`
    SELECT b.id, b.changes->'review'->>'action' AS action, (b.changes->'review'->>'photosOnly') = 'true' AS "photosOnly",
           (SELECT r->>'reference' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.changes->'result'->'results') = 'array'
              THEN b.changes->'result'->'results' ELSE '[]'::jsonb END) r
             WHERE COALESCE(r->>'reference', '') <> '' LIMIT 1) AS reference
      FROM "BulkOperation" b WHERE b.id IN (${Prisma.join(ids)})`)
  return new Map(rows.map(row => [row.id, row]))
}

interface JournalRow {
  listingId: string
  productId: string | null
  sku: string | null
  fields: unknown
  created: boolean
}

const RESULT_ORDER: HistoryProductResult[] = ['FAILED', 'NOT_SENT', 'UNKNOWN', 'WAITING', 'ACCEPTED', 'VERIFIED', 'SKIPPED']

function productResult(entryStatus: unknown, runStatus: string, sentNothing: boolean, delivered: boolean): HistoryProductResult {
  if (entryStatus === 'VERIFIED' || entryStatus === 'ACCEPTED' || entryStatus === 'FAILED') return entryStatus
  if (entryStatus === 'SUBMITTED') return 'WAITING'
  if (!delivered) return 'SKIPPED'
  if (runStatus === 'FAILED' && sentNothing) return 'NOT_SENT'
  if (runStatus === 'PUBLISHING' || runStatus === 'SUBMITTED') return 'WAITING'
  return 'UNKNOWN'
}

function channelIssues(raw: unknown): StudioChannelIssue[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const issue = record(item)
    if (typeof issue.message !== 'string') return []
    return [{ code: typeof issue.code === 'string' ? issue.code : '', severity: issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : 'info',
      message: issue.message, attributeNames: Array.isArray(issue.attributeNames) ? issue.attributeNames.filter((n): n is string => typeof n === 'string') : [] }]
  })
}

export function variationLabel(attributes: unknown): string | null {
  const values = Object.values(record(attributes)).map(value => (value === null || value === undefined ? '' : String(value).trim())).filter(Boolean)
  return values.length ? values.join(' · ') : null
}

function stepsOf(run: Omit<HistoryRun, 'userName' | 'checkedBy'>, input: { createdAt: Date; result: StudioPublishResult | null; checkedByName: string | null; checkedNote: string | null }): HistoryStep[] {
  const where = `${channelLabel(run.channel)}${run.marketplace ? ` · ${run.marketplace}` : ''}`
  const steps: HistoryStep[] = [{ key: 'reviewed', label: 'Reviewed', at: input.createdAt.toISOString(), tone: 'neutral',
    detail: `${run.productCount} ${run.productCount === 1 ? 'product' : 'products'}${run.fieldCount ? ` · ${run.fieldCount} ${run.fieldCount === 1 ? 'field' : 'fields'} chosen` : ''}` }]
  const sentNothing = run.status === 'FAILED' && !(input.result?.results?.length)
  if (sentNothing) {
    steps.push({ key: 'not_sent', label: 'Not sent', at: run.startedAt, tone: 'danger', detail: run.message ?? 'A check failed before sending. Nothing changed on the channel.' })
  } else {
    steps.push({ key: 'sent', label: `Sent to ${where}`, at: run.startedAt, tone: 'info', detail: null })
    if (run.reference) steps.push({ key: 'received', label: `${channelLabel(run.channel)} received it`, at: null, tone: 'info', detail: `Reference ${run.reference}` })
    if (run.status === 'PUBLISHING' || run.status === 'SUBMITTED') {
      steps.push({ key: 'waiting', label: `Waiting for ${channelLabel(run.channel)}`, at: null, tone: 'info', detail: run.state === 'in_progress' ? 'Nexus looks again by itself.' : null })
    }
    if (run.status === 'ACCEPTED' || run.status === 'VERIFIED' || run.status === 'PARTIAL' || run.status === 'FAILED') {
      const failed = run.counts.failed
      const label = run.status === 'FAILED' ? `${channelLabel(run.channel)} refused it`
        : failed ? `${channelLabel(run.channel)} refused ${failed} of ${run.productCount}` : `${channelLabel(run.channel)} accepted it`
      steps.push({ key: 'processed', label, at: run.finishedAt, tone: run.status === 'FAILED' ? 'danger' : failed ? 'warning' : 'info', detail: run.message })
    }
    if (run.status === 'VERIFIED') steps.push({ key: 'verified', label: 'Verified', at: run.finishedAt, tone: 'success', detail: 'Nexus read the listing back.' })
    if (run.status === 'UNVERIFIED') steps.push({ key: 'unknown', label: 'Result unknown', at: null, tone: 'warning', detail: run.message })
  }
  if (run.needsCheck) steps.push({ key: 'needs_check', label: 'Needs a check', at: null, tone: 'warning',
    detail: 'Nexus will not look again by itself. Check the listing on the channel before you publish again.' })
  if (run.checkedAt) steps.push({ key: 'checked', label: input.checkedByName ? `Marked as checked by ${input.checkedByName}` : 'Marked as checked', at: run.checkedAt, tone: 'neutral',
    detail: input.checkedNote })
  return steps
}

async function detail(localId: string, now: Date): Promise<HistoryRunDetail | null> {
  const [row] = await prisma.$queryRaw<ListRow[]>(Prisma.sql`${SELECT_ROWS(now)}
    WHERE b.id = ${localId} AND b.kind = ${STUDIO_KIND} AND b.status IN (${Prisma.join(SENT_STATUSES)})`)
  if (!row) return null
  const operation = await prisma.bulkOperation.findUnique({ where: { id: localId }, select: { changes: true, createdAt: true } })
  if (!operation) return null
  const changes = record(operation.changes)
  const review = record(changes.review) as Partial<StudioPublishReview>
  const result = changes.result && typeof changes.result === 'object' ? changes.result as StudioPublishResult : null
  const selection = record(changes.selection)
  const selected = new Set(Array.isArray(selection.selectedIds) ? selection.selectedIds.filter((id): id is string => typeof id === 'string') : [])
  const delivery = record(changes.delivery)
  const deliveredIds = Array.isArray(delivery.productIds) ? new Set(delivery.productIds.filter((id): id is string => typeof id === 'string')) : null
  const reference = result?.results?.find(entry => typeof entry?.reference === 'string' && entry.reference)?.reference ?? null
  const base = toRow(row, { id: row.id, action: typeof review.action === 'string' ? review.action : null, photosOnly: review.photosOnly === true, reference })

  const journals = await prisma.$queryRaw<JournalRow[]>(Prisma.sql`
    SELECT s."channelListingId" AS "listingId", s.payload->>'productId' AS "productId", s.payload->>'sku' AS sku,
           jsonb_path_query_array(s.payload, '$.requests[*].writes[*].field') AS fields,
           jsonb_path_exists(s.payload, '$.requests[*] ? (@.intentVersion == 1 && (@.message.operationType == "UPDATE" || @.operation == "AddFixedPriceItem"))') AS created
      FROM "ChannelListingSnapshot" s
     WHERE s."publishEventId" = ${localId} AND s.reason = 'publish' AND s.payload->>'kind' = ${STUDIO_KIND}`)
  const journalOf = new Map(journals.filter(j => j.productId).map(j => [j.productId!, j]))

  const rows = Array.isArray(review.rows) ? review.rows : []
  const skipped = Array.isArray(review.skipped) ? review.skipped : []
  const productIds = [...new Set([...rows.map(r => r.productId), ...skipped.map(s => s.productId), ...journals.map(j => j.productId).filter((id): id is string => !!id)])]
  const [products, listings] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, parentId: true, variantAttributes: true } }),
    prisma.channelListing.findMany({ where: { id: { in: journals.map(j => j.listingId) } }, select: { id: true, externalListingId: true } }),
  ])
  const productOf = new Map(products.map(p => [p.id, p] as const))
  const externalOf = new Map(listings.map(l => [l.id, l.externalListingId] as const))
  // A product the journal does not name (a publication sent before the journal kept listings, or one never delivered):
  // its listing on the run's exact destination, when the run records that destination.
  const unjournaled = productIds.filter(id => !journalOf.has(id))
  const coordinate = row.channel && row.marketplace && row.accountId && row.aliasKey !== null
  const byCoordinate = unjournaled.length && coordinate
    ? await prisma.channelListing.findMany({
      where: { productId: { in: unjournaled }, channel: row.channel!, marketplace: row.marketplace!, channelConnectionId: row.accountId!, aliasKey: row.aliasKey! },
      select: { id: true, productId: true, externalListingId: true },
    })
    : []
  const listingByProduct = new Map(byCoordinate.map(l => [l.productId, l] as const))
  const reviewChanges = Array.isArray(review.changes) ? review.changes as StudioPublishChange[] : []
  const sentNothing = row.status === 'FAILED' && !(result?.results?.length)

  const entries = new Map<string, HistoryProduct>()
  const add = (productId: string, fallbackSku: string, skippedReason?: string) => {
    if (entries.has(productId)) return
    const journal = journalOf.get(productId)
    const sku = journal?.sku ?? fallbackSku
    const matches = result?.results?.filter(entry => entry?.sku === sku) ?? []
    const entry = matches.length === 1 ? matches[0] : undefined
    const delivered = skippedReason ? false : deliveredIds ? deliveredIds.has(productId) : true
    const issues = channelIssues(entry?.issues)
    const product = productOf.get(productId)
    const sentFields = journal ? (journal.created ? [CREATE_FIELD]
      : [...new Set((Array.isArray(journal.fields) ? journal.fields : []).filter((f): f is string => typeof f === 'string' && f.trim() !== ''))]) : []
    const chosen = selected.size ? reviewChanges.filter(change => change.productId === productId && selected.has(change.id)) : []
    entries.set(productId, {
      productId, sku, variationLabel: product?.parentId ? variationLabel(product.variantAttributes) : null,
      result: productResult(entry?.status, row.status, sentNothing, delivered),
      message: skippedReason ?? (typeof entry?.message === 'string' && entry.message ? entry.message : null),
      code: issues.find(issue => issue.code)?.code ?? null,
      fieldLabel: issues.find(issue => issue.attributeNames.length)?.attributeNames[0] ?? null, columnKey: null, columnHint: columnHintOf(issues),
      listingId: journal?.listingId ?? listingByProduct.get(productId)?.id ?? null,
      externalId: journal ? externalOf.get(journal.listingId) ?? null : listingByProduct.get(productId)?.externalListingId ?? null,
      sentFields, issues, ...(chosen.length ? { changes: chosen } : {}),
    })
  }
  for (const r of rows) add(r.productId, r.sku)
  for (const s of skipped) add(s.productId, s.sku, s.reason)
  for (const j of journals) if (j.productId) add(j.productId, j.sku ?? productOf.get(j.productId)?.sku ?? '')
  const ordered = [...entries.values()].sort((a, b) => RESULT_ORDER.indexOf(a.result) - RESULT_ORDER.indexOf(b.result) || a.sku.localeCompare(b.sku))

  const summary = record(row.summary)
  const checkedByUserId = base.checkedByUserId
  const names = await userNames([row.userId, checkedByUserId])
  const { sortAt: _sortAt, localId: _localId, checkedByUserId: _checker, ...rest } = base
  const run: HistoryRun = { ...rest, userName: row.userId ? names.get(row.userId) ?? null : null, checkedBy: checkedByUserId ? names.get(checkedByUserId) ?? null : null }
  return {
    run,
    steps: stepsOf(rest, { createdAt: operation.createdAt, result, checkedByName: run.checkedBy, checkedNote: typeof summary.checkedNote === 'string' ? summary.checkedNote : null }),
    products: ordered,
    hasRequest: journals.length > 0,
    rawResponse: result,
  }
}

async function request(localId: string, listingId: string): Promise<{ sku: string; requests: unknown[] } | null> {
  const snapshot = await prisma.channelListingSnapshot.findFirst({
    where: { publishEventId: localId, channelListingId: listingId, reason: 'publish', payload: { path: ['kind'], equals: STUDIO_KIND } },
    select: { payload: true },
  })
  if (!snapshot) return null
  const payload = record(snapshot.payload)
  return { sku: typeof payload.sku === 'string' ? payload.sku : '', requests: Array.isArray(payload.requests) ? payload.requests : [] }
}

async function coverage(): Promise<HistoryCoverage> {
  const [oldest] = await prisma.$queryRaw<Array<{ since: number | null }>>(Prisma.sql`
    SELECT round(extract(epoch from MIN(${STARTED})) * 1000)::float8 AS since
      FROM "BulkOperation" b WHERE b.kind = ${STUDIO_KIND} AND b.status IN (${Prisma.join(SENT_STATUSES)})`)
  return { source: 'studio', included: true, since: iso(oldest?.since ?? null), note: null }
}

export const studioHistorySource: PublicationHistoryAdapter = {
  source: 'studio',
  rank: STUDIO_RANK,
  async list(input) {
    const rows = await listRows(input)
    const facts = await pageFacts(rows.map(row => row.id))
    return rows.map(row => toRow(row, facts.get(row.id)))
  },
  count: countStudioRuns,
  detail,
  request,
  coverage,
}
