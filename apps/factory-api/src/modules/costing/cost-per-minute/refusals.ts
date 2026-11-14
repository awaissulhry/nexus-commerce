import { DomainError } from '@nexus/factory-domain/core/errors'
import { databaseCostRateRefusal } from '@nexus/factory-domain/costing/cost-per-minute/refusals'

/**
 * The cost rates' refusals as 409 answers (B-W2b-419): `refusal/<CODE>` with the words, so a screen says why from the code.
 * `costRateRefusalOf` turns the database's own refusal of the cost rates' tables (a race past the command's check) into one;
 * any other error passes as it is.
 */

export const refused = (code: string, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

/** A check_violation of OverheadRule or CostPerMinuteCalc in words, as a 409; else the error itself. */
export function costRateRefusalOf(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string') return error
  const words = databaseCostRateRefusal(cause.originalMessage)
  return words ? refused(words.code, words.message) : error
}
