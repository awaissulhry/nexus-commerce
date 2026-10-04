/**
 * Build shape v2 (P7) — selling changes as publish history runs: Pause offer, Resume offer, End listing, Relist and
 * Delete listing, as THE listing-action engine runs them (apps/api/src/services/listings/listing-action.service.ts: one
 * BulkOperation of kind `listing-action` per family × destination; its per-row result in `changes.result`, its counts in
 * `summary`, an audit record per row in `ChannelListingSnapshot`).
 *
 * Two kinds of run:
 *  - a selling change on its own (the Matrix, Claude's close-listing / reopen-listing, a direct run): one run, id
 *    `listing-action:<id>`, `kind` = its action;
 *  - one Publish with selling changes — a publication batch whose parts (content publications and selling changes)
 *    share `batchId`: ONE run, id `listing-action:batch:<batchId>`, `kinds` = every part's kind in send order. Its
 *    content parts are not runs of the product sheet source (`FOLDED`, ./studio.ts); the detail lists every part
 *    (`children`), and each part can still be opened by its own id.
 *
 * Filters: a Publish is listed when at least one of its sent parts matches them (`match`), and then reads as the whole
 * Publish — its state and counts are every sent part's. The list and the count read the SAME relation (`unitsSql`), so
 * every count equals the length of the list its tile opens.
 *
 * State of a selling change: DONE succeeded · PARTIAL partial · FAILED failed · NOT_SENT failed, unless every row was
 * already as asked (then succeeded: nothing had to change) · UNKNOWN needs_check · RUNNING in progress for 30 minutes
 * (the engine runs inside one request or one batch step), then needs_check. State of a Publish: in progress while a part
 * is, or while its batch is still sending; else needs_check when a part needs a check; else succeeded or failed when
 * every part did; else partial. A Publish whose every part that needs a check was marked checked (D3) is `checked`.
 *
 * The list reads columns, `summary`, and — for the parts of the page's runs only — single JSON paths of `changes` (the
 * action; a content part's create / photos / Full update facts). The "What" filter reads those paths for the parts it
 * scans: a person choosing a filter, not a page load.
 */
import { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import { HISTORY_SEND_ORDER, kindsOfWhat, type HistoryCounts, type HistoryCoverage, type HistoryKind, type HistoryProduct, type HistoryProductResult,
  type HistoryRun, type HistoryRunDetail, type HistoryState, type HistoryStep } from '@nexus/shared/publication-history'
import prisma from '../../../db.js'
import { afterCursor, byResult, escapeLike, instant, iso, record, whole } from './legacy.js'
import { CHECKED, FOLDED, SELLING_KIND, SENT_STATUSES, STARTED, STUDIO_KIND, countsOf, stateSql, studioHistorySource, studioKindOf, studioRowsByIds,
  variationLabel } from './studio.js'
import { variationBag } from '../shared-variation-values.js'
import { userNames } from './users.js'
import { kindOf, totalsOf, type HistoryCountInput, type HistoryFilters, type HistoryListInput, type HistorySourceRow, type HistorySourceTotals,
  type PublicationHistoryAdapter } from './types.js'

/** After the product sheet (0) and the older sources (1–3) at an equal timestamp. */
export const LISTING_ACTION_RANK = 4
/** Statuses of a selling change that was sent (claimed). PREVIEW was never sent; CANCELLED never will be. */
export const SELLING_SENT = ['RUNNING', 'DONE', 'PARTIAL', 'FAILED', 'NOT_SENT', 'UNKNOWN']
/** A selling change still RUNNING this long after it was made stopped without a result. */
const RUNNING_WINDOW = Prisma.raw(`interval '30 minutes'`)
/** A batch header still sending its parts (publication-batch.processor.ts `BATCH_PHASES`). */
const BATCH_SENDING = ['QUEUED', 'RUNNING', 'CANCELLING']
const BATCH_PREFIX = 'batch:'
/** Parts whose products a Publish's detail lists (a many-family Publish has up to 1,000 parts: then open each one). */
const PARTS_IN_DETAIL = 25

/** A selling change's state (see the file header). */
function sellingStateSql(now: Date) {
  return Prisma.sql`CASE
    WHEN b.status = 'DONE' THEN 'succeeded'
    WHEN b.status = 'PARTIAL' THEN 'partial'
    WHEN b.status = 'FAILED' THEN 'failed'
    WHEN b.status = 'NOT_SENT' AND COALESCE(b.summary->>'notSent', '0') IN ('0', 'false') AND COALESCE(b.summary->>'skipped', '0') NOT IN ('0', 'false') THEN 'succeeded'
    WHEN b.status = 'NOT_SENT' THEN 'failed'
    WHEN b.status = 'RUNNING' AND ${STARTED} > ${instant(now.getTime())} - ${RUNNING_WINDOW} THEN 'in_progress'
    ELSE 'needs_check'
  END`
}

/** A part's kind: a selling change's action, or a content publication's (photos, create, Full update, update). */
const PART_KIND = Prisma.sql`CASE WHEN b.kind = ${SELLING_KIND} THEN b.changes->>'action'
    WHEN COALESCE(b.changes->'review'->>'photosOnly', '') = 'true' THEN 'photos'
    WHEN b.changes->'review'->>'action' = 'create' THEN 'create'
    WHEN jsonb_typeof(b.changes->'fullProductIds') = 'array' AND jsonb_array_length(b.changes->'fullProductIds') > 0 THEN 'full_update'
    ELSE 'update' END`

/** Every sent part: selling changes, and the content publications of a Publish with selling changes. */
const SENT_PART = Prisma.sql`((b.kind = ${SELLING_KIND} AND b.status IN (${Prisma.join(SELLING_SENT)}))
    OR (b.kind = ${STUDIO_KIND} AND b.status IN (${Prisma.join(SENT_STATUSES)}) AND ${FOLDED}))`

/** The part conditions of the filters (the unit's time, state and check are decided on the unit). TRUE = no filter. */
function matchSql(f: HistoryFilters): Prisma.Sql {
  const on: Prisma.Sql[] = []
  if (f.channel) on.push(Prisma.sql`b.channel = ${f.channel}`)
  if (f.marketplace) on.push(Prisma.sql`b.marketplace = ${f.marketplace}`)
  if (f.accountId) on.push(Prisma.sql`b."channelConnectionId" = ${f.accountId}`)
  if (f.familyId) on.push(Prisma.sql`b."productId" = ${f.familyId}`)
  if (f.userId) on.push(Prisma.sql`b."userId" = ${f.userId}`)
  if (f.what?.length) on.push(Prisma.sql`(${PART_KIND}) IN (${Prisma.join(kindsOfWhat(f.what))})`)
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`
    on.push(Prisma.sql`(b.id = ${f.q} OR b."batchId" = ${f.q} OR fp.sku ILIKE ${pattern} OR fp.name ILIKE ${pattern}
      OR EXISTS (SELECT 1 FROM "Product" c WHERE c."parentId" = b."productId" AND c.sku ILIKE ${pattern}))`)
  }
  return on.length ? Prisma.join(on, ' AND ') : Prisma.sql`TRUE`
}

interface UnitScope {
  /** Only this part (opened by its own id: a selling change, alone or inside a Publish, reads as a run of its own). */
  id?: string
  /** Only the parts of this Publish. */
  batchId?: string
  /** Every selling part reads as a run of its own (a Publish's `children`), none is grouped. */
  partsAsRuns?: boolean
}

/**
 * THE unit relation (list, count and detail): one row per run, with `localId`, `started`, `state`, `checked` and the
 * columns a run shows. Parts (`p`) → units (`r`).
 */
function unitsSql(f: HistoryFilters, now: Date, scope: UnitScope = {}) {
  const only = scope.id ? Prisma.sql`AND b.id = ${scope.id}` : scope.batchId ? Prisma.sql`AND b."batchId" = ${scope.batchId}` : Prisma.empty
  const asRuns = !!(scope.partsAsRuns || scope.id)
  const time: Prisma.Sql[] = []
  if (f.from !== undefined) time.push(Prisma.sql`u.started >= ${instant(f.from)}`)
  if (f.to !== undefined) time.push(Prisma.sql`u.started <= ${instant(f.to)}`)
  const timed = time.length ? Prisma.sql`WHERE ${Prisma.join(time, ' AND ')}` : Prisma.empty
  return Prisma.sql`
    WITH parts AS (
      SELECT b.id, b.kind, b."batchId", b.status, b."userId", b."productId", b.channel, b.marketplace, b."channelConnectionId" AS "accountId", b."aliasKey",
             b."changeCount", b."createdAt", b."completedAt", ${STARTED} AS started,
             CASE WHEN b.kind = ${SELLING_KIND} THEN ${sellingStateSql(now)} ELSE ${stateSql(now)} END AS state,
             (b.kind = ${STUDIO_KIND} AND ${CHECKED}) AS checked,
             CASE WHEN b.kind = ${STUDIO_KIND} AND ${CHECKED} THEN b.summary->>'checkedAt' END AS "checkedAt",
             CASE WHEN b.kind = ${STUDIO_KIND} AND ${CHECKED} THEN b.summary->>'checkedBy' END AS "checkedBy",
             COALESCE(b.summary->>'message', '') AS message,
             (${matchSql(f)}) AS match
        FROM "BulkOperation" b
        ${f.q ? Prisma.sql`LEFT JOIN "Product" fp ON fp.id = b."productId"` : Prisma.empty}
       WHERE ${SENT_PART} ${only}
    ),
    groups AS (
      SELECT p."batchId",
             min(p.started) AS started,
             max(p."completedAt") AS "completedAt",
             bool_or(p.state = 'in_progress') OR COALESCE(bool_or(h.status IN (${Prisma.join(BATCH_SENDING)})), FALSE) AS sending,
             bool_or(p.state = 'needs_check') AS "needsCheck",
             bool_and(p.state = 'succeeded') AS succeeded,
             bool_and(p.state = 'failed') AS failed,
             COALESCE(bool_and(p.checked) FILTER (WHERE p.state = 'needs_check'), FALSE) AS "allChecked",
             max(p."checkedAt") FILTER (WHERE p.checked) AS "checkedAt",
             (array_agg(p."checkedBy" ORDER BY p."checkedAt" DESC) FILTER (WHERE p.checked))[1] AS "checkedBy",
             COALESCE(min(h."userId"), min(p."userId")) AS "userId",
             CASE WHEN count(DISTINCT p."productId") = 1 THEN min(p."productId") END AS "productId",
             CASE WHEN count(DISTINCT p.channel) = 1 THEN min(p.channel) END AS channel,
             CASE WHEN count(DISTINCT p.marketplace) = 1 THEN min(p.marketplace) END AS marketplace,
             CASE WHEN count(DISTINCT p."accountId") = 1 THEN min(p."accountId") END AS "accountId",
             CASE WHEN count(DISTINCT p."aliasKey") = 1 THEN min(p."aliasKey") END AS "aliasKey",
             COALESCE(sum(p."changeCount") FILTER (WHERE p.kind = ${STUDIO_KIND}), 0)::int AS "fieldCount",
             COALESCE(min(h.status), 'SENT') AS status
        FROM parts p
        LEFT JOIN "BulkOperation" h ON h.id = p."batchId"
       WHERE p."batchId" IS NOT NULL AND ${asRuns ? Prisma.sql`FALSE` : Prisma.sql`TRUE`}
       GROUP BY p."batchId"
      HAVING bool_or(p.match)
    ),
    u AS (
      SELECT p.id AS "localId", p."batchId", p.started, p."completedAt", p.state, FALSE AS checked, NULL::text AS "checkedAt", NULL::text AS "checkedBy",
             p."userId", p."productId", p.channel, p.marketplace, p."accountId", p."aliasKey", 0 AS "fieldCount", p.status, NULLIF(p.message, '') AS message
        FROM parts p
       WHERE p.kind = ${SELLING_KIND} AND p.match AND (p."batchId" IS NULL OR ${asRuns ? Prisma.sql`TRUE` : Prisma.sql`FALSE`})
      UNION ALL
      SELECT ${BATCH_PREFIX} || g."batchId", g."batchId", g.started,
             CASE WHEN g.sending THEN NULL ELSE g."completedAt" END,
             CASE WHEN g.sending THEN 'in_progress' WHEN g."needsCheck" THEN 'needs_check' WHEN g.succeeded THEN 'succeeded' WHEN g.failed THEN 'failed' ELSE 'partial' END,
             (NOT g.sending AND g."needsCheck" AND g."allChecked"),
             CASE WHEN NOT g.sending AND g."needsCheck" AND g."allChecked" THEN g."checkedAt" END,
             CASE WHEN NOT g.sending AND g."needsCheck" AND g."allChecked" THEN g."checkedBy" END,
             g."userId", g."productId", g.channel, g.marketplace, g."accountId", g."aliasKey", g."fieldCount", g.status, NULL::text
        FROM groups g
    )
    SELECT u.* FROM u ${timed}`
}

interface UnitRow {
  localId: string
  batchId: string | null
  started: Date
  sortAt: number
  completedAt: number | null
  state: HistoryState
  checked: boolean
  checkedAt: string | null
  checkedBy: string | null
  userId: string | null
  productId: string | null
  channel: string | null
  marketplace: string | null
  accountId: string | null
  aliasKey: string | null
  fieldCount: number
  status: string
  message: string | null
  familySku: string | null
  familyTitle: string | null
  accountLabel: string | null
  aliasLabel: string | null
}

/** The units, with the names a run shows. `extra` narrows (state, check, cursor), orders and limits. */
async function readUnits(f: HistoryFilters, now: Date, scope: UnitScope, extra: Prisma.Sql = Prisma.empty): Promise<UnitRow[]> {
  return prisma.$queryRaw<UnitRow[]>(Prisma.sql`
    SELECT r."localId", r."batchId", r.started, round(extract(epoch from r.started) * 1000)::float8 AS "sortAt",
           round(extract(epoch from r."completedAt") * 1000)::float8 AS "completedAt",
           r.state, r.checked, r."checkedAt", r."checkedBy", r."userId", r."productId", r.channel, r.marketplace, r."accountId", r."aliasKey",
           r."fieldCount", r.status, r.message,
           fp.sku AS "familySku", fp.name AS "familyTitle",
           COALESCE(NULLIF(cc."accountLabel", ''), NULLIF(cc."displayName", '')) AS "accountLabel", a.label AS "aliasLabel"
      FROM (${unitsSql(f, now, scope)}) r
      LEFT JOIN "Product" fp ON fp.id = r."productId"
      LEFT JOIN "ChannelConnection" cc ON cc.id = r."accountId"
      LEFT JOIN "ProductListingAlias" a ON r."aliasKey" <> '' AND a.id = r."aliasKey"
     WHERE TRUE ${extra}`)
}

/** One part of a page's run, as the run's kinds and counts need it. */
interface PartFacts {
  id: string
  kind: string
  batchId: string | null
  status: string
  summary: unknown
  productCount: number
  changeCount: number
  partKind: string | null
}

/** The sent parts of these runs: the action or content kind (single JSON paths), the counts' columns. */
async function partFacts(units: Array<Pick<UnitRow, 'localId' | 'batchId'>>, partsAsRuns: boolean): Promise<PartFacts[]> {
  const ids = units.filter(u => partsAsRuns || !u.localId.startsWith(BATCH_PREFIX)).map(u => u.localId)
  const batches = partsAsRuns ? [] : units.filter(u => u.localId.startsWith(BATCH_PREFIX)).map(u => u.batchId!).filter(Boolean)
  if (!ids.length && !batches.length) return []
  const which: Prisma.Sql[] = []
  if (ids.length) which.push(Prisma.sql`b.id IN (${Prisma.join(ids)})`)
  if (batches.length) which.push(Prisma.sql`b."batchId" IN (${Prisma.join(batches)})`)
  return prisma.$queryRaw<PartFacts[]>(Prisma.sql`
    SELECT b.id, b.kind, b."batchId", b.status, b.summary, b."productCount", b."changeCount", ${PART_KIND} AS "partKind"
      FROM "BulkOperation" b
     WHERE (${Prisma.join(which, ' OR ')}) AND ${SENT_PART}`)
}

/** A selling change's per-row counts (`summary`: done, failed, unknown, skipped, notSent). Disjoint; they sum to its product count. */
export function sellingCounts(status: string, summary: unknown, sendCount: number): HistoryCounts {
  const s = record(summary)
  const counts: HistoryCounts = { accepted: whole(s.done), verified: 0, failed: whole(s.failed), waiting: 0, notSent: whole(s.notSent), skipped: whole(s.skipped), unknown: whole(s.unknown) }
  const known = counts.accepted + counts.failed + counts.notSent + counts.skipped + counts.unknown
  // No row result yet: a run still sending waits for every row it sends; one refused before it was claimed sent none.
  if (!known && status === 'RUNNING') counts.waiting = whole(sendCount)
  else if (!known && status === 'NOT_SENT') counts.notSent = whole(sendCount)
  else if (!known && status !== 'DONE') counts.unknown = whole(sendCount)
  return counts
}

const total = (c: HistoryCounts) => c.accepted + c.verified + c.failed + c.waiting + c.notSent + c.skipped + c.unknown
const add = (a: HistoryCounts, b: HistoryCounts): HistoryCounts => ({ accepted: a.accepted + b.accepted, verified: a.verified + b.verified, failed: a.failed + b.failed,
  waiting: a.waiting + b.waiting, notSent: a.notSent + b.notSent, skipped: a.skipped + b.skipped, unknown: a.unknown + b.unknown })
const NO_COUNTS: HistoryCounts = { accepted: 0, verified: 0, failed: 0, waiting: 0, notSent: 0, skipped: 0, unknown: 0 }

function partCounts(part: PartFacts): HistoryCounts {
  return part.kind === SELLING_KIND ? sellingCounts(part.status, part.summary, part.changeCount) : countsOf(part.status, part.summary, part.productCount)
}

const partKindOf = (part: PartFacts): HistoryKind =>
  part.kind === SELLING_KIND ? kindOf(part.partKind, 'pause') : studioKindOf({ action: part.partKind === 'create' ? 'create' : null, photosOnly: part.partKind === 'photos', full: part.partKind === 'full_update' })

const inSendOrder = (kinds: Iterable<HistoryKind>) => [...new Set(kinds)].sort((a, b) => HISTORY_SEND_ORDER.indexOf(a) - HISTORY_SEND_ORDER.indexOf(b))

function toRow(unit: UnitRow, parts: PartFacts[]): HistorySourceRow {
  const batch = unit.localId.startsWith(BATCH_PREFIX)
  const mine = batch ? parts.filter(p => p.batchId === unit.batchId) : parts.filter(p => p.id === unit.localId)
  const kinds = inSendOrder(mine.map(partKindOf))
  const summed = mine.reduce((sum, part) => add(sum, partCounts(part)), NO_COUNTS)
  // Nobody is working on a run that is no longer in progress: what it never answered is unknown, not waiting.
  const counts = unit.state === 'in_progress' ? summed : { ...summed, waiting: 0, unknown: summed.unknown + summed.waiting }
  const run: Omit<HistoryRun, 'userName' | 'checkedBy'> = {
    id: `listing-action:${unit.localId}`, source: 'listing-action', batchId: unit.batchId, startedAt: iso(unit.sortAt)!,
    finishedAt: unit.state === 'in_progress' || unit.checked ? null : iso(unit.completedAt), state: unit.state, status: unit.status,
    kind: kinds[0] ?? 'pause', ...(batch ? { kinds } : {}),
    productId: unit.productId, familySku: unit.familySku, familyTitle: unit.familyTitle,
    channel: unit.channel ?? '', marketplace: unit.marketplace, accountId: unit.accountId, accountLabel: unit.accountLabel,
    aliasKey: unit.aliasKey, aliasLabel: unit.aliasKey ? unit.aliasLabel ?? 'Other listing' : null,
    fieldCount: unit.fieldCount > 0 ? unit.fieldCount : null, productCount: total(counts), counts, userId: unit.userId,
    reference: null, message: unit.message, lastCheckedAt: null,
    needsCheck: unit.state === 'needs_check' && !unit.checked, checkedAt: unit.checked ? unit.checkedAt : null,
  }
  return { ...run, sortAt: unit.sortAt, localId: unit.localId, checkedByUserId: unit.checked ? unit.checkedBy : null }
}

async function list(input: HistoryListInput): Promise<HistorySourceRow[]> {
  const f = input.filters
  const extra = Prisma.sql`
    ${f.states?.length ? Prisma.sql`AND r.state IN (${Prisma.join(f.states)})` : Prisma.empty}
    ${f.checked === true ? Prisma.sql`AND r.checked` : f.checked === false ? Prisma.sql`AND NOT r.checked` : Prisma.empty}
    ${afterCursor(LISTING_ACTION_RANK, input.cursor)}
    ORDER BY r.started DESC, r."localId" COLLATE "C" DESC
    LIMIT ${input.limit}`
  const units = await readUnits(f, input.now, {}, extra)
  const parts = await partFacts(units, false)
  return units.map(unit => toRow(unit, parts))
}

/** Exact counts over the units `list` pages through (every state, no cursor). */
async function count(input: HistoryCountInput): Promise<HistorySourceTotals> {
  const f = { ...input.filters, states: undefined, checked: undefined }
  const rows = await prisma.$queryRaw<Array<{ state: string; n: number; checked: number; done: number }>>(Prisma.sql`
    SELECT r.state, count(*)::int AS n, count(*) FILTER (WHERE r.checked)::int AS checked,
           count(*) FILTER (WHERE r.state IN ('succeeded', 'partial', 'failed') AND r.started >= ${instant(input.doneSince)})::int AS done
      FROM (${unitsSql(f, input.now)}) r
     GROUP BY r.state`)
  return totalsOf(rows)
}

// ── Detail ───────────────────────────────────────────────────────────────────────────────────────

const OUTCOME_RESULT: Record<string, HistoryProductResult> = { DONE: 'ACCEPTED', FAILED: 'FAILED', SKIPPED: 'SKIPPED', NOT_SENT: 'NOT_SENT', UNKNOWN: 'UNKNOWN' }

/**
 * A selling change's products: its stored row results; while it still runs, the rows its preview sends (waiting). A
 * part that finished without results (never sent: cancelled, refused, its turn never came) lists them as Not sent.
 */
async function sellingProducts(id: string, runId: string, kind: HistoryKind, tagged: boolean, inProgress: boolean): Promise<{ products: HistoryProduct[]; result: unknown }> {
  const op = await prisma.bulkOperation.findFirst({ where: { id, kind: SELLING_KIND }, select: { changes: true } })
  const changes = record(op?.changes)
  const result = changes.result && typeof changes.result === 'object' ? changes.result : null
  const resultRows = Array.isArray(record(result).rows) ? record(result).rows as unknown[] : null
  const rows = (resultRows ?? (Array.isArray(record(changes.preview).rows) ? (record(changes.preview).rows as unknown[]).filter(r => record(r).plan === 'send') : []))
    .map(record).filter(r => typeof r.productId === 'string')
  const listingIds = rows.map(r => r.listingId).filter((v): v is string => typeof v === 'string')
  const [products, listings] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: rows.map(r => r.productId as string) } }, select: { id: true, parentId: true, categoryAttributes: true, variantAttributes: true } }),
    listingIds.length ? prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: { id: true, externalListingId: true } }) : Promise.resolve([]),
  ])
  const productOf = new Map(products.map(p => [p.id, p]))
  const externalOf = new Map(listings.map(l => [l.id, l.externalListingId]))
  return {
    result,
    products: rows.map(r => {
      const product = productOf.get(r.productId as string)
      const listingId = typeof r.listingId === 'string' ? r.listingId : null
      return {
        productId: r.productId as string, sku: typeof r.sku === 'string' ? r.sku : '',
        variationLabel: product?.parentId ? variationLabel(variationBag(product)) : null,
        result: resultRows ? OUTCOME_RESULT[String(r.outcome)] ?? 'UNKNOWN' : inProgress ? 'WAITING' : 'NOT_SENT',
        message: typeof r.message === 'string' && r.message ? r.message : typeof r.sentence === 'string' ? r.sentence : null,
        code: null, fieldLabel: null, columnKey: null, columnHint: [], listingId, externalId: listingId ? externalOf.get(listingId) ?? null : null,
        sentFields: [], issues: [], ...(tagged ? { kind, runId } : {}),
      } satisfies HistoryProduct
    }),
  }
}

const where = (run: Pick<HistoryRun, 'channel' | 'marketplace'>) => run.channel ? `${channelLabel(run.channel)}${run.marketplace ? ` · ${run.marketplace}` : ''}` : 'the channels'

function stepsOf(run: HistoryRun, createdAt: Date, parts: number): HistoryStep[] {
  const steps: HistoryStep[] = [{ key: 'reviewed', label: 'Reviewed', at: createdAt.toISOString(), tone: 'neutral',
    detail: parts > PARTS_IN_DETAIL ? `${parts} parts · open each part to see its products`
      : parts > 1 ? `${parts} parts` : `${run.productCount} ${run.productCount === 1 ? 'product' : 'products'}` }]
  const nothingSent = run.counts.accepted + run.counts.verified + run.counts.failed + run.counts.unknown + run.counts.waiting === 0
  if (nothingSent && run.state !== 'in_progress') {
    steps.push({ key: 'not_sent', label: 'Not sent', at: run.startedAt, tone: run.state === 'failed' ? 'danger' : 'neutral',
      detail: run.message ?? (run.counts.skipped ? 'Every listing was already as asked. Nothing changed on the channel.' : 'Nothing changed on the channel.') })
  } else {
    steps.push({ key: 'sent', label: `Sent to ${where(run)}`, at: run.startedAt, tone: 'info', detail: null })
    if (run.state === 'in_progress') steps.push({ key: 'waiting', label: 'Sending', at: null, tone: 'info', detail: 'Nexus is still sending this change.' })
    else if (run.state !== 'needs_check') {
      const label = run.state === 'failed' ? `${channelLabel(run.channel) || 'The channel'} refused it`
        : run.counts.failed ? `${channelLabel(run.channel) || 'The channel'} refused ${run.counts.failed} of ${run.productCount}` : `${channelLabel(run.channel) || 'The channel'} accepted it`
      steps.push({ key: 'processed', label, at: run.finishedAt, tone: run.state === 'failed' ? 'danger' : run.counts.failed ? 'warning' : 'info', detail: run.message })
    } else steps.push({ key: 'unknown', label: 'Result unknown', at: null, tone: 'warning', detail: run.message })
  }
  if (run.needsCheck) steps.push({ key: 'needs_check', label: 'Needs a check', at: null, tone: 'warning',
    detail: 'Nexus will not look again by itself. Check the listing on the channel before you change it again.' })
  if (run.checkedAt) steps.push({ key: 'checked', label: run.checkedBy ? `Marked as checked by ${run.checkedBy}` : 'Marked as checked', at: run.checkedAt, tone: 'neutral', detail: null })
  return steps
}

async function named(rows: HistorySourceRow[]): Promise<HistoryRun[]> {
  const names = await userNames(rows.flatMap(row => [row.userId, row.checkedByUserId]))
  return rows.map(({ sortAt: _s, localId: _l, checkedByUserId, ...run }) => ({ ...run, userName: run.userId ? names.get(run.userId) ?? null : null,
    checkedBy: checkedByUserId ? names.get(checkedByUserId) ?? null : null }))
}

async function detail(localId: string, now: Date): Promise<HistoryRunDetail | null> {
  const batchId = localId.startsWith(BATCH_PREFIX) ? localId.slice(BATCH_PREFIX.length) : null
  const scope: UnitScope = batchId ? { batchId } : { id: localId }
  const [unit] = await readUnits({}, now, scope, Prisma.sql`AND r."localId" = ${localId}`)
  if (!unit) return null
  const parts = await partFacts([unit], !batchId)
  const [run] = await named([toRow(unit, parts)])
  if (!batchId) {
    const op = await prisma.bulkOperation.findFirst({ where: { id: localId, kind: SELLING_KIND }, select: { createdAt: true } })
    const { products, result } = await sellingProducts(localId, run.id, run.kind, false, run.state === 'in_progress')
    return { run, steps: stepsOf(run, op?.createdAt ?? new Date(run.startedAt), 1), products: products.sort(byResult), hasRequest: false, rawResponse: result }
  }

  // One Publish: every part as a run (send order), then their products, each tagged with its part.
  const sellingUnits = await readUnits({}, now, { batchId, partsAsRuns: true })
  const sellingParts = await partFacts(sellingUnits, true)
  const contentIds = parts.filter(p => p.kind === STUDIO_KIND).map(p => p.id)
  const childRows = [...sellingUnits.map(u => toRow(u, sellingParts)), ...await studioRowsByIds(contentIds, now)]
  const order = (row: HistorySourceRow) => HISTORY_SEND_ORDER.indexOf(row.kind)
  const children = await named(childRows.sort((a, b) => order(a) - order(b) || a.sortAt - b.sortAt || a.localId.localeCompare(b.localId)))
  const products: HistoryProduct[] = []
  for (const child of children.length <= PARTS_IN_DETAIL ? children : []) {
    if (child.source === 'listing-action') {
      products.push(...(await sellingProducts(child.id.slice('listing-action:'.length), child.id, child.kind, true, child.state === 'in_progress')).products)
    } else {
      const part = await studioHistorySource.detail(child.id, now)
      products.push(...(part?.products ?? []).map(product => ({ ...product, kind: child.kind, runId: child.id })))
    }
  }
  const header = await prisma.bulkOperation.findFirst({ where: { id: batchId }, select: { createdAt: true } })
  return { run, steps: stepsOf(run, header?.createdAt ?? new Date(run.startedAt), children.length), products: products.sort(byResult), hasRequest: false,
    rawResponse: null, children }
}

async function coverage(): Promise<HistoryCoverage> {
  const [oldest] = await prisma.$queryRaw<Array<{ since: number | null }>>(Prisma.sql`
    SELECT round(extract(epoch from MIN(${STARTED})) * 1000)::float8 AS since
      FROM "BulkOperation" b WHERE b.kind = ${SELLING_KIND} AND b.status IN (${Prisma.join(SELLING_SENT)})`)
  return { source: 'listing-action', included: true, since: iso(oldest?.since ?? null), note: null }
}

export const listingActionHistorySource: PublicationHistoryAdapter = {
  source: 'listing-action',
  rank: LISTING_ACTION_RANK,
  list,
  count,
  detail,
  coverage,
}
