import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { isGrain } from '@nexus/factory-domain/auth/grains/grains'
import { ADMIN_PERMISSION, type HeldRole } from '@nexus/factory-domain/auth/roles/roles'
import type { CommandTx } from '../../../core/command'

/**
 * What a person holds now: their live office role assignments with each role's content (plan A1 §2.3, §3.11). The
 * office authenticator reads it on every request (sessions/grants.ts turns it into the session's grants), sign-in
 * reads it for "is two-factor required", and the administrator guard counts administrators with it.
 */

/** A live assignment as read: started, not past validTo, not ended. */
export const liveAssignment = (now: Date): Prisma.RoleAssignmentWhereInput => ({
  endedAt: null,
  validFrom: { lte: now },
  OR: [{ validTo: null }, { validTo: { gt: now } }],
})

const HELD_SELECT = {
  id: true,
  roleId: true,
  allCompanies: true,
  companyIds: true,
  siteIds: true,
  partyIds: true,
  role: { select: { key: true, system: true, requireMfa: true, permissions: true, grains: true } },
} as const

export interface HeldAssignment extends HeldRole {
  readonly assignmentId: string
  readonly roleId: string
  readonly roleKey: string
  readonly system: boolean
}

/** The person's live office assignments with their roles, oldest first. */
export async function heldRoles(client: FactoryClient | CommandTx, userId: string, now: Date): Promise<HeldAssignment[]> {
  const rows = await client.roleAssignment.findMany({
    where: { userId, ...liveAssignment(now), role: { audience: 'OFFICE' } },
    orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    select: HELD_SELECT,
  })
  return rows.map((row) => ({
    assignmentId: row.id,
    roleId: row.roleId,
    roleKey: row.role.key,
    system: row.role.system,
    role: { requireMfa: row.role.requireMfa, permissions: row.role.permissions as Permission[], grains: row.role.grains.filter(isGrain) },
    scope: { allCompanies: row.allCompanies, companyIds: row.companyIds, siteIds: row.siteIds, partyIds: row.partyIds },
  }))
}

/** The person holds the owner system role now (the `isOwner` the Office shows). */
export const holdsOwner = (held: readonly HeldAssignment[]): boolean => held.some((entry) => entry.system && entry.roleKey === 'owner')

/** What an administrator count leaves out: a user, an assignment, or every assignment of a role. */
export interface AdminExclusion {
  readonly userId?: string
  readonly assignmentId?: string
  readonly roleId?: string
}

/**
 * The tenant's active administrators: ACTIVE people with a live assignment, over every company, of an office role
 * that holds roles.assign (factory-domain ADMIN_PERMISSION). Read inside the command that might remove one, so the
 * guard sees the committed state.
 */
export async function activeAdmins(tx: CommandTx, now: Date, exclude: AdminExclusion = {}): Promise<Set<string>> {
  const rows = await tx.roleAssignment.findMany({
    where: {
      ...liveAssignment(now),
      allCompanies: true,
      user: { status: 'ACTIVE' },
      role: { audience: 'OFFICE', permissions: { has: ADMIN_PERMISSION } },
      ...(exclude.userId ? { userId: { not: exclude.userId } } : {}),
      ...(exclude.assignmentId ? { id: { not: exclude.assignmentId } } : {}),
      ...(exclude.roleId ? { roleId: { not: exclude.roleId } } : {}),
    },
    select: { userId: true },
  })
  return new Set(rows.map((row) => row.userId))
}
