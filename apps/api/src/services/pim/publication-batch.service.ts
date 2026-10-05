/**
 * Sheet publish parity, step 5 (item 3) — publish one family to several destinations in one action.
 *
 *   createPublicationBatch   POST /api/publication-batches          check every review, stamp it, queue the batch
 *   readPublicationBatch     GET  /api/publication-batches/:id      the phase and every destination's status
 *   cancelPublicationBatch   POST /api/publication-batches/:id/cancel   destinations not started are never sent
 *
 * Build shape v2, P6 — the mixed plan (`{ plan }`, `@nexus/shared/publish-plan`): ONE Publish of one family sends the
 * content reviews AND the waiting lifecycle values (Status changes, Delete) as one batch: the content children are these
 * same reviews; each lifecycle child is one listing-action preview (one destination × one action) carrying `batchId`.
 *
 * The Publish dialog keeps one review per destination (its own change plan, its own ticks, its own selection token).
 * The batch adds nothing to what a review sends: `publication-batch.processor.ts` sends each child through the normal
 * submit. A batch is refused before anything is queued when a review is not the caller's, was already sent, expired,
 * has a stale selection, shares a destination with another review of the batch, or when its destination still has a
 * publication waiting for a result — and when two EU markets would create one SKU with two different quantities.
 *
 * The header holds the phase only; every count is derived from the children, so the two can never disagree.
 *
 * P11 — the products list's request may carry a Status target (`options.status`: active, inactive or ended; no Delete):
 * the review stage then makes one lifecycle child per family × destination × action (the listing-action engine's plan,
 * refusals with the reason), and `submitReviewedBatch` sends them in the send order with any content. Ended needs
 * products.delete (checked when the batch is made and when it is sent) and the typed count of listings it ends.
 *
 * One-click O5 (Owner 2026-10-04, OD3 A + OD4 A) — the products list's window follows the studio's rules:
 *   listedMarkets            POST /api/publication-batches/listed-markets   the markets where the chosen families are
 *                            listed (Active or Inactive), so the window starts with them chosen;
 *   Nexus wins               `options.keepChannelValues` (default false; the older `replaceDiffers: false` = true);
 *   skipped, not reviewed    a family not listed in a market (see the processor), shown as "Not listed";
 *   the view                 echoes the options (`request.options`: startAs, keepChannelValues, …) and, per content
 *                            child, how many fields differ from the channel and how many of them are ticked (`differs`);
 *   OD4 A                    at submit, a review whose new SKUs would give Amazon's one EU quantity two numbers is
 *                            skipped with the reason; the rest are sent.
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { PublicationBatchEstimate, PublicationBatchPhase, StudioPublishScope } from '@nexus/shared/studio-publication'
import type { ListingAction, ListingActionPlanRow, ListingActionRowResult } from '@nexus/shared/listing-actions'
import type { SendStep } from '@nexus/shared/publish-actions'
import { confirmCountMatches, isStartAsTarget, MANY_ENDED_WITH_CONTENT, MANY_ROLE_CANNOT_END, manyEndCount, START_AS_NEEDS_CONTENT, TYPE_COUNT_TO_END,
  type ListedStatusTarget, type PublishCreateRow, type PublishPlanBatchChild, type PublishPlanBatchCounts, type PublishPlanBatchView, type StartAsTarget } from '@nexus/shared/publish-plan'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { object } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { IN_FLIGHT, OPEN_PUBLICATION, PUBLICATION_KIND, announcePublication, checkedMark, json } from './studio-publication-settle.js'
import { amazonSendOf, batchEuQuantityConflicts, createdQuantity, euConflictMessage, type BatchAmazonSend, type BatchEuConflict } from './publication-batch-eu-quantity.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND, BATCH_REVIEW_TTL_MS, LIFECYCLE_KIND, MAX_BATCH_FAMILIES, MAX_BATCH_REVIEWS, batchStageOf, cancelWaitingChildren,
  lifecycleStepOf, manyOptionsOf, readFamilyPresence, reviewPairKey, reviewPairs, runPublicationBatch, statusPairKey } from './publication-batch.processor.js'
import type { PublishPlanActor } from './publish-plan.js'
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

/** "eBay · IT"; an alias adds its name: "eBay · IT · Racing edition" (Owner 2026-10-05). */
const destinationLabel = (scope: Record<string, any>, aliasLabel?: string | null) => [scope?.channel === 'EBAY' ? 'eBay' : scope?.channel === 'AMAZON' ? 'Amazon' : scope?.channel === 'SHOPIFY' ? 'Shopify' : String(scope?.channel ?? ''), scope?.marketplace, aliasLabel].filter(Boolean).join(' · ')

/** Aliases (Owner 2026-10-05): the name of each alias id among `keys` ('' = the main listing, skipped). */
async function aliasLabels(tx: Prisma.TransactionClient, keys: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set(keys.filter((key): key is string => !!key))]
  if (!ids.length) return new Map()
  return new Map((await tx.productListingAlias.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } })).map(alias => [alias.id, alias.label]))
}

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

interface FamiliesRequest { productIds: string[]; destinations: StudioPublishScope[]
  /** One-click O5 — "Keep channel values": the fields that differ on the channel are left out (default: Nexus wins). */
  keepChannelValues: boolean; status: ListedStatusTarget | null; content: boolean
  /** New listings (ND4 B): "New listings start as" — the Status the changes create every new listing with. */
  startAs: StartAsTarget | null }

