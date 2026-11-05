import type { Grant, Permission } from '../../core/permissions'
import { isGrain, type Grain } from '../grains/grains'
import { grantOf } from '../roles/roles'

/**
 * Who may open a portal session, and what it may do (B-W2b-159; PLT-050, PLT-006; design portal.signin access-paused;
 * GATE-PRIVACY). Pure: the API reads the facts in the tenant's office scope and asks here.
 *
 * After the code is proved — never before, so an answer tells a stranger nothing about an address — a sign-in is refused
 * in words when:
 *   PAUSED               the person is suspended, or their organisation is blocked or archived;
 *   ENDED                the person's end of access (User.accessUntil, PLT-022) has passed;
 *   INVITATION_ENDED     an invited person's invitation was revoked or expired meanwhile;
 *   PORTAL_OFF           the office has not switched the portal on for the organisation (PortalSettings.portalOn, OFF by
 *                        default; the first live partner is switched on by hand);
 *   TERMS_NOT_PUBLISHED  the company whose portal it is has no PORTAL_TERMS notice in force (GATE-PRIVACY: live portal
 *                        use waits for the published portal terms; local and test databases carry made-up ones).
 * The same rules (but the invitation's) are read again on every request of a live session: a session whose person,
 * organisation or portal stops qualifying stops at its next request.
 */

export type PortalAccessProblem = 'PAUSED' | 'ENDED' | 'INVITATION_ENDED' | 'PORTAL_OFF' | 'TERMS_NOT_PUBLISHED'

export interface PortalAccessFacts {
  readonly user: { readonly status: string; readonly accessUntil: Date | null }
  readonly party: { readonly status: string }
  /** PortalSettings.portalOn of the party (no row: false). */
  readonly portalOn: boolean
  /** The company has a PORTAL_TERMS notice in force. */
  readonly termsInForce: boolean
  /** For an INVITED person: an open PARTNER invitation (not accepted, not revoked, not expired). Ignored otherwise. */
  readonly invitationOpen?: boolean
}

const PAUSED_PARTY = new Set(['BLOCKED', 'ARCHIVED'])

/** The first reason the person may not open (or keep) a portal session now, or null. */
export function portalAccessProblem(facts: PortalAccessFacts, now: Date): PortalAccessProblem | null {
  const { user, party } = facts
  if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED' || PAUSED_PARTY.has(party.status)) return 'PAUSED'
  if (user.status === 'INVITED' && facts.invitationOpen !== true) return 'INVITATION_ENDED'
  if (user.status !== 'ACTIVE' && user.status !== 'INVITED') return 'PAUSED'
  if (user.accessUntil !== null && user.accessUntil.getTime() <= now.getTime()) return 'ENDED'
  if (!facts.portalOn) return 'PORTAL_OFF'
  if (!facts.termsInForce) return 'TERMS_NOT_PUBLISHED'
  return null
}

export interface PortalAccessWordsInput {
  /** The company whose portal it is, as partners know it. */
  readonly company: string
  /** Whom to contact: "<name> (<e-mail>)", or the company's name. */
  readonly contact: string
  /** The end of access as a date the reader reads (`dd/mm/yyyy`). */
  readonly accessUntil?: string | null
}

/** The refusal in words (design portal.signin access-paused: said only after the person proved the address). */
export function portalAccessWords(problem: PortalAccessProblem, input: PortalAccessWordsInput): string {
  switch (problem) {
    case 'PAUSED':
      return `Your access to the ${input.company} portal is paused. Contact ${input.contact}.`
    case 'ENDED':
      return input.accessUntil
        ? `Your access to the ${input.company} portal ended on ${input.accessUntil}. Contact ${input.contact} if you still need it.`
        : `Your access to the ${input.company} portal has ended. Contact ${input.contact} if you still need it.`
    case 'INVITATION_ENDED':
      return `Your invitation to the ${input.company} portal is no longer valid. Ask ${input.contact} for a new one.`
    case 'PORTAL_OFF':
      return `The ${input.company} portal is not switched on for your organisation yet. Contact ${input.contact}.`
    case 'TERMS_NOT_PUBLISHED':
      return `The ${input.company} portal is not open yet: its portal terms are not published. Contact ${input.contact}.`
  }
}

/** The money a partner session may ever see (A1 §2.6: partner and link sessions at most price; RoleAudience PARTNER). */
export const PARTNER_GRAINS: readonly Grain[] = Object.freeze(['price'])

export interface PartnerRole {
  readonly permissions: readonly string[]
  readonly grains: readonly string[]
  /** The assignment's company reach (a partner assignment names its party: the database holds it). */
  readonly allCompanies: boolean
  readonly companyIds: readonly string[]
}

export interface PartnerPlace {
  /** The company whose portal the session opened. */
  readonly companyId: string
  /** The session's party (the person's organisation). */
  readonly partyId: string
}

/**
 * The grants of a portal session: one per live PARTNER role of the person that reaches the session's company, over that
 * company and the person's party only. Grains above price are dropped (and no `money.*` permission is taken from a role's
 * permission list: money travels as grains). Nothing at all while the person has not acknowledged the portal terms in
 * force (the first visit), and nothing for an office preview of a portal (read-only; B-W2b-162 decides what it shows).
 */
export function partnerGrants(roles: readonly PartnerRole[], place: PartnerPlace, options: { readonly termsAcknowledged: boolean; readonly preview?: boolean }): Grant[] {
  if (!options.termsAcknowledged || options.preview === true) return []
  const scope = { allCompanies: false, companyIds: [place.companyId], siteIds: [], partyIds: [place.partyId] }
  return roles
    .filter((role) => role.allCompanies || role.companyIds.includes(place.companyId))
    .map((role) =>
      grantOf(
        {
          permissions: role.permissions.filter((permission) => !permission.startsWith('money.')) as Permission[],
          grains: role.grains.filter((grain): grain is Grain => isGrain(grain) && PARTNER_GRAINS.includes(grain)),
        },
        scope,
      ),
    )
}
