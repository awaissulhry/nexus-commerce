/**
 * Sheet publish parity, step 5 (item 3) — publish one family to several destinations in one action.
 *
 *   createPublicationBatch   POST /api/publication-batches          check every review, stamp it, queue the batch
 *   readPublicationBatch     GET  /api/publication-batches/:id      the phase and every destination's status
 *   cancelPublicationBatch   POST /api/publication-batches/:id/cancel   destinations not started are never sent
 *
 * The Publish dialog keeps one review per destination (its own change plan, its own ticks, its own selection token).
 * The batch adds nothing to what a review sends: `publication-batch.processor.ts` sends each child through the normal
 * submit. A batch is refused before anything is queued when a review is not the caller's, was already sent, expired,
 * has a stale selection, shares a destination with another review of the batch, or when its destination still has a
 * publication waiting for a result — and when two EU markets would create one SKU with two different quantities.
 *
 * The header holds the phase only; every count is derived from the children, so the two can never disagree.
 */
import { randomUUID } from 'node:crypto'
import type { PublicationBatchChild, PublicationBatchCounts, PublicationBatchEstimate, PublicationBatchPhase, PublicationBatchView, StudioPublishScope } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { object } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { IN_FLIGHT, OPEN_PUBLICATION, PUBLICATION_KIND, announcePublication, checkedMark, json } from './studio-publication-settle.js'
import { amazonSendOf, batchEuQuantityConflicts, euConflictMessage } from './publication-batch-eu-quantity.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND, BATCH_REVIEW_TTL_MS, MAX_BATCH_FAMILIES, MAX_BATCH_REVIEWS, batchStageOf, cancelWaitingChildren, reviewPairKey,
  reviewPairs, runPublicationBatch } from './publication-batch.processor.js'
import { AMAZON_FEED_MESSAGE_CAP } from './studio-publication-amazon-batch.js'

/** One family has at most a few dozen destinations (markets × accounts × listings). */
export const MAX_BATCH_DESTINATIONS = 25
const SPARSE = new Set(['AMAZON', 'EBAY'])
/** Reviews a batch closed without sending them; they never become sendable again. */
const CLOSED_UNSENT = new Set(['NOT_SENT', 'CANCELLED', 'BLOCKED'])

interface BatchReviewInput { reviewId: string; selectionToken?: string; confirmOverwrite?: boolean; locationId?: string }

function parseRequest(body: unknown): BatchReviewInput[] {
  const reviews = object(body).reviews
  if (!Array.isArray(reviews) || !reviews.length) throw new WorkspaceScopeError('Choose at least one destination to publish.', 400)
  if (reviews.length > MAX_BATCH_DESTINATIONS) throw new WorkspaceScopeError(`Publish to at most ${MAX_BATCH_DESTINATIONS} destinations at once.`, 400)
  const parsed = reviews.map(raw => {
    const entry = object(raw)
    if (typeof entry.reviewId !== 'string' || !entry.reviewId || entry.reviewId.length > 200) throw new WorkspaceScopeError('Every destination needs its review.', 400)
    if (entry.selectionToken !== undefined && (typeof entry.selectionToken !== 'string' || entry.selectionToken.length > 200)) throw new WorkspaceScopeError('A selection token is not valid.', 400)
    if (entry.confirmOverwrite !== undefined && typeof entry.confirmOverwrite !== 'boolean') throw new WorkspaceScopeError('The overwrite confirmation is not valid.', 400)
    if (entry.locationId !== undefined && (typeof entry.locationId !== 'string' || entry.locationId.length > 200)) throw new WorkspaceScopeError('The inventory location is not valid.', 400)
    return { reviewId: entry.reviewId, ...(entry.selectionToken !== undefined ? { selectionToken: entry.selectionToken } : {}),
      ...(entry.confirmOverwrite !== undefined ? { confirmOverwrite: entry.confirmOverwrite } : {}), ...(entry.locationId !== undefined ? { locationId: entry.locationId } : {}) }
  })
  if (new Set(parsed.map(r => r.reviewId)).size !== parsed.length) throw new WorkspaceScopeError('A destination appears twice in this batch.', 400)
  return parsed
}

