/**
 * AE.2 — offering an assortment to another business profile, and answering the offer.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §14. No data moves in AE.2: an active share
 * records consent; copying products is AE.3.
 *
 * Three layers, each covering what the others cannot (the BP.S1c shape):
 *   • The database (packages/database/workspaces/assortment-share.sql): row security, the status
 *     guard trigger (only the follower can activate a pending share), the answer function, the
 *     one-open-share index. The backstop — it holds even if this file is wrong.
 *   • This service: the OWNER role on both sides, the destination membership rule, and a refusal
 *     in words the operator can act on, before the database has to refuse.
 *   • share-rules.ts: the same transition table in TypeScript, parity-tested against the trigger.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { WorkspaceError, requireWorkspace } from '../../lib/workspace-context.js'
import { createWorkspaceService } from '../workspace.service.js'
import {
  canTransition, followerTarget, normaliseFieldGroups, ownerTarget, transitionRefusal,
  type FollowerDecision, type OwnerAction, type ShareStatus,
} from './share-rules.js'

const workspaces = createWorkspaceService(prisma)

export interface ShareRow {
  id: string
  assortmentId: string
  /** Null when the reader can no longer see the assortment (an ended share, on the follower side). */
  assortmentName: string | null
  ownerWorkspaceId: string
  ownerWorkspaceName: string
  workspaceId: string
  workspaceName: string
  status: ShareStatus
  fieldGroups: string[]
  followSettings: boolean
  version: number
  createdAt: Date
  respondedAt: Date | null
  pausedAt: Date | null
  endedAt: Date | null
  endedBySide: 'owner' | 'follower' | null
}

/**
 * The person acting, and the business they act in. An API key carries no person
 * (workspace-hook.ts), so it can never offer or answer a share: consent is a human act.
 */
function actingPerson(verb: string) {
  const context = requireWorkspace()
  if (!context.actorUserId) {
    throw new WorkspaceError('session_required', `Sign in as an owner of this business profile to ${verb} a share.`, 403)
  }
  return { workspaceId: context.workspaceId, actorUserId: context.actorUserId }
}

const shareSelect = {
  id: true, assortmentId: true, ownerWorkspaceId: true, workspaceId: true, status: true, fieldGroups: true,
  followSettings: true, version: true, createdAt: true, respondedAt: true, pausedAt: true, endedAt: true, endedBySide: true,
  ownerWorkspace: { select: { name: true } },
  workspace: { select: { name: true } },
} satisfies Prisma.AssortmentShareSelect

type ShareRecord = Prisma.AssortmentShareGetPayload<{ select: typeof shareSelect }>

/**
 * Assortment names are read separately, not through `include`: a follower can only read the
 * assortment while the share is open, and a required relation that row security hides makes
 * Prisma throw instead of returning the share.
 */
async function withNames(rows: ShareRecord[]): Promise<ShareRow[]> {
  const ids = [...new Set(rows.map((row) => row.assortmentId))]
  const names = new Map(
    ids.length === 0 ? [] : (await prisma.assortment.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]),
  )
  return rows.map(({ ownerWorkspace, workspace, ...row }) => ({
    ...row,
    status: row.status as ShareStatus,
    endedBySide: row.endedBySide as ShareRow['endedBySide'],
    assortmentName: names.get(row.assortmentId) ?? null,
    ownerWorkspaceName: ownerWorkspace.name,
    workspaceName: workspace.name,
  }))
}

function expectVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new WorkspaceError('version_required', 'Reload the share and try again: this change needs the version you are looking at.', 400)
  }
  return value as number
}

async function audit(tx: Prisma.TransactionClient, share: { id: string; ownerWorkspaceId: string; workspaceId: string; assortmentId: string }, actorUserId: string, action: string, metadata: Record<string, unknown> = {}) {
  // Both businesses get the record: each must be able to see how the other reached it.
  for (const workspaceId of [share.ownerWorkspaceId, share.workspaceId]) {
    await tx.workspaceAudit.create({
      data: {
        workspaceId, actorUserId, action, targetId: share.id,
        metadata: { ownerWorkspaceId: share.ownerWorkspaceId, followerWorkspaceId: share.workspaceId, assortmentId: share.assortmentId, ...metadata } as Prisma.InputJsonValue,
      },
    })
  }
}

