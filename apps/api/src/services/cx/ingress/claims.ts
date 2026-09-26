/**
 * Processing claims for inbound events — one owner at a time, and nothing stranded.
 *
 * Before this, a receiver recorded an arrival as `pending` and then handled it inline.
 * A process that died between the two left a verified event nobody would ever run, and
 * a manual replay could run the handler while the receiver was still running it.
 *
 * Now every execution path (receiver, retry worker, manual replay) first claims the row:
 * a conditional update that sets a random token and a lease. Only the token holder may
 * finish the row, and only while its lease is live. A lease that expires makes the row
 * due again for the retry worker, and the old owner can no longer complete it.
 *
 * A lease is not exactly-once: a handler that outlives its lease (or a process paused
 * past it) can overlap the next owner. Handlers must stay idempotent, as they already
 * had to be for channel redeliveries.
 *
 * All times come from the database clock, so replicas with skewed clocks agree on
 * whether a lease has expired.
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inboundBackoffMs, InboundDeferred, isVerifiedInbound, MAX_INBOUND_ATTEMPTS, VERIFIED_INBOUND_WHERE } from './ledger.js'

/** How long one claim lasts without renewal. Renewed every LEASE_RENEWAL_MS while the handler runs. */
const LEASE_MS = 5 * 60_000
const LEASE_RENEWAL_MS = 60_000

