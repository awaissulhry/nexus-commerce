import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { activeDatabaseTransaction } from '../../../lib/database-context.js'
import { lockOwnedEbayAccount } from '../ebay-identity.js'
import { inboundBackoffMs, MAX_INBOUND_ATTEMPTS, type ReplayOutcome, type ReplayRequest } from './ledger.js'

export const EBAY_INBOUND_LEASE_MS = 180_000

export interface EbayInboundReceipt {
  id: string
  workspaceId: string
  eventType: string
  externalId: string
  connectionId: string | null
  payload: unknown
  providerTimestamp: Date | null
  createdAt: Date
}

export interface EbayInboundClaim extends Readonly<EbayInboundReceipt> {
  readonly leaseToken: string
  readonly attempt: number
}

type Tx = Prisma.TransactionClient
const transactionOptions = { maxWait: 5_000, timeout: 30_000, isolationLevel: 'ReadCommitted' as const }
async function databaseTime(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return row.now
}

const claimWhere = (claim: EbayInboundClaim): Prisma.WebhookEventWhereInput => ({
  id: claim.id, workspaceId: claim.workspaceId, channel: 'EBAY',
  signatureOk: true, verifiedBy: 'ebay_ecdsa', archivedAt: null,
  status: 'pending', leaseToken: claim.leaseToken, attempts: claim.attempt,
})
const receiptSelect = { id: true, workspaceId: true, eventType: true, externalId: true, connectionId: true,
  payload: true, providerTimestamp: true, createdAt: true } as const

export type EbayDeadLetterEffect = (tx: Tx, receipt: Readonly<EbayInboundReceipt>) => Promise<void>

/** The row is already locked. A required warning failure must roll back its DLQ transition. */
async function persistDeadLetterEffect(tx: Tx, id: string, effect: EbayDeadLetterEffect) {
  const row = await tx.webhookEvent.findUniqueOrThrow({ where: { id }, select: { ...receiptSelect, attempts: true } })
  const { attempts, ...receipt } = row
  await effect(tx, receipt)
  const retained = await tx.webhookEvent.findFirst({ where: {
    id, workspaceId: row.workspaceId, channel: 'EBAY', signatureOk: true, verifiedBy: 'ebay_ecdsa', archivedAt: null,
    status: 'dlq', attempts, isProcessed: false, processedAt: null,
    leaseToken: null, leaseUntil: null, nextAttemptAt: null,
  }, select: { id: true } })
  if (!retained) throw new EbayInboundClaimLost()
}

