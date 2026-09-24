'use client'

import { useCallback, useMemo, useState } from 'react'
import { GridCard, NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type NexusGridProps } from '../grid'
import { SlotListEditor, type SlotListEditorParams } from '../grid/editors/SlotListEditor'
import { slotListColumnDef } from '../grid/editors/slotListColumn'
import { slotListChanges, type SlotGroup } from '../grid/editors/slotList'

/*
 * Step 4.3 #3 (A-52; R-55, R-56) — the bullets editor on sample rows. The first column is a channel's ten fixed positions
 * shown as ONE cell (`slotListColumnDef`); the second is a Shared list in `list` mode. Sample data only: an edit here says
 * which positions would be written, one write per changed position, and changes nothing else.
 */
type SampleRow = { id: string; sku: string; values: Record<string, { value: string | null; editable: boolean }>; shared: string[] }
const KEYS = Array.from({ length: 10 }, (_, i) => `bullet_${i + 1}`)
const GROUP: SlotGroup = { of: 'bullets', max: 10, keys: KEYS, maxLength: 200 }
const sample = (id: string, sku: string, bullets: Array<string | null>, shared: string[]): SampleRow => ({
  id, sku, shared, values: Object.fromEntries(KEYS.map((k, i) => [k, { value: bullets[i] ?? null, editable: true }])),
})
const INITIAL: SampleRow[] = [
  sample('one', 'JACKET-M', ['Waterproof shell', 'Taped seams', null, 'Two zip pockets'], ['Waterproof shell', 'Taped seams']),
  sample('two', 'GLOVES-L', ['Touch-screen fingertips'], []),
]
const SHARED_PARAMS: Pick<SlotListEditorParams, 'slotList'> = { slotList: { mode: 'list', max: null, maxLength: null, itemLabel: 'Bullet', label: 'Shared bullet points' } }
const getRowId: NexusGridProps<SampleRow>['getRowId'] = p => p.data.id

export function SlotListEditorExample() {
  const [rows, setRows] = useState(INITIAL)
  const [notice, setNotice] = useState('No sample changes yet.')
  const columns = useMemo<ColDef<SampleRow>[]>(() => [
    { field: 'sku', headerName: 'SKU', width: 130 },
    slotListColumnDef<SampleRow>(GROUP, {
      label: 'Bullet points', itemLabel: 'Bullet',
      cellOf: (row, key) => row.values[key],
      setSlot: (row, key, value) => { row.values = { ...row.values, [key]: { ...row.values[key], value } }; return true },
      rowIdOf: row => row.id,
    }),
    {
      colId: 'shared', headerName: 'Shared bullet points', width: 240, editable: true, cellDataType: false,
      valueGetter: p => p.data?.shared ?? [],
      valueSetter: p => { if (!p.data || !Array.isArray(p.newValue)) return false; p.data.shared = p.newValue as string[]; return true },
      valueFormatter: p => (Array.isArray(p.value) ? `${p.value.length} · ${p.value[0] ?? ''}` : ''),
      cellEditor: SlotListEditor, cellEditorPopup: true, cellEditorParams: SHARED_PARAMS,
    },
  ], [])
  const onCellValueChanged = useCallback<NonNullable<NexusGridProps<SampleRow>['onCellValueChanged']>>(event => {
    const colId = event.column.getColId()
    if (colId === 'shared') setNotice(`Shared list for ${event.data.sku}: one list write of ${(event.newValue as string[]).length} bullets.`)
    else {
      const changed = slotListChanges(event.oldValue as string[], event.newValue as string[], GROUP.max)
      setNotice(`${event.data.sku}: ${changed.length} position write${changed.length === 1 ? '' : 's'} (${changed.map(c => `Bullet ${c.position}`).join(', ')}).`)
    }
    setRows(current => current.map(row => (row.id === event.data.id ? { ...event.data } : row)))
  }, [])
  return <section id="slot-list-editor-example">
    <h3>SlotListEditor</h3>
    <p>Open a Bullet points cell with Enter, F2 or a double-click. Tab moves to the next bullet; Tab on the last bullet saves and moves right. Alt+↑ or Alt+↓ moves a bullet. Enter saves, Esc cancels. Empty positions stay where they are.</p>
    <p>Each changed position is its own write. A position over the cap is marked, never cut. The Shared column opens the same editor in list mode: the items and one empty position.</p>
    <GridCard><NexusGrid<SampleRow> {...SHEET_GRID_OPTIONS} rowData={rows} columnDefs={columns} getRowId={getRowId} domLayout="autoHeight" onCellValueChanged={onCellValueChanged} /></GridCard>
    <p role="status">{notice}</p>
  </section>
}
