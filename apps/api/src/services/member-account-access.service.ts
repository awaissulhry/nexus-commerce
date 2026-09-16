/**
 * BP.S2 — which accounts one PERSON may reach inside one business.
 *
 * Spec: docs/2026-09-16-bp-shared-accounts-and-access.md §4.
 *
 * Enforcement is NOT here. It is the RESTRICTIVE policy `nexus_account_restriction`
 * on ChannelConnection, which PostgreSQL ANDs with every permissive policy, so it
 * covers owned accounts, accounts shared in from another business, reads and writes
 * alike — with no call site changed. This file only lets an owner say what the limit
 * is, and says it back in words.
 *
 * MAP.8 parked this in August because `rbac-hook.ts:42` resolves a permission from
 * (method, pattern) before the handler runs and cannot know which account a request
 * will touch. That is still true; the question moved to the row instead.
 */
import prisma from '../db.js'
import { WorkspaceError, requireWorkspace } from '../lib/workspace-context.js'
import { createWorkspaceService } from './workspace.service.js'

const workspaces = createWorkspaceService(prisma)

export interface MemberAccountAccess {
  membershipId: string
  userId: string
  email: string
  /** false = every account in this business, which is the default for every member. */
  restricted: boolean
  connectionIds: string[]
}

function actingOwner() {
  const context = requireWorkspace()
  if (!context.actorUserId) {
    throw new WorkspaceError('session_required', 'Sign in as an owner of this business profile to change account access.', 403)
  }
  return { workspaceId: context.workspaceId, actorUserId: context.actorUserId }
}

/** The membership must belong to the business in context — an id is not permission. */
async function membershipHere(membershipId: string, workspaceId: string) {
  const row = await prisma.workspaceMembership.findUnique({
    where: { id: membershipId },
    select: { id: true, workspaceId: true, userId: true, status: true, user: { select: { email: true } } },
  })
  if (!row || row.workspaceId !== workspaceId) {
    throw new WorkspaceError('member_unavailable', 'That person is not a member of this business profile.', 404)
  }
  return row
}

export async function listMemberAccountAccess(): Promise<MemberAccountAccess[]> {
  const { workspaceId, actorUserId } = actingOwner()
  await workspaces.requireOwner(actorUserId, workspaceId)
  const rows = await prisma.workspaceMembership.findMany({
    where: { workspaceId },
    select: {
      id: true, userId: true, user: { select: { email: true } },
      accountLimit: { select: { membershipId: true } },
      accounts: { select: { connectionId: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(row => ({
    membershipId: row.id,
    userId: row.userId,
    email: row.user.email,
    restricted: row.accountLimit !== null,
    connectionIds: row.accounts.map(a => a.connectionId),
  }))
}

/**
 * Set the whole limit for one member in one call.
 *
 * `restricted: false` clears it; `restricted: true` replaces the list with exactly
 * `connectionIds`, which may be empty and then means this person reaches no seller
 * account at all. Whole-state rather than add/remove verbs, so two operators editing
 * at once cannot interleave into a set neither of them chose.
 */
export async function setMemberAccountAccess(input: {
  membershipId: string
  restricted: boolean
  connectionIds?: string[]
}): Promise<MemberAccountAccess> {
  const { workspaceId, actorUserId } = actingOwner()
  const owner = await workspaces.requireOwner(actorUserId, workspaceId)
  const member = await membershipHere(input.membershipId, workspaceId)

  /*
   * 🔴 An owner cannot restrict themselves.
   *
   * Not politeness — it is the last-owner problem again. An owner who limited
   * themselves to no accounts could no longer see the accounts they would need in
   * order to lift the limit, and `nexus_workspace_member_limit_manage` requires an
   * OWNER to clear it. The business would be permanently unable to reach its own
   * sellers.
   */
  if (member.userId === actorUserId) {
    throw new WorkspaceError('owner_self_restriction', 'You cannot limit your own account access. Ask another owner to do it.', 409)
  }
  if (owner.isOwner && (await isOwnerOf(member.id))) {
    throw new WorkspaceError('owner_not_restrictable', 'Owners reach every account in their business. Change this person’s role first.', 409)
  }

  const ids = await validAccountIds(input.restricted ? input.connectionIds ?? [] : [])

  const saved = await prisma.$transaction(async tx => {
    if (!input.restricted) {
      await tx.workspaceMemberAccountLimit.deleteMany({ where: { membershipId: member.id } })
      await tx.workspaceMemberAccount.deleteMany({ where: { membershipId: member.id } })
    } else {
      await tx.workspaceMemberAccountLimit.upsert({
        where: { membershipId: member.id },
        create: { membershipId: member.id, setByUserId: actorUserId },
        update: {},
      })
      // Replace, never merge: the caller sent the whole set.
      await tx.workspaceMemberAccount.deleteMany({ where: { membershipId: member.id, connectionId: { notIn: ids.length ? ids : ['__none__'] } } })
      for (const connectionId of ids) {
        await tx.workspaceMemberAccount.upsert({
          where: { membershipId_connectionId: { membershipId: member.id, connectionId } },
          create: { membershipId: member.id, connectionId, grantedByUserId: actorUserId },
          update: {},
        })
      }
    }
    await tx.workspaceAudit.create({
      data: {
        workspaceId, actorUserId, action: 'member.account_access', targetId: member.id,
        metadata: { restricted: input.restricted, connectionIds: ids, memberUserId: member.userId },
      },
    })
    return { restricted: input.restricted, connectionIds: ids }
  })

  return { membershipId: member.id, userId: member.userId, email: member.user.email, ...saved }
}

async function isOwnerOf(membershipId: string): Promise<boolean> {
  const count = await prisma.workspaceMemberRole.count({
    where: { membershipId, role: { key: 'OWNER' } },
  })
  return count > 0
}

/**
 * Every id must name an account this business can actually reach right now.
 *
 * 🔴 Read through the caller's own context on purpose. An owner is unrestricted, so
 * this resolves to the business's accounts including ones shared in from elsewhere —
 * and an id that resolves to nothing is REFUSED rather than dropped. Silently
 * dropping an unknown id would narrow a limit the operator thought they had widened.
 */
async function validAccountIds(ids: string[]): Promise<string[]> {
  if (!Array.isArray(ids)) throw new WorkspaceError('invalid_accounts', 'Choose accounts from this business profile.', 400)
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  if (unique.some(id => typeof id !== 'string' || !id)) {
    throw new WorkspaceError('invalid_accounts', 'Choose accounts from this business profile.', 400)
  }
  const found = await prisma.channelConnection.findMany({ where: { id: { in: unique } }, select: { id: true } })
  if (found.length !== unique.length) {
    const missing = unique.filter(id => !found.some(row => row.id === id))
    throw new WorkspaceError('unknown_account', `${missing.length} of those accounts are not available in this business profile.`, 400)
  }
  return unique
}
