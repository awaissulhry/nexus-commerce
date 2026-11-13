/**
 * The role rules the database holds since W2b-6 schema wave 52/57 (factory-db …_security_audit_w2b_guards, B-W2b-373;
 * PLT-031) that W0's routes can reach, read back from the database's own words, pure: an archived custom role changes no
 * more until it is restored, and it is given to nobody (an office assignment, an invitation's roles, a worker's floor role).
 * B-W2b-404's archive and restore commands check these first in words; when a write of an existing route (PATCH
 * /auth/roles/:roleId, POST /auth/users/:userId/roles, an invitation, a floor role) reaches the rule without that check, the
 * API answers 409 in these words instead of a 500 (apps/factory-api core/errors).
 */

/** The issue path of the refusals. */
export const ROLE_REFUSAL_ISSUES = Object.freeze({
  archived: 'roles/ROLE_ARCHIVED',
} as const)

const FROZEN = /^roles: role \S+ is archived: it changes no more/
const GIVEN = /^roles: role \S+ is archived: it is given to nobody/

/** The words and issue path of a refusal of the database's archived-role rules, or null when the message is another one. */
export function databaseRoleRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (FROZEN.test(message)) {
    return { path: ROLE_REFUSAL_ISSUES.archived, message: 'This role is archived: it changes no more. Restore it first.' }
  }
  if (GIVEN.test(message)) {
    return { path: ROLE_REFUSAL_ISSUES.archived, message: 'This role is archived: it is given to nobody. Pick another role, or restore it first.' }
  }
  return null
}
