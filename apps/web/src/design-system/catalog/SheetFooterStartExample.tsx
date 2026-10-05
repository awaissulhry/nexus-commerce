'use client'
import { useCallback, useMemo, useState } from 'react'
import { Button } from '../primitives/Button'
import { NumberStepper } from '../primitives/NumberStepper'
import { Pill } from '../primitives/Pill'
import { NexusGrid, type ColDef, type ICellRendererParams } from '../grid'
import { GRID_SHEET_STATUS_WIDE, GridSheet, GridSheetStatus, UNSAVED_ROW_CLASS } from '../grid/hosts/GridSheet'

/**
 * The sheet footer's START slot and the unsaved row (Add rows, 2026-10-05) — WEB ONLY: Factory has no NexusGrid.
 * Verify in light and dark, at 1280 and 390 px: the start slot sits bottom left before the row count, set apart by a
 * hairline, and never shrinks; at 390 px "Rows to add" leaves and only the button shows in the 36 px footer. "Add rows"
 * appends rows that wear the dashed warning bar at their start edge (never a row tint) and say "Not saved" in their SKU
 * cell; their other cells are muted. The row count counts saved rows only. Keyboard: Tab reaches −, the count, + and
 * Add rows; the count takes typed digits and stays within 1–50.
 */
interface SampleRow { id: string; sku: string; name: string; unsaved?: boolean }

const SAVED: SampleRow[] = [
  { id: 'r1', sku: 'GALE-JACKET-S', name: 'Gale jacket S' },
  { id: 'r2', sku: 'GALE-JACKET-M', name: 'Gale jacket M' },
]

function SkuCell(p: ICellRendererParams<SampleRow>) {
  if (!p.data) return null
  if (!p.data.unsaved) return <span>{p.data.sku}</span>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--nds-space-6)' }}>
      <span className="nds-cell-muted">Type the SKU</span>
      <Pill tone="warning" size="sm">Not saved</Pill>
    </span>
  )
}

const COLUMNS: ColDef<SampleRow>[] = [
  { colId: 'sku', headerName: 'SKU', field: 'sku', width: 240, cellRenderer: SkuCell, cellClass: 'nds-cell-full-strength' },
  { colId: 'name', headerName: 'Name', field: 'name', flex: 1, valueGetter: (p) => (p.data?.unsaved ? '' : p.data?.name ?? '') },
]
const ROW_CLASS_RULES = { [UNSAVED_ROW_CLASS]: (p: { data?: SampleRow }) => !!p.data?.unsaved }
const ROW_ID = (p: { data: SampleRow }) => p.data.id

export function SheetFooterStartExample() {
  const [count, setCount] = useState(1)
  const [added, setAdded] = useState<SampleRow[]>([{ id: 'n0', sku: '', name: '', unsaved: true }])
  const rows = useMemo(() => [...SAVED, ...added], [added])
  const add = useCallback(() => setAdded((list) => [...list, ...Array.from({ length: count }, (_, i) => ({ id: `n${list.length + i}`, sku: '', name: '', unsaved: true }))]), [count])
  return (
    <div id="sheet-footer-start-example" style={{ maxWidth: 640 }}>
      <GridSheet height={240} footer={
        <GridSheetStatus rows={SAVED.length} start={<>
          <span className={GRID_SHEET_STATUS_WIDE}>
            <span id="sheet-footer-start-count">Rows to add</span>
            <NumberStepper size="sm" value={count} min={1} max={50} onChange={setCount} aria-labelledby="sheet-footer-start-count" decrementLabel="One row fewer" incrementLabel="One row more" />
          </span>
          <Button size="sm" onClick={add} aria-label={`Add rows: ${count} empty ${count === 1 ? 'row' : 'rows'}`}>Add rows</Button>
        </>}>
          <Button size="sm" variant="link" onClick={() => setAdded([])}>Remove the empty rows</Button>
        </GridSheetStatus>
      }>
        <NexusGrid<SampleRow> fill rowData={rows} getRowId={ROW_ID} columnDefs={COLUMNS} rowClassRules={ROW_CLASS_RULES} suppressCellFocus={false} />
      </GridSheet>
    </div>
  )
}