/** Outgoing (offered by this business) and incoming (offered to it). */
export async function listShares(): Promise<{ outgoing: ShareRow[]; incoming: ShareRow[] }> {
  const { workspaceId } = requireWorkspace()
  const [outgoing, incoming] = await Promise.all([
    prisma.assortmentShare.findMany({ where: { ownerWorkspaceId: workspaceId }, select: shareSelect, orderBy: { createdAt: 'desc' } }),
    prisma.assortmentShare.findMany({ where: { workspaceId }, select: shareSelect, orderBy: { createdAt: 'desc' } }),
  ])
  return { outgoing: await withNames(outgoing), incoming: await withNames(incoming) }
}

export async function offerShare(input: { assortmentId?: unknown; destinationWorkspaceId?: unknown; fieldGroups?: unknown; followSettings?: unknown }): Promise<ShareRow> {
  const { workspaceId, actorUserId } = actingPerson('offer')
  const assortmentId = typeof input.assortmentId === 'string' ? input.assortmentId : ''
  const destinationWorkspaceId = typeof input.destinationWorkspaceId === 'string' ? input.destinationWorkspaceId : ''
  if (!assortmentId) throw new WorkspaceError('invalid_assortment', 'Choose an assortment to share.', 400)
  if (!destinationWorkspaceId || destinationWorkspaceId === workspaceId) {
    throw new WorkspaceError('invalid_destination', 'Choose a different business profile.', 400)
  }
  if (input.followSettings !== undefined && typeof input.followSettings !== 'boolean') {
    throw new WorkspaceError('invalid_follow_settings', 'Say whether mapping settings follow: true or false.', 400)
  }
  const fieldGroups = normaliseFieldGroups(input.fieldGroups)

  // "May you offer at all" before "may you name that business" — so a refusal states the true reason.
  await workspaces.requireOwner(actorUserId, workspaceId)
  const assortment = await prisma.assortment.findUnique({ where: { id: assortmentId }, select: { id: true, workspaceId: true, archivedAt: true } })
  if (!assortment) throw new WorkspaceError('assortment_not_found', 'This assortment is unavailable in this business profile.', 404)
  if (assortment.workspaceId !== workspaceId) {
    throw new WorkspaceError('assortment_not_owned', 'This assortment is shared with your business by another profile. Only its owner can offer it.', 403)
  }
  if (assortment.archivedAt) throw new WorkspaceError('assortment_archived', 'This assortment is archived. Create a new one to share these products.', 409)
  // Naming a business requires belonging to it: an owner here gets no authority to reach one they
  // are not a member of. Its OWNER still has to accept.
  try {
    await workspaces.membership(actorUserId, destinationWorkspaceId)
  } catch {
    throw new WorkspaceError('destination_unavailable', 'You can only offer an assortment to a business profile you are a member of.', 403)
  }

  const created = await prisma.$transaction(async (tx) => {
    // Same row lock as archiveAssortment takes, so an offer cannot slip in beside an archive.
    const live = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Assortment" WHERE id = ${assortmentId} AND "workspaceId" = ${workspaceId} AND "archivedAt" IS NULL FOR UPDATE`
    if (live.length === 0) throw new WorkspaceError('assortment_archived', 'This assortment was archived. It cannot be shared.', 409)
    const row = await tx.assortmentShare.create({
      data: { assortmentId, ownerWorkspaceId: workspaceId, workspaceId: destinationWorkspaceId, fieldGroups, followSettings: input.followSettings === true, createdByUserId: actorUserId },
      select: shareSelect,
    })
    await audit(tx, row, actorUserId, 'assortment.share_offered', { fieldGroups, followSettings: row.followSettings })
    return row
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new WorkspaceError('share_already_open', 'This assortment already has an open share with that business profile. Revoke it before offering a new one.', 409)
    }
    throw error
  })
  return (await withNames([created]))[0]
}

const OWNER_AUDIT_VERB: Record<OwnerAction, string> = { pause: 'paused', resume: 'resumed', revoke: 'revoked' }

