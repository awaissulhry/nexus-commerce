/**
 * The database's own refusals of the cost rates' tables (factory-db …_cost_sheets_w2b_guards, B-W2b-378: "costing: overhead
 * rule …" and "costing: cost-per-minute calculation …", check_violation), read back in words, pure. The commands of
 * B-W2b-419 check these rules first in words; a write that still reaches one (a race) answers 409 with the code here, never
 * a 500.
 */

const UUID = / [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const COST_RATES = /^costing: (overhead rule|cost-per-minute calculation) /
const OVERLAPS = /^costing: overhead rule \S+ overlaps another active rule/
const APPLIED = /^costing: cost-per-minute calculation \S+ was applied as a labour rate/

/** The refusal code (OVERLAPS, APPLIED or DATABASE) and words of a cost rates guard's message; null for another message. */
export function databaseCostRateRefusal(message: string): { readonly code: 'OVERLAPS' | 'APPLIED' | 'DATABASE'; readonly message: string } | null {
  if (!COST_RATES.test(message)) return null
  const words = message.slice('costing: '.length).replace(UUID, '')
  const sentence = `${words.charAt(0).toUpperCase()}${words.slice(1)}${words.endsWith('.') ? '' : '.'}`
  if (OVERLAPS.test(message)) return { code: 'OVERLAPS', message: sentence }
  if (APPLIED.test(message)) return { code: 'APPLIED', message: sentence }
  return { code: 'DATABASE', message: sentence }
}
