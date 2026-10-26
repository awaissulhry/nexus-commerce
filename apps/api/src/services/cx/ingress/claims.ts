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
import { Prisma } from '@prisma/client'
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
 * Event types whose stored body is cleared the moment they are handled: their body carries a person's plain e-mail and
 * nothing needs it once handled. Shopify marketing consent (2026-10-26): the consent service keeps only a hash, and a
 * consent change of someone who is not a buyer must leave no address behind. Cleared like the retention sweep clears
 * (archive.ts scrubExpiredInbound): an UPDATE of `rawBody`, `verificationHeaders` and `payload`, in the same update that
 * finishes the row as done; the row itself (identity, verdict, status, timings) stays. A row not handled (failed, dead
 * letter, deferred) keeps its body, so it can still be retried — for this topic at most 7 days: then the retention
 * sweep clears it too (archive.ts SHORT_LIVED_INBOUND).
 */
export const CLEAR_BODY_WHEN_DONE: ReadonlySet<string> = new Set(['SHOPIFY customers_email_marketing_consent/update'])

/**
 * Finish a claimed attempt: done, retry after backoff, or dead letter once the budget is
 * spent. Returns false when the claim was lost; the row then belongs to someone else.
 */
export async function finishInboundClaim(claim: InboundClaim, ok: boolean, error?: string, now?: Date): Promise<boolean> {
  now ??= await inboundDatabaseNow()
  const exhausted = claim.attempt >= MAX_INBOUND_ATTEMPTS
  const reason = ok ? null : (error ?? 'Processing failed').slice(0, 500)
  const clearBody = ok && CLEAR_BODY_WHEN_DONE.has(`${claim.channel} ${claim.eventType}`)
  const result = await prisma.webhookEvent.updateMany({ where: stillOwned(claim, now), data: {
    status: ok ? 'done' : exhausted ? 'dlq' : 'failed', isProcessed: ok,
    processedAt: ok ? now : null, processingToken: null, processingUntil: null,
    nextAttemptAt: ok || exhausted ? null : new Date(now.getTime() + inboundBackoffMs(claim.attempt)),
    lastError: reason, error: reason,
    ...(clearBody ? { rawBody: null, verificationHeaders: Prisma.DbNull, payload: Prisma.JsonNull } : {}),
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
 * Meta ads step 30 — claim many rows of the current business in two round trips, for a receiver that settles a batch
 * of changes inline (Meta: up to 1000 per delivery, answered within seconds). Exactly the claim rule of claimInbound
 * per row — verified, not eBay, not archived, pending or failed, not under a live lease, not waiting for its backoff,
 * attempts left; the attempt is spent when the claim is taken — with ONE token for the batch. The caller finishes with
 * finishInboundClaimMany within the lease (no renewal: a batch is settled in seconds).
 */
export async function claimInboundMany(ids: string[], now?: Date): Promise<{ token: string; claims: InboundClaim[] }> {
  const token = randomUUID()
  if (ids.length === 0) return { token, claims: [] }
  now ??= await inboundDatabaseNow()
  const leaseEnd = new Date(now.getTime() + LEASE_MS)
  await prisma.webhookEvent.updateMany({
    where: {
      id: { in: ids }, channel: { not: 'EBAY' }, status: { in: ['pending', 'failed'] }, archivedAt: null, leaseToken: null,
      attempts: { lt: MAX_INBOUND_ATTEMPTS },
      AND: [
        VERIFIED_INBOUND_WHERE,
        { OR: [{ processingUntil: null }, { processingUntil: { lte: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    data: { status: 'pending', attempts: { increment: 1 }, processingToken: token, processingUntil: leaseEnd, nextAttemptAt: leaseEnd, isProcessed: false, processedAt: null },
  })
  const rows = await prisma.webhookEvent.findMany({
    where: { id: { in: ids }, processingToken: token },
    select: { id: true, attempts: true, payload: true, connectionId: true, eventType: true, channel: true },
  })
  return { token, claims: rows.map((row) => ({ id: row.id, token, attempt: row.attempts, payload: row.payload, connectionId: row.connectionId, eventType: row.eventType, channel: row.channel })) }
}

/**
 * Finish a batch claim: `done` rows finished, `release` rows handed back unspent (the answer budget ran out before
 * their turn; due again at once), `failed` rows retried after their backoff or dead-lettered, each as
 * finishInboundClaim does. Only rows still held by this token are touched.
 */
export async function finishInboundClaimMany(claims: InboundClaim[], outcome: { done: string[]; release: string[]; failed: Array<{ id: string; error: string }> }, now?: Date): Promise<void> {
  if (claims.length === 0) return
  now ??= await inboundDatabaseNow()
  const token = claims[0].token
  const held = { channel: { not: 'EBAY' }, status: 'pending', archivedAt: null, processingToken: token, processingUntil: { gt: now }, AND: [VERIFIED_INBOUND_WHERE] } satisfies Prisma.WebhookEventWhereInput
  if (outcome.done.length) {
    await prisma.webhookEvent.updateMany({ where: { ...held, id: { in: outcome.done } }, data: {
      status: 'done', isProcessed: true, processedAt: now, processingToken: null, processingUntil: null, nextAttemptAt: null, lastError: null, error: null,
    } })
  }
  if (outcome.release.length) {
    await prisma.webhookEvent.updateMany({ where: { ...held, id: { in: outcome.release } }, data: {
      attempts: { decrement: 1 }, processingToken: null, processingUntil: null, nextAttemptAt: now,
    } })
  }
  // Review N2 — one UPDATE per (reason, attempt): rows failing alike share the backoff and the dead-letter verdict.
  const groups = new Map<string, { reason: string; attempt: number; ids: string[] }>()
  for (const failure of outcome.failed) {
    const claim = claims.find((c) => c.id === failure.id)
    if (!claim) continue
    const reason = (failure.error || 'Processing failed').slice(0, 500)
    const key = JSON.stringify([reason, claim.attempt])
    const group = groups.get(key) ?? { reason, attempt: claim.attempt, ids: [] }
    group.ids.push(claim.id)
    groups.set(key, group)
  }
  for (const { reason, attempt, ids } of groups.values()) {
    const exhausted = attempt >= MAX_INBOUND_ATTEMPTS
    await prisma.webhookEvent.updateMany({ where: { ...held, id: { in: ids }, attempts: attempt }, data: {
      status: exhausted ? 'dlq' : 'failed', isProcessed: false, processedAt: null, processingToken: null, processingUntil: null,
      nextAttemptAt: exhausted ? null : new Date(now.getTime() + inboundBackoffMs(attempt)), lastError: reason, error: reason,
    } })
  }
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
