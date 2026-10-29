import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * The Styles screens' problems in their own words (apps/factory-web CLAUDE.md: never the API's message): a message key
 * of the `products` catalogue per error kind, and whether the screen reads the record again (a 409: someone else moved
 * it, or its state no longer allows the change — COL-078: never overwritten).
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
  /** The refused fields' paths (`code`, `sizes/2`), for a form to point at. */
  paths: string[]
}

export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false, paths: [] }
  const paths = error.issues.map((issue) => issuePath(issue)).filter((path) => path !== '')
  if (error.kind === 'conflict') {
    const moved = error.code === 'version_conflict' || paths.some((path) => path.split(/[./]/).includes('version'))
    if (moved) return { key: 'problem.write.moved', reload: true, paths }
    // A release refused with its blockers: the check on the page says which.
    if (paths.some((path) => /^(lines|routing|bom|sizes|colourways)\b/.test(path))) return { key: 'problem.write.blocked', reload: true, paths }
    if (/taken/i.test(error.message) || paths.includes('code')) return { key: 'problem.write.codeTaken', reload: false, paths }
    return { key: 'problem.write.state', reload: true, paths }
  }
  if (error.kind === 'step_up') return { key: 'problem.write.stepUp', reload: false, paths }
  if (error.kind === 'invalid') return { key: 'problem.write.invalid', reload: false, paths }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found', paths }
  return { key: 'problem.write.internal', reload: false, paths }
}