const destinationLabel = (scope: Record<string, any>) => [scope?.channel === 'EBAY' ? 'eBay' : scope?.channel === 'AMAZON' ? 'Amazon' : scope?.channel === 'SHOPIFY' ? 'Shopify' : String(scope?.channel ?? ''), scope?.marketplace].filter(Boolean).join(' · ')

/**
 * Queue a batch for sending. With queue workers (ENABLE_QUEUE_WORKERS=1) the worker sends it; without them it runs in
 * this process, as bulk operations do. Either way a second dispatch is harmless: only the run that claims the header sends.
 */
export async function dispatchPublicationBatch(batchId: string): Promise<'queued' | 'inline'> {
  if (process.env.ENABLE_QUEUE_WORKERS === '1') {
    try {
      const { publicationBatchQueue } = await import('../../lib/queue.js')
      await publicationBatchQueue.add('run', { batchId })
      return 'queued'
    } catch (error) {
      logger.warn('[publication-batch] queueing failed; sending in this process instead', { batchId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  setImmediate(() => {
    void runPublicationBatch(batchId).catch(error =>
      logger.error('[publication-batch] inline run failed; the resume job retries it', { batchId, error: error instanceof Error ? error.message : String(error) }))
  })
  return 'inline'
}

interface FamiliesRequest { productIds: string[]; destinations: StudioPublishScope[]; replaceDiffers: boolean }

const MAX_REQUEST_PRODUCTS = 200
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null

/** Step 6 — the products list's request: products (a variation means its family) × destinations. */
function parseFamiliesRequest(body: unknown): FamiliesRequest {
  const input = object(body)
  const productIds = input.productIds
  if (!Array.isArray(productIds) || !productIds.length) throw new WorkspaceScopeError('Choose at least one product to publish.', 400)
  if (productIds.length > MAX_REQUEST_PRODUCTS) throw new WorkspaceScopeError(`Publish at most ${MAX_REQUEST_PRODUCTS} products at once.`, 400)
  if (productIds.some(id => !text(id, 200))) throw new WorkspaceScopeError('A product in this request is not valid.', 400)
  const destinations = input.destinations
  if (!Array.isArray(destinations) || !destinations.length) throw new WorkspaceScopeError('Choose at least one destination to publish.', 400)
  if (destinations.length > MAX_BATCH_DESTINATIONS) throw new WorkspaceScopeError(`Publish to at most ${MAX_BATCH_DESTINATIONS} destinations at once.`, 400)
  const scopes: StudioPublishScope[] = []
  const seen = new Set<string>()
  for (const raw of destinations) {
    const entry = object(raw)
    const channel = text(entry.channel, 40), marketplace = text(entry.marketplace, 40), accountId = text(entry.accountId, 200)
    if (!channel || !marketplace || !accountId) throw new WorkspaceScopeError('Every destination needs its channel, market and account.', 400)
    if (entry.listingId !== undefined && entry.listingId !== null && !text(entry.listingId, 200)) throw new WorkspaceScopeError('A destination listing is not valid.', 400)
    const scope: StudioPublishScope = { channel: channel.toUpperCase(), marketplace: marketplace.toUpperCase(), accountId, ...(text(entry.listingId, 200) ? { listingId: text(entry.listingId, 200)! } : {}) }
    const key = reviewPairKey('', scope)
    if (seen.has(key)) throw new WorkspaceScopeError('A destination appears twice in this request.', 400)
    seen.add(key)
    scopes.push(scope)
  }
  const options = object(input.options)
  if (options.replaceDiffers !== undefined && typeof options.replaceDiffers !== 'boolean') throw new WorkspaceScopeError('The replace option is not valid.', 400)
  return { productIds: [...new Set(productIds.map(id => String(id).trim()))], destinations: scopes, replaceDiffers: options.replaceDiffers === true }
}

/**
 * Step 6 — queue the REVIEW of many families × destinations. Nothing is reviewed or sent here: the batch reviews in the
 * background (phase REVIEWING) and then waits for `submitReviewedBatch`.
 */
async function createFamiliesBatch(body: unknown, userId: string | null): Promise<{ batchId: string }> {
  const request = parseFamiliesRequest(body)
  // A selected variation means its family; a product of another business is simply not found (row security).
  const rows = await prisma.product.findMany({ where: { id: { in: request.productIds } }, select: { id: true, parentId: true } })
  const missing = request.productIds.length - rows.length
  if (missing) throw new WorkspaceScopeError(`${missing === 1 ? 'One chosen product was' : `${missing} chosen products were`} not found in this business. Refresh the list and choose again.`, 404)
  const byId = new Map(rows.map(row => [row.id, row]))
  const families = [...new Set(request.productIds.map(id => byId.get(id)!.parentId ?? id))]
  if (families.length > MAX_BATCH_FAMILIES) throw new WorkspaceScopeError(`Publish at most ${MAX_BATCH_FAMILIES} product families at once.`, 400)
  const reviews = families.length * request.destinations.length
  if (reviews > MAX_BATCH_REVIEWS) throw new WorkspaceScopeError(`This would review ${reviews} listings; one batch reviews at most ${MAX_BATCH_REVIEWS}. Choose fewer products or destinations.`, 400)
  const batchId = randomUUID()
  const now = new Date()
  await prisma.bulkOperation.create({ data: { id: batchId, userId, status: 'QUEUED', kind: BATCH_KIND, productCount: families.length, changeCount: 0,
    productId: families.length === 1 ? families[0] : null, checkCount: 0, nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
    changes: json({ kind: BATCH_KIND, stage: 'review', request: { families, destinations: request.destinations, options: { replaceDiffers: request.replaceDiffers } },
      children: [], cancelRequestedAt: null }) } })
  await dispatchPublicationBatch(batchId)
  return { batchId }
}

/**
 * Check every review, stamp it with the batch, create the header and queue it. Nothing is sent here.
 * Step 6 — a body with `productIds` and `destinations` (the products list) queues a review of many families instead.
 */
export async function createPublicationBatch(body: unknown, userId: string | null): Promise<{ batchId: string }> {
  const input = object(body)
  if (input.productIds !== undefined || input.destinations !== undefined) {
    if (input.reviews !== undefined) throw new WorkspaceScopeError('Send either reviews or products with destinations, not both.', 400)
    return createFamiliesBatch(body, userId)
  }
  const reviews = parseRequest(body)
  const batchId = randomUUID()
  const now = new Date()
  await prisma.$transaction(async tx => {
    const rows = await tx.bulkOperation.findMany({ where: { id: { in: reviews.map(r => r.reviewId) }, userId },
      select: { id: true, status: true, kind: true, expiresAt: true, batchId: true, changeCount: true, productId: true, changes: true } })
    const byId = new Map(rows.map(row => [row.id, row]))
    const children = reviews.map(review => {
      const row = byId.get(review.reviewId)
      const data = object(row?.changes)
      if (!row || data.kind !== PUBLICATION_KIND) throw new WorkspaceScopeError('A review in this batch was not found. Review the destinations again.', 404)
      const label = destinationLabel(data.scope)
      if (CLOSED_UNSENT.has(row.status)) throw new WorkspaceScopeError(`${label}: this review was not sent and is closed. Review the current values again.`, 409)
      if (row.status !== 'PREVIEW') throw new WorkspaceScopeError(`${label}: this review was already sent. Check its result.`, 409)
      if (row.batchId) throw new WorkspaceScopeError(`${label}: this review already belongs to another batch.`, 409)
      if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) throw new WorkspaceScopeError(`${label}: this review expired. Review the current values again.`, 409)
      if (SPARSE.has(String(data.scope?.channel))) {
        if (data.changeVersion !== 1 || !data.changePlan) throw new WorkspaceScopeError(`${label}: refresh this review to choose the fields to publish.`, 409)
        if (typeof review.selectionToken !== 'string' || review.selectionToken !== data.selection?.token)
          throw new WorkspaceScopeError(`${label}: review the exact selected changes before publishing. The selection token is missing or stale.`, 400)
      }
      return { review, row, data, label }
    })
    // Two reviews of one destination would race each other's send.
    const keys = children.map(child => String(child.data.publicationKey ?? ''))
    if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new WorkspaceScopeError('Two destinations of this batch are the same listing. Keep one review per destination.', 400)
    // A destination still waiting for an earlier result is not sent again (the submit would refuse it anyway).
    const open = await tx.bulkOperation.findMany({ where: { ...OPEN_PUBLICATION, id: { notIn: children.map(c => c.row.id) },
      OR: keys.map(key => ({ changes: { path: ['publicationKey'], equals: key } })) }, select: { changes: true } })
    if (open.length) {
      const waiting = [...new Set(open.map(row => destinationLabel(object(object(row.changes).scope))))].join(', ')
      throw new WorkspaceScopeError(`A previous publication still needs a result on ${waiting}. Check it before publishing there again.`, 409)
    }
    // Amazon's one EU quantity: two EU markets must not create one SKU with two quantities.
    const conflicts = batchEuQuantityConflicts(children.flatMap(child => { const send = amazonSendOf(child.row.id, child.data); return send ? [send] : [] }))
    if (conflicts.length) throw new WorkspaceScopeError(euConflictMessage(conflicts), 422)
    const families = new Set(children.map(child => child.row.productId).filter(Boolean))
    await tx.bulkOperation.create({ data: { id: batchId, userId, status: 'QUEUED', kind: BATCH_KIND, productCount: children.length,
      changeCount: children.reduce((sum, child) => sum + (child.row.changeCount ?? 0), 0),
      productId: families.size === 1 ? [...families][0] : null, checkCount: 0, nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
      changes: json({ kind: BATCH_KIND, children: children.map(child => child.row.id), cancelRequestedAt: null }) } })
    for (const child of children) {
      const { reviewId: _id, ...submitBody } = child.review
      const stamped = await tx.bulkOperation.updateMany({ where: { id: child.row.id, userId, status: 'PREVIEW', batchId: null, changes: { equals: json(child.row.changes) } },
        data: { batchId, expiresAt: new Date(now.getTime() + BATCH_REVIEW_TTL_MS), changes: json({ ...child.data, batch: { batchId, body: submitBody } }) } })
      if (stamped.count !== 1) throw new WorkspaceScopeError(`${child.label}: this review changed in another request. Review it again.`, 409)
    }
  })
  await dispatchPublicationBatch(batchId)
  return { batchId }
}

interface HeaderRow { id: string; status: string; createdAt: Date; completedAt: Date | null; changes: unknown }
interface ChildViewRow { id: string; status: string; productId: string | null; channel: string | null; marketplace: string | null
  channelConnectionId: string | null; aliasKey: string | null; completedAt: Date | null; summary: unknown
  /** Step 6 — read without the change plan (JSON paths only). */
  familySku?: string | null; familyTitle?: string | null; productCount?: number | null; selectedCount?: number | string | null
  issues?: unknown; expiresAt?: Date | null }

const SUCCEEDED = new Set(['ACCEPTED', 'VERIFIED'])
const FAILED = new Set(['FAILED'])

/** PURE. A review's own problems, as counts and at most five messages (errors first). */
export function reviewProblems(issues: unknown): { errors: number; warnings: number; messages: string[] } {
  const list = Array.isArray(issues) ? issues.map(object).filter(issue => typeof issue.message === 'string') : []
  const errors = list.filter(issue => issue.severity === 'error')
  const warnings = list.filter(issue => issue.severity !== 'error')
  return { errors: errors.length, warnings: warnings.length, messages: [...errors, ...warnings].slice(0, 5).map(issue => String(issue.message)) }
}

/** The phase a person sees: a many-family batch that is reviewing shows REVIEWING (its header runs on the same lease). */
export function batchPhase(status: string, changes: unknown): PublicationBatchPhase {
  if (batchStageOf(changes) === 'review' && (status === 'QUEUED' || status === 'RUNNING')) return 'REVIEWING'
  return status as PublicationBatchPhase
}

/** PURE. The batch as the dialog shows it: the header's phase, every destination, and counts derived from them. */
export function batchView(header: HeaderRow, rows: ChildViewRow[]): PublicationBatchView {
  const data = object(header.changes)
  const order: string[] = Array.isArray(data.children) ? data.children : []
  const rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at }
  const children: PublicationBatchChild[] = [...rows].sort((a, b) => rank(a.id) - rank(b.id)).map(row => {
    const summary = row.summary && typeof row.summary === 'object' ? row.summary as Record<string, unknown> : null
    const checked = IN_FLIGHT.includes(row.status) && !!checkedMark(summary)
    const selected = row.selectedCount == null || row.selectedCount === '' ? null : Number(row.selectedCount)
    return { publicationId: row.id, productId: row.productId, channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId,
      aliasKey: row.aliasKey, status: row.status, checked, terminal: checked || (row.status !== 'PREVIEW' && !IN_FLIGHT.includes(row.status)),
      message: typeof summary?.message === 'string' ? summary.message : null, summary,
      ...(row.familySku !== undefined ? { familySku: row.familySku, familyTitle: row.familyTitle ?? null, productCount: row.productCount ?? null,
        selectedCount: Number.isFinite(selected) ? selected : null, problems: reviewProblems(row.issues), expiresAt: row.expiresAt?.toISOString() ?? null,
        nothingToSend: summary?.nothingToSend === true } : {}) }
  })
  const counts: PublicationBatchCounts = { total: children.length, waiting: 0, sending: 0, awaitingChannel: 0, succeeded: 0, partial: 0, failed: 0,
    notSent: 0, cancelled: 0, blocked: 0, checked: 0 }
  for (const child of children) {
    if (child.checked) counts.checked += 1
    else if (child.status === 'PREVIEW') counts.waiting += 1
    else if (child.status === 'PUBLISHING') counts.sending += 1
    else if (IN_FLIGHT.includes(child.status)) counts.awaitingChannel += 1
    else if (SUCCEEDED.has(child.status)) counts.succeeded += 1
    else if (child.status === 'PARTIAL') counts.partial += 1
    else if (FAILED.has(child.status)) counts.failed += 1
    else if (child.status === 'NOT_SENT') counts.notSent += 1
    else if (child.status === 'CANCELLED') counts.cancelled += 1
    else if (child.status === 'BLOCKED') counts.blocked += 1
  }
  const phase = batchPhase(header.status, header.changes)
  const finished = phase === 'SENT' || phase === 'CANCELLED'
  const done = finished && children.every(child => child.terminal)
  // Nothing went through: a batch the person cancelled says CANCELLED (even if a destination was refused before the
  // cancel reached it), any other says FAILED.
  const outcome: PublicationBatchView['outcome'] = !done ? 'IN_PROGRESS'
    : counts.succeeded === counts.total ? 'SUCCEEDED'
    : counts.succeeded + counts.partial + counts.checked > 0 ? 'PARTIAL'
    : phase === 'CANCELLED' ? 'CANCELLED'
    : 'FAILED'
  const request = object(data.request)
  const families: unknown[] = Array.isArray(request.families) ? request.families : []
  const destinations: unknown[] = Array.isArray(request.destinations) ? request.destinations : []
  return { batchId: header.id, phase, createdAt: header.createdAt.toISOString(), sentAt: finished ? (header.completedAt?.toISOString() ?? null) : null,
    cancelRequestedAt: typeof data.cancelRequestedAt === 'string' ? data.cancelRequestedAt : null, done, outcome, counts, children,
    stage: batchStageOf(header.changes),
    request: families.length ? { families: families.length, destinations: destinations.length, reviews: families.length * destinations.length, reviewed: children.length } : null }
}

/**
 * Step 6 — the rates the batch estimate uses (per channel account; two accounts run side by side):
 * - Amazon reads and dry-runs about 5 products a second, and takes a new feed about every 2 minutes after a burst of 15;
 * - eBay needs about 3 Trading calls (≈1.5 s each) per family and market;
 * - Shopify about 10 s per family.
 */
export const ESTIMATE_RATES = { amazonProductsPerSecond: 5, amazonFeedBurst: 15, amazonFeedSeconds: 120, ebayCallsPerFamily: 3, ebayCallSeconds: 1.5,
  shopifySecondsPerFamily: 10, reviewOverheadSeconds: 1 } as const

export interface EstimateWork { kind: 'review' | 'send'; channel: string; accountId: string; marketplace: string; products: number }

/** PURE. Seconds left for `work`, from `ESTIMATE_RATES`. Null when nothing is left. */
export function batchEstimate(work: EstimateWork[]): PublicationBatchEstimate {
  const basis = 'Amazon checks about 5 products a second and takes a new feed about every 2 minutes; eBay needs about 3 calls per family and market.'
  if (!work.length) return { seconds: null, minutes: null, basis }
  const r = ESTIMATE_RATES
  const perAccount = new Map<string, number>()
  const add = (account: string, seconds: number) => perAccount.set(account, (perAccount.get(account) ?? 0) + seconds)
  // Amazon sends: one feed per publication alone in its market, shared feeds of up to 2,000 messages otherwise.
  const amazonSends = new Map<string, EstimateWork[]>()
  for (const item of work) {
    const account = `${item.channel}\u0000${item.accountId}`
    const products = Math.max(1, item.products)
    if (item.channel === 'AMAZON') {
      if (item.kind === 'review') add(account, products / r.amazonProductsPerSecond + r.reviewOverheadSeconds)
      else amazonSends.set(`${item.accountId}\u0000${item.marketplace}`, [...(amazonSends.get(`${item.accountId}\u0000${item.marketplace}`) ?? []), item])
    } else if (item.channel === 'EBAY') add(account, item.kind === 'review' ? r.ebayCallSeconds + r.reviewOverheadSeconds : r.ebayCallsPerFamily * r.ebayCallSeconds)
    else add(account, item.kind === 'review' ? 2 : r.shopifySecondsPerFamily)
  }
  const feedsPerSeller = new Map<string, number>()
  for (const items of amazonSends.values()) {
    const account = `AMAZON\u0000${items[0].accountId}`
    const messages = items.reduce((sum, item) => sum + Math.max(1, item.products), 0)
    add(account, messages / r.amazonProductsPerSecond)
    feedsPerSeller.set(account, (feedsPerSeller.get(account) ?? 0) + (items.length > 1 ? Math.ceil(messages / AMAZON_FEED_MESSAGE_CAP) : 1))
  }
  for (const [account, feeds] of feedsPerSeller) add(account, Math.max(0, feeds - r.amazonFeedBurst) * r.amazonFeedSeconds)
  const times = [...perAccount.values()]
  const total = times.reduce((sum, value) => sum + value, 0)
  const seconds = Math.ceil(Math.max(Math.max(...times), total / Math.min(2, times.length)))
  return { seconds, minutes: Math.max(1, Math.ceil(seconds / 60)), basis }
}

async function readHeader(batchId: string, userId: string | null) {
  const header = await prisma.bulkOperation.findFirst({ where: { id: batchId, kind: BATCH_KIND, userId },
    select: { id: true, status: true, createdAt: true, completedAt: true, changes: true } })
  if (!header) throw new WorkspaceScopeError('Publication batch not found.', 404)
  return header
}

/** The children with what one row per family × destination shows — read by JSON path, never loading a change plan. */
async function readChildren(batchId: string): Promise<ChildViewRow[]> {
  return prisma.$queryRaw<ChildViewRow[]>`
    SELECT b.id, b.status, b."productId", b.channel, b.marketplace, b."channelConnectionId", b."aliasKey", b."completedAt", b.summary,
      b."productCount", b."expiresAt", b.changes->'review'->'issues' AS issues, b.changes->'selection'->>'fieldCount' AS "selectedCount",
      p.sku AS "familySku", p.name AS "familyTitle"
    FROM "BulkOperation" b LEFT JOIN "Product" p ON p.id = b."productId"
    WHERE b."batchId" = ${batchId} AND b.kind = ${PUBLICATION_KIND}
    ORDER BY b."createdAt" ASC, b.id ASC`
}

/** The work left in the current stage (when REVIEWED: the send that submit starts). */
async function remainingWork(view: PublicationBatchView, header: HeaderRow): Promise<EstimateWork[]> {
  if (view.phase === 'REVIEWING') {
    const request = object(object(header.changes).request)
    const families: string[] = Array.isArray(request.families) ? request.families : []
    const destinations: StudioPublishScope[] = Array.isArray(request.destinations) ? request.destinations : []
    const sizes = families.length ? await prisma.$queryRaw<Array<{ family: string; products: number }>>`
      SELECT COALESCE("parentId", id) AS family, count(*)::int AS products FROM "Product"
      WHERE id = ANY(${families}::text[]) OR "parentId" = ANY(${families}::text[]) GROUP BY 1` : []
    const productsOf = new Map(sizes.map(row => [row.family, Number(row.products)]))
    const done = new Set(view.children.map(child => JSON.stringify([child.productId, child.channel, child.marketplace, child.accountId])))
    return reviewPairs(families, destinations)
      .filter(pair => !done.has(JSON.stringify([pair.familyId, pair.scope.channel, pair.scope.marketplace, pair.scope.accountId])))
      .map(pair => ({ kind: 'review' as const, channel: pair.scope.channel, accountId: pair.scope.accountId, marketplace: pair.scope.marketplace, products: productsOf.get(pair.familyId) ?? 1 }))
  }
  if (view.done || view.phase === 'CANCELLED') return []
  return view.children.filter(child => child.status === 'PREVIEW')
    .map(child => ({ kind: 'send' as const, channel: String(child.channel), accountId: String(child.accountId), marketplace: String(child.marketplace), products: child.productCount ?? 1 }))
}

/** The batch's phase and every destination. Only the person who started it reads it, like a single publish. */
export async function readPublicationBatch(batchId: string, userId: string | null): Promise<PublicationBatchView> {
  const header = await readHeader(batchId, userId)
  const view = batchView(header, await readChildren(batchId))
  return { ...view, estimate: batchEstimate(await remainingWork(view, header)) }
}

/**
 * Cancel what has not started. A queued batch, or one waiting for the person after its review, is cancelled at once;
 * a running batch is asked to stop before its next destination (a destination already being sent finishes). A batch
 * that already sent everything has nothing to cancel.
 */
export async function cancelPublicationBatch(batchId: string, userId: string | null): Promise<PublicationBatchView> {
  const header = await readHeader(batchId, userId)
  if (header.status === 'SENT' || header.status === 'CANCELLED') throw new WorkspaceScopeError('Every destination of this batch already had its turn. Nothing is left to cancel.', 409)
  const at = new Date()
  const changes = json({ ...object(header.changes), cancelRequestedAt: at.toISOString() })
  const queued = await prisma.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: { in: ['QUEUED', 'REVIEWED'] } }, data: { status: 'CANCELLED', completedAt: at, nextCheckAt: null, changes } })
  if (queued.count) await cancelWaitingChildren(batchId, at)
  else await prisma.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: 'RUNNING' }, data: { status: 'CANCELLING', changes } })
  return readPublicationBatch(batchId, userId)
}

