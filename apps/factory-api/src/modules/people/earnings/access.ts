import { ConflictError, ForbiddenError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_EARNINGS_RECORDS } from '@nexus/factory-domain/people/earnings/permissions'
import type { EarningsRefusal } from '@nexus/factory-domain/people/earnings/rules'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { seesPay } from '../piecerates/access'

/**
 * Who reaches earnings (B-W2b-43). Sign-in, the office check, the pay grain and the database guard's own words are piece
 * rates' (B-W2b-34, `../piecerates/access`): one page, one set of rules. "The right" to one person's figures is
 * people.earnings.records over the record's company and site AND the pay grain: everyone else reads states and counts, and
 * figures per line where the group is large enough.
 */
export { floorOf, officeOf, payGuarded, refuseProblems, seesPay } from '../piecerates/access'

/** A step refused by its rule (factory-domain people/earnings/rules): a 409 with `refusal/<CODE>` and the words. */
export class EarningsRefusedError extends ConflictError {
  override name = 'EarningsRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: EarningsRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuseEarnings = (refusal: EarningsRefusal | null): void => {
  if (refusal) throw new EarningsRefusedError(refusal)
}

/** The tenant a command runs for (office, floor or system: never the platform). */
export function tenantOf(context: RequestContext): string {
  if (!('tenantId' in context)) throw new ForbiddenError()
  return context.tenantId
}

/** The caller holds the right over this place. */
export const hasRight = (context: OfficeContext, place: { readonly companyId: string; readonly siteId?: string | null }): boolean =>
  seesPay(context) && can(actorOf(context), PEOPLE_EARNINGS_RECORDS, place.siteId ? { companyId: place.companyId, siteId: place.siteId } : { companyId: place.companyId })

export function requireRight(context: OfficeContext, place: { readonly companyId: string; readonly siteId?: string | null }): void {
  if (!hasRight(context, place)) throw new ForbiddenError("One person's pay opens only with people.earnings.records and the pay grain, over the person's company and site.")
}
