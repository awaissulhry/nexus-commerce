import type { ReleaseCheck } from '../../production/work-orders/release'
import { cellsOutsideScope, type ReleaseScope } from './scope'

/**
 * The work-order release reads what its revision is released for (B-W2b-231; PRD-191: "the others wait for a later release of
 * the same revision"): W1's CELLS check (at least one cell, every size in the range) also refuses a cell outside the released
 * scope, in words, each problem at `cells/<cellId>/scope`. Nothing changes for a revision released for every colourway and size.
 */

export interface WorkOrderScope {
  readonly revision: number
  readonly scope: ReleaseScope
  /** "BLK, RED in 50–54". */
  readonly words: string
}

export interface ScopedCell {
  readonly id: string
  /** "BLK 52". */
  readonly label: string
  readonly colourwayId: string
  readonly size: string
}

export function scopedCellsCheck(check: ReleaseCheck, released: WorkOrderScope | null, cells: readonly ScopedCell[]): ReleaseCheck {
  if (check.state !== 'OK' || released === null) return check
  const outside = cellsOutsideScope(released.scope, cells)
  if (outside.length === 0) return check
  const labels = outside.map((cell) => cell.label).join(', ')
  const one = outside.length === 1
  const message = `${labels} ${one ? 'is' : 'are'} not released yet: revision ${released.revision} is released for ${released.words} only. Release more of revision ${released.revision} first (Products › Styles › Release), or take ${one ? 'it' : 'them'} out of the work order.`
  return {
    code: check.code,
    state: 'BLOCKED',
    message,
    problems: outside.map((cell) => ({ path: `cells/${cell.id}/scope`, message: `${cell.label}: not released yet (revision ${released.revision} is released for ${released.words} only).` })),
  }
}
