import type { FactoryClient } from '@nexus/factory-db'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { mfaRequiredFor, sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { TWO_FACTOR_ACTION } from '@nexus/factory-domain/ops/two-factor'
import { heldRoles, type HeldAssignment } from '../roles/access'

/**
 * The grants of an office session (plan A1 §3.11; features PLT-030, PLT-032, PLT-045), built on every request from the
 * person's live role assignments (platform/auth/roles):
 *   - one grant per live assignment: the role's permissions plus a `money.<grain>` permission per grain it sees, over
 *     the assignment's companies, sites and parties; the session holds their union;
 *   - two-factor first: a role that requires two-factor gives nothing until the second factor was proved on THIS
 *     session (at sign-in, or by setting two-factor up on it); a person who requires it (User.requireMfa) holds
 *     nothing at all until then. They can still reach their own account, to set it up;
 *   - from the next sign-in, never mid-session (B-W2a-36, PLT-045): a role whose two-factor rule was switched on through
 *     Security & health (platform/admin/security, audit action TWO_FACTOR_ACTION) AFTER this session started (and after
 *     the assignment was given) keeps giving its permissions to this session until it ends (8 h idle, 7 days at most);
 *     the next sign-in asks for it.
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

/**
 * The assignments held whose role's two-factor rule was switched on after this session started — and after the
 * assignment was given (a role given later already asked for it) (see above). Read only when it can matter: the session
 * has not proved two-factor and a role it holds asks for it.
 */
async function assignmentsInGrace(client: FactoryClient, held: readonly HeldAssignment[], session: { readonly mfaAt: Date | null; readonly createdAt?: Date }): Promise<ReadonlySet<string>> {
  if (session.mfaAt !== null || session.createdAt === undefined) return new Set()
  const asking = held.filter((entry) => entry.role.requireMfa)
  if (asking.length === 0) return new Set()
  const switches = await client.auditLog.findMany({
    where: { recordType: 'Role', recordId: { in: [...new Set(asking.map((entry) => entry.roleId))] }, action: TWO_FACTOR_ACTION, at: { gt: session.createdAt } },
    select: { recordId: true, after: true, at: true },
  })
  const switchedOn = new Map<string, Date>()
  for (const row of switches) {
    if ((row.after as { requireMfa?: unknown } | null)?.requireMfa !== true) continue
    const seen = switchedOn.get(row.recordId)
    if (!seen || row.at > seen) switchedOn.set(row.recordId, row.at)
  }
  if (switchedOn.size === 0) return new Set()
  const given = await client.roleAssignment.findMany({ where: { id: { in: asking.filter((entry) => switchedOn.has(entry.roleId)).map((entry) => entry.assignmentId) } }, select: { id: true, roleId: true, createdAt: true } })
  return new Set(given.filter((row) => row.createdAt < switchedOn.get(row.roleId)!).map((row) => row.id))
}

/** What a session of this person may do now (read in the session's tenant scope). */
export async function sessionAccess(
  client: FactoryClient,
  user: { readonly id: string; readonly requireMfa: boolean },
  session: { readonly mfaAt: Date | null; readonly createdAt?: Date },
  now: Date,
): Promise<SessionAccess> {
  const held = await heldRoles(client, user.id, now)
  const grace = await assignmentsInGrace(client, held, session)
  const effective = grace.size === 0 ? held : held.map((entry) => (grace.has(entry.assignmentId) ? { ...entry, role: { ...entry.role, requireMfa: false } } : entry))
  return {
    grants: sessionGrants(user, effective, session.mfaAt !== null),
    requireMfa: mfaRequiredFor(user, held),
  }
}

/** Two-factor is required for this person now (sign-in and invitation answers, before a session exists). */
export async function requiresMfa(client: FactoryClient, user: { readonly id: string; readonly requireMfa: boolean }, now: Date): Promise<boolean> {
  return user.requireMfa || mfaRequiredFor(user, await heldRoles(client, user.id, now))
}
