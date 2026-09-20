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
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'

export type InboundStatus = 'pending' | 'done' | 'failed' | 'dlq'

/** What established trust for this event, or that nothing did. */
export type VerifiedBy = 'ebay_ecdsa' | 'sqs_iam' | 'shopify_hmac' | 'none'

export interface InboundRecord {
  channel: string
  eventType: string
  /** The channel's own id when it gives one; a body digest is used when it does not. */
  externalId?: string | null
  rawBody?: Buffer | null
  payload: unknown
  /** true = checked and passed · false = checked and failed · null = nothing to check. */
  signatureOk: boolean | null
  verifiedBy: VerifiedBy
  connectionId?: string | null
  providerTimestamp?: Date | null
  lastError?: string | null
  status?: InboundStatus
}

export interface InboundWriteResult {
  id: string | null
  duplicate: boolean
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

export function digestOf(body: Buffer | string | null | undefined): string | null {
  if (body === null || body === undefined) return null
  return crypto.createHash('sha256').update(body).digest('hex')
}

/**
 * Write one arrival. Idempotent on `(channel, externalId)`: a redelivery does not
 * rewrite the original verdict, it only increments `deliveries`, so "how often did this
 * arrive" and "what did we decide the first time" stay separately answerable.
 *
 * Never throws. An ingress endpoint that 500s because its audit trail is unavailable
 * would turn a logging problem into dropped notifications — and eBay marks an endpoint
 * down when it stops answering.
 */
export async function recordInbound(rec: InboundRecord): Promise<InboundWriteResult> {
  const payloadDigest = digestOf(rec.rawBody ?? null)
  const externalId =
    rec.externalId && rec.externalId !== ''
      ? rec.externalId
      : payloadDigest
        ? `sha256:${payloadDigest}`
        : `unidentified:${crypto.randomUUID()}`
  const status: InboundStatus = rec.status ?? (rec.signatureOk === false ? 'failed' : 'pending')

  try {
    const existing = await prisma.webhookEvent.findUnique({
      where: { channel_externalId: workspaceKey({ channel: rec.channel, externalId }) },
      select: { id: true, status: true },
    })
    if (existing) {
      // P2.1 — a redelivery is an ARRIVAL, not a handling attempt. Before this it
      // incremented `attempts`, which the retry worker now uses as its budget: a
      // channel that redelivers eagerly would have spent the retry budget of an event
      // nobody had tried to handle even once.
      await prisma.webhookEvent.update({
        where: { id: existing.id },
        data: { deliveries: { increment: 1 } },
      })
      return { id: existing.id, duplicate: true, existingStatus: existing.status as InboundStatus }
    }
    const row = await prisma.webhookEvent.create({
      data: {
        channel: rec.channel,
        eventType: rec.eventType,
        externalId,
        payload: (rec.payload ?? {}) as never,
        isProcessed: status === 'done',
        processedAt: status === 'done' ? new Date() : null,
        providerTimestamp: rec.providerTimestamp ?? null,
        connectionId: rec.connectionId ?? null,
        status,
        deliveries: 1,
        signatureOk: rec.signatureOk,
        verifiedBy: rec.verifiedBy,
        payloadDigest,
        lastError: rec.lastError ?? null,
        error: rec.lastError ?? null,
      },
      select: { id: true },
    })
    return { id: row.id, duplicate: false }
  } catch (err) {
    logger.error('[cx-ingress] could not record an inbound event', {
      channel: rec.channel,
      eventType: rec.eventType,
      error: err instanceof Error ? err.message : String(err),
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
        where: { id },
        data: { status: 'done', isProcessed: true, processedAt: new Date(), nextAttemptAt: null, lastError: null },
      })
      return
    }
    const row = await prisma.webhookEvent.findUnique({ where: { id }, select: { attempts: true } })
    const attempts = (row?.attempts ?? 0) + 1
    const exhausted = attempts >= MAX_INBOUND_ATTEMPTS
    const reason = (error ?? 'unknown').slice(0, 500)
    await prisma.webhookEvent.update({
      where: { id },
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
 * Move an event to dead letters now, without spending the remaining attempts.
 *
 * For failures that retrying cannot fix — an event type nothing knows how to replay,
 * a payload that is not the shape it claims. Retrying those five times would only
 * delay the moment an operator learns the event needs a human.
 */
export async function deadLetterInbound(id: string, reason: string): Promise<void> {
  try {
    await prisma.webhookEvent.update({
      where: { id },
      data: { status: 'dlq', nextAttemptAt: null, lastError: reason.slice(0, 500), error: reason.slice(0, 500) },
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
}

/**
 * Events that are due to be tried again — not archived, and past their time.
 *
 * `nextAttemptAt` is the queue, not the status. A failure that backed off is `failed`
 * with a time; an event an operator replayed is `pending` with a time. Both belong to
 * the worker, and neither can be confused with the far larger set of rows that carry
 * no time at all: a fresh arrival being handled inline, a finished event, a dead
 * letter. Selecting on the time rather than on one status is what keeps a replayed
 * event from sitting in the table forever waiting for a sweep that only looks at
 * failures.
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
export async function dueInboundEvents(limit = 50, now: Date = new Date()): Promise<DueInboundEvent[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ['failed', 'pending'] },
      archivedAt: null,
      nextAttemptAt: { not: null, lte: now },
    },
    select: { id: true, workspaceId: true, channel: true, eventType: true, externalId: true, payload: true, attempts: true },
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

export type ReplayRefusal = 'not_found' | 'wrong_workspace' | 'archived' | 'already_pending'

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
    select: { id: true, workspaceId: true, channel: true, eventType: true, status: true, archivedAt: true, nextAttemptAt: true },
  })
  if (!row) return { ok: false, reason: 'not_found' }
  if (req.workspaceId && row.workspaceId !== req.workspaceId) return { ok: false, reason: 'wrong_workspace' }
  if (row.archivedAt) return { ok: false, reason: 'archived' }
  // Refuse only what is ALREADY in the worker's queue. A `pending` row with no time
  // on it is not queued for anything — that is the shape a receiver leaves behind when
  // it dies between recording an arrival and handling it, and replay is the only way
  // such an event ever moves again. Refusing every `pending` row would have made the
  // one case the button exists for the one case it could not touch.
  if (row.status === 'pending' && row.nextAttemptAt) return { ok: false, reason: 'already_pending' }
  await prisma.webhookEvent.update({
    where: { id: row.id },
    data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null, isProcessed: false, processedAt: null },
  })
  return { ok: true, channel: row.channel, eventType: row.eventType }
}
