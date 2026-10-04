/**
 * Sheet publish parity, step 6 (item 6) — many families to ONE Amazon account and market, in as few feeds as possible.
 *
 * Amazon allows about one `createFeed` every two minutes per seller (burst 15). A batch of 200 families sent as 200
 * feeds would take hours, so the publications of one batch that go to the same account AND market share a feed:
 *
 *   1. each publication is already CLAIMED (PREVIEW → PUBLISHING, by the normal submit's claim) — nobody else sends it;
 *   2. the delivery checks (live publishing, saved values unchanged) and its draft listings, per publication;
 *   3. Amazon's own dry run (VALIDATION_PREVIEW) per message — a publication with a refused message is FAILED, nothing
 *      of it is sent, and the others go on;
 *   4. a seller SKU in two publications is refused for both (the feed could not say which one Amazon answered);
 *   5. whole publications are packed into feeds of at most 2,000 messages, renumbered 1..n per feed;
 *   6. each publication's exact requests are journaled BEFORE its feed is created;
 *   7. one createFeed per feed; each publication stores the shared feed id, its own { messageId, sku } map and the
 *      feed's message total, so the result sweep can read its own part of the report.
 *
 * A publication is never split across feeds. Every channel call goes through the same gateway paths as a single
 * publish (`validateAmazonMessages`, `submitAmazonFeed`).
 */
import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import { explainAmazonRelist } from '@nexus/shared/publish-actions'
import { logger } from '../../utils/logger.js'
import type { AmazonFeedMessage, AmazonFeedMessageRef, AmazonFeedRequest, AmazonPublication } from './studio-publication-amazon.js'
import type { ClaimedPublication } from './studio-publication.service.js'

/**
 * Messages per feed. The old Amazon flat-file submit route has sent JSON_LISTINGS_FEED feeds of up to 2,000 rows in
 * production (`routes/amazon-flat-file.routes.ts`, the 2,000-row cap); the product sheet keeps that proven size.
 */
export const AMAZON_FEED_MESSAGE_CAP = 2_000

/** One claimed publication's part of a shared feed, before renumbering. */
export interface FeedPart {
  id: string
  header: Record<string, unknown>
  messages: AmazonFeedMessage[]
}

export interface FeedChunk {
  feed: AmazonPublication['feed']
  parts: Array<{ id: string; messages: AmazonFeedMessageRef[] }>
}

export interface FeedPlan {
  chunks: FeedChunk[]
  /** Publications left out, with the reason (nothing of them is sent). */
  refused: Array<{ id: string; reason: string }>
}

/**
 * PURE. Pack whole publications into feeds. A seller SKU that two publications carry refuses both; a publication
 * bigger than one feed is refused (a family is at most 200 products, so this does not happen in practice). Feeds only
 * hold publications with the same header (seller, version). Message ids are renumbered 1..n in each feed.
 */
export function planAmazonFeeds(parts: FeedPart[], cap = AMAZON_FEED_MESSAGE_CAP): FeedPlan {
  const refused: FeedPlan['refused'] = []
  const owners = new Map<string, Set<string>>()
  for (const part of parts) for (const message of part.messages) owners.set(message.sku, (owners.get(message.sku) ?? new Set()).add(part.id))
  const shared = new Map<string, string[]>()
  for (const [sku, ids] of owners) if (ids.size > 1) for (const id of ids) shared.set(id, [...(shared.get(id) ?? []), sku])
  const chunks: FeedChunk[] = []
  const open = new Map<string, FeedChunk>()
  for (const part of parts) {
    const skus = shared.get(part.id)
    if (skus?.length) {
      refused.push({ id: part.id, reason: `Amazon seller SKU ${skus.join(', ')} is also in another family of this batch. Nothing was submitted for this family; publish them separately.` })
      continue
    }
    if (!part.messages.length) { refused.push({ id: part.id, reason: 'No Amazon message was prepared for this family.' }); continue }
    if (part.messages.length > cap) { refused.push({ id: part.id, reason: `This family has ${part.messages.length} Amazon messages, more than one feed holds (${cap}). Publish it on its own.` }); continue }
    const headerKey = JSON.stringify(part.header ?? {})
    let chunk = open.get(headerKey)
    if (!chunk || chunk.feed.messages.length + part.messages.length > cap) {
      chunk = { feed: { header: part.header ?? {}, messages: [] }, parts: [] }
      chunks.push(chunk)
      open.set(headerKey, chunk)
    }
    const refs: AmazonFeedMessageRef[] = []
    for (const message of part.messages) {
      const messageId = chunk.feed.messages.length + 1
      chunk.feed.messages.push({ ...message, messageId })
      refs.push({ messageId, sku: message.sku })
    }
    chunk.parts.push({ id: part.id, messages: refs })
  }
  return { chunks, refused }
}

