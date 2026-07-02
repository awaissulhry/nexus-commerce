/**
 * Phase S2 (RBAC engine) — permission resolver.
 *
 * Turns a session user into the effective permission set actually checked
 * per request. OWNER is implicit-all (short-circuit). Everyone else is the
 * union of their roles' permission arrays, with `financials.view` expanded
 * to its finer grains.
 *
 * Immediate propagation (§3.5): the cache key includes the user's
 * permissionsVersion AND their live role keys, so (a) any role/permission
 * mutation that bumps permissionsVersion and (b) any change to which roles
 * the user holds both invalidate instantly. A short TTL backstops the case
 * where a Role's permission LIST changes without a version bump. Postgres
 * is the source of truth; this cache is a per-process accelerator (no Redis
 * dependency — see docs/security/S0-AUDIT.md §3).
 */

import prisma from '../../db.js'
import { expandPermissions, OWNER_ROLE_KEY } from '@nexus/shared/permissions'

export interface ResolvedPermissions {
  isOwner: boolean
  permissions: Set<string>
}

interface CacheEntry {
  at: number
  value: ResolvedPermissions
}

const CACHE = new Map<string, CacheEntry>()
const TTL_MS = 30_000
const MAX_ENTRIES = 5000

function cacheKey(userId: string, version: number, roleKeys: string[]): string {
  return `${userId}:${version}:${[...roleKeys].sort().join(',')}`
}

/** Resolve the effective permissions for a session user (cached). */
export async function resolvePermissions(user: {
  id: string
  permissionsVersion: number
  roleKeys: string[]
}): Promise<ResolvedPermissions> {
  if (user.roleKeys.includes(OWNER_ROLE_KEY)) {
    return { isOwner: true, permissions: new Set() }
  }
  const key = cacheKey(user.id, user.permissionsVersion, user.roleKeys)
  const hit = CACHE.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  const roles: { permissions: string[] }[] =
    user.roleKeys.length === 0
      ? []
      : await (prisma as any).role.findMany({
          where: { key: { in: user.roleKeys } },
          select: { permissions: true },
        })
  const union: string[] = []
  for (const r of roles) union.push(...r.permissions)
  const value: ResolvedPermissions = { isOwner: false, permissions: expandPermissions(union) }

  if (CACHE.size >= MAX_ENTRIES) CACHE.clear()
  CACHE.set(key, { at: Date.now(), value })
  return value
}

/** Does the resolved set grant `permission`? OWNER always does. */
export function hasPermission(resolved: ResolvedPermissions, permission: string): boolean {
  return resolved.isOwner || resolved.permissions.has(permission)
}

/** Drop cached entries (call after a role/permission mutation as a belt-
 *  and-braces companion to bumping permissionsVersion). */
export function clearPermissionCache(): void {
  CACHE.clear()
}
