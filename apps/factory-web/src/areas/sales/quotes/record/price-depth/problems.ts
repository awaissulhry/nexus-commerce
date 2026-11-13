import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { writeProblem } from '../../problems'
import type { Words } from './model'

/**
 * A refused price write (PUT …/lines/:lineId/price) in this screen's words, never the API's: a reason the list no longer
 * holds or a reason that asks a note (400 at net/reasonCode, net/note), a start that cannot be made (no list, no cost),
 * a quote someone else moved (409 version: read again), a line that is no longer a draft's goods line (409).
 */
export function priceProblem(error: unknown): { words: Words; reload: boolean } {
  if (isApiError(error) && error.kind === 'invalid') {
    const paths = error.issues.map((issue) => issuePath(issue))
    if (paths.some((path) => /reasonCode/i.test(path))) return { words: { key: 'problem.reason' }, reload: false }
    if (paths.some((path) => /note/i.test(path))) return { words: { key: 'problem.note' }, reload: false }
    if (paths.some((path) => /start|marginPct/i.test(path))) return { words: { key: 'problem.start' }, reload: false }
    return { words: { key: 'problem.price' }, reload: false }
  }
  const problem = writeProblem(error)
  if (isApiError(error) && error.kind === 'conflict' && problem.key === 'problem.write.state') return { words: { key: 'problem.state' }, reload: true }
  return { words: { ns: 'sales', key: problem.key }, reload: problem.reload }
}
