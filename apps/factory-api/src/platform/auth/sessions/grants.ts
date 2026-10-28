import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'

/**
 * The grants of an office session: a PLACEHOLDER until the roles step (B-W0-15) brings roles, assignments and their
 * scopes (A1 §3.11). Today:
 *   - an owner (`User.isOwner`) holds OWNER_PERMISSIONS, in every company, site and party of the tenant;
 *   - everyone else holds no permission: only the routes any signed-in person may use (their own account);
 *   - two-factor first (PLT-045): an owner, or a user with `requireMfa`, holds nothing until the second factor was
 *     proved on THIS session (at sign-in, or by setting two-factor up on it). They can still reach their own account,
 *     to set it up.
 * The roles step replaces `grantsOf` (and drops `isOwner`'s meaning here), keeping the two-factor rule.
 */

/** Every permission the platform parts built so far check. */
export const OWNER_PERMISSIONS = [
  'users.view',
  'users.invite',
  'users.suspend',
  'users.reactivate',
  'users.deactivate',
  'users.resetPassword',
  'audit.read',
] as const satisfies readonly Permission[]

export interface GrantSubject {
  readonly isOwner: boolean
  readonly requireMfa: boolean
}

/** Two-factor is required for this person (owners always). */
export const mfaRequired = (user: GrantSubject): boolean => user.isOwner || user.requireMfa

/** The session may use the person's permissions: two-factor is not required, or it was proved on this session. */
export const mfaSatisfied = (user: GrantSubject, session: { readonly mfaAt: Date | null }): boolean => !mfaRequired(user) || session.mfaAt !== null

const OWNER_GRANT: Grant = Object.freeze({ permissions: OWNER_PERMISSIONS, companies: 'all', sites: 'all', parties: 'all' })

export function grantsOf(user: GrantSubject, session: { readonly mfaAt: Date | null }): readonly Grant[] {
  if (!mfaSatisfied(user, session)) return []
  return user.isOwner ? [OWNER_GRANT] : []
}
