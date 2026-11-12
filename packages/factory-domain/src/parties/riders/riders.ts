import type { PartyKind, PartyRole, PartyStatus } from '../rules'
import { isCustomer } from '../rules'

/**
 * Riders under a team or dealer (B-W2b-290; SAL-021; design sales.customers grid "Riders (people, W2b)", record › Overview
 * "Measurement profiles (riders, W2b)"), pure. A rider is a PERSON party (a customer: it may buy, and its measurement
 * profiles are its own) that rides for a team or is fitted through a dealer: factory-db's Party.teamPartyId (B-W2b-279).
 * W1 kept a rider as a contact of the team with a measurement profile; that stays as it is, and a rider record is now a
 * person of its own under the team.
 *
 *   rider   a PERSON party with the customer (or brand) role, not archived, not its own team
 *   team    an ORGANISATION with the customer or brand role, not archived, of the rider's company or tenant-wide; a party
 *           with riders stays an organisation (the database refuses a kind change; W1's PATCH answers 409 in words)
 */

export interface RiderFacts {
  readonly id: string
  readonly code: string
  readonly kind: PartyKind
  readonly roles: readonly PartyRole[]
  readonly status: PartyStatus
  readonly companyId: string | null
}

/** Why `rider` cannot ride for `team`, in words; null when it may. */
export function teamProblem(rider: RiderFacts, team: RiderFacts): string | null {
  if (rider.id === team.id) return `${rider.code} cannot ride for itself.`
  if (rider.kind !== 'PERSON') return `${rider.code} is an organisation: only a person rides for a team. Riders are people under a team or dealer.`
  if (!isCustomer(rider.roles)) return `${rider.code} is not a customer: give the rider the customer role first.`
  if (rider.status === 'ARCHIVED') return `${rider.code} is archived: reactivate it first.`
  if (team.kind !== 'ORGANISATION') return `${team.code} is a person: a rider rides for a team or dealer, an organisation.`
  if (!isCustomer(team.roles)) return `${team.code} is not a customer or a brand: a team or dealer buys from us.`
  if (team.status === 'ARCHIVED') return `${team.code} is archived: a rider is put under a team that is not archived.`
  if (team.companyId !== null && rider.companyId !== team.companyId) return `${team.code} belongs to one of our companies and ${rider.code} to ${rider.companyId === null ? 'every company' : 'another'}: a rider rides for a team of its own company, or for one of every company.`
  return null
}
