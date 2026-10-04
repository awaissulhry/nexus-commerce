/**
 * Sheet publish parity, step 4 — photo publishes as publish history runs (Owner D1 = A).
 *
 * Three stores, one source:
 *  - `AmazonMediaRun` — the Media page's Amazon photo review and send (it records its account and its person). Only a
 *    run that was approved is a run here; a review that was never sent is not, like a product sheet review.
 *  - `AmazonImageFeedJob` — the older Amazon photo feed (per market, or ALL).
 *  - `ChannelImagePublishJob` — eBay and Shopify photo publishes.
 * Run ids keep the store: `photos:amazon-media.<id>`, `photos:amazon-feed.<id>`, `photos:channel.<id>`. No store keeps
 * the exact request.
 *
 * State, decided in SQL so a filter pages correctly:
 *  - in_progress: still working, inside the store's own time limit (an hour for a photo review send — its worker marks
 *    a lost send after 10 minutes; a day for an Amazon photo feed, which is polled only while its page is open; 30
 *    minutes for an eBay or Shopify publish, which runs inside one request);
 *  - needs_check: past that limit with no result, a send whose outcome is unknown, or a finished feed with no receipt;
 *  - failed / partial / succeeded: from the per-SKU receipts.
 */
import { Prisma } from '@prisma/client'
import type { HistoryCoverage, HistoryProduct, HistoryProductResult, HistoryRun, HistoryRunDetail, HistoryState, HistoryStep } from '@nexus/shared/publication-history'
import type { AmazonMediaPlanItem, AmazonMediaReceipt } from '@nexus/shared/amazon-media'
import { channelLabel } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { amazonImagePerSku } from '../../images/image-publish-jobs.service.js'
import { afterCursor, ago, byResult, countRelation, escapeLike, instant, iso, jsonArray, legacyCounts, onlyChecked, productsBySku, record, STALE, statesFilter, text } from './legacy.js'
import { columnHintOf, emptyTotals, publicRunId, type HistoryFilters, type HistoryListInput, type HistorySourceRow, type PublicationHistoryAdapter } from './types.js'

export const PHOTOS_RANK = 3
/** Media page runs that were sent (approved). REVIEW_* never left Nexus. */
const MEDIA_SENT = ['QUEUED', 'READY', 'SUBMITTING', 'COMPLETE', 'UNKNOWN']

type Store = 'amazon-media' | 'amazon-feed' | 'channel'

interface ListRow {
  localId: string
  store: Store
  status: string
  channel: string
  marketplace: string | null
  accountId: string | null
  userId: string | null
  reference: string | null
  errorMessage: string | null
  total: number
  ok: number
  refused: number
  notSent: number
  skipped: number
  unknown: number
  state: HistoryState
  sortAt: number
  finishedAt: number | null
  familyId: string | null
  familySku: string | null
  familyTitle: string | null
  accountLabel: string | null
}

const RECEIPTS = jsonArray(Prisma.sql`m.receipts`)
const PER_SKU = jsonArray(Prisma.sql`(a."resultSummary"->'perSku')`)
const SKUS = jsonArray(Prisma.sql`a.skus`)
const RESULTS = jsonArray(Prisma.sql`(c.response->'results')`)
const receiptCount = (status: string) => Prisma.sql`(SELECT count(*) FROM jsonb_array_elements(${RECEIPTS}) e WHERE e->>'status' = ${status})::int`

