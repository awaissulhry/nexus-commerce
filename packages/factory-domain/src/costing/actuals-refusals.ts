/**
 * The actual-cost rules the database holds since W2b-6 schema wave 54/57 (factory-db …_cost_actuals_w2b_guards, B-W2b-376;
 * FIN-034, MES-013) that existing routes can reach, read back from the database's own words, pure: a CLOSED work order, or one
 * whose close is settled (its closing entry posted), takes no cost entry but a reversal; and a close's variance or closing
 * entry is reversed only by undoing the close. B-W2b-411's close and B-W2b-407's postings check these first in words; when a
 * write of an existing route (the cost ledger's catch-up and reversal routes, the standard's freeze) reaches the rule without
 * that check, the API answers 409 in these words instead of a 500 (apps/factory-api core/errors).
 */

/** The issue paths of the refusals. */
export const ACTUAL_COST_REFUSAL_ISSUES = Object.freeze({
  closed: 'costing/WORK_ORDER_CLOSED',
  closeStands: 'costing/CLOSE_STANDS',
} as const)

const CLOSED = /^cost: work order \S+ is CLOSED; it takes no cost entry but a reversal/
const SETTLED = /^cost: the close of work order \S+ is settled \(its closing entry is posted\); it takes no cost entry but a reversal/
const STANDS = /^cost: (CLOSE|VARIANCE) entry \S+ belongs to close \S+, which stands; it is reversed only once the close is undone/

/** The words and issue path of a refusal of the database's actual-cost rules, or null when the message is another one. */
export function databaseActualCostRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (CLOSED.test(message)) {
    return { path: ACTUAL_COST_REFUSAL_ISSUES.closed, message: 'This work order is closed: it takes no cost entry but a reversal. Reopen it first.' }
  }
  if (SETTLED.test(message)) {
    return { path: ACTUAL_COST_REFUSAL_ISSUES.closed, message: "This work order's close is settled: it takes no cost entry but a reversal. Undo the close first." }
  }
  if (STANDS.test(message)) {
    return { path: ACTUAL_COST_REFUSAL_ISSUES.closeStands, message: "This entry is part of a work order's close that stands: undo the close, which reverses it." }
  }
  return null
}
