/**
 * Sheet publish parity, step 5 (item 3) — the batch sender: one family's reviews for several destinations, sent one
 * after another in the background, so closing the Publish dialog does not stop them.
 *
 * The batch is a header `BulkOperation` (`kind` 'publication-batch'); its children are ordinary studio publication
 * reviews carrying `batchId`. Each child is sent through the SAME submit as a single publish
 * (`submitStudioPublication`): the same review checks, the same claim, the same journal, the same channel calls through
 * the gateway, the same publish-mode gates. Nothing here talks to a channel.
 *
 * - Order: children of one channel account go one after another (rate limits, Amazon's one EU quantity); different
 *   accounts run side by side, two at most.
 * - Once: the header is CLAIMED (QUEUED → RUNNING, or a RUNNING header whose heartbeat went stale) and only a child
 *   still in PREVIEW is ever submitted. A repeated job, or a resume after a crash, finds the claimed header or the sent
 *   children and sends nothing twice. A child left PUBLISHING by a crash is the result sweep's (30-minute rule).
 * - Cancel: checked before each child. A child not started becomes CANCELLED and is never sent; one in flight finishes.
 * - A child the submit refuses before anything was claimed (expired, stale, gated) becomes NOT_SENT with the reason.
 *
 * Build shape v2, P6 — a mixed Publish (`publish-plan.ts`) also has LIFECYCLE children: one listing-action preview
 * (kind 'listing-action') per destination × action, carrying `batchId`. Per channel account the children go in the send
 * order (`SEND_ORDER`): Resume and Relist, then the content, then Pause, End and Delete (the Amazon adapter deletes the
 * variations before their main product and keeps the main product when one fails). A lifecycle child runs through the
 * engine's own seam (`executeListingAction`), which claims it PREVIEW → RUNNING, so a resume never sends it twice; this
 * run first leases it (`nextCheckAt`), and a child still RUNNING past its lease is UNKNOWN ("check on the channel"),
 * never sent again. After each lifecycle child the values it did are cleared; a failure keeps them.
 */
import type { Prisma } from '@prisma/client'
import type { StudioPublishReview, StudioPublishScope, StudioPublishSelection, StudioPublishResult } from '@nexus/shared/studio-publication'
import { isPhotoChangeId } from '@nexus/shared/studio-publication'
import type { ListingAction, ListingActionDestination, ListingActionRunResult } from '@nexus/shared/listing-actions'
import { SEND_ORDER, type SendStep } from '@nexus/shared/publish-actions'
import { CONTENT_HELD_FOR_RELIST, isStartAsTarget, LIFECYCLE_UNKNOWN, lifecycleStep, START_AS_LABEL, type ListedStatusTarget, type ManyBatchOptions,
  type StartAsTarget } from '@nexus/shared/publish-plan'
import { statusTargetOf } from '@nexus/shared/publish-actions'
import { channelLabel } from '@nexus/shared/channel-label'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { object } from './studio-publication-plan.js'
import { PUBLICATION_KIND, announcePublication, json } from './studio-publication-settle.js'
import type { ClaimedPublication } from './studio-publication.service.js'
import type { MergedSendOutcome } from './studio-publication-amazon-batch.js'

/*
 * Step 6 (item 6) — a batch of MANY families. The person picks products on the products list and the destinations;
 * the batch first REVIEWS every family × destination here (one review each, with its default ticks), then waits for
 * the person (REVIEWED), then sends like step 5.
 * One-click O5 (Owner 2026-10-04, OD3 A) — the studio's rules: Nexus wins (`defaultBatchSelection`: SEND and every
 * selectable DIFFERS line are ticked; "Keep channel values" leaves the DIFFERS lines out), and a family NOT listed in a
 * market (its main listing neither Active nor Inactive there, `readFamilyPresence`) is skipped with the reason instead
 * of being reviewed as a new listing — unless "New listings start as" was chosen, or one of its rows there already has
 * its own Status choice Active or Inactive. A family or market whose request cannot be built is NOT_SENT with its
 * reason (OD4 A); the rest go on.
 * Both stages use the same header lease (QUEUED → RUNNING, heartbeat, resume), so the resume job resumes either;
 * `changes.stage` says which one a run does ('review' or 'send').
 * P11 — with a Status target (`request.options.status`), each family × destination is first reviewed by the
 * listing-action engine (`reviewStatusPair` in publish-plan.ts: one lifecycle child per action, in the send order); the
 * content review follows only when it was asked for too (`options.content`), and not where an eBay or Shopify listing
 * is being relisted (a new item: its changes wait for the next Publish).
 */
export type BatchStage = 'review' | 'send'
export const batchStageOf = (changes: unknown): BatchStage => object(changes).stage === 'review' ? 'review' : 'send'

export const BATCH_KIND = 'publication-batch'
/** A lifecycle child: the listing-action engine's preview (`LISTING_ACTION_KIND` in listing-action.service.ts). */
export const LIFECYCLE_KIND = 'listing-action'
/** A lifecycle child left RUNNING longer than this by a run that stopped is UNKNOWN: Nexus never sends it again. */
export const LIFECYCLE_LEASE_MS = 15 * 60_000
/** While a lifecycle child runs, the header's heartbeat is renewed this often (a long run must not look stopped). */
const LIFECYCLE_HEARTBEAT_MS = 30_000
export const lifecycleStepOf = (action: ListingAction): SendStep => lifecycleStep(action)
/** Families one batch may review (the products list's bulk cap). */
export const MAX_BATCH_FAMILIES = 200
/** Family × destination reviews one batch may hold (200 families × 5 Amazon EU markets). */
export const MAX_BATCH_REVIEWS = 1_000
/** The header's lease while it sends: a header whose heartbeat is older than this is resumed. */
export const BATCH_HEARTBEAT_MS = 2 * 60_000
/** A review the batch will send lives this long (the batch owns its lifetime; the revision check at submit still guards it). */
export const BATCH_REVIEW_TTL_MS = 2 * 60 * 60_000
/** Channel accounts sent side by side. */
export const BATCH_GROUP_CONCURRENCY = 2

