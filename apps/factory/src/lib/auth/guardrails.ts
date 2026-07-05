/**
 * F1 — Owner-supremacy guardrails (S-series pattern; pure predicates, unit-
 * tested without a DB). The team service is the ONLY sanctioned mutation path
 * and must consult these before writing.
 */
import { OWNER_ROLE_KEY, isValidPermission } from "./permissions";

export class GuardrailError extends Error {
  constructor(
    public readonly code:
      | "owner_grant_denied"
      | "last_owner"
      | "system_role"
      | "role_in_use"
      | "unknown_permission",
    message: string,
  ) {
    super(message);
  }
}

/** Only an OWNER may grant the OWNER role. */
export function assertOwnerGrant(actorIsOwner: boolean, grantedRoleKey: string): void {
  if (grantedRoleKey === OWNER_ROLE_KEY && !actorIsOwner)
    throw new GuardrailError("owner_grant_denied", "Only an owner can grant the Owner role");
}

/** The last OWNER can never be demoted, deleted or deactivated — by anyone. */
export function assertNotLastOwner(ownerCountAfterChange: number): void {
  if (ownerCountAfterChange < 1)
    throw new GuardrailError("last_owner", "The last owner cannot be removed or deactivated");
}

/** System roles are immutable (rename/permissions/delete). */
export function assertNotSystemRole(isSystem: boolean): void {
  if (isSystem) throw new GuardrailError("system_role", "System roles cannot be modified");
}

/** Custom roles are deletable only with zero members. */
export function assertRoleUnused(memberCount: number): void {
  if (memberCount > 0)
    throw new GuardrailError("role_in_use", `Role still has ${memberCount} member(s)`);
}

/** Every stored permission must exist in the registry. */
export function assertKnownPermissions(permissions: string[]): void {
  const unknown = permissions.filter((p) => !isValidPermission(p));
  if (unknown.length)
    throw new GuardrailError("unknown_permission", `Unknown permission(s): ${unknown.join(", ")}`);
}