/** Each store's rows in one shape, with their state. */
function unionSql(now: Date) {
  return Prisma.sql`
    SELECT x.*, CASE
        WHEN x.status IN ('QUEUED', 'READY', 'SUBMITTING') AND x.started > ${ago(now, STALE.photoRunMs)} THEN 'in_progress'
        WHEN x.status = 'COMPLETE' AND (x.refused > 0 OR x."notSent" > 0) AND x.ok + x.skipped = 0 THEN 'failed'
        WHEN x.status = 'COMPLETE' AND (x.refused > 0 OR x."notSent" > 0) THEN 'partial'
        WHEN x.status = 'COMPLETE' THEN 'succeeded'
        ELSE 'needs_check' END AS state
      FROM (
        SELECT 'amazon-media.' || m.id AS "localId", 'amazon-media' AS store, m."productId", m.status, 'AMAZON' AS channel, m.marketplace,
               m."accountId", m."actorId" AS "userId", NULL::text AS reference, NULL::text AS "errorMessage", m."createdAt" AS started,
               CASE WHEN m.status IN ('COMPLETE', 'UNKNOWN') THEN m."updatedAt" END AS finished,
               jsonb_array_length(${RECEIPTS})::int AS total, ${receiptCount('ACCEPTED')} AS ok, ${receiptCount('REJECTED')} AS refused,
               ${receiptCount('NOT_SENT')} AS "notSent", ${receiptCount('UNCHANGED')} AS skipped,
               (${receiptCount('UNKNOWN')} + ${receiptCount('SENDING')})::int AS unknown
          FROM "AmazonMediaRun" m WHERE m.status IN (${Prisma.join(MEDIA_SENT)})
      ) x
    UNION ALL
    SELECT y.*, CASE
        WHEN y.status IN ('PENDING', 'SUBMITTING', 'IN_QUEUE', 'IN_PROGRESS') AND y.started > ${ago(now, STALE.photoFeedMs)} THEN 'in_progress'
        WHEN y.status IN ('FATAL', 'CANCELLED') THEN 'failed'
        WHEN y.status = 'DONE' AND y.reference IS NULL THEN 'failed'
        WHEN y.status = 'DONE' AND y.refused > 0 AND y.ok = 0 THEN 'failed'
        WHEN y.status = 'DONE' AND y.refused > 0 THEN 'partial'
        WHEN y.status = 'DONE' AND y.ok > 0 THEN 'succeeded'
        ELSE 'needs_check' END AS state
      FROM (
        SELECT 'amazon-feed.' || a.id AS "localId", 'amazon-feed' AS store, a."productId", a.status, 'AMAZON' AS channel, a.marketplace,
               NULL::text AS "accountId", NULL::text AS "userId", a."feedId" AS reference, a."errorMessage", a."submittedAt" AS started, a."completedAt" AS finished,
               GREATEST(jsonb_array_length(${SKUS}), jsonb_array_length(${PER_SKU}))::int AS total,
               (SELECT count(*) FROM jsonb_array_elements(${PER_SKU}) e WHERE e->>'accepted' = 'true')::int AS ok,
               (SELECT count(*) FROM jsonb_array_elements(${PER_SKU}) e WHERE e->>'accepted' = 'false')::int AS refused,
               (CASE WHEN a.status = 'DONE' AND a."feedId" IS NULL THEN jsonb_array_length(${SKUS}) ELSE 0 END)::int AS "notSent",
               0 AS skipped, 0 AS unknown
          FROM "AmazonImageFeedJob" a
      ) y
    UNION ALL
    SELECT z.*, CASE
        WHEN z.status = 'SUBMITTING' AND z.started > ${ago(now, STALE.photoRequestMs)} THEN 'in_progress'
        WHEN z.status = 'DONE' AND z.refused > 0 THEN 'partial'
        WHEN z.status = 'DONE' THEN 'succeeded'
        WHEN z.status = 'FATAL' AND z.ok > 0 THEN 'partial'
        WHEN z.status IN ('FATAL', 'CANCELLED') THEN 'failed'
        ELSE 'needs_check' END AS state
      FROM (
        SELECT 'channel.' || c.id AS "localId", 'channel' AS store, c."productId", c.status, c.channel, c.marketplace,
               NULL::text AS "accountId", NULL::text AS "userId", c."vendorEntityId" AS reference, c."errorMessage", c."submittedAt" AS started, c."completedAt" AS finished,
               GREATEST(jsonb_array_length(${RESULTS}), 1)::int AS total,
               (SELECT count(*) FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'status' = 'PUSHED')::int AS ok,
               (SELECT count(*) FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'status' = 'ERROR')::int AS refused,
               0 AS "notSent",
               (SELECT count(*) FROM jsonb_array_elements(${RESULTS}) e WHERE e->>'status' NOT IN ('PUSHED', 'ERROR'))::int AS skipped,
               0 AS unknown
          FROM "ChannelImagePublishJob" c
      ) z`
}

