import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ConflictError, ForbiddenError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { VersionRefusal } from '@nexus/factory-domain/people/piecerates/rates'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'

/**
 * Who reaches piece rates (B-W2b-34), and the refusals every route answers with. The office within its grants (can() on
 * the table's or the site's company and site; lists with scopeWhere()); a floor device only at its own site, for the
 * signed-in worker's own publications. A pay figure is shown only with the pay grain (`money.pay`; the API's grain
 * filter drops the marked fields for everyone else and refuses a body that sends one).
 */

/** A version refused by its rule (factory-domain people/piecerates/rates): a 409 with `refusal/<CODE>` and the words. */
export class PieceRateRefusedError extends ConflictError {
  override name = 'PieceRateRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: VersionRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuseVersion = (refusal: VersionRefusal | null): void => {
  if (refusal) throw new PieceRateRefusedError(refusal)
}

/** A body that breaks a rule: 400 with every problem at its field. */
export function refuseProblems(problems: readonly Issue[], message: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems)
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** The caller sees pay figures (the design's noPermission state otherwise: "operations and SMVs only"). */
export const seesPay = (context: OfficeContext | FloorContext): boolean => heldGrains(actorOf(context)).has('pay')

/**
 * The database's own refusal of a pay write (…_pay_w2b_guards: check_violation 'pay: …'), when a race slipped past the
 * command's check (another version put in force, a publication withdrawn): a 409 in the guard's words, never a 500.
 */
export async function payGuarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
    if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('pay: ')) {
      const words = cause.originalMessage.slice(5)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Reload and try again.`)
    }
    throw error
  }
}
