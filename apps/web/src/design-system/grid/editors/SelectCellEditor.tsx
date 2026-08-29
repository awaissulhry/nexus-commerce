'use client'

/**
 * GDS — a DS `Listbox` as an AG cell editor.
 *
 *   { ...selectEditor([{ value: 'ACTIVE', label: 'Active' }, …]) }
 *
 * AG hands the editor the cell's value and a setter; the Listbox is the DS control operators
 * already know from the filter bar, at the dense `xs` tier so it sits inside the row. Choosing a
 * value commits the edit (AG's `stopEditing`), Escape cancels — the same keys as every other cell.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useGridCellEditor, type CustomCellEditorProps } from 'ag-grid-react'
import type { ColDef } from 'ag-grid-community'

import { Listbox, type ListboxOption } from '../../components'

export interface SelectEditorParams {
  options: ListboxOption[]
  placeholder?: string
}

export function SelectCellEditor(p: CustomCellEditorProps & SelectEditorParams) {
  const { value, onValueChange, api, stopEditing } = p
  const hostRef = useRef<HTMLDivElement>(null)
  const committed = useRef(false)

  useGridCellEditor({
    // A value chosen from the list is the edit; closing the list without choosing is a cancel.
    isCancelAfterEnd: () => !committed.current,
  })

  useEffect(() => {
    // Open the list as the editor mounts — the operator asked to edit, not to look at a trigger.
    const trigger = hostRef.current?.querySelector<HTMLElement>('button, [role="combobox"]')
    trigger?.focus()
    trigger?.click()
  }, [])

  const onChange = useCallback(
    (next: string) => {
      committed.current = true
      onValueChange(next)
      // Let the Listbox close before AG tears the editor down.
      setTimeout(() => stopEditing(), 0)
    },
    [onValueChange, stopEditing],
  )

  return (
    <div ref={hostRef} className="nds-cell-select-editor" onKeyDown={(e) => { if (e.key === 'Escape') { committed.current = false; api.stopEditing(true) } }}>
      <Listbox size="xs" options={p.options} value={value == null ? undefined : String(value)} onChange={onChange} placeholder={p.placeholder} ariaLabel={p.colDef.headerName ?? 'Value'} />
    </div>
  )
}

/** The `ColDef` fragment: editable, this editor, its options. */
export const selectEditor = (options: ListboxOption[], placeholder?: string): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorParams' | 'cellEditorPopup'> => ({
  editable: true,
  cellEditor: SelectCellEditor,
  cellEditorParams: { options, placeholder } satisfies SelectEditorParams,
  cellEditorPopup: false,
})
