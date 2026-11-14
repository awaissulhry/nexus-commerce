import { ACCOUNTING_CLOSE } from '@nexus/factory-domain/accounting/mapping/permissions'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * The hard lock: closing a month for good (B-W2b-408; FIN-155; design finance.accounting pop "Close August for good?":
 * "Nothing dated August can change; typed phrase 'close August 2026'"; lead decision 11-14: a step-up action). POST
 * /accounting/locks with level HARD (locks.ts) asks, in this order:
 *
 *   1. accounting.close over the company (finance by template; owner) — else 403 in words
 *   2. the typed phrase (`close August 2026` or `chiudi agosto 2026`) — else 400 body/phrase
 *   3. nothing the month still waits for (W2a: an invoice rejected by SDI, a stock move without its value, a year-end
 *      inventory open or missing) — else 409 problem/… in words
 *   4. a fresh code (requireStepUp, the route's check; 403 stepUp) — asked last, so a request refused anyway asks none
 * then the lock is written (one command, audited, period_lock.locked). The permission is on the `money.settings` line of
 * the step-up actions with accounting.unlock (lifting a hard lock): like the lift, the route's own permission is
 * accounting.lock, so the fresh code is asked whatever that line's switch says.
 */

/** Closing a month for good needs accounting.close (403 in words). */
export function assertMayClose(context: OfficeContext, companyId: string): void {
  if (!can(actorOf(context), ACCOUNTING_CLOSE, { companyId })) {
    throw new ForbiddenError('Closing a month for good needs accounting.close: nothing dated in it can change afterwards.')
  }
}
