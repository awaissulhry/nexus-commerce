import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * The inbound ledger — one writer for every channel (CX.4a).
 *
 * Before this, an inbound event was recorded only once it had already been accepted:
 * the Amazon SQS poll wrote a row per message, and the eBay receiver wrote nothing at
 * all unless the payload passed a check that could never pass. A rejected notification
 * left a `logger.warn` and a 204, which is to say it left nothing an operator could
 * find later.
 *
 * So the rule here is that arrival is what creates the row, not acceptance. A
 * notification we could not verify is a row with `signatureOk = false` and a reason;
 * a notification on a transport that carries no signature is a row with
 * `signatureOk = null` and the name of what did establish trust. Both can be counted.
 * Neither can be confused for the other.
 */
import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { canReplayInbound } from './handlers.js'

export type InboundStatus = 'pending' | 'done' | 'failed' | 'dlq'

const unclaimedUnverifiedEbay: Prisma.WebhookEventWhereInput = {
  channel: 'EBAY', leaseToken: null,
  OR: [{ signatureOk: false }, { signatureOk: null }, { verifiedBy: { not: 'ebay_ecdsa' } }, { verifiedBy: null }],
}

/** What established trust for this event, or that nothing did. */
export type VerifiedBy = 'ebay_ecdsa' | 'sqs_iam' | 'shopify_hmac' | 'none'

/** A retry cannot turn an audit record of a rejected delivery into trusted work. */
export function isVerifiedInbound(event: { channel: string; signatureOk?: boolean | null; verifiedBy?: string | null }): boolean {
  return event.signatureOk === true || (
    event.signatureOk === null && event.verifiedBy === 'sqs_iam' &&
    (event.channel === 'AMAZON' || event.channel === 'AMAZON_ADS')
  )
}

/** `isVerifiedInbound` as a query filter, for conditional updates that must re-check trust. */
export const VERIFIED_INBOUND_WHERE: Prisma.WebhookEventWhereInput = { OR: [
  { signatureOk: true },
  { signatureOk: null, verifiedBy: 'sqs_iam', channel: { in: ['AMAZON', 'AMAZON_ADS'] } },
] }

/**
 * Exact request bytes are kept so a signature can be re-verified later, when a
 * delivery is disputed. Bounded: a larger body keeps only its digest and payload.
 */
const MAX_RAW_BODY_BYTES = 1024 * 1024

/** Headers that carry a delivery's identity or signature. Never credentials. */
const VERIFICATION_HEADERS = new Set([
  'x-shopify-hmac-sha256', 'x-shopify-webhook-id', 'x-shopify-topic', 'x-shopify-shop-domain',
  'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-ebay-signature',
])
const MAX_VERIFICATION_HEADER_LENGTH = 8192

function verificationHeadersOf(headers: InboundRecord['headers']): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] =>
    VERIFICATION_HEADERS.has(entry[0].toLowerCase()) &&
    typeof entry[1] === 'string' && entry[1].length <= MAX_VERIFICATION_HEADER_LENGTH))
}

interface InboundRecordFields {
  channel: string
  eventType: string
  /** The channel's own id when it gives one; a body digest is used when it does not. */
  externalId?: string | null
  rawBody?: Buffer | null
  headers?: Record<string, string | string[] | undefined>
  payload: unknown
  /** true = checked and passed · false = checked and failed · null = nothing to check. */
  signatureOk: boolean | null
  verifiedBy: VerifiedBy
  connectionId?: string | null
  providerTimestamp?: Date | null
  lastError?: string | null
  status?: InboundStatus
}

/** Existing inline/broker flows stay opt-out; only eBay is being moved to this queue. */
export type InboundRecord = InboundRecordFields & (
  { queueForRetry?: false } | { channel: 'EBAY'; queueForRetry: true }
)

export interface InboundWriteResult {
  id: string | null
  duplicate: boolean
  /** The delivery ID is already bound to different account/event/trust metadata. */
  conflict?: 'identity_mismatch'
  /**
   * The status the row ALREADY had, when this arrival was a duplicate.
   *
   * A receiver needs it to tell two very different redeliveries apart. A channel
   * resends an event both when it never heard an answer and when we answered with a
   * failure — the delivery id is identical in each case. Without this, "we have seen
   * this id" reads as "this is handled", and a retry the channel sent BECAUSE our
   * first attempt failed gets a cheerful 200 and is never handled at all.
   */
  existingStatus?: InboundStatus
}

