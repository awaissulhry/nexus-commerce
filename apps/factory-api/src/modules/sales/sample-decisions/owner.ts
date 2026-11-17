import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../../core/command'

/**
 * B-PR-38 (production plan §3 "No silent decisions: the office can no longer record a brand's PP or sample decision by itself;
 * it must use 'Decide for the brand'"; review fix R-06; 07-control §6.1 "'Brand-owned' = a round, swatch … of a brand whose
 * portal is on"): whose a round or a swatch is. A round or swatch of a customer whose portal is on is the customer's to decide —
 * its people answer it in the portal (or by link), or the office decides it FOR the customer (B-PR-30a: a reason they read, a
 * second person when its switch is on). The plain office decision (decidedVia OFFICE) and the hand pass of a gate that waits for
 * such a round are refused in words (factory-domain sample-decisions/rules customerDecidesRefusal, planning/milestones/rules
 * handPassRefusal). An internal round (no customer) and a customer without a portal stay the office's to record.
 *
 * Read in the caller's office scope (PortalSettings is office-only; the row's id is the party's), always by the record's own
 * customer: nothing here reads or names another customer.
 */

type Client = FactoryClient | CommandTx

/** The customers among these whose portal is on (their rounds and swatches are theirs to decide). */
export async function portalOnParties(client: Client, partyIds: Iterable<string | null>): Promise<Set<string>> {
  const ids = [...new Set([...partyIds].filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Set()
  const rows = await client.portalSettings.findMany({ where: { id: { in: ids }, portalOn: true }, select: { id: true, partyId: true } })
  return new Set(rows.filter((row) => row.id === row.partyId).map((row) => row.partyId))
}

/** The record's customer decides it (a customer with its portal on); false for an internal record. */
export async function customerDecides(client: Client, partyId: string | null): Promise<boolean> {
  return partyId !== null && (await portalOnParties(client, [partyId])).has(partyId)
}