/** Batch phases (the header's status). The children's results are counted on read, never stored twice. */
export const BATCH_PHASES = ['REVIEWING', 'REVIEWED', 'QUEUED', 'RUNNING', 'SENT', 'CANCELLING', 'CANCELLED'] as const

type Submit = (productId: string, id: string, body: unknown, userId: string | null) => Promise<unknown>
type Claim = (productId: string, id: string, body: unknown, userId: string | null) => Promise<{ result: StudioPublishResult } | { claim: ClaimedPublication }>
type SendMerged = (claims: ClaimedPublication[], heartbeat: () => Promise<unknown>) => Promise<MergedSendOutcome[]>
type Preview = (productId: string, scope: StudioPublishScope, userId: string | null, options: { batchId: string; expiresInMs: number; startAs?: StartAsTarget }) => Promise<StudioPublishReview>
type Select = (productId: string, id: string, body: unknown, userId: string | null) => Promise<StudioPublishSelection>
/** P6 — runs one confirmed listing-action preview (claims PREVIEW → RUNNING first). */
type Execute = (previewId: string, opts: { actorUserId: string | null }) => Promise<ListingActionRunResult>
/** P6 — the channel's publish mode for listing changes: a sentence when it is not live, else null. */
type Gate = (channel: string) => string | null | Promise<string | null>
/** P6 — clears the values a lifecycle child did; keeps the rest. Never throws. */
type SettleValues = (input: { familyId: string; destination: ListingActionDestination; values: LifecycleValue[]; result: ListingActionRunResult | null }) => Promise<unknown>
/** P11 — reviews one family × destination for a Status target (default `reviewStatusPair`). */
type StatusReview = (batchId: string, pair: ReviewPair, target: ListedStatusTarget, userId: string | null, ttlMs: number) => Promise<{ children: Array<{ action: ListingAction; sendCount: number }> }>
interface LifecycleValue { listingId: string; productId: string; column: 'send' | 'status'; setAt: string }
export interface BatchRunDeps {
  submit?: Submit
  /** Step 6 — the claim half of the submit, for publications that share an Amazon feed. */
  claim?: Claim
  /** Step 6 — sends claimed Amazon publications of one account and market as shared feeds. */
  sendMerged?: SendMerged
  /** Step 6 — the review stage's preview and default selection. */
  preview?: Preview
  select?: Select
  /** P6 — the lifecycle children's engine seam (default `executeListingAction`), gate and value clearing. */
  execute?: Execute
  gate?: Gate
  settleValues?: SettleValues
  /** P11 — the review stage's Status review of one family × destination. */
  statusReview?: StatusReview
  /** One-click O5 — whether each family is listed in each market (default `readFamilyPresence`). */
  presence?: Presence
  now?: () => Date
}

export interface BatchRunSummary {
  /** This call owned the header; false = another worker has it, or it is finished. */
  claimed: boolean
  submitted: number
  notSent: number
  skipped: number
  cancelled: number
  /** Step 6 — reviews made by this run (review stage). */
  reviewed?: number
  /** Step 6 — publications sent in a shared Amazon feed by this run. */
  merged?: number
  /** P6 — lifecycle children this run sent, and those it found stopped mid-way (UNKNOWN). */
  lifecycle?: number
  unknown?: number
  /** One-click O5 — families × markets skipped because the family is not listed there. */
  notListed?: number
}

interface ChildRow {
  id: string
  status: string
  userId: string | null
  productId: string | null
  channel: string | null
  marketplace: string | null
  channelConnectionId: string | null
  aliasKey: string | null
  batchId: string | null
  changes: Prisma.JsonValue
  kind?: string | null
}

const childSelect = { id: true, status: true, userId: true, productId: true, channel: true, marketplace: true, channelConnectionId: true,
  aliasKey: true, batchId: true, changes: true, kind: true } as const
const isLifecycle = (row: Pick<ChildRow, 'kind'>) => row.kind === LIFECYCLE_KIND
/** A child's place in the send order: its action's step (lifecycle) or 'content'. */
export function childStep(row: Pick<ChildRow, 'kind' | 'changes'>): SendStep {
  if (!isLifecycle(row)) return 'content'
  const action = object(row.changes).action
  return typeof action === 'string' && (SEND_ORDER as readonly string[]).includes(action) ? lifecycleStepOf(action as ListingAction) : 'delete'
}

/** The default submit, loaded when first needed (the studio publication module pulls in every channel). */
async function defaultSubmit(productId: string, id: string, body: unknown, userId: string | null) {
  const { submitStudioPublication } = await import('./studio-publication.service.js')
  return submitStudioPublication(productId, id, body, userId)
}

/** Children not started yet (content and lifecycle) become CANCELLED: never sent. Returns how many. */
export async function cancelWaitingChildren(batchId: string, now = new Date()): Promise<number> {
  const waiting = await prisma.bulkOperation.findMany({ where: { batchId, kind: { in: [PUBLICATION_KIND, LIFECYCLE_KIND] }, status: 'PREVIEW' }, select: childSelect })
  let cancelled = 0
  for (const row of waiting) {
    const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
      data: { status: 'CANCELLED', completedAt: now, summary: json({ message: 'The batch was cancelled before this destination\'s turn. Nothing was sent.', cancelled: true }) } })
    if (!moved.count) continue
    cancelled += 1
    announcePublication(row.id, row, object(row.changes), 'CANCELLED', { terminal: true })
  }
  return cancelled
}