/** The calls a merged send makes; the defaults are the real ones (tests replace them). */
export interface AmazonBatchDeps {
  checkStillValid: (claim: ClaimedPublication) => Promise<void>
  ensureDrafts: (claim: ClaimedPublication) => Promise<unknown>
  /** Amazon sheet gaps — a reviewed fulfilment root goes with the stock job's quantity at send (`withSendQuantities`). */
  sendQuantities: (plan: AmazonPublication, destination: { marketplace: string; accountId: string; aliasKey: string }) => Promise<AmazonPublication>
  validate: (plan: AmazonPublication, accountId: string, onChecked?: () => Promise<unknown> | void) => Promise<void>
  record: (claim: ClaimedPublication, request: AmazonFeedRequest, refs: AmazonFeedMessageRef[]) => Promise<void>
  submitFeed: (plan: { marketplaceId: string; feed: AmazonPublication['feed'] }, accountId: string, beforeSend: (request: AmazonFeedRequest) => Promise<void>) => Promise<string>
  checkpoint: (claim: ClaimedPublication, result: StudioPublishResult) => Promise<void>
  finish: (claim: ClaimedPublication, delivered: { result: StudioPublishResult; receipt?: StudioPublishResult }) => Promise<StudioPublishResult>
  /** Called while the batch works through a long validation (the batch keeps its heartbeat). */
  heartbeat?: () => Promise<unknown> | void
}

async function realDeps(): Promise<AmazonBatchDeps> {
  const service = await import('./studio-publication.service.js')
  const amazon = await import('./studio-publication-amazon.js')
  const { recordPublicationRequests } = await import('./studio-publication-records.js')
  const { recordContext } = await import('./studio-publication-settle.js')
  return {
    checkStillValid: service.checkDeliveryStillValid,
    ensureDrafts: service.ensureClaimDrafts,
    sendQuantities: (await import('./studio-publication-amazon-offer.js')).withSendQuantities,
    validate: amazon.validateAmazonMessages,
    record: (claim, request, refs) => recordAmazonRequests(claim, request, refs, recordPublicationRequests, recordContext),
    submitFeed: amazon.submitAmazonFeed,
    checkpoint: service.checkpointPublication,
    finish: service.finishPublication,
  }
}

/** Journal one publication's own messages of a shared feed, renumbered, each tied to its product. */
async function recordAmazonRequests(claim: ClaimedPublication, request: AmazonFeedRequest, refs: AmazonFeedMessageRef[],
  recordPublicationRequests: typeof import('./studio-publication-records.js').recordPublicationRequests,
  recordContext: typeof import('./studio-publication-settle.js').recordContext) {
  const amazon = claim.plan.prepared as AmazonPublication
  const ids = new Set(refs.map(ref => ref.messageId))
  const messages = request.feed.messages.filter(message => ids.has(message.messageId))
  await recordPublicationRequests(recordContext(claim.id, claim.data, claim.userId), messages.map(message => {
    const products = amazon.products.filter(product => product.sku === message.sku)
    if (products.length !== 1) throw new Error(`The exact product for Amazon seller SKU ${message.sku} could not be recorded.`)
    const offer = amazon.offers?.[products[0].productId]
    return { productId: products[0].productId, sku: message.sku, request: { feedType: request.feedType, marketplaceIds: request.marketplaceIds,
      header: request.feed.header, message, intentVersion: 1, writes: amazon.fieldWrites?.[products[0].productId] ?? [], ...(offer ? { offer } : {}) } }
  }))
}

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error)
/** Delete and relist (S3): a relist Amazon refused is explained in plain words beside Amazon's own (`explainAmazonRelist`). */
const notSubmitted = (claim: ClaimedPublication, reason: string): StudioPublishResult =>
  ({ id: claim.id, status: 'FAILED', message: `Nothing was submitted. ${explainAmazonRelist(claim.data, null, [], reason)}`, results: [] })

export interface MergedSendOutcome { id: string; result: StudioPublishResult }

/**
 * Send claimed Amazon publications of ONE account and market as shared feeds. Never throws for one publication's
 * failure: each publication ends with its own stored result (FAILED when nothing of it was sent).
 */