const MAX_REQUEST_PRODUCTS = 200
/** The products list's Publish never names a listing: an alias is published from its product's own Publish window. */
export const ALIAS_FROM_OWN_WINDOW = 'Aliases are published from each product\'s own Publish window.'
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
    // Aliases (Owner 2026-10-05): this path publishes each family's MAIN listing only (its review, Status and presence never
    // read a listing), so a destination that names a listing is refused rather than sent to the main listing.
    if (entry.listingId !== undefined && entry.listingId !== null) throw new WorkspaceScopeError(ALIAS_FROM_OWN_WINDOW, 400)
    const scope: StudioPublishScope = { channel: channel.toUpperCase(), marketplace: marketplace.toUpperCase(), accountId }
    const key = reviewPairKey('', scope)
    if (seen.has(key)) throw new WorkspaceScopeError('A destination appears twice in this request.', 400)
    seen.add(key)
    scopes.push(scope)
  }
  const options = object(input.options)
  if (options.replaceDiffers !== undefined && typeof options.replaceDiffers !== 'boolean') throw new WorkspaceScopeError('The replace option is not valid.', 400)
  if (options.keepChannelValues !== undefined && typeof options.keepChannelValues !== 'boolean') throw new WorkspaceScopeError('The Keep channel values option is not valid.', 400)
  // P11 — a Status target for every listing there (no Delete here), with or without the content.
  if (options.status !== undefined && options.status !== null && !['active', 'inactive', 'ended'].includes(options.status))
    throw new WorkspaceScopeError('Choose Active, Inactive or Ended as the status to set.', 400)
  if (options.content !== undefined && typeof options.content !== 'boolean') throw new WorkspaceScopeError('The content option is not valid.', 400)
  // New listings (ND4 B) — "New listings start as": Active or Inactive, for the listings the changes create.
  if (options.startAs !== undefined && options.startAs !== null && !isStartAsTarget(options.startAs))
    throw new WorkspaceScopeError('Choose Active or Inactive for how new listings start.', 400)
  const { keepChannelValues, status, content, startAs } = manyOptionsOf(options)
  if (!status && !content) throw new WorkspaceScopeError('Choose what to publish: the changes, or a status.', 400)
  if (status === 'ended' && content) throw new WorkspaceScopeError(MANY_ENDED_WITH_CONTENT, 400)
  if (startAs && !content) throw new WorkspaceScopeError(START_AS_NEEDS_CONTENT, 400)
  return { productIds: [...new Set(productIds.map(id => String(id).trim()))], destinations: scopes, keepChannelValues, status, content, startAs }
}

/** Step 6 — the families a selection reaches (a selected variation means its family); another business's product is not found. */
async function familiesOf(productIds: string[]): Promise<string[]> {
  const rows = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true } })
  const missing = productIds.length - rows.length
  if (missing) throw new WorkspaceScopeError(`${missing === 1 ? 'One chosen product was' : `${missing} chosen products were`} not found in this business. Refresh the list and choose again.`, 404)
  const byId = new Map(rows.map(row => [row.id, row]))
  return [...new Set(productIds.map(id => byId.get(id)!.parentId ?? id))]
}

/** One market where some of the chosen families are listed (`listedMarkets`). */
export interface ListedMarket { channel: string; marketplace: string; accountId: string; families: number }

/**
 * One-click O5 — the markets where the chosen products are listed: every channel market and account where at least one
 * chosen family's main listing is Active or Inactive (or Mixed), with how many families. Only facts Nexus holds; no
 * channel call. The products list's Publish window starts with these markets chosen (removable).
 */
export async function listedMarkets(body: unknown): Promise<{ families: number; markets: ListedMarket[] }> {
  const productIds = object(body).productIds
  if (!Array.isArray(productIds) || !productIds.length) throw new WorkspaceScopeError('Choose at least one product.', 400)
  if (productIds.length > MAX_REQUEST_PRODUCTS) throw new WorkspaceScopeError(`Choose at most ${MAX_REQUEST_PRODUCTS} products.`, 400)
  if (productIds.some(id => !text(id, 200))) throw new WorkspaceScopeError('A product in this request is not valid.', 400)
  const families = await familiesOf([...new Set(productIds.map(id => String(id).trim()))])
  const { pairs, destinations } = await readFamilyPresence(families, null)
  const markets = destinations.map(scope => ({ channel: scope.channel, marketplace: scope.marketplace, accountId: scope.accountId,
    families: families.filter(familyId => pairs.get(statusPairKey(familyId, scope))?.presence === 'listed').length }))
    .filter(market => market.families > 0)
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.accountId.localeCompare(b.accountId) || a.marketplace.localeCompare(b.marketplace))
  return { families: families.length, markets }
}

/**
 * Step 6 — queue the REVIEW of many families × destinations. Nothing is reviewed or sent here: the batch reviews in the
 * background (phase REVIEWING) and then waits for `submitReviewedBatch`.
 * P11 — Ended is refused at once to a role without products.delete (it could never be sent).
 */
