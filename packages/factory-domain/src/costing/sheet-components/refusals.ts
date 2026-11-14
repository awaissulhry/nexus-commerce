/**
 * The database's own refusals of the cost sheet components' tables (factory-db …_cost_sheets_w2b_guards, B-W2b-378: "costing:
 * cost sheet …", "costing: cost sheet line …", "costing: labour line …", "costing: leather cost basis …", "costing: the grade
 * mix of leather cost basis …", "costing: cost uplift …", "costing: piece-rate labour …", check_violation), read back in
 * words, pure. The commands of B-W2b-418 check these rules first in words; a write that still reaches one (a race, a grade
 * archived meanwhile) answers 409 with the code here, never a 500.
 */

const UUID = / ?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const COMPONENTS = /^costing: (cost sheet |labour line |leather cost basis |the grade mix of leather cost basis |cost uplift |piece-rate labour |the lines of cost sheet |the company, material, style and first day of leather cost basis |the company, target and first day of cost uplift )/
const NOT_DRAFT = /^costing: (the lines of cost sheet \S+ are (written|removed) only while it is a DRAFT|cost sheet \S+ is approved and locked|cost sheet \S+ is frozen)/
const PIECE_PAY_OFF = /^costing: piece-rate labour is switched on only for a company with piece pay ON/

/** The refusal code (NOT_DRAFT, PIECE_PAY_OFF or DATABASE) and words of a components guard's message; null for another message. */
export function databaseComponentRefusal(message: string): { readonly code: 'NOT_DRAFT' | 'PIECE_PAY_OFF' | 'DATABASE'; readonly message: string } | null {
  if (!COMPONENTS.test(message)) return null
  const words = message.slice('costing: '.length).replace(UUID, '').replace(/ {2,}/g, ' ')
  const sentence = `${words.charAt(0).toUpperCase()}${words.slice(1)}${words.endsWith('.') ? '' : '.'}`
  if (NOT_DRAFT.test(message)) return { code: 'NOT_DRAFT', message: sentence }
  if (PIECE_PAY_OFF.test(message)) return { code: 'PIECE_PAY_OFF', message: sentence }
  return { code: 'DATABASE', message: sentence }
}
