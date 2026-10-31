import { ConflictError, ForbiddenError, type Issue } from '@nexus/factory-domain/core/errors'
import type { OffStandardRefusal } from '@nexus/factory-domain/production/offstandard/rules'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'

/**
 * Who reaches off-standard time (B-W2b-29), and the refusal every route answers with: the office within its grants (can()
 * on the code's company, or the block's company and site), a floor device only at its own site.
 */

/** A block or code refused by its rule (factory-domain production/offstandard/rules): a 409 with `refusal/<CODE>` and the fix. */
export class OffStandardRefusedError extends ConflictError {
  override name = 'OffStandardRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: OffStandardRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: OffStandardRefusal): never => {
  throw new OffStandardRefusedError(refusal)
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}