async function createFamiliesBatch(body: unknown, userId: string | null, actor: PublishPlanActor): Promise<{ batchId: string }> {
  const request = parseFamiliesRequest(body)
  if (request.status === 'ended' && !actor.can('products.delete')) throw new WorkspaceScopeError(MANY_ROLE_CANNOT_END, 403)
  // A selected variation means its family; a product of another business is simply not found (row security).
  const families = await familiesOf(request.productIds)
  if (families.length > MAX_BATCH_FAMILIES) throw new WorkspaceScopeError(`Publish at most ${MAX_BATCH_FAMILIES} product families at once.`, 400)
  const reviews = families.length * request.destinations.length
  if (reviews > MAX_BATCH_REVIEWS) throw new WorkspaceScopeError(`This would review ${reviews} listings; one batch reviews at most ${MAX_BATCH_REVIEWS}. Choose fewer products or destinations.`, 400)
  const batchId = randomUUID()
  const now = new Date()
  await prisma.bulkOperation.create({ data: { id: batchId, userId, status: 'QUEUED', kind: BATCH_KIND, productCount: families.length, changeCount: 0,
    productId: families.length === 1 ? families[0] : null, checkCount: 0, nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
    changes: json({ kind: BATCH_KIND, stage: 'review', request: { families, destinations: request.destinations,
      options: { keepChannelValues: request.keepChannelValues, status: request.status, content: request.content, ...(request.startAs ? { startAs: request.startAs } : {}) } },
      children: [], cancelRequestedAt: null }) } })
  await dispatchPublicationBatch(batchId)
  return { batchId }
}

interface CheckedReview {
  review: BatchReviewInput
  row: { id: string; status: string; changeCount: number | null; productId: string | null; aliasKey: string | null; changes: Prisma.JsonValue }
  data: Record<string, any>
  label: string
}

/**
 * Every content review a batch will send, checked inside the batch's transaction: the caller's own, still a sendable
 * review (not sent, not closed, not in another batch, not expired), its ticks current; no two reviews of one listing; no
 * earlier publication there still waiting for a result; Amazon's one EU quantity kept. `extra` adds the caller's own
 * check of each review (a refusal sentence, or null).
 */
async function checkReviews(tx: Prisma.TransactionClient, reviews: BatchReviewInput[], userId: string | null, now: Date,
  extra: (row: CheckedReview['row'], data: Record<string, any>, label: string) => string | null = () => null): Promise<CheckedReview[]> {
  const rows = await tx.bulkOperation.findMany({ where: { id: { in: reviews.map(r => r.reviewId) }, userId },
    select: { id: true, status: true, kind: true, expiresAt: true, batchId: true, changeCount: true, productId: true, aliasKey: true, changes: true } })
  const byId = new Map(rows.map(row => [row.id, row]))
  const labels = await aliasLabels(tx, rows.map(row => row.aliasKey))
  const children = reviews.map(review => {
    const row = byId.get(review.reviewId)
    const data = object(row?.changes)
    if (!row || data.kind !== PUBLICATION_KIND) throw new WorkspaceScopeError('A review in this batch was not found. Review the destinations again.', 404)
    const label = destinationLabel(data.scope, row.aliasKey ? labels.get(row.aliasKey) : null)
    if (CLOSED_UNSENT.has(row.status)) throw new WorkspaceScopeError(`${label}: this review was not sent and is closed. Review the current values again.`, 409)
    if (row.status !== 'PREVIEW') throw new WorkspaceScopeError(`${label}: this review was already sent. Check its result.`, 409)
    if (row.batchId) throw new WorkspaceScopeError(`${label}: this review already belongs to another batch.`, 409)
    if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) throw new WorkspaceScopeError(`${label}: this review expired. Review the current values again.`, 409)
    if (SPARSE.has(String(data.scope?.channel))) {
      if (data.changeVersion !== 1 || !data.changePlan) throw new WorkspaceScopeError(`${label}: refresh this review to choose the fields to publish.`, 409)
      if (typeof review.selectionToken !== 'string' || review.selectionToken !== data.selection?.token)
        throw new WorkspaceScopeError(`${label}: review the exact selected changes before publishing. The selection token is missing or stale.`, 400)
    }
    const refusal = extra(row, data, label)
    if (refusal) throw new WorkspaceScopeError(refusal, 409)
    return { review, row, data, label }
  })
  // Two reviews of one destination would race each other's send.
  const keys = children.map(child => String(child.data.publicationKey ?? ''))
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new WorkspaceScopeError('Two destinations of this batch are the same listing. Keep one review per destination.', 400)
  // A destination still waiting for an earlier result is not sent again (the submit would refuse it anyway).
  if (keys.length) {
    const open = await tx.bulkOperation.findMany({ where: { ...OPEN_PUBLICATION, id: { notIn: children.map(c => c.row.id) },
      OR: keys.map(key => ({ changes: { path: ['publicationKey'], equals: key } })) }, select: { aliasKey: true, changes: true } })
    if (open.length) {
      const openLabels = await aliasLabels(tx, open.map(row => row.aliasKey))
      const waiting = [...new Set(open.map(row => destinationLabel(object(object(row.changes).scope), row.aliasKey ? openLabels.get(row.aliasKey) : null)))].join(', ')
      throw new WorkspaceScopeError(`A previous publication still needs a result on ${waiting}. Check it before publishing there again.`, 409)
    }
  }
  // Amazon's one EU quantity: two EU markets must not create one SKU with two quantities.
  const conflicts = batchEuQuantityConflicts(children.flatMap(child => { const send = amazonSendOf(child.row.id, child.data); return send ? [send] : [] }))
  if (conflicts.length) throw new WorkspaceScopeError(euConflictMessage(conflicts), 422)
  return children
}

