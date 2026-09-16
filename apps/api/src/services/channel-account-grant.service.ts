/**
 * BP.S1c/BP.S3 — sharing a seller account with another business, read-only or to publish.
 *
 * Spec: docs/2026-09-16-bp-shared-accounts-and-access.md. The model is one owner,
 * many guests: ownership, credentials, reconnect, disconnect and inbound routing
 * never move. A guest receives a `ChannelAccountGrant` and nothing else.
 *
 * Three layers have to agree, and each covers what the others cannot:
 *   • RLS — `nexus_workspace_isolation` on ChannelAccountGrant is owner-only for
 *     INSERT/UPDATE/DELETE, so a guest cannot write a grant even if this file were
 *     wrong. It is the backstop, not the explanation.
 *   • This service — states WHY in words the operator can read, and enforces the
 *     OWNER role, which RLS cannot express.
 *   • `token.service.assertCredentialOwner` (BP.S1b) — only a `publish` grant yields a
 *     usable credential; a `read` grant never does.
 */
import prisma from '../db.js'
import { WorkspaceError, requireWorkspace } from '../lib/workspace-context.js'
import { createWorkspaceService } from './workspace.service.js'

const workspaces = createWorkspaceService(prisma)

/**
 * 'read'    — the guest sees the account and nothing else.
 * 'publish' — the guest may also reach the channel with it (BP.S3). Safe because a
 *             seller coordinate is exclusive: `ChannelListingClaim` gives one
 *             (account, marketplace, sellerSku) to ONE business, so two profiles can
 *             never publish into the same listing or push two quantities at it.
 */
export const GRANT_MODES = ['read', 'publish'] as const
export type GrantMode = (typeof GRANT_MODES)[number]

export interface GrantRow {
  connectionId: string
  workspaceId: string
  workspaceName: string
  ownerWorkspaceId: string
  mode: string
  marketplaces: string[]
  grantedAt: Date
  revokedAt: Date | null
}

/**
 * The actor, and the business they are acting in.
 *
 * An API key context carries `roleKeys: []` and a null actor (workspace-hook.ts:58),
 * so it can never pass `requireOwner`. Sharing a seller account with another
 * business stays a deliberate human act.
 */
function actingOwner() {
  const context = requireWorkspace()
  if (!context.actorUserId) {
    throw new WorkspaceError('session_required', 'Sign in as an owner of this business profile to share an account.', 403)
  }
  return { workspaceId: context.workspaceId, actorUserId: context.actorUserId }
}

/**
 * 🔴 The connection must be OWNED here, not merely visible here.
 *
 * Before migration 20260916a those were the same thing and a successful
 * `findUnique` implied ownership. `nexus_workspace_grant_read` breaks that: a guest
 * can now read a shared account, so without this check a guest could re-share an
 * account it only borrows, and the owner would have no record of the second guest.
 */
async function ownedConnection(connectionId: string, workspaceId: string) {
  const row = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, workspaceId: true, channelType: true, managedBy: true, externalAccountId: true },
  })
  if (!row) throw new WorkspaceError('account_unavailable', 'This account is unavailable in this business profile.', 404)
  if (row.workspaceId !== workspaceId) {
    throw new WorkspaceError('account_not_owned', 'This account is shared with your business by another profile. Only its owner can manage how it is shared.', 403)
  }
  if (row.managedBy === 'transferred') {
    throw new WorkspaceError('account_retired', 'This connection was retired by a profile assignment and cannot be shared.', 409)
  }
  return row
}

/** Accounts this business owns and has shared out. */
export async function listSharesFor(connectionId: string): Promise<GrantRow[]> {
  const { workspaceId, actorUserId } = actingOwner()
  await workspaces.requireOwner(actorUserId, workspaceId)
  await ownedConnection(connectionId, workspaceId)
  const rows = await prisma.channelAccountGrant.findMany({
    where: { connectionId, ownerWorkspaceId: workspaceId },
    include: { workspace: { select: { name: true } } },
    orderBy: { grantedAt: 'asc' },
  })
  return rows.map(row => ({
    connectionId: row.connectionId, workspaceId: row.workspaceId, workspaceName: row.workspace.name,
    ownerWorkspaceId: row.ownerWorkspaceId, mode: row.mode, marketplaces: row.marketplaces,
    grantedAt: row.grantedAt, revokedAt: row.revokedAt,
  }))
}

/**
 * Accounts shared WITH the business in context, so a page can mark those rows as
 * belonging to someone else. No owner check: reading this is how the current
 * business learns it is a guest.
 */