/** "Nothing was sent." once, then the reason — a refusal that already ends with those words (Etsy's claim refusal, an
 *  Amazon SKU move) does not say them twice. */
export function notSentMessage(reason: string): string {
  return `Nothing was sent. ${reason.replace(/\s*Nothing was sent\.\s*$/, '')}`.trim()
}

/** A child the submit refused before anything was claimed: NOT_SENT, with the reason. Only while it is still PREVIEW. */
async function markNotSent(row: ChildRow, reason: string, now: Date, extra: Record<string, unknown> = {}): Promise<boolean> {
  const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
    data: { status: 'NOT_SENT', completedAt: now, summary: json({ message: notSentMessage(reason), notSent: true, ...extra }) } })
  if (moved.count) announcePublication(row.id, row, object(row.changes), 'NOT_SENT', { terminal: true })
  return moved.count === 1
}

interface ClaimedHeader { status: string; changes: Prisma.JsonValue; userId: string | null }

/** Claim the header for this run. QUEUED → RUNNING; a stale RUNNING is resumed; a stale CANCELLING is finished. */
async function claimHeader(batchId: string, now: Date): Promise<ClaimedHeader | null> {
  const header = await prisma.bulkOperation.findFirst({ where: { id: batchId, kind: BATCH_KIND }, select: { status: true, nextCheckAt: true, changes: true, userId: true } })
  if (!header) return null
  const lease = new Date(now.getTime() + BATCH_HEARTBEAT_MS)
  if (header.status === 'QUEUED') {
    const moved = await prisma.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: 'QUEUED' },
      data: { status: 'RUNNING', nextCheckAt: lease, checkCount: { increment: 1 } } })
    return moved.count ? { status: 'RUNNING', changes: header.changes, userId: header.userId } : null
  }
  if (header.status !== 'RUNNING' && header.status !== 'CANCELLING') return null
  const moved = await prisma.bulkOperation.updateMany({ where: { id: batchId, kind: BATCH_KIND, status: header.status, nextCheckAt: { lte: now } },
    data: { nextCheckAt: lease, checkCount: { increment: 1 } } })
  return moved.count ? { status: header.status, changes: header.changes, userId: header.userId } : null
}

/** The claim half of the submit, loaded when first needed. */
async function defaultClaim(productId: string, id: string, body: unknown, userId: string | null) {
  const { claimPublication } = await import('./studio-publication.service.js')
  return claimPublication(productId, id, body, userId)
}

async function defaultSendMerged(claims: ClaimedPublication[], heartbeat: () => Promise<unknown>) {
  const { sendAmazonMergedGroup } = await import('./studio-publication-amazon-batch.js')
  return sendAmazonMergedGroup(claims, { heartbeat })
}

async function defaultPreview(productId: string, scope: StudioPublishScope, userId: string | null, options: { batchId: string; expiresInMs: number; startAs?: StartAsTarget }) {
  const { previewStudioPublication } = await import('./studio-publication.service.js')
  return previewStudioPublication(productId, scope, userId, options)
}

async function defaultSelect(productId: string, id: string, body: unknown, userId: string | null) {
  const { previewStudioPublicationSelection } = await import('./studio-publication.service.js')
  return previewStudioPublicationSelection(productId, id, body, userId)
}

/**
 * PURE. The fields a batch ticks for one review by default — Nexus wins (One-click O5, OD3 A): what the review ticks
 * itself (SEND) and every selectable field the channel holds differently (DIFFERS: changed on the channel, on both
 * sides, or never published from Nexus). "Keep channel values" (`keepChannelValues`) leaves the DIFFERS fields out —
 * except a Full update row's locked fields, which always go whole. A photos-only review (other fields have problems)
 * ticks only its photos. Never ticked: SAME, CANNOT_COMPARE and every line the review refuses (not selectable).
 */
export function defaultBatchSelection(review: Pick<StudioPublishReview, 'changes' | 'photosOnly'>, keepChannelValues: boolean): string[] {
  const ids = (review.changes ?? []).filter(change => {
    if (!change.selectable) return false
    const differs = change.status === 'DIFFERS' && !change.locked
    if (keepChannelValues) return change.selectedByDefault && !differs
    return change.selectedByDefault || change.status === 'DIFFERS'
  }).map(change => change.id)
  return review.photosOnly ? ids.filter(id => isPhotoChangeId(id)) : ids
}

/**
 * One-click O5 — is a family on the channel in one market? `listed`: its main listing is Active or Inactive there (or
 * Mixed: its variations differ); `chosen`: it is not on the channel, but one of its rows there has its own Status choice
 * Active or Inactive (the sheet's new-listing choice); `not_listed`: neither (no listing, a draft, or deleted by Nexus);
 * `other`: Ended or a state Nexus cannot read — reviewed as before.
 */
export type FamilyPresence = 'listed' | 'chosen' | 'not_listed' | 'other'
export interface FamilyPresenceRead { presence: FamilyPresence; familySku: string }
/** Reads every family × destination's presence (key: `statusPairKey`). `destinations: null` = every market a row is in. */
type Presence = (families: string[], destinations: StudioPublishScope[] | null) => Promise<{ pairs: Map<string, FamilyPresenceRead>; destinations: StudioPublishScope[] }>

interface PresenceListing {
  id: string; productId: string; channel: string; marketplace: string; accountId: string | null; externalListingId: string | null
  listingStatus: string; isPublished: boolean; offerClosedAt: Date | null; offerCloseReason: string | null; offerActive: boolean
  fulfillmentMethod: string | null; sellingTarget: string | null; shopifyStatus: string | null
}

