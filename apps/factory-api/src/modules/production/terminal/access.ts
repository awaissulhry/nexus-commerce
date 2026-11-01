import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import type { TimingRefusal } from '@nexus/factory-domain/production/terminal/rules'

/**
 * A timing action refused by its rule (factory-domain production/terminal/rules): a 409 whose issues are
 * `refusal/<CODE>` with its words and `fix` with the one fix, as the scans' refusals; in the offline queue the module
 * refusal (code, words, fix, final) through platform/floor-sync/kinds.ts refusalOfError. A scans rule's refusal (the
 * operation a START means, "already reported", a voided bundle …) keeps the scans' code and words.
 */
export class TimingRefusedError extends ConflictError {
  override name = 'TimingRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: { readonly code: string; readonly message: string; readonly fix: string; readonly final: boolean }) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuseTiming = (refusal: TimingRefusal | { readonly code: string; readonly message: string; readonly fix: string; readonly final: boolean }): never => {
  throw new TimingRefusedError(refusal)
}
