/**
 * Phase S2 (RBAC engine) — Owner-supremacy guardrails (pure predicates).
 *
 * The invariants from master prompt §3.4, expressed as pure functions so
 * they are unit-tested without a DB and enforced in ONE place (the service
 * layer, not the UI):
 *   • the last OWNER can never be demoted, deleted, or deactivated — by
 *     anyone, including themselves;
 *   • only an OWNER may grant OWNER;
 *   • system roles (OWNER especially) can't be edited or deleted;
 *   • a role's permission set must contain only registry permissions.
 *
 * Each throws a GuardrailError with a stable `code` the API maps to 403/409.
 */

import { isValidPermission, OWNER_ROLE_KEY } from '@nexus/shared/permissions'

export class GuardrailError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'GuardrailError'
  }
}

/** Only an OWNER may grant the OWNER role. */
export function assertCanAssignRole(actorIsOwner: boolean, roleKey: string): void {
  if (roleKey === OWNER_ROLE_KEY && !actorIsOwner) {
    throw new GuardrailError('owner_grant_denied', 'Only an Owner can grant the Owner role.')
  }
}

/** Removing/demoting an OWNER assignment is blocked when they're the last. */
export function assertCanRemoveOwner(targetIsOwner: boolean, ownerCount: number): void {
  if (targetIsOwner && ownerCount <= 1) {
    throw new GuardrailError('last_owner', 'Cannot remove the last Owner — the workspace must always have one.')
  }
}

/** Deactivating the last OWNER is blocked. */
export function assertCanDeactivate(targetIsOwner: boolean, ownerCount: number): void {
  if (targetIsOwner && ownerCount <= 1) {
    throw new GuardrailError('last_owner', 'Cannot deactivate the last Owner.')
  }
}

/** System roles are immutable structurally (name/permissions of OWNER etc). */
export function assertRoleEditable(role: { key: string; isSystem: boolean }): void {
  if (role.key === OWNER_ROLE_KEY) {
    throw new GuardrailError('system_role', 'The Owner role is system-protected and cannot be edited.')
  }
}

/** A role can be deleted only if it is custom and has no members. */
export function assertRoleDeletable(role: { isSystem: boolean }, memberCount: number): void {
  if (role.isSystem) {
    throw new GuardrailError('system_role', 'System roles cannot be deleted.')
  }
  if (memberCount > 0) {
    throw new GuardrailError('role_in_use', `Reassign or remove the ${memberCount} member(s) before deleting this role.`)
  }
}

/** Every permission on a role must exist in the registry. */
export function assertValidPermissions(permissions: string[]): void {
  const bad = permissions.filter((p) => !isValidPermission(p))
  if (bad.length > 0) {
    throw new GuardrailError('unknown_permission', `Unknown permission(s): ${bad.join(', ')}`)
  }
}