/** A receiver's words for a write that returned no receipt: an identity refusal is not an outage. */
export function inboundNotRecorded(result: Pick<InboundWriteResult, 'conflict'>): string {
  return result.conflict === 'identity_mismatch'
    ? 'the delivery ID is already bound to another account, event type or trust verdict'
    : 'the inbound ledger is unavailable'
}

export function digestOf(body: Buffer | string | null | undefined): string | null {
  if (body === null || body === undefined) return null
  return crypto.createHash('sha256').update(body).digest('hex')
}

/**
 * Write one arrival. Idempotent on `(channel, externalId)`: a redelivery does not
 * rewrite the original verdict, it only increments `deliveries`, so "how often did this
 * arrive" and "what did we decide the first time" stay separately answerable.
 *
 * A unique insert chooses the first receipt atomically. A concurrent redelivery
 * increments only that receipt's delivery count, with its identity guarded in the
 * same UPDATE. No read-before-insert race, overwritten payload or spent retry.
 *
 * A null ID is a refusal to acknowledge durable receipt; callers must retain/retry
 * the delivery. Expected conflicts never pass through Prisma's error logger with
 * the inbound payload as part of a failed INSERT diagnostic.
 */
export async function recordInbound(rec: InboundRecord): Promise<InboundWriteResult> {
  return persistInbound(prisma, rec)
}

/** A quarantine handoff must commit its business receipt and destination pointer together. */
export async function recordInboundInTx(tx: Prisma.TransactionClient, rec: InboundRecord,
  history?: { receivedAt: Date; deliveries: number },
): Promise<InboundWriteResult> {
  return persistInbound(tx, rec, history)
}

type LedgerClient = Pick<Prisma.TransactionClient, 'webhookEvent' | 'channelConnection' | '$queryRaw'>

/**
 * Is an arrival under `next` the same delivery as the one stored under `stored`? The account
 * is the identity, not the connection row: a delivery recorded before its shop had a route
 * (NULL) or under an earlier row of the same account (disconnect, then a fresh Connect) is the
 * same delivery, and binds to the arriving row. An arrival with no route keeps the stored
 * binding. Two rows that cannot be shown to be one account are different identities.
 */
async function redeliveryBinding(db: LedgerClient, stored: string | null, next: string | null): Promise<'keep' | 'bind' | 'mismatch'> {
  if (stored === next || next === null) return 'keep'
  if (stored === null) return 'bind'
  const rows = await db.channelConnection.findMany({ where: { id: { in: [stored, next] } }, select: { id: true, channelType: true, externalAccountId: true } })
  const [a, b] = [rows.find(row => row.id === stored), rows.find(row => row.id === next)]
  return a && b && a.channelType === b.channelType && a.externalAccountId && a.externalAccountId === b.externalAccountId ? 'bind' : 'mismatch'
}