const LISTED_STATES = new Set(['active', 'paused', 'mixed'])
const OFF_CHANNEL_STATES = new Set(['draft', 'not_listed'])

/**
 * The presence of every family × destination, from the facts Nexus holds (no channel call): the products of each family
 * and their primary listing rows (alias ''), read with THE selling-state reader (`destinationSellingStates`), so
 * "listed" means what the sheet's Status column shows. Rows Nexus deleted read as rows not on the channel either way.
 */
export async function readFamilyPresence(families: string[], destinations: StudioPublishScope[] | null): Promise<{ pairs: Map<string, FamilyPresenceRead>; destinations: StudioPublishScope[] }> {
  const pairs = new Map<string, FamilyPresenceRead>()
  if (!families.length || (destinations && !destinations.length)) return { pairs, destinations: destinations ?? [] }
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: families } }, { parentId: { in: families } }] },
    select: { id: true, sku: true, parentId: true, fulfillmentMethod: true } })
  const productIds = products.map(product => product.id)
  const channels = destinations ? [...new Set(destinations.map(d => d.channel))] : null
  const markets = destinations ? [...new Set(destinations.map(d => d.marketplace))] : null
  const rows = productIds.length ? await prisma.$queryRaw<PresenceListing[]>`
    SELECT id, "productId", channel, marketplace, "channelConnectionId" AS "accountId", "externalListingId", "listingStatus", "isPublished",
      "offerClosedAt", "offerCloseReason", "offerActive", "fulfillmentMethod"::text AS "fulfillmentMethod", "sellingTarget",
      "platformAttributes"->>'status' AS "shopifyStatus"
    FROM "ChannelListing"
    WHERE "productId" = ANY(${productIds}::text[]) AND "aliasKey" = ''` : []
  const inScope = rows.filter(row => !!row.accountId && (!channels || channels.includes(row.channel)) && (!markets || markets.includes(row.marketplace)))
  const scopes = destinations ?? [...new Map(inScope.map(row => [JSON.stringify([row.channel, row.marketplace, row.accountId]),
    { channel: row.channel, marketplace: row.marketplace, accountId: row.accountId! }])).values()]
  const { destinationSellingStates } = await import('../listings/listing-action.service.js')
  const familyOf = new Map(products.map(product => [product.id, product.parentId ?? product.id]))
  const membersOf = new Map<string, typeof products>()
  for (const product of products) membersOf.set(familyOf.get(product.id)!, [...(membersOf.get(familyOf.get(product.id)!) ?? []), product])
  const rowsOf = new Map<string, PresenceListing[]>()
  for (const row of inScope) {
    const key = statusPairKey(familyOf.get(row.productId) ?? row.productId, { channel: row.channel, marketplace: row.marketplace, accountId: row.accountId })
    rowsOf.set(key, [...(rowsOf.get(key) ?? []), row])
  }
  for (const familyId of families) {
    const members = membersOf.get(familyId) ?? []
    const main = members.find(product => product.id === familyId)
    if (!main) continue
    const hasChildren = members.some(product => product.parentId === familyId)
    for (const scope of scopes) {
      const key = statusPairKey(familyId, scope)
      const listings = rowsOf.get(key) ?? []
      const read = destinationSellingStates({ familyId, channel: scope.channel,
        products: members.map(product => ({ id: product.id, sku: product.sku, isParent: product.id === familyId && hasChildren, fulfillmentMethod: product.fulfillmentMethod ?? null })),
        listings: listings.map(row => ({ id: row.id, productId: row.productId, externalListingId: row.externalListingId, listingStatus: row.listingStatus,
          isPublished: row.isPublished, offerClosedAt: row.offerClosedAt, offerCloseReason: row.offerCloseReason, offerActive: row.offerActive,
          fulfillmentMethod: row.fulfillmentMethod, platformAttributes: row.shopifyStatus ? { status: row.shopifyStatus } : null })) })
      const state = read.states.get(familyId)?.state ?? 'not_listed'
      let presence: FamilyPresence = LISTED_STATES.has(state) ? 'listed' : OFF_CHANNEL_STATES.has(state) ? 'not_listed' : 'other'
      if (presence === 'not_listed' && listings.some(row => {
        const own = statusTargetOf(row.sellingTarget)
        return (own === 'active' || own === 'inactive') && OFF_CHANNEL_STATES.has(read.states.get(row.productId)?.state ?? 'not_listed')
      })) presence = 'chosen'
      pairs.set(key, { presence, familySku: main.sku })
    }
  }
  return { pairs, destinations: scopes }
}

/** "Skipped GALE-JACKET on Amazon · DE: not listed there. Choose “New listings start as” to create it." */
export const notListedSentence = (familySku: string, scope: Pick<StudioPublishScope, 'channel' | 'marketplace'>) =>
  `Skipped ${familySku} on ${channelLabel(scope.channel)} · ${scope.marketplace}: not listed there. Choose “${START_AS_LABEL}” to create it.`

/** One family × destination of a review stage, as the header asked for it. */
export interface ReviewPair { familyId: string; scope: StudioPublishScope }
export const reviewPairKey = (familyId: string, scope: Partial<StudioPublishScope>) =>
  JSON.stringify([familyId, scope.channel ?? null, scope.marketplace ?? null, scope.accountId ?? null, scope.listingId ?? null])

/** PURE. Every family × destination, destination by destination, in the order the person chose them. */
export function reviewPairs(families: string[], destinations: StudioPublishScope[]): ReviewPair[] {
  return destinations.flatMap(scope => families.map(familyId => ({ familyId, scope })))
}

