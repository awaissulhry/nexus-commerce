/**
 * F1 — permission resolver (S2 pattern). OWNER short-circuits to implicit-all;
 * everyone else gets the union of their roles' permission lists, expanded
 * (financials.view ⇒ grains). Cached 30s keyed on userId:permissionsVersion —
 * the version bump on any role mutation gives immediate propagation.
 */
import { prisma } from "@/lib/db";
import { TtlCache } from "@/lib/ttl-cache";
import { OWNER_ROLE_KEY, expandPermissions } from "./permissions";
import type { SessionUser } from "./session";

export type Resolved = { isOwner: boolean; permissions: Set<string> };

const cache = new TtlCache<Resolved>(30_000, 5000);

export async function resolvePermissions(user: SessionUser): Promise<Resolved> {
  if (user.roleKeys.includes(OWNER_ROLE_KEY)) return { isOwner: true, permissions: new Set() };
  const key = `${user.id}:${user.permissionsVersion}:${[...user.roleKeys].sort().join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const roles = await prisma.role.findMany({ where: { key: { in: user.roleKeys } } });
  const union: string[] = [];
  for (const role of roles) {
    const perms = Array.isArray(role.permissions) ? (role.permissions as string[]) : [];
    union.push(...perms);
  }
  const resolved: Resolved = { isOwner: false, permissions: expandPermissions(union) };
  cache.set(key, resolved);
  return resolved;
}

export const hasPermission = (resolved: Resolved, permission: string): boolean =>
  resolved.isOwner || resolved.permissions.has(permission);

export const clearPermissionCache = () => cache.clear();