async function persistInbound(db: LedgerClient, rec: InboundRecord,
  history?: { receivedAt: Date; deliveries: number },
): Promise<InboundWriteResult> {
  const payloadDigest = digestOf(rec.rawBody ?? null)
  const externalId =
    rec.externalId && rec.externalId !== ''
      ? rec.externalId
      : payloadDigest
        ? `sha256:${payloadDigest}`
        : `unidentified:${crypto.randomUUID()}`
  const status: InboundStatus = rec.status ?? (rec.signatureOk === false ? 'failed' : 'pending')
  // A trusted arrival with a handler is due at once. The receiver claims it inline;
  // if that process dies first, the retry worker finds it due and claims it instead.
  // Never eBay: its receipts belong to the eBay processor, which schedules them itself
  // (queueForRetry below) and holds admitted receipts unscheduled while processing is off.
  const dueNow = String(rec.channel) !== 'EBAY' && status === 'pending' && isVerifiedInbound(rec) && canReplayInbound(rec.channel, rec.eventType)

  try {
    if (rec.queueForRetry && String(rec.channel) !== 'EBAY') {
      logger.error('[cx-ingress] durable receipt scheduling is not configured for this channel', { channel: rec.channel })
      return { id: null, duplicate: false }
    }
    let nextAttemptAt: Date | null = dueNow ? new Date() : null
    if (rec.queueForRetry && rec.signatureOk === true && rec.verifiedBy === 'ebay_ecdsa' && status === 'pending') {
      const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
      nextAttemptAt = clock.now
    }
    const id = crypto.randomUUID()
    const inserted = await db.webhookEvent.createMany({
      skipDuplicates: true,
      data: {
        id,
        channel: rec.channel,
        eventType: rec.eventType,
        externalId,
        payload: (rec.payload ?? {}) as never,
        isProcessed: status === 'done',
        processedAt: status === 'done' ? new Date() : null,
        providerTimestamp: rec.providerTimestamp ?? null,
        connectionId: rec.connectionId ?? null,
        status,
        nextAttemptAt,
        deliveries: history?.deliveries ?? 1,
        ...(history ? { createdAt: history.receivedAt } : {}),
        signatureOk: rec.signatureOk,
        verifiedBy: rec.verifiedBy,
        payloadDigest,
        rawBody: rec.rawBody && rec.rawBody.length <= MAX_RAW_BODY_BYTES ? Uint8Array.from(rec.rawBody) : null,
        verificationHeaders: verificationHeadersOf(rec.headers),
        lastError: rec.lastError ?? null,
        error: rec.lastError ?? null,
      },
    })
    if (inserted.count === 1) return { id, duplicate: false }

    // A redelivery. Event type and trust verdict must match exactly; the account is compared as
    // an identity (redeliveryBinding). The UPDATE is conditional on the connection read, so of
    // concurrent redeliveries one binds and the rest are re-evaluated against that binding.
    const key = workspaceKey({ channel: rec.channel, externalId })
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await db.webhookEvent.findUnique({ where: { channel_externalId: key },
        select: { id: true, status: true, eventType: true, connectionId: true, signatureOk: true, verifiedBy: true } })
      if (!stored) break
      const binding = stored.eventType === rec.eventType && stored.signatureOk === rec.signatureOk && stored.verifiedBy === (rec.verifiedBy ?? null)
        ? await redeliveryBinding(db, stored.connectionId, rec.connectionId ?? null)
        : 'mismatch'
      if (binding === 'mismatch') {
        logger.warn('[cx-ingress] delivery identity conflicts with its stored receipt', { channel: rec.channel, eventType: rec.eventType })
        return { id: null, duplicate: true, conflict: 'identity_mismatch' }
      }
      try {
        const existing = await db.webhookEvent.update({
          where: { channel_externalId: key, eventType: rec.eventType, signatureOk: rec.signatureOk, verifiedBy: rec.verifiedBy, connectionId: stored.connectionId },
          data: { deliveries: { increment: history?.deliveries ?? 1 }, ...(binding === 'bind' ? { connectionId: rec.connectionId ?? null } : {}) },
          select: { id: true, status: true },
        })
        return { id: existing.id, duplicate: true, existingStatus: existing.status as InboundStatus }
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2025') throw err
        // The stored binding changed since it was read: evaluate the arrival against the new one.
      }
    }
    return { id: null, duplicate: false }
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    logger.error('[cx-ingress] could not record an inbound event', {
      channel: rec.channel,
      eventType: rec.eventType,
      code: typeof code === 'string' && /^P\d{4}$/.test(code) ? code : 'unavailable',
    })
    return { id: null, duplicate: false }
  }
}

/**
 * How many handling attempts an event gets before it goes to dead letters.
 *
 * The number is a budget, not a guess about how long a channel is down: the backoff
 * below stretches 5 attempts over roughly 8 hours, which is long enough for a channel
 * outage or a deploy and short enough that an operator sees the dead letter the same
 * day rather than the next week.
 */
export const MAX_INBOUND_ATTEMPTS = 5

/**
 * Wait before attempt number `attempts + 1`: 1, 2, 4, 8 minutes, capped at 6 hours.
 *
 * The cap matters more than the curve. Without it the eighth attempt of a long-dead
 * event would be scheduled beyond the retention of anything an operator could use to
 * diagnose it.
 */
export function inboundBackoffMs(attempts: number): number {
  const step = 60_000 * Math.pow(2, Math.max(0, attempts - 1))
  return Math.min(step, 6 * 60 * 60 * 1000)
}

/**
 * Mark an event processed, or failed with a reason.
 *
 * P2.1 — a failure now also SCHEDULES. Before this it set `status = 'failed'` and
 * stopped, so `nextAttemptAt` stayed null on every row in the table and a failed event
 * was indistinguishable from an abandoned one. A failure that has spent its attempts
 * becomes a dead letter; a failure with attempts left gets a time to be tried again.
 *
 * Deciding here rather than in the worker means the state is correct from the moment
 * the failure is known, even if the worker never runs — an operator reading the table
 * sees `dlq` or a due time, never a row that merely says `failed` forever.
 */
