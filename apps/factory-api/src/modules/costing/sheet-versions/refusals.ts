import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { databaseVersionRefusal, VERSION_REFUSAL_WORDS, type VersionRefusal } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { componentRefusalOf } from '../sheet-components/refusals'

/**
 * The versions' refusals as 409 answers (B-W2b-420): `refusal/<CODE>` with the words first, so a screen says why from the
 * code. `versionRefusalOf` turns the database's own refusals of a cost sheet (a race past the command's checks) into one: a
 * cost sheet guard's check_violation, a draft another version was copied from (the foreign key), a version number or a
 * second approved version of a series taken meanwhile (the unique indexes); a line's refusal is B-W2b-418's mapping.
 */

export const refused = (code: VersionRefusal, message: string = VERSION_REFUSAL_WORDS[code], more: readonly Issue[] = []): DomainError =>
  new DomainError('conflict', message, [{ path: `refusal/${code}`, message }, ...more])

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }

export function versionRefusalOf(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
  const code = cause?.originalCode
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  if (code === '23514') {
    const words = databaseVersionRefusal(message)
    if (words) return refused(words.code, words.message)
    return componentRefusalOf(error)
  }
  if (code === '23503' && message.includes('CostSheet')) return refused('COPIED_FROM')
  if (code === '23505' && message.includes('CostSheet')) return new DomainError('conflict', 'Another version of this series was made or approved at the same time: look again.', [{ path: 'refusal/DATABASE', message: 'Another version of this series was made or approved at the same time: look again.' }])
  return error
}
