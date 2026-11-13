/**
 * The party rules the database holds for every write (factory-db …_sales_intake_w2b_guards, W2b-5 schema wave 37/44,
 * B-W2b-279; SAL-021, SAL-022), read back from the database's own words, pure: an erased contact keeps its personal fields
 * blank and stays archived (GDPR art. 17), a rider under a team stays a person, and a team with riders stays an
 * organisation. The commands of B-W2b-290 check these first in words; when a write reaches the rule without that check
 * (W1's contact and party routes, the importer, a supplier's profile change), the API answers 409 in these words instead of
 * a 500 (apps/factory-api core/errors).
 *
 * W2b-6 (schema wave 48/57, B-W2b-367; LOG-038; …_carriers_w2b_guards Party_carrier_account_check): a party that ships on its
 * own carrier account, or has a default carrier service, keeps its preferred carrier (W1's commercial terms route clears it).
 */

/** The issue paths of the three refusals. */
export const PARTY_REFUSAL_ISSUES = Object.freeze({
  erased: 'privacy/CONTACT_ERASED',
  rider: 'parties/RIDER_IS_PERSON',
  team: 'parties/TEAM_HAS_RIDERS',
  carrier: 'parties/CARRIER_ACCOUNT_NEEDS_CARRIER',
} as const)

const ERASED = /^parties: contact \S+ was erased/
const RIDER = /^parties: party \S+ rides for a team, so it is a person/
const TEAM = /^parties: party \S+ has riders, so it stays an organisation/
const CARRIER = /^parties: (party \S+ keeps a carrier account only with its preferred carrier|the default carrier service of party \S+ is 1 to 100 characters on one line, with its preferred carrier)/

/** The words and issue path of a party refusal of the database, or null when the message is another one. */
export function databasePartyRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (ERASED.test(message)) {
    return {
      path: PARTY_REFUSAL_ISSUES.erased,
      message: 'This contact was erased on request: its name, e-mail and phone stay blank and it stays archived. Add a new contact for new details.',
    }
  }
  if (RIDER.test(message)) {
    return { path: PARTY_REFUSAL_ISSUES.rider, message: 'This party rides for a team, so it stays a person. Take it off the team first.' }
  }
  if (TEAM.test(message)) {
    return { path: PARTY_REFUSAL_ISSUES.team, message: 'This party is a team or dealer with riders under it, so it stays an organisation. Move its riders first.' }
  }
  if (CARRIER.test(message)) {
    return {
      path: PARTY_REFUSAL_ISSUES.carrier,
      message: 'This party ships on its own carrier account or has a default carrier service, so it keeps its preferred carrier. Remove the account and the service first.',
    }
  }
  return null
}