export async function completeInbound(id: string | null, ok: boolean, error?: string): Promise<void> {
  if (!id) return
  try {
    if (ok) {
      await prisma.webhookEvent.update({
        where: { id, channel: { not: 'EBAY' }, processingToken: null },
        data: { status: 'done', isProcessed: true, processedAt: new Date(), nextAttemptAt: null, lastError: null },
      })
      return
    }
    const row = await prisma.webhookEvent.findUnique({ where: { id }, select: { attempts: true, channel: true, processingToken: true } })
    // One owner per row: the eBay processor finishes eBay receipts, a claim holder finishes its claim.
    if (row?.channel === 'EBAY' || row?.processingToken) return
    const attempts = (row?.attempts ?? 0) + 1
    const exhausted = attempts >= MAX_INBOUND_ATTEMPTS
    const reason = (error ?? 'unknown').slice(0, 500)
    await prisma.webhookEvent.update({
      where: { id, channel: { not: 'EBAY' }, processingToken: null, attempts: row?.attempts ?? 0 },
      data: {
        status: exhausted ? 'dlq' : 'failed',
        attempts,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + inboundBackoffMs(attempts)),
        lastError: reason,
        error: reason,
      },
    })
  } catch (err) {
    logger.warn('[cx-ingress] could not close out an inbound event', { id, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Thrown by a handler whose event must wait WITHOUT spending an attempt (an account that must be
 * signed in again, say): C5's rule for sign-in holds, applied to inbound. The claim that runs the
 * handler (`runWithInboundClaim`) reschedules the row after `delayMs` and gives the attempt back;
 * callers report it as deferred, never as a failure. Retrying cannot fix an account that needs its
 * owner, and burning the attempts on it would dead-letter real orders while the owner reconnects.
 */
export class InboundDeferred extends Error {
  constructor(message: string, readonly delayMs: number) {
    super(message)
    this.name = 'InboundDeferred'
  }
}

/**
 * Move an event to dead letters now, without spending the remaining attempts.
 *
 * For failures that retrying cannot fix — an event type nothing knows how to replay,
 * a payload that is not the shape it claims. Retrying those five times would only
 * delay the moment an operator learns the event needs a human.
 */
export async function deadLetterInbound(id: string, reason: string): Promise<void> {
  try {
    await prisma.webhookEvent.update({
      where: { id, processingToken: null, OR: [{ channel: { not: 'EBAY' } }, unclaimedUnverifiedEbay] },
      data: { status: 'dlq', isProcessed: false, processedAt: null, nextAttemptAt: null, lastError: reason.slice(0, 500), error: reason.slice(0, 500) },
    })
  } catch (err) {
    logger.warn('[cx-ingress] could not dead-letter an inbound event', { id, error: err instanceof Error ? err.message : String(err) })
  }
}

export interface DueInboundEvent {
  id: string
  workspaceId: string
  channel: string
  eventType: string
  externalId: string
  payload: unknown
  attempts: number
  signatureOk: boolean | null
  verifiedBy: string | null
  /**
   * The connected account this event arrived on, recorded by the receiver.
   *
   * A replay runs from the STORED payload, which is the channel's own body and names
   * no Nexus account. Without this a handler has to work the account out for itself,
   * and "the only connected account" is exactly the ambient lookup the MAP.3 ratchet
   * forbids — it is how a write lands in the wrong store the day a second account is
   * connected. The ledger already knew; it just was not being asked.
   */
  connectionId: string | null
}

/**
 * Events that are due to be tried again — not archived, and past their time.
 *
 * `nextAttemptAt` is the queue, not the status. A failure that backed off is `failed`
 * with a time; an event an operator replayed is `pending` with a time; a trusted
 * arrival with a handler is `pending` and due the moment it is written, so a receiver
 * that dies before handling it cannot strand it. A claimed event's time is its lease
 * expiry (see `claims.ts`): it becomes due again only if its owner stops renewing.
 * Rows with no time are finished, dead letters, or have nothing to run. Selecting on
 * the time rather than on one status is what keeps a replayed event from sitting in
 * the table forever waiting for a sweep that only looks at failures.
 *
 * Rows stranded before claims existed (`pending`, no time) are deliberately NOT
 * collected: replaying a weeks-old delivery could write stale state over newer data.
 * They stay visible in Sync Logs, where an operator can replay each one on purpose.
 *
 * Ordered by `nextAttemptAt` so the longest-waiting event goes first, and limited so
 * one sweep cannot hold the worker open indefinitely when a channel has been down.
 *
 * Scoped to the CALLER's workspace, and deliberately not written as raw SQL. A raw
 * query is invisible to the scoping client and is filtered only by the database's own
 * row policy, so the first end-to-end run of this sweep returned zero rows every time
 * while the table held a due event — a worker that looked like it had nothing to do
 * and in fact could not see anything. The model API is scoped by the client, which is
 * the layer the rest of this file already trusts.
 *
 * Reaching every business is the cron wrapper's job, not this function's: a non-platform
 * schedule visits each active profile in turn and runs its handler inside that profile.
 */
export async function dueInboundEvents(limit = 50, now: Date = new Date(), options?: { excludeVerifiedEbay: boolean }): Promise<DueInboundEvent[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ['failed', 'pending'] },
      archivedAt: null,
      nextAttemptAt: { not: null, lte: now },
      ...(options?.excludeVerifiedEbay ? { OR: [{ channel: { not: 'EBAY' } }, unclaimedUnverifiedEbay] } : {}),
    },
    select: { id: true, workspaceId: true, channel: true, eventType: true, externalId: true, payload: true, attempts: true, connectionId: true, signatureOk: true, verifiedBy: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  })
  return rows as unknown as DueInboundEvent[]
}

