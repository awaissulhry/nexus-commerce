/**
 * Phase S2 (RBAC engine) — team & access service (guardrailed mutations).
 *
 * The ONLY sanctioned path for changing who-can-do-what. Every mutation:
 *   • enforces the Owner-supremacy guardrails (team-guardrails.ts),
 *   • bumps the affected users' permissionsVersion so their cached
 *     permissions re-resolve on the next request (immediate propagation,
 *     §3.5),
 *   • revokes sessions where the change must take effect instantly
 *     (deactivation, force sign-out).
 * The S4 console calls these; they never live in a route handler.
 */

import prisma from '../db.js'
import { revokeAllSessions } from '../lib/auth/session.js'
import { clearPermissionCache } from '../lib/auth/rbac.js'
import {
  assertCanAssignRole,
  assertCanRemoveOwner,
  assertCanDeactivate,
  assertRoleEditable,
  assertRoleDeletable,
  assertValidPermissions,
} from '../lib/auth/team-guardrails.js'
import { OWNER_ROLE_KEY, SYSTEM_ROLES } from '@nexus/shared/permissions'

/**
 * Seed/refresh the six system roles from the registry. Idempotent +
 * production-safe (roles are config). Called at API startup so a deploy
 * always converges the DB to the code, and by the seed-roles script.
 * bumpVersions forces every user to re-resolve permissions next request —
 * used by the script (a manual re-seed), not on every boot.
 */
export async function seedSystemRoles(opts?: { bumpVersions?: boolean }): Promise<number> {
  for (const def of Object.values(SYSTEM_ROLES)) {
    await (prisma as any).role.upsert({
      where: { key: def.key },
      create: {
        key: def.key, name: def.name, description: def.description,
        permissions: def.permissions, isSystem: true, requireMfa: def.requireMfa,
      },
      update: {
        name: def.name, description: def.description,
        permissions: def.permissions, isSystem: true, requireMfa: def.requireMfa,
      },
    })
  }
  if (opts?.bumpVersions) {
    await (prisma as any).userProfile.updateMany({ data: { permissionsVersion: { increment: 1 } } })
    clearPermissionCache()
  }
  return Object.keys(SYSTEM_ROLES).length
}

export async function countOwners(): Promise<number> {
  return (prisma as any).userRole.count({
    where: { role: { key: OWNER_ROLE_KEY }, user: { status: 'active' } },
  })
}

async function isUserOwner(userId: string): Promise<boolean> {
  const n = await (prisma as any).userRole.count({
    where: { userId, role: { key: OWNER_ROLE_KEY } },
  })
  return n > 0
}

/** Bump a single user's permissionsVersion (invalidates their perm cache). */
export async function bumpUserPermissionVersion(userId: string): Promise<void> {
  await (prisma as any).userProfile.update({
    where: { id: userId },
    data: { permissionsVersion: { increment: 1 } },
  })
}

/** Bump every user holding a role — used when the role's permissions change. */
async function bumpUsersWithRole(roleId: string): Promise<void> {
  const members = await (prisma as any).userRole.findMany({ where: { roleId }, select: { userId: true } })
  const ids = [...new Set(members.map((m: any) => m.userId as string))]
  if (ids.length > 0) {
    await (prisma as any).userProfile.updateMany({
      where: { id: { in: ids } },
      data: { permissionsVersion: { increment: 1 } },
    })
  }
  clearPermissionCache()
}

// ── Role assignment ────────────────────────────────────────────────

export async function assignRole(opts: {
  actorIsOwner: boolean
  actorUserId: string
  targetUserId: string
  roleKey: string
  channelScope?: unknown
}): Promise<void> {
  assertCanAssignRole(opts.actorIsOwner, opts.roleKey)
  const role = await (prisma as any).role.findUnique({ where: { key: opts.roleKey }, select: { id: true } })
  if (!role) throw new Error(`Unknown role "${opts.roleKey}"`)
  await (prisma as any).userRole.upsert({
    where: { userId_roleId: { userId: opts.targetUserId, roleId: role.id } },
    create: {
      userId: opts.targetUserId,
      roleId: role.id,
      channelScope: (opts.channelScope as any) ?? undefined,
      grantedByUserId: opts.actorUserId,
    },
    update: { channelScope: (opts.channelScope as any) ?? undefined },
  })
  await bumpUserPermissionVersion(opts.targetUserId)
}

export async function removeRole(opts: { targetUserId: string; roleKey: string }): Promise<void> {
  if (opts.roleKey === OWNER_ROLE_KEY) {
    assertCanRemoveOwner(true, await countOwners())
  }
  const role = await (prisma as any).role.findUnique({ where: { key: opts.roleKey }, select: { id: true } })
  if (!role) return
  await (prisma as any).userRole.deleteMany({ where: { userId: opts.targetUserId, roleId: role.id } })
  await bumpUserPermissionVersion(opts.targetUserId)
}

// ── User lifecycle ─────────────────────────────────────────────────

export async function deactivateUser(targetUserId: string): Promise<void> {
  if (await isUserOwner(targetUserId)) {
    assertCanDeactivate(true, await countOwners())
  }
  await (prisma as any).userProfile.update({
    where: { id: targetUserId },
    data: { status: 'deactivated', deactivatedAt: new Date(), permissionsVersion: { increment: 1 } },
  })
  // Instant lockout: kill every live session.
  await revokeAllSessions(targetUserId)
}

export async function reactivateUser(targetUserId: string): Promise<void> {
  await (prisma as any).userProfile.update({
    where: { id: targetUserId },
    data: { status: 'active', deactivatedAt: null, permissionsVersion: { increment: 1 } },
  })
}

/** Force sign-out: revoke all sessions without deactivating the account. */
export async function forceSignOut(targetUserId: string): Promise<number> {
  return revokeAllSessions(targetUserId)
}

// ── Role CRUD (custom roles) ───────────────────────────────────────

export async function createRole(opts: {
  key: string
  name: string
  description?: string
  permissions: string[]
  requireMfa?: boolean
}): Promise<string> {
  assertValidPermissions(opts.permissions)
  const row = await (prisma as any).role.create({
    data: {
      key: opts.key,
      name: opts.name,
      description: opts.description ?? '',
      permissions: opts.permissions,
      isSystem: false,
      requireMfa: opts.requireMfa ?? false,
    },
    select: { id: true },
  })
  return row.id as string
}

export async function updateRole(
  roleId: string,
  patch: { name?: string; description?: string; permissions?: string[]; requireMfa?: boolean },
): Promise<void> {
  const role = await (prisma as any).role.findUnique({ where: { id: roleId }, select: { key: true, isSystem: true } })
  if (!role) throw new Error('Role not found')
  assertRoleEditable(role)
  if (patch.permissions) assertValidPermissions(patch.permissions)
  await (prisma as any).role.update({
    where: { id: roleId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
      ...(patch.requireMfa !== undefined ? { requireMfa: patch.requireMfa } : {}),
    },
  })
  // A permission change affects everyone holding the role.
  if (patch.permissions !== undefined) await bumpUsersWithRole(roleId)
}

export async function deleteRole(roleId: string): Promise<void> {
  const role = await (prisma as any).role.findUnique({ where: { id: roleId }, select: { isSystem: true } })
  if (!role) return
  const memberCount = await (prisma as any).userRole.count({ where: { roleId } })
  assertRoleDeletable(role, memberCount)
  await (prisma as any).role.delete({ where: { id: roleId } })
}
