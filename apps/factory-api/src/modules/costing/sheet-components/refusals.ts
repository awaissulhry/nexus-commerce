import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { databaseComponentRefusal } from '@nexus/factory-domain/costing/sheet-components/refusals'

/**
 * The components' refusals as 409 answers (B-W2b-418): `refusal/<CODE>` with the words first, so a screen says why from the
 * code (more issues may follow: the missing inputs of an INCOMPLETE write). `componentRefusalOf` turns the database's own
 * refusal of the cost sheet tables (a race past the command's check) into one; any other error passes as it is.
 */

export const refused = (code: string, message: string, more: readonly Issue[] = []): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }, ...more])

/** A check_violation of the cost sheet components' tables in words, as a 409; else the error itself. */
export function componentRefusalOf(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string') return error
  const words = databaseComponentRefusal(cause.originalMessage)
  return words ? refused(words.code, words.message) : error
}
