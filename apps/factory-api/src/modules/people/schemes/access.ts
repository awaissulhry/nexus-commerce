import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import type { SchemeRefusal } from '@nexus/factory-domain/people/schemes/rules'

/**
 * The refusals of incentive schemes (B-W2b-38). Sign-in, the office check, the pay grain and the database guard's own
 * words are piece rates' (B-W2b-34, `../piecerates/access`): one page, one set of rules.
 */
export { officeOf, payGuarded, refuseProblems, seesPay } from '../piecerates/access'

/** A scheme refused by its rule (factory-domain people/schemes/rules): a 409 with `refusal/<CODE>` and the words. */
export class SchemeRefusedError extends ConflictError {
  override name = 'SchemeRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: SchemeRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuseScheme = (refusal: SchemeRefusal | null): void => {
  if (refusal) throw new SchemeRefusedError(refusal)
}