function matchText(q: string) {
  const pattern = `%${escapeLike(q)}%`
  return Prisma.sql`(u."localId" = ${q} OR u.reference ILIKE ${pattern} OR p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern}
    OR f.sku ILIKE ${pattern} OR f.name ILIKE ${pattern})`
}

/**
 * This source's rows with their state — the one relation the list pages through and the count groups, so the two can
 * never disagree. `onlyId` narrows it to one run (the detail).
 */
function relation(f: HistoryFilters, now: Date, onlyId?: string) {
  const where: Prisma.Sql[] = [onlyId ? Prisma.sql`u."localId" = ${onlyId}` : Prisma.sql`TRUE`]
  if (f.channel) where.push(Prisma.sql`u.channel = ${f.channel}`)
  if (f.marketplace) where.push(Prisma.sql`u.marketplace = ${f.marketplace}`)
  // Only the Media page run records its account and its person; the other stores answer these filters with no rows.
  if (f.accountId) where.push(Prisma.sql`u."accountId" = ${f.accountId}`)
  if (f.userId) where.push(Prisma.sql`u."userId" = ${f.userId}`)
  if (f.familyId) where.push(Prisma.sql`COALESCE(p."parentId", p.id) = ${f.familyId}`)
  if (f.from !== undefined) where.push(Prisma.sql`u.started >= ${instant(f.from)}`)
  if (f.to !== undefined) where.push(Prisma.sql`u.started <= ${instant(f.to)}`)
  if (f.q) where.push(matchText(f.q))
  return Prisma.sql`
    SELECT u."localId", u.store, u.status, u.channel, u.marketplace, u."accountId", u."userId", u.reference, u."errorMessage",
           u.total, u.ok, u.refused, u."notSent", u.skipped, u.unknown, u.state, u.started,
           round(extract(epoch from u.started) * 1000)::float8 AS "sortAt",
           round(extract(epoch from u.finished) * 1000)::float8 AS "finishedAt",
           f.id AS "familyId", f.sku AS "familySku", f.name AS "familyTitle",
           COALESCE(NULLIF(cc."accountLabel", ''), NULLIF(cc."displayName", '')) AS "accountLabel"
      FROM (${unionSql(now)}) u
      LEFT JOIN "Product" p ON p.id = u."productId"
      LEFT JOIN "Product" f ON f.id = COALESCE(p."parentId", p.id)
      LEFT JOIN "ChannelConnection" cc ON cc.id = u."accountId"
     WHERE ${Prisma.join(where, ' AND ')}`
}

/** `onlyId` reads one run by its id (the detail), through the same state and count rules as the list. */
async function listRows(input: HistoryListInput, onlyId?: string): Promise<ListRow[]> {
  const f = input.filters
  if (onlyChecked(f)) return []
  return prisma.$queryRaw<ListRow[]>(Prisma.sql`
    SELECT r."localId", r.store, r.status, r.channel, r.marketplace, r."accountId", r."userId", r.reference, r."errorMessage",
           r.total, r.ok, r.refused, r."notSent", r.skipped, r.unknown, r.state, r."sortAt", r."finishedAt",
           r."familyId", r."familySku", r."familyTitle", r."accountLabel"
      FROM (${relation(f, input.now, onlyId)}) r
     WHERE TRUE ${statesFilter(f)} ${afterCursor(PHOTOS_RANK, input.cursor)}
     ORDER BY r.started DESC, r."localId" COLLATE "C" DESC
     LIMIT ${input.limit}`)
}