/** Stamp each checked review with the batch and its submit body (compare-and-set: a review changed meanwhile refuses the batch). */
async function stampReviews(tx: Prisma.TransactionClient, children: CheckedReview[], batchId: string, userId: string | null, now: Date) {
  for (const child of children) {
    const { reviewId: _id, ...submitBody } = child.review
    const stamped = await tx.bulkOperation.updateMany({ where: { id: child.row.id, userId, status: 'PREVIEW', batchId: null, changes: { equals: json(child.row.changes) } },
      data: { batchId, expiresAt: new Date(now.getTime() + BATCH_REVIEW_TTL_MS), changes: json({ ...child.data, batch: { batchId, body: submitBody } }) } })
    if (stamped.count !== 1) throw new WorkspaceScopeError(`${child.label}: this review changed in another request. Review it again.`, 409)
  }
}

/**
 * Check every review, stamp it with the batch, create the header and queue it. Nothing is sent here.
 * Step 6 — a body with `productIds` and `destinations` (the products list) queues a review of many families instead.
 * Build shape v2, P6 — a body with `plan` (`PublishPlanSubmit`) is one mixed Publish (`createPlanBatch`); `actor`
 * decides whether its Ended and Delete rows may be sent (products.delete). Without an actor they never are.
 */
export async function createPublicationBatch(body: unknown, userId: string | null, actor?: PublishPlanActor): Promise<{ batchId: string }> {
  const input = object(body)
  if (input.plan !== undefined) {
    if (input.reviews !== undefined || input.productIds !== undefined) throw new WorkspaceScopeError('Send either a plan, reviews, or products with destinations.', 400)
    return createPlanBatch(input.plan, userId, actor ?? { userId, can: () => false })
  }
  if (input.productIds !== undefined || input.destinations !== undefined) {
    if (input.reviews !== undefined) throw new WorkspaceScopeError('Send either reviews or products with destinations, not both.', 400)
    return createFamiliesBatch(body, userId, actor ?? { userId, can: () => false })
  }
  const reviews = parseRequest(body)
  const batchId = randomUUID()
  const now = new Date()
  await prisma.$transaction(async tx => {
    const children = await checkReviews(tx, reviews, userId, now)
    const families = new Set(children.map(child => child.row.productId).filter(Boolean))
    await tx.bulkOperation.create({ data: { id: batchId, userId, status: 'QUEUED', kind: BATCH_KIND, productCount: children.length,
      changeCount: children.reduce((sum, child) => sum + (child.row.changeCount ?? 0), 0),
      productId: families.size === 1 ? [...families][0] : null, checkCount: 0, nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
      changes: json({ kind: BATCH_KIND, children: children.map(child => child.row.id), cancelRequestedAt: null }) } })
    await stampReviews(tx, children, batchId, userId, now)
  })
  await dispatchPublicationBatch(batchId)
  return { batchId }
}

/**
 * Build shape v2, P6 — ONE mixed Publish of one family (`PublishPlanSubmit`). The request is checked against the values
 * now (`preparePlanSubmit`); then one listing-action preview is made per destination × action (outside the transaction:
 * one the transaction does not stamp is never sent and expires in 15 minutes); then, in one transaction, the content
 * reviews are checked and stamped, the header is created, and every lifecycle preview is stamped with the batch, the
 * values it carries (cleared after it succeeds) and its place in the send order. Ended and Delete the person may not
 * send are stamped NOT_SENT with the reason (their values keep waiting). The values the listing outgrew are cleared once
 * the batch exists; then the batch is queued.
 */
