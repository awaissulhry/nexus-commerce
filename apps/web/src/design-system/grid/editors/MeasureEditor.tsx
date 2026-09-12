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
import { asMeasure, type MeasureValue } from '../renderers/shapeFormat'
import { editorBox, roomToRightOf } from './editorBox'

export interface MeasureEditorParams {
  unitOptions?: string[]
  label?: string
  value?: unknown
  column: { getActualWidth(): number }
  stopEditing: (cancel?: boolean) => void
  onValueChange?: (value: unknown) => void
  eGridCell?: HTMLElement
}

export const MeasureEditor = forwardRef<unknown, MeasureEditorParams>(function MeasureEditor(props, _ref) {
  const { unitOptions = [], label, value, column, stopEditing, onValueChange } = props
  const [m, setM] = useState<MeasureValue>(() => asMeasure(value))
  const [text, setText] = useState(() => (m.value === null ? '' : String(m.value)))
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current?.querySelector<HTMLInputElement>('input')
    el?.focus()
    el?.select()
  }, [])
  const report = useCallback(
    (next: MeasureValue) => {
      setM(next)
      onValueChange?.(next.value === null && next.unit === null ? null : { value: next.value, unit: next.unit })
    },
    [onValueChange],
  )
  const onText = (s: string) => {
    setText(s)
    const t = s.trim().replace(',', '.')
    const n = t === '' ? null : Number(t)
    report({ value: n === null || !Number.isFinite(n) ? null : n, unit: m.unit })
  }
  const cellRect = props.eGridCell?.getBoundingClientRect()
  const box = editorBox({
    cellWidth: cellRect?.width ?? column.getActualWidth(),
    cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, window.innerWidth) : window.innerWidth,
    kind: 'measure',
  })
  return (
    <div ref={root} className="nds-measure-editor" style={{ width: box.width }} role="group" aria-label={label ? `${label} — value and unit` : 'Value and unit'}>
      <Input type="number" inputMode="decimal" step="any" value={text} onChange={(e) => onText(e.target.value)} aria-label="Value" className="nds-measure-editor-value" />
      {unitOptions.length > 0 && (
        <ListboxPanel
          options={unitOptions.map((u) => ({ value: u, label: u }))}
          value={m.unit ?? undefined}
          onCommit={(u) => report({ value: m.value, unit: u })}
          onCancel={() => stopEditing(true)}
          emptyLabel="No units"
        />
      )}
    </div>
  )
})
