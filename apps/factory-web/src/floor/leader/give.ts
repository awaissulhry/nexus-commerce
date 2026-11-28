import type { BasketTeam, TeamPerson } from '../basket/api'
import type { GiveBasket, GivePerson } from './view/GiveWindowView'

/**
 * owb-fl6 step 3 — Give to… without a screen: the people of the team with what each holds (only where the site names workers: server B's
 * fl4), the team's baskets a person does not hold, and the Undo of a give (back to who held it).
 */

/** The label of a person: the name, or "Person n" (`words` builds it). */
export const personLabel = (person: TeamPerson, index: number, words: (n: number) => string): string => person.name ?? words(index + 1)

/**
 * The people a basket may be given to: only where the site names workers (`name` set; at a station site the key is a placeholder and the
 * server refuses a give: SITE_NAMES_NO_WORKERS). Each with what he or she holds.
 */
export function givePeopleOf(team: BasketTeam, bundleId: string, words: (n: number) => string): GivePerson[] {
  return team.people.flatMap((person, index) => (person.name === null ? [] : [{ key: person.key, label: personLabel(person, index, words), holds: person.holds?.code ?? null, current: person.holds?.bundleId === bundleId }]))
}

/** The site names no workers: Give to… and Who has what are not used here (the words say so). */
export const namesNoWorkers = (team: Pick<BasketTeam, 'people'>): boolean => team.people.length > 0 && team.people.every((person) => person.name === null)

/** The team's baskets (every order) a person does not hold now, in the leader home's order. */
export function giveBasketsOf(team: BasketTeam, personKey: string): GiveBasket[] {
  const holds = team.people.find((person) => person.key === personKey)?.holds?.bundleId ?? null
  return team.orders.flatMap((order) => order.baskets).filter((row) => row.bundleId !== holds).map((row) => ({ bundleId: row.bundleId, code: row.code }))
}

/** Who held a basket before a give (the Undo gives it back to them); null: nobody. */
export function holderOf(team: BasketTeam, bundleId: string): TeamPerson | null {
  return team.people.find((person) => person.holds?.bundleId === bundleId) ?? null
}
