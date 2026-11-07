import type { FactoryClient } from '@nexus/factory-db'
import { partnerGrants, portalAccessProblem } from '@nexus/factory-domain/auth/portal/access'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../../core/command'
import { partnerRoles, partyOf, portalOn, termsState } from '../../auth/portal/store'

/**
 * The people of a party a request or a notification is for (B-W2b-167; plan B-W2b-156 "which person a task is for is the
 * API's"): there is no assignee — a partner person is a reader of the party's task list or news when they could use the portal
 * now (ACTIVE, before their end of access, the organisation not paused, its portal ON, the company's portal terms in force:
 * B-W2b-159's access rules) and their PARTNER roles reach the record's company and party. Their actor carries those grants
 * (price at most), so `isTaskFor` and a rule's own check read the same thing a portal session of theirs would hold.
 *
 * Read in the tenant's office or system scope (the partner role reads only its own party, and not roles). Whether a reader
 * acknowledged the terms is not asked here: a person told by e-mail signs in and acknowledges first.
 */

type Client = FactoryClient | CommandTx

export interface PartnerReader {
  readonly personId: string
  readonly email: string
  readonly displayName: string
  readonly locale: 'it' | 'en'
  readonly partyId: string
  readonly actor: Actor
}

/** At most this many people of one party (a partner organisation's portal users). */
export const MAX_PARTY_PEOPLE = 200

export async function partyReaders(client: Client, tenantId: string, partyId: string, companyId: string, now: Date, options: { readonly includeAll?: boolean } = {}): Promise<PartnerReader[]> {
  const party = await partyOf(client, partyId)
  if (!party || (party.companyId !== null && party.companyId !== companyId)) return []
  const on = await portalOn(client, partyId)
  const people = await client.user.findMany({
    where: { partyId, audience: 'PARTNER', status: 'ACTIVE' },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: MAX_PARTY_PEOPLE,
    select: { id: true, email: true, displayName: true, locale: true, status: true, accessUntil: true },
  })
  const readers: PartnerReader[] = []
  for (const person of people) {
    const terms = await termsState(client, companyId, person.id)
    const problem = portalAccessProblem({ user: { status: person.status, accessUntil: person.accessUntil }, party, portalOn: on, termsInForce: terms !== null }, now)
    if (problem !== null && options.includeAll !== true) continue
    const grants = partnerGrants(await partnerRoles(client, person.id, now), { companyId, partyId }, { termsAcknowledged: true })
    readers.push({
      personId: person.id,
      email: person.email,
      displayName: person.displayName,
      locale: person.locale === 'en' ? 'en' : 'it',
      partyId,
      actor: { audience: 'partner', tenantId, partyId, grants },
    })
  }
  return readers
}
