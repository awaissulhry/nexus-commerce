'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListKey } from '../../../list-frame/model'
import { ListKeysHelp } from '../shared/view/parts'
import { onScreen } from './bulk-model'
import './list.css'

/**
 * What the B-W0-28 lists add around the shared list frame (`src/list-frame/`, Owner rule 2026-10-29): the selection
 * (the page's, or the design gallery's own so ticking works there too), the `?` dialog with every key of the list, the
 * reach of a bulk action in a confirm. The frame's states (FrameState), the bulk button (BulkButton) and the keys dialog
 * (ListKeysHelp) are part 1's, in shared/view/parts.tsx: every Admin list draws them the same.
 */

/**
 * The selected ids, kept to the rows on screen. With `onSelect` the page owns them; without it (a design case) the view
 * keeps them, starting from the model's.
 */
export function useSelection(given: readonly string[] | undefined, onSelect: ((ids: string[]) => void) | undefined, rowIds: readonly string[]) {
  const [local, setLocal] = useState<readonly string[]>(given ?? [])
  useEffect(() => setLocal(given ?? []), [given])
  const raw = onSelect ? given : local
  const shownKey = rowIds.join('|')
  // The rows on screen change by content, not by identity: their ids joined are the dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selected = useMemo(() => onScreen(raw, rowIds), [raw, shownKey])
  const onChange = useCallback((ids: string[]) => (onSelect ? onSelect(ids) : setLocal(ids)), [onSelect])
  return { selected, onChange }
}

/**
 * The latest value, read when a cell's button is pressed: a page's callbacks are new on each render, and a column
 * definition that held them would rebuild the grid's columns every time.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** `?` on a list (and the footer icon's "All shortcuts"): every key of the list, in a dialog. */
export function useKeysHelp(own: readonly ListKey[], withSelection: boolean) {
  const [open, setOpen] = useState(false)
  const onHelp = useCallback(() => setOpen(true), [])
  // The same dialog as every Admin list (part 1's ListKeysHelp).
  const help = <ListKeysHelp open={open} onClose={() => setOpen(false)} keys={own} selection={withSelection} />
  return { onHelp, help }
}



/** In a bulk confirm: what the action applies to (by name), and each reason some selected rows are left out. */
export function BulkReach({ names, left, label }: { names: readonly string[]; left: ReadonlyArray<{ why: string; count: number; words: string }>; label: string }) {
  return (
    <div className="fw-adm-bulk-reach">
      <ul className="fw-adm-bulk-names" aria-label={label}>
        {names.map((name, index) => (
          <li key={`${name}-${index}`}>{name}</li>
        ))}
      </ul>
      {left.map((entry) => (
        <p key={entry.why} className="fw-adm-hint">
          {entry.words}
        </p>
      ))}
    </div>
  )
}
