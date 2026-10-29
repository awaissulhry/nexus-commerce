import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * The quotes screens' problems in their own words (apps/factory-web CLAUDE.md: never the API's message): a message key
 * of the `sales` catalogue per error kind, and whether the screen reads the record again (a 409: someone else moved it,
 * or its state no longer allows the change — COL-078: never overwritten).
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
  key: string
  /** Read the record again (it changed meanwhile). */
  reload: boolean
}

export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  if (error.kind === 'conflict') {
    const moved = error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version'))
    return { key: moved ? 'problem.write.moved' : 'problem.write.state', reload: true }
  }
  if (error.kind === 'step_up') return { key: 'problem.write.stepUp', reload: false }
  if (['signed_out', 'forbidden', 'not_found', 'invalid', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}