/** Pause, resume or revoke (a pending offer is withdrawn by revoking it). OWNER of the offering business. */
export async function ownerAction(shareId: string, action: OwnerAction, input: { expectedVersion?: unknown }): Promise<ShareRow> {
  const { workspaceId, actorUserId } = actingPerson(action)
  const expectedVersion = expectVersion(input.expectedVersion)
  await workspaces.requireOwner(actorUserId, workspaceId)

  const share = await prisma.assortmentShare.findUnique({ where: { id: shareId }, select: shareSelect })
  if (!share) throw new WorkspaceError('share_not_found', 'This share is unavailable in this business profile.', 404)
  if (share.ownerWorkspaceId !== workspaceId) {
    // Visible is not owned: the follower can read this row.
    throw new WorkspaceError('share_owner_only', 'Only the business that offered this share can pause, resume or revoke it. You can leave it.', 403)
  }
  const from = share.status as ShareStatus
  const to = ownerTarget(action)
  if (!canTransition('owner', from, to)) throw new WorkspaceError('share_state', transitionRefusal('owner', action, from), 409)

  const now = new Date()
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.assortmentShare.updateMany({
      where: { id: shareId, ownerWorkspaceId: workspaceId, version: expectedVersion, status: from },
      data: {
        status: to,
        version: { increment: 1 },
        ...(action === 'pause' ? { pausedAt: now, pausedByUserId: actorUserId } : {}),
        ...(action === 'resume' ? { pausedAt: null, pausedByUserId: null } : {}),
        ...(action === 'revoke' ? { endedAt: now, endedByUserId: actorUserId, endedBySide: 'owner' } : {}),
      },
    })
    if (result.count === 0) {
      throw new WorkspaceError('share_changed', 'This share changed since you loaded it. Review it again.', 409)
    }
    const verb = action === 'revoke' && from === 'pending' ? 'withdrawn' : OWNER_AUDIT_VERB[action]
    await audit(tx, share, actorUserId, `assortment.share_${verb}`, { from, to })
    return tx.assortmentShare.findUniqueOrThrow({ where: { id: shareId }, select: shareSelect })
  })
  return (await withNames([updated]))[0]
}

const FOLLOWER_AUDIT_VERB: Record<FollowerDecision, string> = { accept: 'accepted', decline: 'declined', leave: 'left' }

/**
 * Accept, decline or leave. OWNER of the follower business. Goes through the database function
 * `nexus_assortment_share_respond`, because the follower has no UPDATE policy on the owner's row;
 * the function re-checks the OWNER role and the version itself.
 */
export async function followerDecision(shareId: string, decision: FollowerDecision, input: { expectedVersion?: unknown }): Promise<ShareRow> {
  const { workspaceId, actorUserId } = actingPerson(decision)
  const expectedVersion = expectVersion(input.expectedVersion)
  await workspaces.requireOwner(actorUserId, workspaceId)

  const share = await prisma.assortmentShare.findUnique({ where: { id: shareId }, select: shareSelect })
  if (!share) throw new WorkspaceError('share_not_found', 'This share is unavailable in this business profile.', 404)
  if (share.workspaceId !== workspaceId) {
    throw new WorkspaceError('share_follower_only', 'Only the business this assortment was offered to can accept, decline or leave it. You can pause or revoke it.', 403)
  }
  const from = share.status as ShareStatus
  if (!canTransition('follower', from, followerTarget(decision))) {
    throw new WorkspaceError('share_state', transitionRefusal('follower', decision, from), 409)
  }

  const updated = await prisma.$transaction(async (tx) => {
    const [{ result }] = await tx.$queryRaw<Array<{ result: { error?: string; code?: string; status?: number; share?: unknown } }>>`
      SELECT nexus_assortment_share_respond(${shareId}, ${decision}, ${expectedVersion}::integer) AS result`
    if (result.error) throw new WorkspaceError(result.code ?? 'share_refused', result.error, result.status ?? 409)
    await audit(tx, share, actorUserId, `assortment.share_${FOLLOWER_AUDIT_VERB[decision]}`, { from, to: followerTarget(decision) })
    return tx.assortmentShare.findUniqueOrThrow({ where: { id: shareId }, select: shareSelect })
  })
  return (await withNames([updated]))[0]
}
