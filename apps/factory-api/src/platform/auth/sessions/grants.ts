import type { FactoryClient } from '@nexus/factory-db'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { mfaRequiredFor, sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { heldRoles } from '../roles/access'

/**
 * The grants of an office session (plan A1 §3.11; features PLT-030, PLT-032, PLT-045), built on every request from the
 * person's live role assignments (platform/auth/roles):
 *   - one grant per live assignment: the role's permissions plus a `money.<grain>` permission per grain it sees, over
 *     the assignment's companies, sites and parties; the session holds their union;
 *   - two-factor first: a role that requires two-factor gives nothing until the second factor was proved on THIS
 *     session (at sign-in, or by setting two-factor up on it); a person who requires it (User.requireMfa) holds
 *     nothing at all until then. They can still reach their own account, to set it up.
 */

/** The person as the grant rules see them: `requireMfa` is the effective flag (their own, or a role's). */
export interface GrantSubject {
  readonly requireMfa: boolean
}

/** Two-factor is required for this person (the effective flag from `sessionAccess`). */
export const mfaRequired = (user: GrantSubject): boolean => user.requireMfa

/** The session may use the person's permissions: two-factor is not required, or it was proved on this session. */
export const mfaSatisfied = (user: GrantSubject, session: { readonly mfaAt: Date | null }): boolean => !mfaRequired(user) || session.mfaAt !== null

export interface SessionAccess {
  readonly grants: readonly Grant[]
  /** Two-factor is required: by the person's own flag or by a role they hold now. */
  readonly requireMfa: boolean
}

/** What a session of this person may do now (read in the session's tenant scope). */
export async function sessionAccess(
  client: FactoryClient,
  user: { readonly id: string; readonly requireMfa: boolean },
  session: { readonly mfaAt: Date | null },
  now: Date,
): Promise<SessionAccess> {
  const held = await heldRoles(client, user.id, now)
  return {
    grants: sessionGrants(user, held, session.mfaAt !== null),
    requireMfa: mfaRequiredFor(user, held),
  }
}

/** Two-factor is required for this person now (sign-in and invitation answers, before a session exists). */
export async function requiresMfa(client: FactoryClient, user: { readonly id: string; readonly requireMfa: boolean }, now: Date): Promise<boolean> {
  return user.requireMfa || mfaRequiredFor(user, await heldRoles(client, user.id, now))
}
