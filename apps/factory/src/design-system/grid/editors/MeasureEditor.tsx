/**
 * GDS — the `shape: 'measure'` cell editor (AM.1 §A.3 row 4): a number field and the channel's unit
 * list in ONE popup. The unit list is the DS `ListboxPanel` rendered INLINE, not a dropdown — a
 * portalled option list sits outside AG's popup and AG reads the click as "elsewhere" and stops the
 * edit before the choice lands (the trap `SelectPanelEditor` documents from the other side).
 *
 * Reports `{ value, unit }` with `onValueChange` on every change (never a bare number — the route
 * refuses one), `null` when both are empty (= clear). Enter/Tab/Esc are AG's.
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { ListboxPanel } from '../../components'
import { Input } from '../../primitives'
import { asMeasure } from '../renderers/shapeFormat'
import { editorBox, roomToRightOf } from './editorBox'
import { typedStart } from './selectPanelModel'
import { measureFromText, type MeasureDraft } from './shapeValue'

export interface MeasureEditorParams {
  unitOptions?: string[]
  label?: string
  value?: unknown
  column: { getActualWidth(): number }
  stopEditing: (cancel?: boolean) => void
  onValueChange?: (value: unknown) => void
  eGridCell?: HTMLElement
  eventKey?: string | null
}

export const MeasureEditor = forwardRef<unknown, MeasureEditorParams>(function MeasureEditor(props, _ref) {
  const { unitOptions = [], label, value, column, stopEditing, onValueChange } = props
  const [m, setM] = useState<MeasureDraft>(() => asMeasure(value))
  /* A digit, point, comma or minus that opened the cell by typing starts the number; the grid consumed that keystroke
     (P0, 2026-09-30). The field is text with a decimal keypad, not `type="number"`: a number field clears "." and "-",
     so ".5" was saved as 5 (code review 2026-09-30), and it refused the Italian decimal comma that `onText` accepts. */
  const typed = /^[\d.,-]$/.test(typedStart(props.eventKey)) ? typedStart(props.eventKey) : ''
  const [text, setText] = useState(() => (m.value === null ? '' : String(m.value)))
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current?.querySelector<HTMLInputElement>('input')
    el?.focus()
    if (typed) onText(typed)
    else el?.select()
    // mount only: the typed key is taken once, as if typed into the field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const report = useCallback(
    (next: MeasureDraft) => {
      setM(next)
      onValueChange?.(next.value === null && next.unit === null ? null : { value: next.value, unit: next.unit })
    },
    [onValueChange],
  )
  const onText = (s: string) => {
    setText(s)
    report(measureFromText(s, m.unit, unitOptions))
  }
  const cellRect = props.eGridCell?.getBoundingClientRect()
  const box = editorBox({
    cellWidth: cellRect?.width ?? column.getActualWidth(),
    cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, window.innerWidth) : window.innerWidth,
    kind: 'measure',
  })
  /* Tab from the number goes to the units and Shift+Tab back; Tab from the units is AG's (it saves and moves). Tab used to
     leave at once, so a unit could be chosen only with the mouse (P0, 2026-09-30). */
  const tabToUnits = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || unitOptions.length === 0) return
    const units = root.current?.querySelector<HTMLElement>('.nds-listbox-pop')
    const inNumber = e.target instanceof HTMLInputElement && !units?.contains(e.target)
    if (!units || inNumber === e.shiftKey) return
    e.preventDefault(); e.stopPropagation()
    if (inNumber) units.focus()
    else root.current?.querySelector<HTMLInputElement>('input')?.focus()
  }
  return (
    <div ref={root} className="nds-measure-editor" style={{ width: box.width }} role="group" aria-label={label ? `${label} — value and unit` : 'Value and unit'} onKeyDownCapture={tabToUnits}>
      <Input type="text" inputMode="decimal" value={text} onChange={(e) => onText(e.target.value)} aria-label="Value" className="nds-measure-editor-value" />
      {unitOptions.length > 0 && (
        <ListboxPanel
          options={unitOptions.map((u) => ({ value: u, label: u }))}
          value={m.unit ?? undefined}
          onCommit={(u) => report({ value: m.value, unit: u })}
          onKeyChoice={(u) => { if (u !== null && u !== m.unit) report({ value: m.value, unit: u }) }}
          onCancel={() => stopEditing(true)}
          emptyLabel="No units"
        />
      )}
    </div>
  )
})
