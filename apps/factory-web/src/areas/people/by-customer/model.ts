import type { ByCustomer, ExtraRight, Given, PersonAnswer } from './api'

/**
 * owb-of4 step 3 — People by customer (design § 5f, § 5h, round 36), pure: who works for which customer (a tick per person and
 * customer), each person's extra rights (Allow production · Pack and send · Print and start), and the bulk acts over the selected
 * people: Give to every customer runs at once; Take out for every customer… asks first (round 36). The customer reads the name of a
 * factory person only when the person is given to it; floor people are not here.
 */

export const NS = 'people-by-customer'

export const givenKey = (partyId: string, userId: string): string => `${partyId}:${userId}`

/** The ticks as a set (`<partyId>:<userId>`). */
export const givenSetOf = (given: readonly Given[]): ReadonlySet<string> => new Set(given.map((row) => givenKey(row.partyId, row.userId)))

/** How many customers a person works for. */
export const customersOf = (given: readonly Given[], userId: string): number => given.filter((row) => row.userId === userId).length

/**
 * A tick's answer put into the read: given — the pair's row as the answer names it (who gave it, since when); taken out — the pair's
 * row leaves the list (the server ended it: `endedAt`, never a delete). The intent decides, so an ended row the answer may still name
 * never shows as given.
 */
export function withTick(read: ByCustomer, partyId: string, userId: string, isGiven: boolean, answer: readonly Given[]): ByCustomer {
  const others = read.given.filter((row) => !(row.partyId === partyId && row.userId === userId))
  if (!isGiven) return { ...read, given: others }
  const row = answer.find((entry) => entry.partyId === partyId && entry.userId === userId)
  return { ...read, given: row ? [...others, row] : others }
}

/**
 * Give to / take out for every customer, put into the read: given — the person keeps the rows it had (every customer skips the ones
 * already given) and gains the answer's new ones; taken out — the person has none left.
 */
export function withEvery(read: ByCustomer, userId: string, isGiven: boolean, answer: readonly Given[]): ByCustomer {
  if (!isGiven) return { ...read, given: read.given.filter((row) => row.userId !== userId) }
  const known = givenSetOf(read.given)
  return { ...read, given: [...read.given, ...answer.filter((row) => row.userId === userId && !known.has(givenKey(row.partyId, row.userId)))] }
}

/** An extra right's answer put into the read. */
export function withExtra(read: ByCustomer, answer: PersonAnswer): ByCustomer {
  return { ...read, people: read.people.map((person) => (person.userId === answer.person.userId ? { ...person, extra: answer.person.extra } : person)) }
}

/** A tick's next value (what PUT sends): the opposite of now. */
export const nextGiven = (given: ReadonlySet<string>, partyId: string, userId: string): boolean => !given.has(givenKey(partyId, userId))

export const hasExtra = (person: { readonly extra: readonly ExtraRight[] }, right: ExtraRight): boolean => person.extra.includes(right)

/** The bulk acts: Give to every customer runs at once; Take out for every customer… asks first (it ends every given row of them). */
export type BulkStep = { readonly kind: 'run'; readonly given: boolean; readonly userIds: readonly string[] } | { readonly kind: 'ask'; readonly userIds: readonly string[]; readonly rows: number } | { readonly kind: 'none' }

export function bulkStepOf(act: 'give' | 'takeOut', userIds: readonly string[], given: readonly Given[], mayWrite: boolean): BulkStep {
  if (!mayWrite || userIds.length === 0) return { kind: 'none' }
  if (act === 'give') return { kind: 'run', given: true, userIds }
  return { kind: 'ask', userIds, rows: given.filter((row) => userIds.includes(row.userId)).length }
}

/** The customers a person works for, as chips on the phone's card (by the customers' order). */
export function customersOfPerson(read: Pick<ByCustomer, 'customers' | 'given'>, userId: string): ByCustomer['customers'] {
  const set = givenSetOf(read.given)
  return read.customers.filter((customer) => set.has(givenKey(customer.partyId, userId)))
}
