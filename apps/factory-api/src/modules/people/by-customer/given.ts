import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'

/**
 * owb-of2 step 3 (order workflow, plan.md § 5f "People by customer"; settle 10, S1's portal reads it): the names of the office people
 * given to a customer — the open rows of its pool (PartyOfficePerson), oldest first — the ONLY factory names its people may read
 * (S1 po4 imports this; names only: no id, no role, never who gave them).
 *
 * Read with the caller's client: S1 calls it in the office or system scope AFTER its own check that the party is the reader's own; under
 * the partner role the database itself keeps a session to its own party's rows (another customer's pool never comes back).
 */
export async function factoryPeopleGivenTo(tx: FactoryClient | CommandTx, partyId: string): Promise<string[]> {
  const rows = await tx.partyOfficePerson.findMany({ where: { partyId, endedAt: null }, select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (rows.length === 0) return []
  const people = await tx.user.findMany({ where: { id: { in: rows.map((row) => row.userId) }, status: 'ACTIVE' }, select: { id: true, displayName: true } })
  const nameOf = new Map(people.map((person) => [person.id, person.displayName]))
  return rows.flatMap((row) => (nameOf.has(row.userId) ? [nameOf.get(row.userId)!] : []))
}
