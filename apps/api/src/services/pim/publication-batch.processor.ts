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
 */
import type { Prisma } from '@prisma/client'
import type { StudioPublishReview, StudioPublishScope, StudioPublishSelection, StudioPublishResult } from '@nexus/shared/studio-publication'
import { isPhotoChangeId } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { object } from './studio-publication-plan.js'
import { PUBLICATION_KIND, announcePublication, json } from './studio-publication-settle.js'
import type { ClaimedPublication } from './studio-publication.service.js'
import type { MergedSendOutcome } from './studio-publication-amazon-batch.js'

/*
 * Step 6 (item 6) — a batch of MANY families. The person picks products on the products list and the destinations;
 * the batch first REVIEWS every family × destination here (one review each, with its default ticks: only the fields
 * Nexus changed, SEND; DIFFERS only on request), then waits for the person (REVIEWED), then sends like step 5.
 * Both stages use the same header lease (QUEUED → RUNNING, heartbeat, resume), so the resume job resumes either;
 * `changes.stage` says which one a run does ('review' or 'send').
 */
export type BatchStage = 'review' | 'send'
export const batchStageOf = (changes: unknown): BatchStage => object(changes).stage === 'review' ? 'review' : 'send'

export const BATCH_KIND = 'publication-batch'
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
type Preview = (productId: string, scope: StudioPublishScope, userId: string | null, options: { batchId: string; expiresInMs: number }) => Promise<StudioPublishReview>
type Select = (productId: string, id: string, body: unknown, userId: string | null) => Promise<StudioPublishSelection>
export interface BatchRunDeps {
  submit?: Submit
  /** Step 6 — the claim half of the submit, for publications that share an Amazon feed. */
  claim?: Claim
  /** Step 6 — sends claimed Amazon publications of one account and market as shared feeds. */
  sendMerged?: SendMerged
  /** Step 6 — the review stage's preview and default selection. */
  preview?: Preview
  select?: Select
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
}

const childSelect = { id: true, status: true, userId: true, productId: true, channel: true, marketplace: true, channelConnectionId: true,
  aliasKey: true, batchId: true, changes: true } as const

/** The default submit, loaded when first needed (the studio publication module pulls in every channel). */
async function defaultSubmit(productId: string, id: string, body: unknown, userId: string | null) {
  const { submitStudioPublication } = await import('./studio-publication.service.js')
  return submitStudioPublication(productId, id, body, userId)
}

/** Children not started yet become CANCELLED: never sent. Returns how many. */
export async function cancelWaitingChildren(batchId: string, now = new Date()): Promise<number> {
  const waiting = await prisma.bulkOperation.findMany({ where: { batchId, kind: PUBLICATION_KIND, status: 'PREVIEW' }, select: childSelect })
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

/** A child the submit refused before anything was claimed: NOT_SENT, with the reason. Only while it is still PREVIEW. */
async function markNotSent(row: ChildRow, reason: string, now: Date, extra: Record<string, unknown> = {}): Promise<boolean> {
  const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'PREVIEW' },
    data: { status: 'NOT_SENT', completedAt: now, summary: json({ message: `Nothing was sent. ${reason}`, notSent: true, ...extra }) } })
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

async function defaultPreview(productId: string, scope: StudioPublishScope, userId: string | null, options: { batchId: string; expiresInMs: number }) {
  const { previewStudioPublication } = await import('./studio-publication.service.js')
  return previewStudioPublication(productId, scope, userId, options)
}

async function defaultSelect(productId: string, id: string, body: unknown, userId: string | null) {
  const { previewStudioPublicationSelection } = await import('./studio-publication.service.js')
  return previewStudioPublicationSelection(productId, id, body, userId)
}

/**
 * PURE. The fields a batch ticks for one review by default: what Nexus changed since the last accepted publish (SEND).
 * A field the channel holds differently (DIFFERS) is ticked only when the person asked to replace such values. A
 * photos-only review (other fields have problems) ticks only its photos.
 */
export function defaultBatchSelection(review: Pick<StudioPublishReview, 'changes' | 'photosOnly'>, replaceDiffers: boolean): string[] {
  const ids = (review.changes ?? []).filter(change => change.selectable && (change.selectedByDefault || (replaceDiffers && change.status === 'DIFFERS'))).map(change => change.id)
  return review.photosOnly ? ids.filter(id => isPhotoChangeId(id)) : ids
}

/** One family × destination of a review stage, as the header asked for it. */
export interface ReviewPair { familyId: string; scope: StudioPublishScope }
export const reviewPairKey = (familyId: string, scope: Partial<StudioPublishScope>) =>
  JSON.stringify([familyId, scope.channel ?? null, scope.marketplace ?? null, scope.accountId ?? null, scope.listingId ?? null])

/** PURE. Every family × destination, destination by destination, in the order the person chose them. */
export function reviewPairs(families: string[], destinations: StudioPublishScope[]): ReviewPair[] {
  return destinations.flatMap(scope => families.map(familyId => ({ familyId, scope })))
}