/**
 * A family × destination the batch could not review: a child NOT_SENT with the reason (never sent, never in the history).
 * P11 — `part: 'lifecycle'` when it was the Status review that failed (a resumed run then does not try it again).
 */
async function recordUnreviewed(batchId: string, pair: ReviewPair, userId: string | null, reason: string, now: Date, part: 'content' | 'lifecycle' = 'content') {
  const { randomUUID } = await import('node:crypto')
  const id = randomUUID()
  const row = { productId: pair.familyId, channel: pair.scope.channel, marketplace: pair.scope.marketplace, channelConnectionId: pair.scope.accountId,
    aliasKey: null, batchId }
  const changes = { kind: PUBLICATION_KIND, productId: pair.familyId, scope: pair.scope, batch: { batchId }, reviewFailed: true, ...(part === 'lifecycle' ? { part } : {}) }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'NOT_SENT', kind: PUBLICATION_KIND, ...row, productCount: 0, changeCount: 0, completedAt: now,
    summary: json({ message: notSentMessage(reason), notSent: true, notReviewed: true }), changes: json(changes) } })
  announcePublication(id, row, changes, 'NOT_SENT', { terminal: true })
}

/**
 * One-click O5 — a family not listed in a market, skipped (not reviewed as a new listing): a NOT_SENT child with the
 * sentence and `notListed` (the window shows it as "Not listed", not as a problem). A resumed run counts it as reviewed.
 */
async function recordNotListed(batchId: string, pair: ReviewPair, userId: string | null, familySku: string, now: Date) {
  const { randomUUID } = await import('node:crypto')
  const id = randomUUID()
  const row = { productId: pair.familyId, channel: pair.scope.channel, marketplace: pair.scope.marketplace, channelConnectionId: pair.scope.accountId,
    aliasKey: null, batchId }
  const changes = { kind: PUBLICATION_KIND, productId: pair.familyId, scope: pair.scope, batch: { batchId }, reviewFailed: true, notListed: true }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'NOT_SENT', kind: PUBLICATION_KIND, ...row, productCount: 0, changeCount: 0, completedAt: now,
    summary: json({ message: notListedSentence(familySku, pair.scope), notSent: true, notReviewed: true, notListed: true }), changes: json(changes) } })
  announcePublication(id, row, changes, 'NOT_SENT', { terminal: true })
}

/** Run `work` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  }))
}

/**
 * Send one batch. Safe to call any number of times, from the worker, the inline fallback or the resume job: only the
 * caller that claims the header sends, and only children still in PREVIEW are sent.
 */
export async function runPublicationBatch(batchId: string, deps: BatchRunDeps = {}): Promise<BatchRunSummary> {
  const clock = deps.now ?? (() => new Date())
  const summary: BatchRunSummary = { claimed: false, submitted: 0, notSent: 0, skipped: 0, cancelled: 0 }
  const header = await claimHeader(batchId, clock())
  if (!header) return summary
  summary.claimed = true
  const stage = batchStageOf(header.changes)
  const stopped = async () => (await prisma.bulkOperation.findFirst({ where: { id: batchId }, select: { status: true } }))?.status !== 'RUNNING'
  const heartbeat = () => prisma.bulkOperation.updateMany({ where: { id: batchId, status: { in: ['RUNNING', 'CANCELLING'] } },
    data: { nextCheckAt: new Date(clock().getTime() + BATCH_HEARTBEAT_MS) } })

  let pendingUntil: Date | null = null
  if (header.status === 'RUNNING') {
    if (stage === 'review') await reviewStage(batchId, header, deps, clock, summary, stopped, heartbeat)
    else pendingUntil = await sendStage(batchId, header, deps, clock, summary, stopped, heartbeat)
  }

  // P6 — a lifecycle child another run left RUNNING inside its lease: not finished yet. The header looks again when
  // the lease ends (the resume job re-queues it then), and that run finds the child's result or marks it UNKNOWN.
  if (pendingUntil) {
    await prisma.bulkOperation.updateMany({ where: { id: batchId, status: { in: ['RUNNING', 'CANCELLING'] } }, data: { nextCheckAt: pendingUntil } })
    logger.info('[publication-batch] run waits for a lifecycle change still running', { batchId, until: pendingUntil.toISOString(), ...summary })
    return summary
  }

  // Finish: every destination had its turn (reviewed, or sent), or the batch was cancelled.
  const now = clock()
  const finished = await prisma.bulkOperation.updateMany({ where: { id: batchId, status: 'RUNNING' },
    data: stage === 'review' ? { status: 'REVIEWED', nextCheckAt: null } : { status: 'SENT', completedAt: now, nextCheckAt: null } })
  if (!finished.count) {
    summary.cancelled += await cancelWaitingChildren(batchId, now)
    await prisma.bulkOperation.updateMany({ where: { id: batchId, status: 'CANCELLING' }, data: { status: 'CANCELLED', completedAt: now, nextCheckAt: null } })
  }
  logger.info('[publication-batch] run', { batchId, stage, ...summary })
  return summary
}

type Stopped = () => Promise<boolean>
type Heartbeat = () => Promise<unknown>

/**
 * Step 6 — review every family × destination the person asked for. Each review is the studio's own preview (made for
 * this batch, living 2 hours) with the default ticks (`defaultBatchSelection`). A review that cannot be sent is kept
 * BLOCKED by the preview; a family the preview cannot even review becomes NOT_SENT with the reason; a review with
 * nothing to send becomes NOT_SENT ("nothing to send"). A resumed run skips the pairs an earlier run already made.
 * One-click O5 — without "New listings start as", a family not listed in the market is skipped (`recordNotListed`).
 */