export interface ReplayRequest {
  id: string
  /** Set when the caller is scoped to one workspace; a mismatch refuses the replay. */
  workspaceId?: string | null
}

export type ReplayRefusal = 'not_found' | 'wrong_workspace' | 'archived' | 'already_pending' | 'unverified' | 'changed' | 'processing_held'

/**
 * One shape rather than a discriminated union on `ok`.
 *
 * This package compiles with `strict: false`, where a union keyed on a BOOLEAN literal
 * does not narrow — `if (!outcome.ok)` leaves the full union in place and every read of
 * `reason` is an error. An optional field says the same thing and survives the
 * compiler settings this codebase actually uses.
 */
export interface ReplayOutcome {
  ok: boolean
  /** Set only when `ok` is false. */
  reason?: ReplayRefusal
  channel?: string
  eventType?: string
}

/**
 * Put a dead letter (or a failed event) back in the queue by hand.
 *
 * Attempts go back to zero — the operator is asserting that whatever broke is fixed,
 * so the event deserves a full budget rather than the one attempt its old count left.
 * `deliveries` is untouched: how often the channel sent this event is history and no
 * button should be able to rewrite it.
 *
 * Decision D8 — the row is never deleted and never copied. The same row goes round
 * again, so its whole life stays on one line an operator can read.
 */
export async function replayInbound(req: ReplayRequest): Promise<ReplayOutcome> {
  const row = await prisma.webhookEvent.findUnique({
    where: { id: req.id },
    select: { id: true, workspaceId: true, channel: true, eventType: true, status: true, archivedAt: true, nextAttemptAt: true, signatureOk: true, verifiedBy: true, processingToken: true, processingUntil: true },
  })
  if (!row) return { ok: false, reason: 'not_found' }
  if (req.workspaceId && row.workspaceId !== req.workspaceId) return { ok: false, reason: 'wrong_workspace' }
  if (!isVerifiedInbound(row)) return { ok: false, reason: 'unverified' }
  if (row.archivedAt) return { ok: false, reason: 'archived' }
  if (row.channel === 'EBAY') {
    const { queueEbayReplay } = await import('./ebay-claims.js')
    return queueEbayReplay(req)
  }
  // The worker recovers expired claims. A manual request never overrides a
  // claimant based on a potentially skewed HTTP-container clock.
  if (row.processingToken) return { ok: false, reason: 'already_pending' }
  // Refuse only what is ALREADY in the worker's queue. A `pending` row with no time
  // on it is not queued for anything — that is the shape a receiver leaves behind when
  // it dies between recording an arrival and handling it, and replay is the only way
  // such an event can be expedited before automatic historical recovery. Refusing every `pending` row would have made the
  // one case the button exists for the one case it could not touch.
  if (row.status === 'pending' && row.nextAttemptAt) return { ok: false, reason: 'already_pending' }
  const saved = await prisma.webhookEvent.updateMany({
    where: { id: row.id, workspaceId: row.workspaceId, channel: row.channel, status: row.status, archivedAt: null,
      nextAttemptAt: row.nextAttemptAt, processingToken: row.processingToken, processingUntil: row.processingUntil,
      signatureOk: row.signatureOk, verifiedBy: row.verifiedBy },
    data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null, isProcessed: false, processedAt: null, processingToken: null, processingUntil: null },
  })
  if (saved.count !== 1) {
    const current = await prisma.webhookEvent.findUnique({ where: { id: row.id }, select: { archivedAt: true, processingToken: true } })
    return { ok: false, reason: !current ? 'not_found' : current.archivedAt ? 'archived' : current.processingToken ? 'already_pending' : 'changed' }
  }
  return { ok: true, channel: row.channel, eventType: row.eventType }
}
