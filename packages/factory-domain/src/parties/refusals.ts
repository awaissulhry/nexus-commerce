/**
 * The party rules the database holds for every write (factory-db …_sales_intake_w2b_guards, W2b-5 schema wave 37/44,
 * B-W2b-279; SAL-021, SAL-022), read back from the database's own words, pure: an erased contact keeps its personal fields
 * blank and stays archived (GDPR art. 17), a rider under a team stays a person, and a team with riders stays an
 * organisation. The commands of B-W2b-290 check these first in words; when a write reaches the rule without that check
 * (W1's contact and party routes, the importer, a supplier's profile change), the API answers 409 in these words instead of
 * a 500 (apps/factory-api core/errors).
 */

/** The issue paths of the three refusals. */
export const PARTY_REFUSAL_ISSUES = Object.freeze({
  erased: 'privacy/CONTACT_ERASED',
  rider: 'parties/RIDER_IS_PERSON',
  team: 'parties/TEAM_HAS_RIDERS',
} as const)

const ERASED = /^parties: contact \S+ was erased/
const RIDER = /^parties: party \S+ rides for a team, so it is a person/
const TEAM = /^parties: party \S+ has riders, so it stays an organisation/

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
  return null
}