/** A family × destination the batch could not review: a child NOT_SENT with the reason (never sent, never in the history). */
async function recordUnreviewed(batchId: string, pair: ReviewPair, userId: string | null, reason: string, now: Date) {
  const { randomUUID } = await import('node:crypto')
  const id = randomUUID()
  const row = { productId: pair.familyId, channel: pair.scope.channel, marketplace: pair.scope.marketplace, channelConnectionId: pair.scope.accountId,
    aliasKey: null, batchId }
  const changes = { kind: PUBLICATION_KIND, productId: pair.familyId, scope: pair.scope, batch: { batchId }, reviewFailed: true }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'NOT_SENT', kind: PUBLICATION_KIND, ...row, productCount: 0, changeCount: 0, completedAt: now,
    summary: json({ message: `Nothing was sent. ${reason}`, notSent: true, notReviewed: true }), changes: json(changes) } })
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

  if (header.status === 'RUNNING') {
    if (stage === 'review') await reviewStage(batchId, header, deps, clock, summary, stopped, heartbeat)
    else await sendStage(batchId, header, deps, clock, summary, stopped, heartbeat)
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
 */
async function reviewStage(batchId: string, header: ClaimedHeader, deps: BatchRunDeps, clock: () => Date, summary: BatchRunSummary, stopped: Stopped, heartbeat: Heartbeat) {
  const request = object(object(header.changes).request)
  const families: string[] = Array.isArray(request.families) ? request.families.filter((id: unknown): id is string => typeof id === 'string') : []
  const destinations: StudioPublishScope[] = Array.isArray(request.destinations) ? request.destinations : []
  const replaceDiffers = object(request.options).replaceDiffers === true
  const preview = deps.preview ?? defaultPreview
  const select = deps.select ?? defaultSelect
  summary.reviewed = 0
  const made = await prisma.$queryRaw<Array<{ productId: string | null; scope: unknown }>>`
    SELECT changes->>'productId' AS "productId", changes->'scope' AS scope FROM "BulkOperation" WHERE "batchId" = ${batchId} AND kind = ${PUBLICATION_KIND}`
  const done = new Set(made.map(row => reviewPairKey(String(row.productId ?? ''), object(row.scope))))
  // One channel account at a time (its read rate), two accounts side by side.
  const groups = new Map<string, ReviewPair[]>()
  for (const pair of reviewPairs(families, destinations)) {
    if (done.has(reviewPairKey(pair.familyId, pair.scope))) continue
    const key = JSON.stringify([pair.scope.channel, pair.scope.accountId])
    groups.set(key, [...(groups.get(key) ?? []), pair])
  }
  await pool([...groups.values()], BATCH_GROUP_CONCURRENCY, async group => {
    for (const pair of group) {
      if (await stopped()) return
      await heartbeat()
      let review: StudioPublishReview
      try {
        review = await preview(pair.familyId, pair.scope, header.userId, { batchId, expiresInMs: BATCH_REVIEW_TTL_MS })
      } catch (error) {
        await recordUnreviewed(batchId, pair, header.userId, error instanceof Error ? error.message : String(error), clock())
        summary.notSent += 1
        continue
      }
      summary.reviewed! += 1
      if (!review.id || !['AMAZON', 'EBAY'].includes(pair.scope.channel)) continue
      const row = await prisma.bulkOperation.findFirst({ where: { id: review.id }, select: childSelect })
      if (row?.status !== 'PREVIEW') continue // BLOCKED: the preview kept it with its reason
      const ids = defaultBatchSelection(review, replaceDiffers)
      if (!ids.length) {
        if (await markNotSent(row, replaceDiffers ? 'Every field already matches the channel.' : 'Every field Nexus changed already matches the channel. Fields the channel holds differently are not replaced unless you choose to.', clock(), { nothingToSend: true }))
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

/**
 * Send what the person reviewed. One channel account at a time; in it, Amazon publications of ONE market that are
 * two or more share feeds (`sendAmazonMergedGroup`); every other publication goes through the normal submit, as in
 * step 5 (one family to several markets keeps that exact path).
 */
async function sendStage(batchId: string, header: ClaimedHeader, deps: BatchRunDeps, clock: () => Date, summary: BatchRunSummary, stopped: Stopped, heartbeat: Heartbeat) {
  const submit = deps.submit ?? defaultSubmit
  const claim = deps.claim ?? defaultClaim
  const sendMerged = deps.sendMerged ?? defaultSendMerged
  const order: string[] = Array.isArray(object(header.changes).children) ? object(header.changes).children : []
  const rows = await prisma.bulkOperation.findMany({ where: { batchId, kind: PUBLICATION_KIND }, select: childSelect, orderBy: { createdAt: 'asc' } })
  const rank = (id: string) => { const at = order.indexOf(id); return at < 0 ? order.length : at }
  rows.sort((a, b) => rank(a.id) - rank(b.id))
  // One channel account at a time, in the order the person chose the destinations.
  const groups = new Map<string, ChildRow[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.channel, row.channelConnectionId])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const waiting = async (row: ChildRow) => (await prisma.bulkOperation.findFirst({ where: { id: row.id }, select: { status: true } }))?.status === 'PREVIEW'
  const refused = async (row: ChildRow, error: unknown) => {
    // The submit refuses before it claims (expired, stale, a gate, a blocking issue): the review is still PREVIEW.
    // Anything later is the submit's own stored result, or the sweep's (a claimed send never stays PREVIEW).
    const reason = error instanceof Error ? error.message : String(error)
    if (await markNotSent(row, reason, clock())) summary.notSent += 1
    else logger.warn('[publication-batch] a destination failed after it was claimed; its stored result or the result sweep settles it',
      { batchId, publicationId: row.id, error: reason })
  }
  await pool([...groups.values()], BATCH_GROUP_CONCURRENCY, async group => {
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
        if (await stopped()) return
        continue
      }
      handled.add(row.id)
      if (await stopped()) return
      await heartbeat()
      if (!await waiting(row)) { summary.skipped += 1; continue }
      const data = object(row.changes)
      try {
        await submit(String(data.productId), row.id, object(data.batch).body ?? {}, row.userId)
        summary.submitted += 1
      } catch (error) { await refused(row, error) }
    }
  })
}