function messageOf(row: ListRow): string {
  const where = channelLabel(row.channel)
  if (row.state === 'in_progress') return `Still sending photos to ${where}.`
  if (row.store === 'amazon-feed' && row.status === 'DONE' && !row.reference) return row.errorMessage ?? 'Nothing was sent to Amazon.'
  if (row.status === 'CANCELLED') return 'Replaced by a later attempt.'
  if (row.state === 'needs_check') return row.store === 'amazon-media' && row.status === 'UNKNOWN'
    ? 'Amazon did not confirm every photo change. Check the listing on Amazon before you send again.'
    : `Nexus has no final answer from ${where}. Check the photos on ${where} before you send again.`
  if (row.state === 'failed' && !row.ok && !row.refused && row.errorMessage) return row.errorMessage
  const sent = row.ok + row.refused
  if (row.refused) return row.ok ? `${where} refused the photos of ${row.refused} of ${sent}.` : `${where} refused the photos.`
  return `${where} accepted the photos.`
}

function toRow(row: ListRow): HistorySourceRow {
  const run: Omit<HistoryRun, 'userName' | 'checkedBy'> = {
    id: publicRunId('photos', row.localId), source: 'photos', batchId: null,
    startedAt: iso(row.sortAt)!, finishedAt: row.state === 'in_progress' || row.state === 'needs_check' ? null : iso(row.finishedAt),
    state: row.state, status: row.status, kind: 'photos',
    productId: row.familyId, familySku: row.familySku, familyTitle: row.familyTitle,
    channel: row.channel, marketplace: row.marketplace, accountId: row.accountId, accountLabel: row.accountLabel, aliasKey: null, aliasLabel: null,
    fieldCount: null, productCount: row.total,
    counts: { ...legacyCounts({ total: row.total, accepted: row.ok, failed: row.refused, skipped: row.skipped, notSent: row.notSent, state: row.state }) },
    userId: row.userId, reference: row.reference, message: messageOf(row),
    lastCheckedAt: null, needsCheck: row.state === 'needs_check', checkedAt: null,
  }
  return { ...run, sortAt: row.sortAt, localId: row.localId, checkedByUserId: null }
}

const MEDIA_RESULT: Record<AmazonMediaReceipt['status'], HistoryProductResult> = {
  ACCEPTED: 'ACCEPTED', REJECTED: 'FAILED', NOT_SENT: 'NOT_SENT', UNKNOWN: 'UNKNOWN', SENDING: 'WAITING', UNCHANGED: 'SKIPPED',
}

async function mediaProducts(id: string, state: HistoryState): Promise<HistoryProduct[] | null> {
  const run = await prisma.amazonMediaRun.findFirst({ where: { id } })
  if (!run) return null
  const plan = (Array.isArray(run.plan) ? run.plan : []) as unknown as AmazonMediaPlanItem[]
  const receipts = (Array.isArray(run.receipts) ? run.receipts : []) as unknown as AmazonMediaReceipt[]
  const listings = await prisma.channelListing.findMany({ where: { id: { in: receipts.map(r => r.listingId) } }, select: { id: true, productId: true, externalListingId: true } })
  const listingOf = new Map(listings.map(l => [l.id, l]))
  const products = await prisma.product.findMany({ where: { id: { in: listings.map(l => l.productId) } }, select: { id: true, sku: true } })
  const skuOf = new Map(products.map(p => [p.id, p.sku]))
  const bySku = await productsBySku(products.map(p => p.sku))
  return receipts.map(receipt => {
    const item = plan.find(p => p.listingId === receipt.listingId)
    const listing = listingOf.get(receipt.listingId)
    const sku = item?.sku ?? (listing ? skuOf.get(listing.productId) ?? '' : '')
    let result = MEDIA_RESULT[receipt.status] ?? 'UNKNOWN'
    if (result === 'WAITING' && state !== 'in_progress') result = 'UNKNOWN'
    const issues = (item?.issues ?? []).map(message => ({ code: '', severity: 'error' as const, message, attributeNames: [] as string[] }))
    return {
      productId: listing?.productId ?? null, sku, variationLabel: bySku.get(sku)?.variationLabel ?? null, result,
      message: receipt.status === 'UNCHANGED' ? 'No photo change was needed.' : text(receipt.message),
      code: null, fieldLabel: null, columnKey: null, columnHint: columnHintOf(issues), listingId: receipt.listingId,
      externalId: item?.asin || listing?.externalListingId || null, sentFields: [], issues,
    }
  })
}