export async function sendAmazonMergedGroup(claims: ClaimedPublication[], options: Partial<AmazonBatchDeps> = {}): Promise<MergedSendOutcome[]> {
  if (!claims.length) return []
  const required: Array<keyof AmazonBatchDeps> = ['checkStillValid', 'ensureDrafts', 'sendQuantities', 'validate', 'record', 'submitFeed', 'checkpoint', 'finish']
  const deps: AmazonBatchDeps = required.every(key => options[key]) ? options as AmazonBatchDeps : { ...await realDeps(), ...options }
  const outcomes: MergedSendOutcome[] = []
  const finish = async (claim: ClaimedPublication, result: StudioPublishResult, receipt?: StudioPublishResult) => {
    try { outcomes.push({ id: claim.id, result: await deps.finish(claim, { result, ...(receipt ? { receipt } : {}) }) }) }
    catch (error) {
      logger.warn('[publication-batch] an Amazon result could not be stored; the result sweep settles it', { publicationId: claim.id, error: reasonOf(error) })
      outcomes.push({ id: claim.id, result })
    }
  }
  const { scope } = claims[0].plan.facts
  if (claims.some(claim => claim.plan.prepared.kind !== 'amazon' || claim.plan.facts.scope.accountId !== scope.accountId || claim.plan.facts.scope.marketplace !== scope.marketplace))
    throw new Error('A merged Amazon send takes publications of one Amazon account and market only.')

  // 2–3. Per publication: still valid, drafts in place, every message passes Amazon's dry run.
  const ready: ClaimedPublication[] = []
  for (const claim of claims) {
    try {
      await deps.checkStillValid(claim)
      await deps.ensureDrafts(claim)
      // The same quantity rule as a single publication: the feed, the journal and the FBA boundary see what goes out.
      claim.plan.prepared = await deps.sendQuantities(claim.plan.prepared as AmazonPublication,
        { marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: claim.plan.facts.destination?.aliasKey ?? '' })
      await deps.validate(claim.plan.prepared as AmazonPublication, scope.accountId, deps.heartbeat)
      ready.push(claim)
    } catch (error) {
      await finish(claim, notSubmitted(claim, reasonOf(error)))
    }
  }

  // 4–5. Shared feeds of whole publications.
  const byId = new Map(ready.map(claim => [claim.id, claim]))
  const plan = planAmazonFeeds(ready.map(claim => {
    const amazon = claim.plan.prepared as AmazonPublication
    return { id: claim.id, header: amazon.feed.header, messages: amazon.feed.messages }
  }))
  for (const refusal of plan.refused) await finish(byId.get(refusal.id)!, notSubmitted(byId.get(refusal.id)!, refusal.reason))

  const marketplaceId = (claims[0].plan.prepared as AmazonPublication).marketplaceId
  for (const chunk of plan.chunks) {
    const parts = chunk.parts.map(part => ({ part, claim: byId.get(part.id)! }))
    let journaled = false
    let feedId: string
    try {
      // 6. The journal of every publication in this feed is written before the feed exists.
      feedId = await deps.submitFeed({ marketplaceId, feed: chunk.feed }, scope.accountId, async request => {
        for (const { part, claim } of parts) await deps.record(claim, request, part.messages)
        journaled = true
      })
    } catch (error) {
      // Nothing left Nexus (a refusal before createFeed), or Amazon may have the feed (createFeed itself failed).
      const refused = !journaled || (error as { notSent?: boolean })?.notSent === true
      for (const { claim } of parts) await finish(claim, refused ? notSubmitted(claim, reasonOf(error))
        : { id: claim.id, status: 'UNVERIFIED', message: `Publication could not be verified. Check the channel before retrying: ${reasonOf(error)}`, results: [] })
      continue
    }
    // 7. Each publication keeps its own place in the shared feed.
    for (const { part, claim } of parts) {
      claim.data.feedMessages = part.messages
      claim.data.feedTotal = chunk.feed.messages.length
      const result: StudioPublishResult = { id: claim.id, status: 'SUBMITTED',
        message: `Submitted to Amazon with ${parts.length - 1 ? `${parts.length - 1} other famil${parts.length - 1 === 1 ? 'y' : 'ies'} in ` : ''}feed ${feedId}. It is awaiting processing; the listing is not yet confirmed live.`,
        results: part.messages.map(ref => ({ sku: ref.sku, status: 'SUBMITTED', reference: feedId, message: 'Awaiting Amazon processing' })) }
      try {
        await deps.checkpoint(claim, result)
        await finish(claim, result, result)
      } catch (error) {
        logger.warn('[publication-batch] an Amazon receipt could not be stored; the result sweep settles it', { publicationId: claim.id, feedId, error: reasonOf(error) })
        outcomes.push({ id: claim.id, result: { ...result, status: 'UNVERIFIED', message: `Amazon received feed ${feedId}, but Nexus could not record it. Keep this reference and check publication status before retrying.` } })
      }
    }
  }
  return outcomes
}