function parseSubmit(body: unknown): { confirmOverwrite: Set<string>; locations: Record<string, string> } {
  const input = object(body)
  const confirm = input.confirmOverwrite ?? []
  if (!Array.isArray(confirm) || confirm.length > MAX_BATCH_REVIEWS || confirm.some(id => !text(id, 200))) throw new WorkspaceScopeError('The overwrite confirmations are not valid.', 400)
  const locations = object(input.shopifyLocations)
  if (input.shopifyLocations !== undefined && (typeof input.shopifyLocations !== 'object' || Array.isArray(input.shopifyLocations)
    || Object.entries(locations).some(([key, value]) => !text(key, 200) || !text(value, 200)))) throw new WorkspaceScopeError('The Shopify inventory locations are not valid.', 400)
  return { confirmOverwrite: new Set(confirm.map(String)), locations: locations as Record<string, string> }
}

/**
 * Step 6 — send what the batch reviewed. A review that expired, or that has nothing ticked, is marked NOT_SENT with
 * the reason; the others are stamped with their submit body (their CURRENT ticks: the person may have changed one
 * review's ticks through the normal selection route) and the batch is queued to send. Refused as a whole when two EU
 * markets would create one SKU with two quantities, as a step-5 batch is.
 */
export async function submitReviewedBatch(batchId: string, body: unknown, userId: string | null): Promise<PublicationBatchView> {
  const { confirmOverwrite, locations } = parseSubmit(body)
  const header = await readHeader(batchId, userId)
  if (header.status !== 'REVIEWED') throw new WorkspaceScopeError(batchPhase(header.status, header.changes) === 'REVIEWING'
    ? 'This batch is still reviewing. Send it when every destination is reviewed.' : 'This batch is not waiting to be sent.', 409)
  const now = new Date()
  const rows = await prisma.bulkOperation.findMany({ where: { batchId, kind: PUBLICATION_KIND, status: 'PREVIEW' },
    select: { id: true, status: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, batchId: true, expiresAt: true, changes: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const sendable: typeof rows = []
  for (const row of rows) {
    const data = object(row.changes)
    const sparse = SPARSE.has(String(row.channel))
    const reason = !row.expiresAt || row.expiresAt.getTime() <= now.getTime() ? 'This review expired before the batch was sent. Review it again.'
      : sparse && (data.changeVersion !== 1 || typeof data.selection?.token !== 'string') ? 'No fields are ticked for this destination.' : null
    if (!reason) { sendable.push(row); continue }
    const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
      data: { status: 'NOT_SENT', completedAt: now, summary: json({ message: `Nothing was sent. ${reason}`, notSent: true }) } })
    if (moved.count) announcePublication(row.id, row, data, 'NOT_SENT', { terminal: true })
  }
  const conflicts = batchEuQuantityConflicts(sendable.flatMap(row => { const send = amazonSendOf(row.id, object(row.changes)); return send ? [send] : [] }))
  if (conflicts.length) throw new WorkspaceScopeError(euConflictMessage(conflicts), 422)
  await prisma.$transaction(async tx => {
    for (const row of sendable) {
      const data = object(row.changes)
      const submitBody = { ...(SPARSE.has(String(row.channel)) ? { selectionToken: data.selection.token } : {}),
        ...(confirmOverwrite.has(row.id) ? { confirmOverwrite: true } : {}),
        ...(row.channel === 'SHOPIFY' && row.channelConnectionId && locations[row.channelConnectionId] ? { locationId: locations[row.channelConnectionId] } : {}) }
      const stamped = await tx.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW', batchId, changes: { equals: json(row.changes) } },
        data: { changes: json({ ...data, batch: { batchId, body: submitBody } }) } })
      if (stamped.count !== 1) throw new WorkspaceScopeError('A destination of this batch changed while it was being sent. Open the batch again and send it.', 409)
    }
    const queued = await tx.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: 'REVIEWED', userId },
      data: { status: 'QUEUED', nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
        changes: json({ ...object(header.changes), stage: 'send', children: sendable.map(row => row.id), submittedAt: now.toISOString() }) } })
    if (queued.count !== 1) throw new WorkspaceScopeError('This batch changed in another request. Open it again.', 409)
  })
  if (sendable.length) await dispatchPublicationBatch(batchId)
  else await prisma.bulkOperation.updateMany({ where: { id: batchId, status: 'QUEUED' }, data: { status: 'SENT', completedAt: now, nextCheckAt: null } })
  return readPublicationBatch(batchId, userId)
}
