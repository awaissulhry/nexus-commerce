import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { inboundBackoffMs, MAX_INBOUND_ATTEMPTS } from './ledger.js'

export const EBAY_INBOUND_LEASE_MS = 180_000

export interface EbayInboundReceipt {
  id: string
  workspaceId: string
  eventType: string
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
const transactionOptions = { maxWait: 5_000, timeout: 30_000 }
async function databaseTime(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return row.now
}

const claimWhere = (claim: EbayInboundClaim): Prisma.WebhookEventWhereInput => ({
  id: claim.id, workspaceId: claim.workspaceId, channel: 'EBAY',
  signatureOk: true, verifiedBy: 'ebay_ecdsa', archivedAt: null,
  status: 'pending', leaseToken: claim.leaseToken, attempts: claim.attempt,
})
const receiptSelect = { id: true, workspaceId: true, eventType: true, connectionId: true,
  payload: true, providerTimestamp: true, createdAt: true } as const

/** Called while this transaction holds the receipt row lock. */
async function extendLockedClaim(tx: Tx, claim: Pick<EbayInboundClaim, 'id' | 'leaseToken'>) {
  const until = new Date((await databaseTime(tx)).getTime() + EBAY_INBOUND_LEASE_MS)
  await tx.webhookEvent.update({ where: { id: claim.id, leaseToken: claim.leaseToken }, data: { leaseUntil: until, nextAttemptAt: until } })
}

/** The database clock and conditional UPDATE choose one owner, including after a crash. */
export async function claimEbayInbound(id: string): Promise<EbayInboundClaim | null> {
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
      await tx.webhookEvent.updateMany({ where: { ...eligible, attempts: { gte: MAX_INBOUND_ATTEMPTS } },
        data: { status: 'dlq', isProcessed: false, processedAt: null, nextAttemptAt: null,
          leaseToken: null, leaseUntil: null, lastError: reason, error: reason } })
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
export async function finishEbayInbound(claim: EbayInboundClaim, outcome: EbayInboundFailure): Promise<boolean> {
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
  return prisma.$transaction(async tx => {
    const owned = await tx.webhookEvent.updateMany({ where: claimWhere(claim), data: { leaseToken: claim.leaseToken } })
    if (owned.count !== 1) return { committed: false }
    await extendLockedClaim(tx, claim)
    const receipt = await tx.webhookEvent.findUniqueOrThrow({ where: { id: claim.id }, select: receiptSelect })
    if (receipt.connectionId) {
      // A plain read would permit a reconnect or credential change between the
      // check and the domain write. Keep this DB-only phase stable through commit.
      const accounts = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "ChannelConnection"
        WHERE id=${receipt.connectionId} AND "workspaceId"=${receipt.workspaceId}
          AND "channelType"='EBAY' FOR UPDATE`
      if (!accounts.length) throw new Error('The stored eBay receipt account is not owned by this business profile.')
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