async function createPlanBatch(planBody: unknown, userId: string | null, actor: PublishPlanActor): Promise<{ batchId: string }> {
  const { preparePlanSubmit, heldTickRefusal, clearOutgrown } = await import('./publish-plan.js')
  const prepared = await preparePlanSubmit(planBody, { ...actor, userId })
  const contents = prepared.destinations.flatMap((entry, at) => entry.content ? [{ at, entry, review: entry.content as BatchReviewInput }] : [])
  if (!contents.length && !prepared.groups.length) throw new WorkspaceScopeError('Nothing is ticked to send. Tick a change or a waiting value.', 400)
  const batchId = randomUUID()
  const { previewListingAction } = await import('../listings/listing-action.service.js')
  const lifecycle: Array<{ group: (typeof prepared.groups)[number]; previewId: string }> = []
  for (const group of prepared.groups) {
    const preview = await previewListingAction(prepared.familyId, group.action, { scope: group.destination, productIds: group.productIds, reason: 'Publish' }, userId)
    lifecycle.push({ group, previewId: preview.previewId })
  }
  // The header lists the children in the person's destination order, each destination in the send order.
  const order = prepared.destinations.flatMap((_, at) => [
    ...lifecycle.filter(l => l.group.destinationIndex === at && ['resume', 'relist'].includes(l.group.action)).map(l => l.previewId),
    ...contents.filter(c => c.at === at).map(c => c.review.reviewId),
    ...lifecycle.filter(l => l.group.destinationIndex === at && !['resume', 'relist'].includes(l.group.action)).map(l => l.previewId),
  ])
  const now = new Date()
  try {
    await prisma.$transaction(async tx => {
      const byReview = new Map(contents.map(c => [c.review.reviewId, c.entry]))
      const children = await checkReviews(tx, contents.map(c => c.review), userId, now, (row, data, label) => {
        const entry = byReview.get(row.id)!
        const scope = object(data.scope)
        if (row.productId !== prepared.familyId || scope.channel !== entry.scope.channel || scope.marketplace !== entry.scope.marketplace || scope.accountId !== entry.scope.accountId)
          return `${label}: this review is for another product or destination. Review again.`
        // Aliases (Owner 2026-10-05): the review must be of the same listing there — the main listing, or that alias.
        if ((row.aliasKey ?? '') !== entry.destination.aliasKey)
          return `${entry.label}: this review is for ${row.aliasKey ? 'another listing (an alias)' : 'the main listing'} on this market, not the listing chosen. Review again.`
        return heldTickRefusal(entry, data)
      })
      await tx.bulkOperation.create({ data: { id: batchId, userId, status: 'QUEUED', kind: BATCH_KIND, productCount: order.length,
        changeCount: children.reduce((sum, child) => sum + (child.row.changeCount ?? 0), 0) + prepared.groups.reduce((sum, group) => sum + group.values.length, 0),
        productId: prepared.familyId, checkCount: 0, nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
        changes: json({ kind: BATCH_KIND, stage: 'send', children: order, cancelRequestedAt: null, plan: { familyId: prepared.familyId, outgrown: prepared.outgrown.length } }) } })
      await stampReviews(tx, children, batchId, userId, now)
      for (const { group, previewId } of lifecycle) {
        const row = await tx.bulkOperation.findFirst({ where: { id: previewId, kind: LIFECYCLE_KIND, userId, status: 'PREVIEW', batchId: null }, select: { changes: true } })
        if (!row) throw new WorkspaceScopeError('A waiting value changed while the batch was being made. Review again.', 409)
        const batch = { batchId, step: lifecycleStepOf(group.action), familyId: prepared.familyId, destination: group.destination, values: group.values }
        const stamped = await tx.bulkOperation.updateMany({ where: { id: previewId, status: 'PREVIEW', batchId: null, changes: { equals: json(row.changes) } },
          data: { batchId, expiresAt: new Date(now.getTime() + BATCH_REVIEW_TTL_MS), changes: json({ ...object(row.changes), batch }),
            ...(group.refused ? { status: 'NOT_SENT', completedAt: now, summary: json({ message: group.refused, notSent: true, refused: true }) } : {}) } })
        if (stamped.count !== 1) throw new WorkspaceScopeError('A waiting value changed while the batch was being made. Review again.', 409)
      }
    })
  } catch (error) {
    // Nothing was queued: the previews made for this batch are removed (never sent; nobody else knows their ids).
    await prisma.bulkOperation.deleteMany({ where: { id: { in: lifecycle.map(l => l.previewId) }, kind: LIFECYCLE_KIND, status: 'PREVIEW', batchId: null } })
      .catch(cleanup => logger.warn('[publication-batch] unstamped lifecycle previews not removed; they expire unsent', { error: cleanup instanceof Error ? cleanup.message : String(cleanup) }))
    throw error
  }
  await clearOutgrown(prepared.outgrown)
  await dispatchPublicationBatch(batchId)
  return { batchId }
}

interface HeaderRow { id: string; status: string; createdAt: Date; completedAt: Date | null; changes: unknown }
interface ChildViewRow { id: string; status: string; productId: string | null; channel: string | null; marketplace: string | null
  channelConnectionId: string | null; aliasKey: string | null; completedAt: Date | null; summary: unknown
  /** Step 6 — read without the change plan (JSON paths only). */
  familySku?: string | null; familyTitle?: string | null; productCount?: number | null; selectedCount?: number | string | null
  issues?: unknown; expiresAt?: Date | null
  /** P6 — 'listing-action' for a lifecycle child (absent or 'studio-publication' for content), its action, sentence and rows. */
  kind?: string | null; action?: string | null; consequence?: string | null; resultRows?: unknown
  /** P11 — a lifecycle child's reviewed plan (until it has a result) and the rows it sends. */
  planRows?: unknown; changeCount?: number | null
  /** New listings (ND4 B) — the rows a content review creates and how each starts. */
  creates?: unknown
  /** One-click O5 — a content review's fields that differ from the channel, and how many of them are ticked. */
  differsTotal?: number | null; differsTicked?: number | null }

