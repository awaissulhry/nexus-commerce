'use client'

import { CellSaveMark } from '@nexus/ui/grid'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { useT } from '../../../../lib/i18n/provider'
import type { Mark } from '../w2b-model'

/**
 * A grid cell's save mark (design "autosave per cell"): the DS CellSaveMark while saving or when the answer is not known,
 * nothing once saved (the green fade is the DS's), and a refused cell's "!" with the reason as its name and tooltip.
 */
export function SaveMark({ mark }: { mark: Mark | undefined }) {
  const t = useT('floor-rules')
  const ds = useDsLabels()
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const words = t(mark.problem ?? 'fr.problem.write')
    return (
      <span className="fw-fr-refused" role="img" aria-label={words} title={words}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} labels={ds.cellSaveMark} />
}

/** A key the cell takes for itself (Enter on a switch); printable keys never start an edit (they are the list's keys). */
export const cellKeys = (onEnter?: () => void) => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Enter' && onEnter) {
    if (event.type === 'keydown') onEnter()
    return true
  }
  return event.key.length === 1 && event.key !== ' '
}

/** A language's name in the page's language (ro → "Romanian"). */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