async function feedProducts(id: string, state: HistoryState): Promise<{ products: HistoryProduct[]; raw: unknown } | null> {
  const job = await prisma.amazonImageFeedJob.findFirst({ where: { id } })
  if (!job) return null
  const perSku = amazonImagePerSku(job.resultSummary) ?? []
  const skus = [...new Set([...perSku.map(r => r.sku), ...(Array.isArray(job.skus) ? job.skus.filter((s): s is string => typeof s === 'string') : [])])]
  const bySku = await productsBySku(skus)
  const nothingSent = job.status === 'DONE' && !job.feedId
  const products = skus.map(sku => {
    const receipt = perSku.find(r => r.sku === sku)
    const result: HistoryProductResult = receipt ? (receipt.accepted ? 'ACCEPTED' : 'FAILED')
      : nothingSent ? 'NOT_SENT' : job.status === 'FATAL' || job.status === 'CANCELLED' ? 'FAILED' : state === 'in_progress' ? 'WAITING' : 'UNKNOWN'
    const issues = (receipt?.errors ?? []).filter(e => text(e?.message)).map(e => ({ code: text(e.code) ?? '', severity: 'error' as const, message: e.message, attributeNames: [] }))
    return {
      productId: bySku.get(sku)?.productId ?? null, sku, variationLabel: bySku.get(sku)?.variationLabel ?? null, result,
      message: issues[0]?.message ?? (result === 'FAILED' || result === 'NOT_SENT' ? job.errorMessage : null),
      code: issues[0]?.code || null, fieldLabel: null, columnKey: null, columnHint: columnHintOf(issues), listingId: null, externalId: receipt?.asin ?? null, sentFields: [], issues,
    }
  })
  return { products, raw: { status: job.status, summary: job.resultSummary ?? null, error: job.errorMessage ?? null } }
}

async function channelProducts(id: string): Promise<{ products: HistoryProduct[]; raw: unknown } | null> {
  const job = await prisma.channelImagePublishJob.findFirst({ where: { id } })
  if (!job) return null
  const results = Array.isArray(record(job.response).results) ? (record(job.response).results as unknown[]).map(record) : []
  const bySku = await productsBySku(results.map(r => text(r.sku) ?? ''))
  const severalMarkets = new Set(results.map(r => text(r.market))).size > 1
  const products = results.map(r => {
    const sku = text(r.sku) ?? ''
    const product = bySku.get(sku)
    const result: HistoryProductResult = r.status === 'PUSHED' ? 'ACCEPTED' : r.status === 'ERROR' ? 'FAILED' : 'SKIPPED'
    const message = text(r.message)
    // The shared-listing photo publish names the eBay item, not a SKU: that number is the listing's own id.
    const itemNumber = !product && /^\d{6,}$/.test(sku) ? sku : null
    const issues = result === 'FAILED' && message ? [{ code: '', severity: 'error' as const, message, attributeNames: [] as string[] }] : []
    return {
      productId: product?.productId ?? null, sku, variationLabel: [product?.variationLabel, severalMarkets ? text(r.market) : null].filter(Boolean).join(' · ') || null, result,
      message: result === 'ACCEPTED' ? (message ? `Photos sent: ${message}.` : 'Photos sent.') : message,
      code: null, fieldLabel: null, columnKey: null, columnHint: columnHintOf(issues), listingId: null,
      externalId: itemNumber ?? (results.length === 1 ? job.vendorEntityId : null), sentFields: [], issues,
    }
  })
  return { products, raw: { status: job.status, response: job.response ?? null, error: job.errorMessage ?? null } }
}