/** ACCEPTED / VERIFIED: a content result; DONE: a lifecycle child's. */
const SUCCEEDED = new Set(['ACCEPTED', 'VERIFIED', 'DONE'])
const FAILED = new Set(['FAILED'])
/** A lifecycle child not finished yet: waiting its turn, or running now. */
const LIFECYCLE_OPEN = new Set(['PREVIEW', 'RUNNING'])

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
export function batchView(header: HeaderRow, rows: ChildViewRow[]): PublishPlanBatchView {
  const data = object(header.changes)
  const order: string[] = Array.isArray(data.children) ? data.children : []
  const rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at }
  const children: PublishPlanBatchChild[] = [...rows].sort((a, b) => rank(a.id) - rank(b.id)).map(row => {
    const summary = row.summary && typeof row.summary === 'object' ? row.summary as Record<string, unknown> : null
    const lifecycle = row.kind === LIFECYCLE_KIND
    const checked = !lifecycle && IN_FLIGHT.includes(row.status) && !!checkedMark(summary)
    const selected = row.selectedCount == null || row.selectedCount === '' ? null : Number(row.selectedCount)
    const action = lifecycle && typeof row.action === 'string' ? row.action as ListingAction : null
    const open = lifecycle ? LIFECYCLE_OPEN.has(row.status) : row.status === 'PREVIEW' || IN_FLIGHT.includes(row.status)
    return { publicationId: row.id, productId: row.productId, channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId,
      aliasKey: row.aliasKey, status: row.status, checked, terminal: checked || !open,
      message: typeof summary?.message === 'string' ? summary.message : lifecycle && typeof row.consequence === 'string' ? row.consequence : null, summary,
      kind: lifecycle ? 'lifecycle' : 'content', action, step: (action ? lifecycleStepOf(action) : 'content') as SendStep,
      rows: lifecycle && Array.isArray(row.resultRows) ? row.resultRows as ListingActionRowResult[] : null,
      planRows: lifecycle && Array.isArray(row.planRows) ? row.planRows as ListingActionPlanRow[] : null,
      sendCount: lifecycle && row.changeCount != null ? Number(row.changeCount) : null,
      ...(row.familySku !== undefined ? { familySku: row.familySku, familyTitle: row.familyTitle ?? null, productCount: row.productCount ?? null,
        selectedCount: Number.isFinite(selected) ? selected : null, problems: reviewProblems(row.issues), expiresAt: row.expiresAt?.toISOString() ?? null,
        nothingToSend: summary?.nothingToSend === true } : {}),
      ...(!lifecycle && Array.isArray(row.creates) && row.creates.length ? { creates: row.creates as PublishCreateRow[] } : {}),
      ...(summary?.notListed === true ? { notListed: true } : {}),
      ...(!lifecycle && row.differsTotal != null ? { differs: { total: Number(row.differsTotal), ticked: Number(row.differsTicked ?? 0) } } : {}) }
  })
  const counts: PublishPlanBatchCounts = { total: children.length, waiting: 0, sending: 0, awaitingChannel: 0, succeeded: 0, partial: 0, failed: 0,
    notSent: 0, cancelled: 0, blocked: 0, checked: 0, unknown: 0 }
  for (const child of children) {
    if (child.checked) counts.checked += 1
    else if (child.status === 'PREVIEW') counts.waiting += 1
    else if (child.status === 'PUBLISHING' || child.status === 'RUNNING') counts.sending += 1
    else if (child.status === 'UNKNOWN') counts.unknown += 1
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
  const outcome: PublishPlanBatchView['outcome'] = !done ? 'IN_PROGRESS'
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
    // P11 — a family × destination may have several children (Relist and Resume, Status and content): count pairs.
    // One-click O5 — and the options it was made with, so the window shows them after a reload.
    request: families.length ? { families: families.length, destinations: destinations.length, reviews: families.length * destinations.length,
      reviewed: new Set(children.map(child => JSON.stringify([child.productId, child.channel, child.marketplace, child.accountId]))).size,
      options: manyOptionsOf(request.options) } : null }
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

/**
 * The children with what one row per family × destination shows — read by JSON path, never loading a change plan.
 * P6 — lifecycle children too: their action, the sentence of what they do, and their rows once finished.
 * P11 — and, until a lifecycle child has a result, its reviewed plan (one row per listing) and the rows it sends.
 */
async function readChildren(batchId: string): Promise<ChildViewRow[]> {
  return prisma.$queryRaw<ChildViewRow[]>`
    SELECT b.id, b.status, b."productId", b.channel, b.marketplace, b."channelConnectionId", b."aliasKey", b."completedAt", b.summary,
      b."productCount", b."expiresAt", b.changes->'review'->'issues' AS issues, b.changes->'selection'->>'fieldCount' AS "selectedCount",
      p.sku AS "familySku", p.name AS "familyTitle", b.kind, b.changes->>'action' AS action,
      b.changes->'preview'->>'consequence' AS consequence, b.changes->'result'->'rows' AS "resultRows",
      CASE WHEN b.kind = ${LIFECYCLE_KIND} AND b.changes->'result' IS NULL THEN b.changes->'preview'->'rows' END AS "planRows", b."changeCount",
      b.changes->'creates' AS creates,
      CASE WHEN b.kind = ${PUBLICATION_KIND} AND jsonb_typeof(b.changes->'review'->'changes') = 'array' THEN (
        SELECT count(*)::int FROM jsonb_array_elements(b.changes->'review'->'changes') AS c
        WHERE c->>'status' = 'DIFFERS' AND c->>'selectable' = 'true') END AS "differsTotal",
      CASE WHEN b.kind = ${PUBLICATION_KIND} AND jsonb_typeof(b.changes->'review'->'changes') = 'array'
        AND jsonb_typeof(b.changes->'selection'->'selectedIds') = 'array' THEN (
        SELECT count(*)::int FROM jsonb_array_elements(b.changes->'review'->'changes') AS c
        WHERE c->>'status' = 'DIFFERS' AND c->>'selectable' = 'true' AND b.changes->'selection'->'selectedIds' @> jsonb_build_array(c->>'id')) END AS "differsTicked"
    FROM "BulkOperation" b LEFT JOIN "Product" p ON p.id = b."productId"
    WHERE b."batchId" = ${batchId} AND b.kind IN (${PUBLICATION_KIND}, ${LIFECYCLE_KIND})
    ORDER BY b."createdAt" ASC, b.id ASC`
}

