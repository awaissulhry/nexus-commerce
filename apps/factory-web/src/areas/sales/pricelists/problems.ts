import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Phrase } from './model'

/**
 * The price lists screens' problems in their own words (apps/factory-web CLAUDE.md: never the API's message): a message
 * key of the `pricelists` catalogue per error kind and, for a write, what the screen does next (a 409 that names the
 * version: someone else moved the record; it is read again, never overwritten — COL-078). A refusal the screen can see
 * coming is held before the click (model.ts); these are what is left.
 */

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  switch (error.kind) {
    case 'signed_out':
    case 'forbidden':
    case 'not_found':
    case 'unavailable':
    case 'rate_limited':
    case 'contract':
      return `problem.read.${error.kind}`
    default:
      return 'problem.read.internal'
  }
}

export interface WriteProblem {
  words: Phrase
  /** Read the record again (it changed meanwhile, or its state no longer allows the change). */
  reload: boolean
}

const movedVersion = (error: { code: string; issues: readonly { path?: unknown }[] }) => error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue as never).split(/[./]/).includes('version'))

/** A write's refusal: `refusedKey` names what the screen says for a 409 / 400 of this kind of write. */
export function writeProblem(error: unknown, refusedKey = 'problem.write.refused'): WriteProblem {
  if (!isApiError(error)) return { words: { key: 'problem.write.internal' }, reload: false }
  if (error.kind === 'conflict') return movedVersion(error) ? { words: { key: 'problem.write.moved' }, reload: true } : { words: { key: refusedKey }, reload: true }
  if (error.kind === 'invalid') return { words: { key: refusedKey }, reload: false }
  if (['signed_out', 'forbidden', 'not_found', 'step_up', 'rate_limited', 'unavailable'].includes(error.kind)) return { words: { key: `problem.write.${error.kind}` }, reload: error.kind === 'not_found' }
  return { words: { key: 'problem.write.internal' }, reload: false }
}

/** New price list: a 409 is a code in use (or, for a base list, a base list this company already has in that currency). */
export function createProblem(error: unknown, kind?: string): Phrase {
  if (isApiError(error) && error.kind === 'conflict') return { key: kind === 'BASE' ? 'new.refused.codeOrBase' : 'new.refused.codeTaken' }
  if (isApiError(error) && error.kind === 'invalid') {
    const paths = error.issues.map((issue) => issuePath(issue))
    if (paths.some((path) => path.includes('baseListId'))) return { key: 'new.refused.base' }
    if (paths.some((path) => path.includes('companyId'))) return { key: 'new.refused.company' }
    return { key: 'new.refused.fields' }
  }
  return writeProblem(error).words
}

/**
 * B-W2b-16: a refused change of customers: a second change of a customer's list on one day (409 at body/validFrom: its
 * history keeps one list per day), else the customers' own checks (another company, archived, currency, the role).
 */
export function customersProblem(error: unknown): WriteProblem {
  if (isApiError(error) && error.kind === 'conflict' && error.issues.some((issue) => issuePath(issue).includes('validFrom'))) return { words: { key: 'customers.refusedDay' }, reload: true }
  return writeProblem(error, 'customers.refused')
}
