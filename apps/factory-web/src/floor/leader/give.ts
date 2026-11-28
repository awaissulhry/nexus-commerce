import type { BasketTeam, TeamPerson } from '../basket/api'
import type { GiveBasket, GivePerson } from './view/GiveWindowView'

/**
 * owb-fl6 step 3 — Give to… without a screen: the people of the team with what each holds (a name only where the site names workers:
 * else "Person n", in the team's order), the team's baskets a person does not hold, and the Undo of a give (back to who held it).
 */

/** The label of a person: the name, or "Person n" (`words` builds it). */
export const personLabel = (person: TeamPerson, index: number, words: (n: number) => string): string => person.name ?? words(index + 1)

export function givePeopleOf(team: BasketTeam, bundleId: string, words: (n: number) => string): GivePerson[] {
  return team.people.map((person, index) => ({ key: person.key, label: personLabel(person, index, words), holds: person.holds?.code ?? null, current: person.holds?.bundleId === bundleId }))
}

/** The team's baskets (every order) a person does not hold now, in the leader home's order. */
export function giveBasketsOf(team: BasketTeam, personKey: string): GiveBasket[] {
  const holds = team.people.find((person) => person.key === personKey)?.holds?.bundleId ?? null
  return team.orders.flatMap((order) => order.baskets).filter((row) => row.bundleId !== holds).map((row) => ({ bundleId: row.bundleId, code: row.code }))
}

/** Who held a basket before a give (the Undo gives it back to them); null: nobody. */
export function holderOf(team: BasketTeam, bundleId: string): TeamPerson | null {
  return team.people.find((person) => person.holds?.bundleId === bundleId) ?? null
}
