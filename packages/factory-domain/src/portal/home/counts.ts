import type { PartnerKind } from '../../auth/partners/kinds'
import type { PortalArea, Words } from '../tasks/kinds'

/**
 * The counts of a partner's Home (B-W2b-167; design portal.customer.home and portal.supplier.home "At a glance", the rail's
 * badges): each count is a number that is also a link to the same filtered list. A count is declared by a SOURCE file in the
 * API's platform/portal/home/sources (one per step that adds counts, as the task sources: no clash), with:
 *
 *   key      `<area>.<count>`, unique (`tasks.open`, later `orders.open`, `deliveries.in_transit`)
 *   area     the rail area it links to
 *   kinds    the partner kinds whose Home shows it (a supplier never sees a customer's count)
 *   words    the tile's label, Italian and English
 *
 * A count that cannot be read answers null ("A badge that cannot be counted shows nothing, never 0"). Never money: an
 * amount is not a count (the design's "Invoices due: count + amount" waits for its own step with the price grain).
 */

export interface HomeCountDefinition {
  readonly key: string
  readonly area: PortalArea
  readonly kinds: readonly PartnerKind[]
  readonly words: Words
}

const KEY = /^[a-z][a-z_]*\.[a-z][a-z_]*$/

/** What is wrong with the declared counts (the API's source registry runs it at load). */
export function homeCountProblems(definitions: readonly HomeCountDefinition[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (!KEY.test(definition.key)) problems.push(`${definition.key}: a home count key is <area>.<count> in lower case`)
    if (seen.has(definition.key)) problems.push(`${definition.key}: declared twice`)
    seen.add(definition.key)
    if (definition.kinds.length === 0) problems.push(`${definition.key}: names the partner kinds whose Home shows it`)
    if (!definition.words.it.trim() || !definition.words.en.trim()) problems.push(`${definition.key}: has its words in Italian and English`)
  }
  return problems
}