/** The work left in the current stage (when REVIEWED: the send that submit starts). */
async function remainingWork(view: PublishPlanBatchView, header: HeaderRow): Promise<EstimateWork[]> {
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
export async function readPublicationBatch(batchId: string, userId: string | null): Promise<PublishPlanBatchView> {
  const header = await readHeader(batchId, userId)
  const view = batchView(header, await readChildren(batchId))
  return { ...view, estimate: batchEstimate(await remainingWork(view, header)) }
}

/**
 * Cancel what has not started. A queued batch, or one waiting for the person after its review, is cancelled at once;
 * a running batch is asked to stop before its next destination (a destination already being sent finishes). A batch
 * that already sent everything has nothing to cancel.
 */
export async function cancelPublicationBatch(batchId: string, userId: string | null): Promise<PublishPlanBatchView> {
  const header = await readHeader(batchId, userId)
  if (header.status === 'SENT' || header.status === 'CANCELLED') throw new WorkspaceScopeError('Every destination of this batch already had its turn. Nothing is left to cancel.', 409)
  const at = new Date()
  const changes = json({ ...object(header.changes), cancelRequestedAt: at.toISOString() })
  const queued = await prisma.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: { in: ['QUEUED', 'REVIEWED'] } }, data: { status: 'CANCELLED', completedAt: at, nextCheckAt: null, changes } })
  if (queued.count) await cancelWaitingChildren(batchId, at)
  else await prisma.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: 'RUNNING' }, data: { status: 'CANCELLING', changes } })
  return readPublicationBatch(batchId, userId)
}

function parseSubmit(body: unknown): { confirmOverwrite: Set<string>; locations: Record<string, string>; confirmText: string | null } {
  const input = object(body)
  const confirm = input.confirmOverwrite ?? []
  if (!Array.isArray(confirm) || confirm.length > MAX_BATCH_REVIEWS || confirm.some(id => !text(id, 200))) throw new WorkspaceScopeError('The overwrite confirmations are not valid.', 400)
  const locations = object(input.shopifyLocations)
  if (input.shopifyLocations !== undefined && (typeof input.shopifyLocations !== 'object' || Array.isArray(input.shopifyLocations)
    || Object.entries(locations).some(([key, value]) => !text(key, 200) || !text(value, 200)))) throw new WorkspaceScopeError('The Shopify inventory locations are not valid.', 400)
  if (input.confirmText !== undefined && input.confirmText !== null && (typeof input.confirmText !== 'string' || input.confirmText.length > 40))
    throw new WorkspaceScopeError('The typed confirmation is not valid.', 400)
  return { confirmOverwrite: new Set(confirm.map(String)), locations: locations as Record<string, string>, confirmText: typeof input.confirmText === 'string' ? input.confirmText : null }
}

/**
 * PURE. One-click O5 (OD4 A) — the reviews a many-family send skips so Amazon's one EU quantity never gets two numbers:
 * every review that creates a conflicting SKU in one of the conflict's markets (same account), with the conflict's
 * words. Review id → reason.
 */
export function euSkipped(sends: readonly BatchAmazonSend[], conflicts: readonly BatchEuConflict[]): Map<string, string> {
  const found = new Map<string, BatchEuConflict[]>()
  for (const conflict of conflicts) for (const send of sends) {
    if (send.accountId !== conflict.accountId || !conflict.markets.includes(send.marketplace.toUpperCase())) continue
    if (!send.messages.some(message => message.sku === conflict.sku && createdQuantity(message))) continue
    found.set(send.reviewId, [...(found.get(send.reviewId) ?? []), conflict])
  }
  return new Map([...found].map(([reviewId, list]) => [reviewId, euConflictMessage(list)]))
}

/** A refusal the web branches on by its code (`confirm_required`), as the plan route sends it. */
const refusal = (message: string, statusCode: number, code: string) => Object.assign(new Error(message), { statusCode, code })

/**
 * Step 6 — send what the batch reviewed. A review that expired, or that has nothing ticked, is marked NOT_SENT with
 * the reason; the others are stamped with their submit body (their CURRENT ticks: the person may have changed one
 * review's ticks through the normal selection route) and the batch is queued to send. Refused as a whole when two EU
 * markets would create one SKU with two quantities, as a step-5 batch is.
 * P11 — the lifecycle children (a Status target) go too, in the send order: one that sends nothing is removed (nothing
 * to send; the window showed why); one that expired is NOT_SENT. Ending listings is refused as a whole, before anything
 * is marked or queued, to a role without products.delete, and without the typed count of listings it ends
 * (`manyEndCount`: "Type 36 to end 36 listings.").
 * One-click O5 (OD4 A) — two EU markets that would create one SKU with two quantities no longer hold the whole batch:
 * the reviews that create such a SKU are NOT_SENT with the reason (`euSkipped`), and the rest are sent.
 */