export const inboundDatabaseNow = async (): Promise<Date> =>
  (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`)[0].now

/** What a claim holder may run: the row's own verified payload and account, never the caller's copy. */
export interface InboundClaim {
  id: string
  token: string
  attempt: number
  payload: unknown
  connectionId: string | null
  eventType: string
  channel: string
}

/**
 * Claim an event for one attempt, or return null when it is not claimable now: missing,
 * archived, unverified, finished, owned by a live lease, or waiting for its backoff.
 *
 * The update is conditional on every field read, so of any number of concurrent callers
 * exactly one wins. The attempt is spent when work starts, so a handler that crashes
 * the process still uses up budget, and a poison event reaches dead letters.
 */
export async function claimInbound(id: string, now?: Date): Promise<InboundClaim | null> {
  now ??= await inboundDatabaseNow()
  const row = await prisma.webhookEvent.findUnique({ where: { id } })
  // One owner per row type: eBay rows belong to the eBay processor (ebay-claims.ts leases),
  // never to this claimant, whatever their trust or schedule.
  if (!row || row.channel === 'EBAY' || row.archivedAt || !isVerifiedInbound(row) || !['pending', 'failed'].includes(row.status)) return null
  if (row.processingUntil && row.processingUntil > now) return null
  if (row.nextAttemptAt && row.nextAttemptAt > now) return null

  const unchanged: Prisma.WebhookEventWhereInput = {
    id, channel: { not: 'EBAY' }, status: row.status, archivedAt: null, attempts: row.attempts,
    processingToken: row.processingToken, processingUntil: row.processingUntil, leaseToken: null,
    nextAttemptAt: row.nextAttemptAt, AND: [VERIFIED_INBOUND_WHERE],
  }
  if (row.attempts >= MAX_INBOUND_ATTEMPTS) {
    // Reached only through an interrupted last attempt: a completed one finishes as dlq.
    await prisma.webhookEvent.updateMany({ where: unchanged, data: {
      status: 'dlq', isProcessed: false, nextAttemptAt: null,
      processingToken: null, processingUntil: null,
      lastError: 'Processing attempts exhausted after an interrupted delivery.',
    } })
    return null
  }

  const token = randomUUID()
  const leaseEnd = new Date(now.getTime() + LEASE_MS)
  const claimed = await prisma.webhookEvent.updateMany({ where: unchanged, data: {
    // nextAttemptAt = lease end: if the owner dies, the retry worker finds the row due then.
    status: 'pending', attempts: { increment: 1 }, processingToken: token,
    processingUntil: leaseEnd, nextAttemptAt: leaseEnd, isProcessed: false, processedAt: null,
  } })
  if (claimed.count !== 1) return null
  return {
    id, token, attempt: row.attempts + 1,
    payload: row.payload, connectionId: row.connectionId, eventType: row.eventType, channel: row.channel,
  }
}

/** The row as its claim left it: same token and attempt, lease still live. */
function stillOwned(claim: InboundClaim, now: Date): Prisma.WebhookEventWhereInput {
  return {
    id: claim.id, channel: { not: 'EBAY' }, status: 'pending', archivedAt: null, processingToken: claim.token,
    attempts: claim.attempt, processingUntil: { gt: now }, AND: [VERIFIED_INBOUND_WHERE],
  }
}

/**
 * Finish a claimed attempt: done, retry after backoff, or dead letter once the budget is
 * spent. Returns false when the claim was lost; the row then belongs to someone else.
 */
export async function finishInboundClaim(claim: InboundClaim, ok: boolean, error?: string, now?: Date): Promise<boolean> {
  now ??= await inboundDatabaseNow()
  const exhausted = claim.attempt >= MAX_INBOUND_ATTEMPTS
  const reason = ok ? null : (error ?? 'Processing failed').slice(0, 500)
  const result = await prisma.webhookEvent.updateMany({ where: stillOwned(claim, now), data: {
    status: ok ? 'done' : exhausted ? 'dlq' : 'failed', isProcessed: ok,
    processedAt: ok ? now : null, processingToken: null, processingUntil: null,
    nextAttemptAt: ok || exhausted ? null : new Date(now.getTime() + inboundBackoffMs(claim.attempt)),
    lastError: reason, error: reason,
  } })
  return result.count === 1
}

/**
 * Reschedule a claimed attempt WITHOUT spending it (InboundDeferred: a sign-in hold). Fenced like a
 * finish: returns false when the claim was lost, and the row then belongs to someone else.
 */
export async function deferInboundClaim(claim: InboundClaim, reason: string, delayMs: number, now?: Date): Promise<boolean> {
  now ??= await inboundDatabaseNow()
  const text = reason.slice(0, 500)
  const result = await prisma.webhookEvent.updateMany({ where: stillOwned(claim, now), data: {
    status: 'failed', attempts: { decrement: 1 }, isProcessed: false, processedAt: null,
    processingToken: null, processingUntil: null, nextAttemptAt: new Date(now.getTime() + delayMs),
    lastError: text, error: text,
  } })
  return result.count === 1
}

/**
 * Run `work` under a claim: renew the lease while it runs, then finish the row.
 *
 * If a renewal finds the lease lost, `signal` aborts and the result is not recorded:
 * the new owner decides the row's outcome. A failure the owner still holds is finished
 * as a retry or dead letter here, then rethrown for the caller to report.
 */
export async function runWithInboundClaim<T>(claim: InboundClaim, work: (claim: InboundClaim, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let renewal: Promise<void> | undefined
  const timer = setInterval(() => {
    if (renewal || controller.signal.aborted) return
    renewal = (async () => {
      const now = await inboundDatabaseNow()
      const leaseEnd = new Date(now.getTime() + LEASE_MS)
      const result = await prisma.webhookEvent.updateMany({
        where: stillOwned(claim, now), data: { processingUntil: leaseEnd, nextAttemptAt: leaseEnd },
      })
      if (result.count !== 1) throw new Error('Inbound processing lease lost')
    })().catch(error => { controller.abort(error) }).finally(() => { renewal = undefined })
  }, LEASE_RENEWAL_MS)
  timer.unref()
  try {
    const result = await work(claim, controller.signal)
    clearInterval(timer)
    await renewal
    controller.signal.throwIfAborted()
    if (!await finishInboundClaim(claim, true)) throw new Error('Inbound processing lease lost before completion')
    return result
  } catch (error) {
    clearInterval(timer)
    await renewal
    if (!controller.signal.aborted) {
      if (error instanceof InboundDeferred) await deferInboundClaim(claim, error.message, error.delayMs)
      else await finishInboundClaim(claim, false, error instanceof Error ? error.message : String(error))
    }
    throw error
  } finally {
    clearInterval(timer)
  }
}
