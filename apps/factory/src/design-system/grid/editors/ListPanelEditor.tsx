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
import { splitListText } from './shapeValue'
import { keepGridOffEnter, typedStart, type EditorStop } from './selectPanelModel'

export interface ListPanelEditorParams {
  /** Closed list → `OptionList`; absent/empty → free-text chips. */
  options?: OptionListItem[]
  /** The channel leaves this list open (`mode: 'open'`): a typed value is offered as `Add "…"`. */
  allowCustom?: boolean
  /** `cardinality.max`; `null` = unbounded. */
  maxItems?: number | null
  label?: string
  value?: unknown
  column: { getActualWidth(): number }
  stopEditing: EditorStop
  onValueChange?: (value: unknown) => void
  eGridCell?: HTMLElement
  eventKey?: string | null
}

export const ListPanelEditor = forwardRef<unknown, ListPanelEditorParams>(function ListPanelEditor(props, _ref) {
  const { options, allowCustom, maxItems, label, value, column, onValueChange } = props
  const [items, setItems] = useState<string[]>(() => asList(value))
  /* 🔴 The free-text DRAFT is part of the value. AG's popup owns Enter and its native listener fires
     before React's, so on Enter AG commits whatever was last reported and the `TagInput`'s own Enter
     handler (which would have turned the draft into a chip) runs too late or not at all — the last
     typed value vanished (measured on the design, 2026-09-05). The draft is mirrored from the input
     and reported as the final item, de-duplicated against the chips, so Enter means "add and save".
     The key that opened a free-text list by typing starts the draft (the grid consumed it: "Rosso" saved "osso", audit
     B11); a list with options searches with it instead. A draft or chip holding "a | b" is two values, as a paste is. */
  const closed = !!options && options.length > 0
  const typed = closed ? '' : typedStart(props.eventKey)
  const [draft, setDraft] = useState(typed)
  const root = useRef<HTMLDivElement>(null)
  const reported = (list: string[], pending: string) => {
    const out = [...list]
    for (const v of splitListText(pending)) if (!out.includes(v)) out.push(v)
    return out
  }
  useEffect(() => {
    const input = root.current?.querySelector<HTMLInputElement>('input')
    input?.focus()
    if (typed) { input?.setSelectionRange(typed.length, typed.length); onValueChange?.(reported(items, typed)) }
    // mount only: the typed key is taken once, as if typed into the field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const change = useCallback(
    (next: string[]) => {
      const split = reported([], next.join('\n'))
      setItems(split)
      onValueChange?.(reported(split, draft))
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
  /* A stored value the list does not hold stays visible, so it can be seen and unticked (P0, 2026-09-30) — FIRST, and
     named "current" as `SelectPanelEditor` names it; a closed list adds that it is not in the list (audit B12). */
  const stored = asList(value)
  const note = (v: string) => stored.includes(v) ? allowCustom ? 'current' : 'current · not in the list' : 'added'
  const shown = closed ? [...items.filter((v) => !options!.some((o) => o.value === v)).map((v) => ({ value: v, label: `${v} (${note(v)})` })), ...options!] : []
  /* ↑/↓ walk the search field and the boxes; Space ticks. Inside AG's popup nothing else reaches the boxes: Tab is AG's
     (it saves and moves), so the list had no keyboard path at all (P0, 2026-09-30). */
  const walk = (e: React.KeyboardEvent) => {
    if (keepGridOffEnter(e, props.stopEditing)) return
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !closed) return
    const stops = [...(root.current?.querySelectorAll<HTMLElement>('.nds-combo-search input, input[type="checkbox"]') ?? [])]
    const at = stops.indexOf(document.activeElement as HTMLElement)
    const next = stops[Math.min(stops.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    e.preventDefault(); e.stopPropagation()
    next.focus()
  }
  return (
    <div ref={root} className="nds-list-editor" style={{ width: box.width, maxHeight: box.height }} role="group" aria-label={label ? `${label} — values` : 'Values'} onKeyDownCapture={walk}>
      {closed ? (
        <OptionList options={shown} value={items} onChange={change} searchable selectAll={false} listClassName="nds-list-editor-list" initialQuery={typedStart(props.eventKey)}
          allowCustom={allowCustom} onCustomDraft={onDraft} />
      ) : (
        <div onInput={(e) => onDraft((e.target as HTMLInputElement).value ?? '')}>
          <TagInput value={items} onChange={change} initialInput={typed} maxTags={maxItems ?? undefined} placeholder="Add a value… (, adds · Enter saves)" aria-label={label ?? 'Values'} />
        </div>
      )}
      <span className="nds-list-editor-count" aria-live="polite">
        {reported(items, draft).length} {closed ? 'selected' : reported(items, draft).length === 1 ? 'value' : 'values'} · Enter saves · Esc cancels
      </span>
    </div>
  )
})
