/**
 * GDS — the `shape: 'list'` cell editor (AM.1 §A.3 row 3): AG's popup, the DS `OptionList` inside it
 * when the column has options (the SAME list the grid's set filter and `MultiSelect` render — D18,
 * one control), the DS `TagInput` for a free-text list.
 *
 * The value is reported with `onValueChange` on every change (AG36 React: a ref `getValue` is never
 * read — `reference_ag36_react_editor_onvaluechange`). Enter/Tab/Esc are AG's (popup editors own
 * them); Enter commits the last reported array, Esc discards it. An array is ALWAYS reported — never a
 * joined string — because the route refuses one value into a list (`coerceForShape`).
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { OptionList, type OptionListItem } from '../../components'
import { TagInput } from '../../primitives'
import { asList } from '../renderers/shapeFormat'
import { editorBox, roomToRightOf } from './editorBox'

export interface ListPanelEditorParams {
  /** Closed list → `OptionList`; absent/empty → free-text chips. */
  options?: OptionListItem[]
  /** `cardinality.max`; `null` = unbounded. */
  maxItems?: number | null
  label?: string
  value?: unknown
  column: { getActualWidth(): number }
  stopEditing: (cancel?: boolean) => void
  onValueChange?: (value: unknown) => void
  eGridCell?: HTMLElement
}

export const ListPanelEditor = forwardRef<unknown, ListPanelEditorParams>(function ListPanelEditor(props, _ref) {
  const { options, maxItems, label, value, column, onValueChange } = props
  const [items, setItems] = useState<string[]>(() => asList(value))
  /* 🔴 The free-text DRAFT is part of the value. AG's popup owns Enter and its native listener fires
     before React's, so on Enter AG commits whatever was last reported and the `TagInput`'s own Enter
     handler (which would have turned the draft into a chip) runs too late or not at all — the last
     typed value vanished (measured on the design, 2026-09-05). The draft is mirrored from the input
     and reported as the final item, de-duplicated against the chips, so Enter means "add and save". */
  const [draft, setDraft] = useState('')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('input')?.focus()
  }, [])
  const reported = (list: string[], pending: string) => {
    const p = pending.trim()
    return p && !list.includes(p) ? [...list, p] : [...list]
  }
  const change = useCallback(
    (next: string[]) => {
      setItems(next)
      onValueChange?.(reported(next, draft))
    },
    [onValueChange, draft],
  )
  const onDraft = useCallback(
    (text: string) => {
      setDraft(text)
      onValueChange?.(reported(items, text))
    },
    [onValueChange, items],
  )
  const cellRect = props.eGridCell?.getBoundingClientRect()
  const box = editorBox({
    cellWidth: cellRect?.width ?? column.getActualWidth(),
    cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, window.innerWidth) : window.innerWidth,
    kind: 'list',
  })
  const closed = !!options && options.length > 0
  return (
    <div ref={root} className="nds-list-editor" style={{ width: box.width, maxHeight: box.height }} role="group" aria-label={label ? `${label} — values` : 'Values'}>
      {closed ? (
        <OptionList options={options!} value={items} onChange={change} searchable selectAll={false} listClassName="nds-list-editor-list" />
      ) : (
        <div onInput={(e) => onDraft((e.target as HTMLInputElement).value ?? '')}>
          <TagInput value={items} onChange={change} maxTags={maxItems ?? undefined} placeholder="Add a value… (, adds · Enter saves)" aria-label={label ?? 'Values'} />
        </div>
      )}
      <span className="nds-list-editor-count" aria-live="polite">
        {reported(items, draft).length} {closed ? 'selected' : reported(items, draft).length === 1 ? 'value' : 'values'} · Enter saves · Esc cancels
      </span>
    </div>
  )
})
