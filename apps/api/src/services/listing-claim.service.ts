/**
 * BP.S3 — one seller coordinate, one owning business.
 *
 * Spec: docs/2026-09-16-bp-shared-accounts-and-access.md §5.
 *
 * A seller account identifies a listing by the seller's own SKU within that account
 * and marketplace. Two businesses sharing one account share ONE namespace, so before
 * either may publish into a coordinate it must hold the claim for it.
 *
 * ── Scope, deliberately narrow ───────────────────────────────────────────────
 *
 * A claim is required ONLY on a SHARED account. An account with a single business
 * behind it has no second publisher, so nothing about today's publishing changes —
 * `sharedConnectionIds` is the gate, and it is one indexed read.
 */
import prisma from '../db.js'
import { WorkspaceError, requireWorkspace } from '../lib/workspace-context.js'

export interface Coordinate {
  connectionId: string
  marketplace: string
  /** eBay custom label / Amazon SKU. Null is not claimable — see `claimCoordinate`. */
  sellerSku: string | null
  channelListingId?: string | null
}

/**
 * Which of these accounts are shared with, or shared out to, another business.
 *
 * Reads `ChannelAccountGrant` under the caller's own policies. An account that is
 * not here needs no claim at all, which is what keeps this feature off the path of
 * every existing single-business publish.
 */
export async function sharedConnectionIds(connectionIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(connectionIds.filter(Boolean))]
  if (unique.length === 0) return new Set()
  const rows = await prisma.channelAccountGrant.findMany({
    where: { connectionId: { in: unique }, revokedAt: null },
    select: { connectionId: true },
  })
  return new Set(rows.map(row => row.connectionId))
}

export interface ClaimOutcome {
  coordinate: Coordinate
  /** 'held' = already ours. 'acquired' = taken now. 'blocked' = someone else holds it. */
  result: 'held' | 'acquired' | 'blocked'
  /** Only on 'blocked': the business that holds it, named for the operator. */
  heldBy?: { workspaceId: string; workspaceName: string }
  reason?: string
}

/**
 * Take a coordinate, or report who has it.
 *
 * Never throws for a conflict: a bulk publish must be able to report every blocked
 * coordinate at once rather than stopping on the first. `assertClaimed` is the
 * throwing wrapper for single-coordinate callers.
 */
export async function claimCoordinate(coordinate: Coordinate): Promise<ClaimOutcome> {
  const { workspaceId, actorUserId } = requireWorkspace()

  /*
   * 🔴 A null seller SKU is refused on a shared account, never guessed.
   *
   * `sellerSkuForDelist` returns null when a listing carries two seller identities,
   * with the note that "naming a coordinate cannot choose one of two seller
   * identities". If we cannot say which coordinate this is, we cannot promise
   * exclusivity on it, and publishing into a shared namespace without exclusivity is
   * the exact collision this unit exists to prevent.
   */
  if (!coordinate.sellerSku || !coordinate.sellerSku.trim()) {
    return {
      coordinate, result: 'blocked',
      reason: 'This listing has no single seller SKU, so its place on the shared account cannot be reserved. Give it one seller SKU, or publish it from the profile that owns the account.',
    }
  }
  const sellerSku = coordinate.sellerSku.trim()

  const existing = await prisma.channelListingClaim.findUnique({
    where: { connectionId_marketplace_sellerSku: { connectionId: coordinate.connectionId, marketplace: coordinate.marketplace, sellerSku } },
    include: { workspace: { select: { id: true, name: true } } },
  })
  if (existing) {
    if (existing.workspaceId === workspaceId) {
      // Keep the pointer fresh: a re-created listing row should not leave the claim
      // pointing at a row that no longer exists.
      if (coordinate.channelListingId && existing.channelListingId !== coordinate.channelListingId) {
        await prisma.channelListingClaim.update({
          where: { connectionId_marketplace_sellerSku: { connectionId: coordinate.connectionId, marketplace: coordinate.marketplace, sellerSku } },
          data: { channelListingId: coordinate.channelListingId },
        })
      }
      return { coordinate, result: 'held' }
    }
    return {
      coordinate, result: 'blocked',
      heldBy: { workspaceId: existing.workspace.id, workspaceName: existing.workspace.name },
      reason: `${existing.workspace.name} already publishes ${sellerSku} on this account. One seller SKU can belong to one profile at a time.`,
    }
  }

  try {
    await prisma.channelListingClaim.create({
      data: {
        connectionId: coordinate.connectionId, marketplace: coordinate.marketplace, sellerSku,
        workspaceId, channelListingId: coordinate.channelListingId ?? null, claimedByUserId: actorUserId,
      },
    })
    return { coordinate, result: 'acquired' }
  } catch (error) {
    /*
     * 🔴 Two businesses can reach the INSERT at the same moment; the read above
     * cannot prevent that, only the primary key can. A 23505 here is the race
     * landing correctly, so it is reported as a conflict and not as a fault.
     */
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await prisma.channelListingClaim.findUnique({
        where: { connectionId_marketplace_sellerSku: { connectionId: coordinate.connectionId, marketplace: coordinate.marketplace, sellerSku } },
        include: { workspace: { select: { id: true, name: true } } },
      })
      return {
        coordinate, result: 'blocked',
        heldBy: winner ? { workspaceId: winner.workspace.id, workspaceName: winner.workspace.name } : undefined,
        reason: winner
          ? `${winner.workspace.name} claimed ${sellerSku} on this account a moment ago. One seller SKU can belong to one profile at a time.`
          : `${sellerSku} was claimed on this account a moment ago.`,
      }
    }
    throw error
  }
}

/** The throwing wrapper, for a caller publishing exactly one coordinate. */
export async function assertClaimed(coordinate: Coordinate): Promise<void> {
  const shared = await sharedConnectionIds([coordinate.connectionId])
  if (!shared.has(coordinate.connectionId)) return
  const outcome = await claimCoordinate(coordinate)
  if (outcome.result === 'blocked') {
    throw new WorkspaceError('listing_coordinate_claimed', outcome.reason ?? 'That listing is published by another business profile.', 409)
  }
}

/**
 * Give a coordinate back, so another business can take it.
 *
 * Called when a listing is delisted or its account attribution changes. Deletes
 * rather than tombstones: a claim is a LOCK, and a released lock that still occupies
 * its own primary key would block the next holder forever. Who held it is in
 * WorkspaceAudit.
 */
export async function releaseCoordinate(coordinate: Omit<Coordinate, 'channelListingId'>): Promise<boolean> {
  const { workspaceId } = requireWorkspace()
  if (!coordinate.sellerSku?.trim()) return false
  const removed = await prisma.channelListingClaim.deleteMany({
    where: {
      connectionId: coordinate.connectionId, marketplace: coordinate.marketplace,
      sellerSku: coordinate.sellerSku.trim(),
      // RLS already restricts this, and naming it makes the intent readable.
      workspaceId,
    },
  })
  return removed.count > 0
}

/** Everything this business holds on one account — what the UI lists. */
export async function claimsForConnection(connectionId: string) {
  return prisma.channelListingClaim.findMany({
    where: { connectionId },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: [{ marketplace: 'asc' }, { sellerSku: 'asc' }],
  })
}
