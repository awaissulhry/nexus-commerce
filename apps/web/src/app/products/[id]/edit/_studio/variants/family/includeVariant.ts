/**
 * One inclusion tick from the family page (master scope), IN LINE (2.4).
 *
 * The family page holds no projection version of its own: each tick reads the coordinate's version and then writes.
 * Two quick ticks used to do that side by side — both read the same version, the first write moved it, and the second
 * answered 409 and was lost. In the page's one write queue, a tick reads only once the tick before it has settled, so
 * it is sent at the version that tick left.
 */
import type { ProjectionSaveResult, ProjectionSource } from '../channel/types'
import type { WriteQueue } from '../writeQueue'

export function includeVariant(
  inLine: WriteQueue,
  source: Pick<ProjectionSource, 'read' | 'setIncluded'>,
  id: string,
  included: boolean,
): Promise<ProjectionSaveResult> {
  return inLine(async () => {
    const current = await source.read(new AbortController().signal)
    return source.setIncluded(current.version, [{ id, included }])
  })
}