async function detail(localId: string, now: Date): Promise<HistoryRunDetail | null> {
  const [row] = await listRows({ filters: {}, cursor: null, limit: 1, now }, localId)
  if (!row) return null
  const { sortAt: _sortAt, localId: _localId, checkedByUserId: _checker, ...rest } = toRow(row)
  const userName = row.userId ? (await prisma.userProfile.findFirst({ where: { id: row.userId }, select: { displayName: true } }))?.displayName?.trim() || null : null
  const run: HistoryRun = { ...rest, userName, checkedBy: null }
  const id = localId.slice(localId.indexOf('.') + 1)

  let products: HistoryProduct[] = []
  let raw: unknown = null
  if (row.store === 'amazon-media') {
    const found = await mediaProducts(id, row.state)
    if (!found) return null
    products = found
    raw = { status: row.status, receipts: found.map(p => ({ sku: p.sku, result: p.result, message: p.message })) }
  } else {
    const found = row.store === 'amazon-feed' ? await feedProducts(id, row.state) : await channelProducts(id)
    if (!found) return null
    products = found.products
    raw = found.raw
  }

  const where = `${channelLabel(row.channel)}${row.marketplace ? ` · ${row.marketplace}` : ''}`
  const steps: HistoryStep[] = []
  if (row.store === 'amazon-media') steps.push({ key: 'reviewed', label: 'Reviewed', at: run.startedAt, tone: 'neutral', detail: `${row.total} ${row.total === 1 ? 'SKU' : 'SKUs'}` })
  const nothingSent = row.store === 'amazon-feed' && row.status === 'DONE' && !row.reference
  if (nothingSent) {
    steps.push({ key: 'not_sent', label: 'Not sent', at: run.startedAt, tone: 'danger', detail: run.message })
  } else {
    steps.push({ key: 'sent', label: `Photos sent to ${where}`, at: row.store === 'amazon-media' ? null : run.startedAt, tone: 'info', detail: 'From the Media page.' })
    if (row.reference) steps.push({ key: 'received', label: `${channelLabel(row.channel)} received it`, at: null, tone: 'info', detail: `Reference ${row.reference}` })
    if (row.state === 'in_progress') steps.push({ key: 'waiting', label: `Waiting for ${channelLabel(row.channel)}`, at: null, tone: 'info', detail: null })
    if (row.state === 'succeeded' || row.state === 'partial' || row.state === 'failed') {
      const label = row.state === 'failed' ? `${channelLabel(row.channel)} refused it` : row.refused ? `${channelLabel(row.channel)} refused ${row.refused} of ${row.ok + row.refused}` : `${channelLabel(row.channel)} accepted it`
      steps.push({ key: 'processed', label, at: run.finishedAt, tone: row.state === 'failed' ? 'danger' : row.state === 'partial' ? 'warning' : 'info', detail: run.message })
    }
  }
  if (row.state === 'needs_check') steps.push({ key: 'needs_check', label: 'Needs a check', at: null, tone: 'warning', detail: run.message })

  return { run, steps, products: products.sort(byResult), hasRequest: false, rawResponse: raw }
}

async function coverage(): Promise<HistoryCoverage> {
  const [oldest] = await prisma.$queryRaw<Array<{ since: number | null }>>(Prisma.sql`
    SELECT round(extract(epoch from MIN(t.started)) * 1000)::float8 AS since FROM (
      SELECT MIN(m."createdAt") AS started FROM "AmazonMediaRun" m WHERE m.status IN (${Prisma.join(MEDIA_SENT)})
      UNION ALL SELECT MIN(a."submittedAt") FROM "AmazonImageFeedJob" a
      UNION ALL SELECT MIN(c."submittedAt") FROM "ChannelImagePublishJob" c) t`)
  return { source: 'photos', included: true, since: iso(oldest?.since ?? null), note: null }
}

export const photosHistorySource: PublicationHistoryAdapter = {
  source: 'photos',
  rank: PHOTOS_RANK,
  async list(input) {
    return (await listRows(input)).map(toRow)
  },
  async count(input) {
    const f = { ...input.filters, states: undefined, checked: undefined }
    return onlyChecked(f) ? emptyTotals() : countRelation(relation(f, input.now), input.doneSince)
  },
  detail,
  coverage,
}