export async function submitReviewedBatch(batchId: string, body: unknown, userId: string | null, actor?: PublishPlanActor): Promise<PublishPlanBatchView> {
  const { confirmOverwrite, locations, confirmText } = parseSubmit(body)
  const header = await readHeader(batchId, userId)
  if (header.status !== 'REVIEWED') throw new WorkspaceScopeError(batchPhase(header.status, header.changes) === 'REVIEWING'
    ? 'This batch is still reviewing. Send it when every destination is reviewed.' : 'This batch is not waiting to be sent.', 409)
  const now = new Date()
  const rows = await prisma.bulkOperation.findMany({ where: { batchId, kind: { in: [PUBLICATION_KIND, LIFECYCLE_KIND] }, status: 'PREVIEW' },
    select: { id: true, status: true, kind: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, batchId: true, expiresAt: true,
      changeCount: true, changes: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const expired = (row: { expiresAt: Date | null }) => !row.expiresAt || row.expiresAt.getTime() <= now.getTime()

  // P11 — the Status children: what each sends, checked before anything is marked or queued.
  const lifecycle = rows.filter(row => row.kind === LIFECYCLE_KIND)
  const empty = lifecycle.filter(row => (row.changeCount ?? 0) <= 0)
  const lateLifecycle = lifecycle.filter(row => !empty.includes(row) && expired(row))
  const sendLifecycle = lifecycle.filter(row => !empty.includes(row) && !lateLifecycle.includes(row))
  const actionOf = (row: { changes: Prisma.JsonValue }) => object(row.changes).action
  const ending = manyEndCount(sendLifecycle.map(row => ({ kind: 'lifecycle' as const, status: 'PREVIEW', action: actionOf(row) as ListingAction, sendCount: row.changeCount })))
  if (sendLifecycle.some(row => actionOf(row) === 'end' || actionOf(row) === 'delete')) {
    if (!actor?.can('products.delete')) throw new WorkspaceScopeError(MANY_ROLE_CANNOT_END, 403)
    if (!confirmCountMatches(ending, confirmText)) throw refusal(TYPE_COUNT_TO_END(ending), 400, 'confirm_required')
  }

  const sendable: typeof rows = []
  for (const row of rows) {
    if (row.kind === LIFECYCLE_KIND) continue
    const data = object(row.changes)
    const sparse = SPARSE.has(String(row.channel))
    const reason = expired(row) ? 'This review expired before the batch was sent. Review it again.'
      : sparse && (data.changeVersion !== 1 || typeof data.selection?.token !== 'string') ? 'No fields are ticked for this destination.' : null
    if (!reason) { sendable.push(row); continue }
    const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
      data: { status: 'NOT_SENT', completedAt: now, summary: json({ message: `Nothing was sent. ${reason}`, notSent: true }) } })
    if (moved.count) announcePublication(row.id, row, data, 'NOT_SENT', { terminal: true })
  }
  for (const row of lateLifecycle) {
    const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
      data: { status: 'NOT_SENT', completedAt: now, summary: json({ message: 'Nothing was sent. This check expired before the batch was sent. Check again.', notSent: true }) } })
    if (moved.count) announcePublication(row.id, row, object(row.changes), 'NOT_SENT', { terminal: true })
  }
  // OD4 A — a review whose new SKU would give Amazon's one EU quantity two numbers is skipped with the reason.
  const sends = sendable.flatMap(row => { const send = amazonSendOf(row.id, object(row.changes)); return send ? [send] : [] })
  for (const [reviewId, reason] of euSkipped(sends, batchEuQuantityConflicts(sends))) {
    const row = sendable.find(candidate => candidate.id === reviewId)!
    sendable.splice(sendable.indexOf(row), 1)
    const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
      data: { status: 'NOT_SENT', completedAt: now, summary: json({ message: reason, notSent: true, euQuantity: true }) } })
    if (moved.count) announcePublication(row.id, row, object(row.changes), 'NOT_SENT', { terminal: true })
  }
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
    // Nothing to send there (every listing already as asked, or not allowed): removed, never sent.
    if (empty.length) await tx.bulkOperation.deleteMany({ where: { id: { in: empty.map(row => row.id) }, batchId, kind: LIFECYCLE_KIND, status: 'PREVIEW' } })
    const children = [...sendable, ...sendLifecycle].map(row => row.id)
    const queued = await tx.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: 'REVIEWED', userId },
      data: { status: 'QUEUED', nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS),
        changes: json({ ...object(header.changes), stage: 'send', children, submittedAt: now.toISOString() }) } })
    if (queued.count !== 1) throw new WorkspaceScopeError('This batch changed in another request. Open it again.', 409)
  })
  if (sendable.length || sendLifecycle.length) await dispatchPublicationBatch(batchId)
  else await prisma.bulkOperation.updateMany({ where: { id: batchId, status: 'QUEUED' }, data: { status: 'SENT', completedAt: now, nextCheckAt: null } })
  return readPublicationBatch(batchId, userId)
}