export async function listSharedWithCurrent(): Promise<Array<{ connectionId: string; ownerWorkspaceId: string; ownerWorkspaceName: string; mode: string; marketplaces: string[] }>> {
  const { workspaceId } = requireWorkspace()
  const rows = await prisma.channelAccountGrant.findMany({
    where: { workspaceId, revokedAt: null },
    include: { ownerWorkspace: { select: { name: true } } },
  })
  return rows.map(row => ({
    connectionId: row.connectionId, ownerWorkspaceId: row.ownerWorkspaceId,
    ownerWorkspaceName: row.ownerWorkspace.name, mode: row.mode, marketplaces: row.marketplaces,
  }))
}

export async function shareAccount(input: { connectionId: string; destinationWorkspaceId: string; mode?: string; marketplaces?: unknown }): Promise<GrantRow> {
  const { workspaceId, actorUserId } = actingOwner()
  const mode = input.mode ?? 'read'
  if (!(GRANT_MODES as readonly string[]).includes(mode)) {
    throw new WorkspaceError('grant_mode_unavailable', `Choose ${GRANT_MODES.join(' or ')} for a shared account.`, 400)
  }
  const marketplaces = normaliseMarketplaces(input.marketplaces)
  if (!input.destinationWorkspaceId || input.destinationWorkspaceId === workspaceId) {
    throw new WorkspaceError('invalid_destination', 'Choose a different business profile.', 400)
  }

  // Owner of BOTH sides, each re-read from live membership. An owner of this
  // business gets no authority in the destination; `requireOwner` is what says so.
  //
  // Order is deliberate: "can you share this account at all" is answered before
  // "may you share it there". With the destination checked first, a guest trying to
  // pass on a borrowed account was refused for the WRONG reason whenever it also
  // lacked the destination — a true refusal that says something untrue.
  await workspaces.requireOwner(actorUserId, workspaceId)
  const connection = await ownedConnection(input.connectionId, workspaceId)
  const destination = await workspaces.requireOwner(actorUserId, input.destinationWorkspaceId)

  const grant = await prisma.$transaction(async tx => {
    // An existing grant is UPDATED, never duplicated: re-sharing a revoked account
    // is the same row coming back, so its history stays in one place.
    const row = await tx.channelAccountGrant.upsert({
      where: { connectionId_workspaceId: { connectionId: connection.id, workspaceId: input.destinationWorkspaceId } },
      create: {
        connectionId: connection.id, workspaceId: input.destinationWorkspaceId, ownerWorkspaceId: workspaceId,
        mode, marketplaces, grantedByUserId: actorUserId,
      },
      update: { mode, marketplaces, grantedByUserId: actorUserId, grantedAt: new Date(), revokedAt: null, revokedByUserId: null },
      include: { workspace: { select: { name: true } } },
    })
    // Both businesses get the record. A guest must be able to see how it got access.
    for (const id of [workspaceId, input.destinationWorkspaceId]) {
      await tx.workspaceAudit.create({
        data: {
          workspaceId: id, actorUserId, action: 'account.shared', targetId: connection.id,
          metadata: { ownerWorkspaceId: workspaceId, destinationWorkspaceId: input.destinationWorkspaceId, channelType: connection.channelType, mode, marketplaces },
        },
      })
    }
    return row
  })

  return {
    connectionId: grant.connectionId, workspaceId: grant.workspaceId, workspaceName: destination.workspace.name,
    ownerWorkspaceId: grant.ownerWorkspaceId, mode: grant.mode, marketplaces: grant.marketplaces,
    grantedAt: grant.grantedAt, revokedAt: grant.revokedAt,
  }
}

export async function revokeShare(input: { connectionId: string; workspaceId: string }): Promise<{ revoked: boolean }> {
  const { workspaceId, actorUserId } = actingOwner()
  await workspaces.requireOwner(actorUserId, workspaceId)
  const connection = await ownedConnection(input.connectionId, workspaceId)

  return prisma.$transaction(async tx => {
    // Revocation sets a timestamp; it never deletes. The read policies test
    // `revokedAt IS NULL`, so access ends at the same moment either way, and the
    // record of who had access survives.
    const updated = await tx.channelAccountGrant.updateMany({
      where: { connectionId: connection.id, workspaceId: input.workspaceId, ownerWorkspaceId: workspaceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: actorUserId },
    })
    if (updated.count === 0) return { revoked: false }
    for (const id of [workspaceId, input.workspaceId]) {
      await tx.workspaceAudit.create({
        data: {
          workspaceId: id, actorUserId, action: 'account.share_revoked', targetId: connection.id,
          metadata: { ownerWorkspaceId: workspaceId, destinationWorkspaceId: input.workspaceId, channelType: connection.channelType },
        },
      })
    }
    return { revoked: true }
  })
}

/** A marketplace list narrows a grant, so a malformed one must not silently widen it. */
function normaliseMarketplaces(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(entry))) {
    throw new WorkspaceError('invalid_marketplaces', 'Choose marketplaces from the account, or leave the list empty for all of them.', 400)
  }
  return [...new Set(value as string[])]
}