async function reviewStage(batchId: string, header: ClaimedHeader, deps: BatchRunDeps, clock: () => Date, summary: BatchRunSummary, stopped: Stopped, heartbeat: Heartbeat) {
  const request = object(object(header.changes).request)
  const families: string[] = Array.isArray(request.families) ? request.families.filter((id: unknown): id is string => typeof id === 'string') : []
  const destinations: StudioPublishScope[] = Array.isArray(request.destinations) ? request.destinations : []
  const { keepChannelValues, status, content, startAs } = manyOptionsOf(request.options)
  const preview = deps.preview ?? defaultPreview
  const select = deps.select ?? defaultSelect
  const statusReview = deps.statusReview ?? defaultStatusReview
  summary.reviewed = 0
  // What an earlier run already reviewed: content reviews by their family and scope; Status reviews by their lifecycle
  // children (and a failed Status review by its NOT_SENT record); a relist that sends holds that pair's content.
  const made = await prisma.$queryRaw<Array<{ kind: string; productId: string | null; scope: unknown; part: string | null; family: string | null
    channel: string | null; marketplace: string | null; account: string | null; action: string | null; changeCount: number | null }>>`
    SELECT kind, changes->>'productId' AS "productId", changes->'scope' AS scope, changes->>'part' AS part, "productId" AS family, channel, marketplace,
      "channelConnectionId" AS account, changes->>'action' AS action, "changeCount"
    FROM "BulkOperation" WHERE "batchId" = ${batchId} AND kind IN (${PUBLICATION_KIND}, ${LIFECYCLE_KIND})`
  const contentDone = new Set<string>(), statusDone = new Set<string>(), relisting = new Set<string>()
  for (const row of made) {
    if (row.kind === LIFECYCLE_KIND) {
      const key = statusPairKey(String(row.family ?? ''), { channel: row.channel, marketplace: row.marketplace, accountId: row.account })
      statusDone.add(key)
      if (row.action === 'relist' && Number(row.changeCount ?? 0) > 0) relisting.add(key)
    } else if (row.part === 'lifecycle') statusDone.add(statusPairKey(String(row.productId ?? ''), object(row.scope)))
    else contentDone.add(reviewPairKey(String(row.productId ?? ''), object(row.scope)))
  }
  const statusDue = (pair: ReviewPair) => !!status && !statusDone.has(statusPairKey(pair.familyId, pair.scope))
  const contentDue = (pair: ReviewPair) => content && !contentDone.has(reviewPairKey(pair.familyId, pair.scope))
  // One channel account at a time (its read rate), two accounts side by side.
  const groups = new Map<string, ReviewPair[]>()
  for (const pair of reviewPairs(families, destinations)) {
    if (!statusDue(pair) && !contentDue(pair)) continue
    const key = JSON.stringify([pair.scope.channel, pair.scope.accountId])
    groups.set(key, [...(groups.get(key) ?? []), pair])
  }
  // One-click O5 — where each family is listed, read once for the content still due (not needed when new listings
  // start as Active or Inactive: then a family not listed there is created). Unreadable: nothing is skipped.
  let presence: Map<string, FamilyPresenceRead> = new Map()
  const contentPairs = [...groups.values()].flat().filter(contentDue)
  if (content && !startAs && contentPairs.length) {
    try {
      presence = (await (deps.presence ?? readFamilyPresence)([...new Set(contentPairs.map(pair => pair.familyId))], destinations)).pairs
    } catch (error) {
      logger.warn('[publication-batch] listing presence unreadable; every family is reviewed', { batchId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await pool([...groups.values()], BATCH_GROUP_CONCURRENCY, async group => {
    for (const pair of group) {
      if (await stopped()) return
      await heartbeat()
      const statusKey = statusPairKey(pair.familyId, pair.scope)
      if (status && statusDue(pair)) {
        try {
          const reviewed = await statusReview(batchId, pair, status, header.userId, BATCH_REVIEW_TTL_MS)
          if (reviewed.children.some(child => child.action === 'relist' && child.sendCount > 0)) relisting.add(statusKey)
          summary.reviewed! += 1
        } catch (error) {
          await recordUnreviewed(batchId, pair, header.userId, error instanceof Error ? error.message : String(error), clock(), 'lifecycle')
          summary.notSent += 1
        }
      }
      if (!contentDue(pair)) continue
      // A listing being relisted gets a new item number: its changes wait for the next Publish.
      if (relisting.has(statusKey)) {
        await recordUnreviewed(batchId, pair, header.userId, CONTENT_HELD_FOR_RELIST, clock())
        summary.notSent += 1
        continue
      }
      // Not listed there, and nobody chose to create it: skipped, not reviewed as a new listing.
      const where = presence.get(statusKey)
      if (where?.presence === 'not_listed') {
        await recordNotListed(batchId, pair, header.userId, where.familySku, clock())
        summary.notListed = (summary.notListed ?? 0) + 1
        continue
      }
      let review: StudioPublishReview
      try {
        review = await preview(pair.familyId, pair.scope, header.userId, { batchId, expiresInMs: BATCH_REVIEW_TTL_MS, ...(startAs ? { startAs } : {}) })
      } catch (error) {
        await recordUnreviewed(batchId, pair, header.userId, error instanceof Error ? error.message : String(error), clock())
        summary.notSent += 1
        continue
      }
      summary.reviewed! += 1
      if (!review.id || !['AMAZON', 'EBAY'].includes(pair.scope.channel)) continue
      const row = await prisma.bulkOperation.findFirst({ where: { id: review.id }, select: childSelect })
      if (row?.status !== 'PREVIEW') continue // BLOCKED: the preview kept it with its reason
      const ids = defaultBatchSelection(review, keepChannelValues)
      if (!ids.length) {
        if (await markNotSent(row, keepChannelValues ? KEPT_NOTHING_TO_SEND : 'Every field already matches the channel.', clock(), { nothingToSend: true }))
          summary.notSent += 1
        continue
      }
      try {
        await select(pair.familyId, review.id, { selectedIds: ids }, header.userId)
      } catch (error) {
        if (await markNotSent(row, error instanceof Error ? error.message : String(error), clock())) summary.notSent += 1
      }
    }
  })
}

/** P11 — one family × destination for a Status review, whatever listing the scope names (a family has one per market). */
export const statusPairKey = (familyId: string, scope: { channel?: string | null; marketplace?: string | null; accountId?: string | null }) =>
  JSON.stringify([familyId, scope.channel ?? null, scope.marketplace ?? null, scope.accountId ?? null])

const STATUS_TARGETS = new Set(['active', 'inactive', 'ended'])
/** A review with nothing to send while "Keep channel values" is on. */
export const KEPT_NOTHING_TO_SEND = 'Every field Nexus changed already matches the channel. Values changed on the channel stay as they are (Keep channel values is on).'

/**
 * P11 — what a many-family batch was asked to do: content (the default without a Status), a Status target, or both; New
 * listings (ND4 B) — and how the listings the changes create start (`startAs`).
 * One-click O5 — Nexus wins unless "Keep channel values" (`keepChannelValues: true`). The older wire word
 * `replaceDiffers: false` (and every batch stored before O5, which saved it) means the same: keep the channel's values.
 */
export function manyOptionsOf(raw: unknown): ManyBatchOptions {
  const options = object(raw)
  const status = typeof options.status === 'string' && STATUS_TARGETS.has(options.status) ? options.status as ListedStatusTarget : null
  const keepChannelValues = typeof options.keepChannelValues === 'boolean' ? options.keepChannelValues : options.replaceDiffers === false
  return { keepChannelValues, status, content: typeof options.content === 'boolean' ? options.content : !status,
    startAs: isStartAsTarget(options.startAs) ? options.startAs : null }
}

async function defaultStatusReview(batchId: string, pair: ReviewPair, target: ListedStatusTarget, userId: string | null, ttlMs: number) {
  const { reviewStatusPair } = await import('./publish-plan.js')
  return reviewStatusPair(batchId, pair, target, userId, ttlMs)
}

/**
 * Send what the person reviewed. One channel account at a time; in it, Amazon publications of ONE market that are
 * two or more share feeds (`sendAmazonMergedGroup`); every other publication goes through the normal submit, as in
 * step 5 (one family to several markets keeps that exact path).
 * P6 — per account the children go in the send order (`SEND_ORDER`): Resume and Relist, the content, Pause, End,
 * Delete. Returns when the header must look again, if a lifecycle child another run started is still inside its lease.
 */
async function sendStage(batchId: string, header: ClaimedHeader, deps: BatchRunDeps, clock: () => Date, summary: BatchRunSummary, stopped: Stopped, heartbeat: Heartbeat): Promise<Date | null> {
  const submit = deps.submit ?? defaultSubmit
  const claim = deps.claim ?? defaultClaim
  const sendMerged = deps.sendMerged ?? defaultSendMerged
  const order: string[] = Array.isArray(object(header.changes).children) ? object(header.changes).children : []
  const rows = await prisma.bulkOperation.findMany({ where: { batchId, kind: { in: [PUBLICATION_KIND, LIFECYCLE_KIND] } }, select: childSelect, orderBy: { createdAt: 'asc' } })
  const rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at }
  rows.sort((a, b) => rank(a.id) - rank(b.id))
  // One channel account at a time, in the order the person chose the destinations.
  const groups = new Map<string, ChildRow[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.channel, row.channelConnectionId])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  let pendingUntil: Date | null = null
  const waitFor = (until: Date) => { if (!pendingUntil || until > pendingUntil) pendingUntil = until }
  const waiting = async (row: ChildRow) => (await prisma.bulkOperation.findFirst({ where: { id: row.id }, select: { status: true } }))?.status === 'PREVIEW'
  const refused = async (row: ChildRow, error: unknown) => {
    // The submit refuses before it claims (expired, stale, a gate, a blocking issue): the review is still PREVIEW.
    // Anything later is the submit's own stored result, or the sweep's (a claimed send never stays PREVIEW).
    const reason = error instanceof Error ? error.message : String(error)
    if (await markNotSent(row, reason, clock())) summary.notSent += 1
    else logger.warn('[publication-batch] a destination failed after it was claimed; its stored result or the result sweep settles it',
      { batchId, publicationId: row.id, error: reason })
  }
  const sendContent = async (group: ChildRow[]): Promise<boolean> => {
    const perMarket = new Map<string, ChildRow[]>()
    for (const row of group) if (row.channel === 'AMAZON') perMarket.set(String(row.marketplace), [...(perMarket.get(String(row.marketplace)) ?? []), row])
    const handled = new Set<string>()
    for (const row of group) {
      if (handled.has(row.id)) continue
      const market = row.channel === 'AMAZON' ? perMarket.get(String(row.marketplace)) ?? [] : []
      if (market.length > 1) {
        // Step 6 — several families to one Amazon market: claim each (in order), then one shared send.
        for (const member of market) handled.add(member.id)
        const claims: ClaimedPublication[] = []
        for (const member of market) {
          if (await stopped()) break
          await heartbeat()
          if (!await waiting(member)) { summary.skipped += 1; continue }
          const data = object(member.changes)
          try {
            const claimed = await claim(String(data.productId), member.id, object(data.batch).body ?? {}, member.userId)
            if ('result' in claimed) { summary.skipped += 1; continue }
            claims.push(claimed.claim)
          } catch (error) { await refused(member, error) }
        }
        if (claims.length) {
          await sendMerged(claims, heartbeat)
          summary.submitted += claims.length
          summary.merged = (summary.merged ?? 0) + claims.length
        }
        if (await stopped()) return false
        continue
      }
      handled.add(row.id)
      if (await stopped()) return false
      await heartbeat()
      if (!await waiting(row)) { summary.skipped += 1; continue }
      const data = object(row.changes)
      try {
        await submit(String(data.productId), row.id, object(data.batch).body ?? {}, row.userId)
        summary.submitted += 1
      } catch (error) { await refused(row, error) }
    }
    return true
  }
  await pool([...groups.values()], BATCH_GROUP_CONCURRENCY, async group => {
    for (const step of SEND_ORDER) {
      const children = group.filter(row => childStep(row) === step)
      if (!children.length) continue
      if (step === 'content') { if (!await sendContent(children)) return; continue }
      for (const row of children) {
        if (await stopped()) return
        const until = await sendLifecycle(batchId, row, deps, clock, summary, heartbeat)
        if (until) waitFor(until)
      }
    }
  })
  return pendingUntil
}

async function defaultExecute(previewId: string, opts: { actorUserId: string | null }) {
  const { executeListingAction } = await import('../listings/listing-action.service.js')
  return executeListingAction(previewId, opts)
}

async function defaultGate(channel: string) {
  const { listingActionGate } = await import('../listings/listing-action.service.js')
  return listingActionGate(channel)
}

async function defaultSettleValues(input: Parameters<SettleValues>[0]) {
  const { settleLifecycleValues } = await import('./publish-plan.js')
  return settleLifecycleValues(input)
}

/** Run `work` while renewing the header's heartbeat, so a long channel call never makes the batch look stopped. */
async function withHeartbeat<T>(heartbeat: Heartbeat, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => { void heartbeat().catch(() => undefined) }, LIFECYCLE_HEARTBEAT_MS)
  try { return await work() } finally { clearInterval(timer) }
}

/**
 * P6 — one lifecycle child. Only a child still in PREVIEW is sent: it is leased first, then the engine claims it
 * (PREVIEW → RUNNING) and runs it. A child RUNNING past its lease stopped mid-way: UNKNOWN, never sent again (its values
 * keep waiting). One still inside its lease belongs to another run: the batch waits for it (the returned time).
 */
async function sendLifecycle(batchId: string, row: ChildRow, deps: BatchRunDeps, clock: () => Date, summary: BatchRunSummary, heartbeat: Heartbeat): Promise<Date | null> {
  const execute = deps.execute ?? defaultExecute
  const gate = deps.gate ?? defaultGate
  const settleValues = deps.settleValues ?? defaultSettleValues
  await heartbeat()
  const now = clock()
  const fresh = await prisma.bulkOperation.findFirst({ where: { id: row.id }, select: { status: true, nextCheckAt: true } })
  if (fresh?.status === 'RUNNING') {
    if (fresh.nextCheckAt && fresh.nextCheckAt.getTime() > now.getTime()) return fresh.nextCheckAt
    const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'RUNNING', OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
      data: { status: 'UNKNOWN', completedAt: now, nextCheckAt: null, summary: json({ message: LIFECYCLE_UNKNOWN, unknown: true }) } })
    if (moved.count) {
      summary.unknown = (summary.unknown ?? 0) + 1
      announcePublication(row.id, row, object(row.changes), 'UNKNOWN', { terminal: true })
    }
    return null
  }
  if (fresh?.status !== 'PREVIEW') { summary.skipped += 1; return null }
  const closed = await gate(String(row.channel ?? ''))
  if (closed) {
    if (await markNotSent(row, closed, now)) summary.notSent += 1
    return null
  }
  const leased = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' }, data: { nextCheckAt: new Date(now.getTime() + LIFECYCLE_LEASE_MS) } })
  if (!leased.count) { summary.skipped += 1; return null }
  let result: ListingActionRunResult
  try {
    result = await withHeartbeat(heartbeat, () => execute(row.id, { actorUserId: row.userId }))
  } catch (error) {
    const after = await prisma.bulkOperation.findFirst({ where: { id: row.id }, select: { status: true, nextCheckAt: true } })
    const reason = error instanceof Error ? error.message : String(error)
    if (after?.status === 'PREVIEW') { if (await markNotSent(row, reason, clock())) summary.notSent += 1 }
    else if (after?.status === 'RUNNING') {
      // It was claimed and stopped mid-way: its lease decides (UNKNOWN once it ends; nothing is sent again).
      logger.warn('[publication-batch] a lifecycle change stopped after it was claimed; it becomes UNKNOWN when its lease ends', { batchId, previewId: row.id, error: reason })
      return after.nextCheckAt
    } else summary.skipped += 1
    return null
  }
  summary.lifecycle = (summary.lifecycle ?? 0) + 1
  await prisma.bulkOperation.updateMany({ where: { id: row.id, status: { not: 'RUNNING' } }, data: { nextCheckAt: null } })
  announcePublication(row.id, row, object(row.changes), result.status, { terminal: true })
  const batch = object(object(row.changes).batch)
  const values: LifecycleValue[] = Array.isArray(batch.values) ? batch.values : []
  if (values.length && batch.destination && typeof batch.familyId === 'string')
    await settleValues({ familyId: batch.familyId, destination: batch.destination as ListingActionDestination, values, result })
  return null
}