/** An operator reset must serialize with a worker claim, and never steal its lease. */
export async function queueEbayReplay(request: ReplayRequest): Promise<ReplayOutcome> {
  const workspaceId = workspaceIdForQuery()
  if (request.workspaceId && request.workspaceId !== workspaceId) return { ok: false, reason: 'wrong_workspace' }
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "WebhookEvent" WHERE id=${request.id}
        AND "workspaceId"=${workspaceId} AND channel='EBAY' FOR UPDATE`
    if (!locked.length) return { ok: false, reason: 'not_found' }
    const row = await tx.webhookEvent.findUniqueOrThrow({ where: { id: request.id },
      select: { id: true, channel: true, eventType: true, status: true, archivedAt: true,
        signatureOk: true, verifiedBy: true, nextAttemptAt: true, leaseToken: true, leaseUntil: true } })
    if (row.signatureOk !== true || row.verifiedBy !== 'ebay_ecdsa') return { ok: false, reason: 'unverified' }
    if (row.archivedAt) return { ok: false, reason: 'archived' }
    const now = await databaseTime(tx)
    if ((row.leaseToken && row.leaseUntil && row.leaseUntil > now) || (row.status === 'pending' && row.nextAttemptAt)) {
      return { ok: false, reason: 'already_pending' }
    }
    await tx.webhookEvent.update({ where: { id: row.id }, data: {
      status: 'pending', attempts: 0, nextAttemptAt: now, leaseToken: null, leaseUntil: null,
      lastError: null, error: null, isProcessed: false, processedAt: null,
    } })
    return { ok: true, channel: row.channel, eventType: row.eventType }
  }, transactionOptions)
}

/** Called while this transaction holds the receipt row lock. */
async function extendLockedClaim(tx: Tx, claim: Pick<EbayInboundClaim, 'id' | 'leaseToken'>) {
  const until = new Date((await databaseTime(tx)).getTime() + EBAY_INBOUND_LEASE_MS)
  await tx.webhookEvent.update({ where: { id: claim.id, leaseToken: claim.leaseToken }, data: { leaseUntil: until, nextAttemptAt: until } })
}

/** The database clock and conditional UPDATE choose one owner, including after a crash. */
export async function claimEbayInbound(id: string, onDeadLetter?: EbayDeadLetterEffect): Promise<EbayInboundClaim | null> {
  return prisma.$transaction(async tx => {
    const now = await databaseTime(tx)
    const eligible: Prisma.WebhookEventWhereInput = {
      id, channel: 'EBAY', signatureOk: true, verifiedBy: 'ebay_ecdsa', archivedAt: null,
      status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    }
    const leaseToken = randomUUID()
    const leaseUntil = new Date(now.getTime() + EBAY_INBOUND_LEASE_MS)
    const claimed = await tx.webhookEvent.updateMany({
      where: { ...eligible, attempts: { lt: MAX_INBOUND_ATTEMPTS } },
      data: { status: 'pending', isProcessed: false, processedAt: null, leaseToken, leaseUntil,
        nextAttemptAt: leaseUntil, attempts: { increment: 1 } },
    })
    if (claimed.count !== 1) {
      // Crashes consume attempts too. An abandoned fifth attempt must not loop forever.
      const reason = 'Processing attempt budget exhausted; inspect the event before replay.'
      const exhausted = await tx.webhookEvent.updateMany({ where: { ...eligible, attempts: { gte: MAX_INBOUND_ATTEMPTS } },
        data: { status: 'dlq', isProcessed: false, processedAt: null, nextAttemptAt: null,
          leaseToken: null, leaseUntil: null, lastError: reason, error: reason } })
      if (exhausted.count === 1 && onDeadLetter) await persistDeadLetterEffect(tx, id, onDeadLetter)
      return null
    }
    // A lock wait must not shorten the new owner's lease. Sample the clock again
    // after the conditional UPDATE has acquired ownership and the row lock.
    await extendLockedClaim(tx, { id, leaseToken })
    const row = await tx.webhookEvent.findUniqueOrThrow({ where: { id },
      select: { ...receiptSelect, attempts: true } })
    const { attempts, ...receipt } = row
    return { ...receipt, leaseToken, attempt: attempts }
  }, transactionOptions)
}

/** Expiry permits takeover; the token, not a caller's clock, fences the old owner. */
export async function renewEbayInboundClaim(claim: EbayInboundClaim): Promise<boolean> {
  if (workspaceIdForQuery() !== claim.workspaceId) return false
  return prisma.$transaction(async tx => {
    const result = await tx.webhookEvent.updateMany({ where: claimWhere(claim), data: { leaseToken: claim.leaseToken } })
    if (result.count !== 1) return false
    await extendLockedClaim(tx, claim)
    return true
  }, transactionOptions)
}

export type EbayInboundFailure =
  | { kind: 'retry' | 'dead_letter'; reason: string }
  | { kind: 'defer'; code: 'AUTH_REQUIRED' | 'RATE_LIMITED'; reason: string }

/** A failure cannot release another worker's claim, or consume its retry budget. */
export async function finishEbayInbound(claim: EbayInboundClaim, outcome: EbayInboundFailure, onDeadLetter?: EbayDeadLetterEffect): Promise<boolean> {
  if (workspaceIdForQuery() !== claim.workspaceId) return false
  return prisma.$transaction(async tx => {
    const owned = await tx.webhookEvent.updateMany({ where: claimWhere(claim), data: { leaseToken: claim.leaseToken } })
    if (owned.count !== 1) return false
    const now = await databaseTime(tx)
    const dead = outcome.kind === 'dead_letter' || (outcome.kind === 'retry' && claim.attempt >= MAX_INBOUND_ATTEMPTS)
    const reason = outcome.reason.slice(0, 500)
    const result = await tx.webhookEvent.updateMany({ where: claimWhere(claim), data: {
      status: dead ? 'dlq' : 'failed', isProcessed: false, processedAt: null,
      leaseToken: null, leaseUntil: null,
      nextAttemptAt: dead ? null : new Date(now.getTime() + (outcome.kind === 'defer' ? 300_000 : inboundBackoffMs(claim.attempt))),
      ...(outcome.kind === 'defer' ? { attempts: claim.attempt - 1 } : {}), lastError: reason, error: reason,
    } })
    if (result.count === 1 && dead && onDeadLetter) await persistDeadLetterEffect(tx, claim.id, onDeadLetter)
    return result.count === 1
  }, transactionOptions)
}

export class EbayInboundClaimLost extends Error {
  constructor() { super('Inbound processing ownership changed before commit.'); this.name = 'EbayInboundClaimLost' }
}

/**
 * Domain effects and receipt completion commit together. Fetch remote data BEFORE
 * calling this; the callback must use only this transaction for database effects.
 * The guarded UPDATE locks the receipt until commit, so even an expired lease
 * cannot be reclaimed between the ownership check and the domain mutation.
 */
export async function commitEbayInbound<T>(claim: EbayInboundClaim, effect: (tx: Tx, receipt: Readonly<EbayInboundReceipt>) => Promise<T>): Promise<{ committed: boolean; value?: T }> {
  if (workspaceIdForQuery() !== claim.workspaceId) return { committed: false }
  if (activeDatabaseTransaction()) throw new Error('eBay receipt completion requires its own ordered transaction.')
  return prisma.$transaction(async tx => {
    const owned = await tx.webhookEvent.updateMany({ where: claimWhere(claim), data: { leaseToken: claim.leaseToken } })
    if (owned.count !== 1) return { committed: false }
    await extendLockedClaim(tx, claim)
    const receipt = await tx.webhookEvent.findUniqueOrThrow({ where: { id: claim.id }, select: receiptSelect })
    if (receipt.connectionId) {
      // Account generations alone cannot fence a new grant on a sibling row.
      // Acquire the seller identity first and recheck after any reconnect wait.
      await lockOwnedEbayAccount(tx, receipt.workspaceId, receipt.connectionId)
    }
    // The mutable claim object is only a fencing handle. Domain code receives the
    // authoritative account and payload reloaded after the receipt is locked.
    const value = await effect(tx, receipt)
    const completed = await tx.webhookEvent.updateMany({ where: claimWhere(claim), data: {
      status: 'done', isProcessed: true, processedAt: await databaseTime(tx),
      leaseToken: null, leaseUntil: null, nextAttemptAt: null, error: null, lastError: null,
    } })
    if (completed.count !== 1) throw new EbayInboundClaimLost()
    return { committed: true, value }
  }, transactionOptions)
}
