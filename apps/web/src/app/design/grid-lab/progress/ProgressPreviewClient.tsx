'use client'

/**
 * /design/grid-lab/progress — the PROGRESS COLUMNS lab (2026-09-26). Sample rows only; nothing is saved.
 *
 * The Owner approved this page as a clickable preview; it now renders the SHIPPED design-system pieces — `ProgressCell`
 * (meter + card), colour rule A (`progressTone`) and `landOnCell` — so what is tried here is what the sheet draws.
 * Rule A: red while a required field is empty (whatever the percent), yellow when every required field is filled but an
 * optional one is empty, green when nothing is missing. Edit any cell and the bars follow.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { GridApi } from 'ag-grid-community'

import { GridCard, NexusGrid, ProgressCell, SHEET_GRID_OPTIONS, cellDetailKeys, landOnCell, scalarValueEditor, type ColDef, type NexusGridProps, type ProgressCellParams, type ProgressValue } from '@/design-system/grid'

import styles from './progress.module.css'

type Field = 'title' | 'brand' | 'colour' | 'material' | 'description' | 'bullet1'
type Row = { id: string; sku: string } & Record<Field, string>
const FIELDS: Array<{ key: Field; label: string; width: number }> = [
  { key: 'title', label: 'Title', width: 220 }, { key: 'brand', label: 'Brand', width: 110 }, { key: 'colour', label: 'Colour', width: 100 },
  { key: 'material', label: 'Material', width: 120 }, { key: 'description', label: 'Description', width: 200 }, { key: 'bullet1', label: 'Bullet 1', width: 180 },
]
const LABEL = Object.fromEntries(FIELDS.map(f => [f.key, f.label])) as Record<Field, string>

/** What each scope asks for — sample rules. The sheet reads these from the server's completeness. */
const SCOPES = [
  { id: 'shared', label: 'Shared product', required: ['title', 'brand', 'description'] as Field[], optional: ['colour', 'material', 'bullet1'] as Field[] },
  { id: 'amazon-it', label: 'Amazon · IT', required: ['title', 'brand', 'material', 'bullet1'] as Field[], optional: ['colour'] as Field[] },
  { id: 'ebay-it', label: 'eBay · IT', required: ['title', 'colour'] as Field[], optional: ['material', 'description'] as Field[] },
] as const
type Scope = (typeof SCOPES)[number]

const INITIAL: Row[] = [
  { id: 'p', sku: 'AIREON', title: 'XAVIA AIREON Giacca Moto Uomo', brand: 'Xavia', colour: '', material: 'Poliestere', description: 'Giacca da moto con protezioni CE…', bullet1: 'Protezioni CE livello 2' },
  { id: 'c1', sku: 'AIREON-NERO-M', title: 'XAVIA AIREON Giacca Moto Uomo', brand: 'Xavia', colour: 'Nero', material: 'Poliestere', description: 'Giacca da moto con protezioni CE…', bullet1: 'Protezioni CE livello 2' },
  { id: 'c2', sku: 'AIREON-NERO-L', title: 'XAVIA AIREON Giacca Moto Uomo', brand: '', colour: 'Nero', material: '', description: 'Giacca da moto con protezioni CE…', bullet1: '' },
  { id: 'c3', sku: 'AIREON-CREMA-M', title: 'XAVIA AIREON Giacca Moto Uomo Crema', brand: 'Xavia', colour: 'Crema', material: '', description: '', bullet1: 'Protezioni CE livello 2' },
  { id: 'c4', sku: 'AIREON-CREMA-L', title: 'XAVIA AIREON Giacca Moto Uomo Crema', brand: 'Xavia', colour: 'Crema', material: 'Poliestere', description: 'Giacca da moto con protezioni CE…', bullet1: 'Protezioni CE livello 2' },
]

/** A sample row's reading, in the shape the sheet's rows give the DS cell. */
function progressOf(row: Row, scope: Scope): ProgressValue {
  const empty = (f: Field) => !row[f]?.trim()
  const requiredEmpty = scope.required.filter(empty).map(f => ({ field: f, label: LABEL[f] }))
  const optionalEmpty = scope.optional.filter(empty).map(f => ({ field: f, label: LABEL[f] }))
  const total = scope.required.length + scope.optional.length
  return {
    pct: Math.round(((total - requiredEmpty.length - optionalEmpty.length) / total) * 100),
    required: { filled: scope.required.length - requiredEmpty.length, total: scope.required.length },
    optional: { filled: scope.optional.length - optionalEmpty.length, total: scope.optional.length },
    requiredEmpty, optionalEmpty,
  }
}

const getRowId: NexusGridProps<Row>['getRowId'] = p => p.data.id

export function ProgressPreviewClient() {
  const [rows, setRows] = useState(() => INITIAL.map(r => ({ ...r })))
  const [notice, setNotice] = useState('Click or hover a bar. Edit a cell and the bars follow.')
  const apiRef = useRef<GridApi<Row> | null>(null)

  const progressColumn = useCallback((scope: Scope): ColDef<Row> => ({
    colId: `progress:${scope.id}`, headerName: scope.label, width: 132, editable: false,
    valueGetter: p => (p.data ? progressOf(p.data, scope) : null),
    suppressKeyboardEvent: cellDetailKeys,
    cellClass: 'nds-ag-cell nds-cell-is-locked',
    cellRenderer: ProgressCell,
    cellRendererParams: {
      scopeLabel: scope.label,
      subjectOf: p => (p.data as Row | undefined)?.sku ?? null,
      actionFor: () => ({ kind: 'goto', label: 'Go to' }),
      onGoTo: (field, p) => {
        const row = p.data as Row | undefined
        const api = apiRef.current
        if (!row || !api) return
        landOnCell(api, { rowId: row.id, colId: field })
        setNotice(`Cursor on ${LABEL[field as Field]} of ${row.sku}. Press Enter or type to fill it.`)
      },
      footerLink: () => (scope.id === 'shared' ? null : { label: `All products for ${scope.label}`, href: '/products/listing-readiness' }),
    } satisfies ProgressCellParams,
  }), [])

  const columns = useMemo<ColDef<Row>[]>(() => [
    { field: 'sku', headerName: 'Product', pinned: 'left', width: 170, editable: false },
    ...SCOPES.map(progressColumn),
    ...FIELDS.map((f): ColDef<Row> => ({ field: f.key, headerName: f.label, width: f.width, editable: true, cellDataType: false, ...scalarValueEditor('text') })),
  ], [progressColumn])

  const onGridReady = useCallback<NonNullable<NexusGridProps<Row>['onGridReady']>>(e => { apiRef.current = e.api }, [])

  const onCellValueChanged = useCallback<NonNullable<NexusGridProps<Row>['onCellValueChanged']>>(event => {
    const field = event.column.getColId() as Field
    setRows(current => current.map(r => r.id === event.data.id ? { ...r, [field]: String(event.newValue ?? '') } : r))
    setNotice(`Saved ${LABEL[field]} on ${event.data.sku}. The bars updated.`)
  }, [])

  return <div className={styles.lab}>
    <h1>Progress columns</h1>
    <div className={styles.legend}>
      <span><i className={`${styles.swatch} ${styles.missing}`} /> Red: a required field is empty</span>
      <span><i className={`${styles.swatch} ${styles.partial}`} /> Yellow: required done, an optional field is empty</span>
      <span><i className={`${styles.swatch} ${styles.complete}`} /> Green: nothing is missing</span>
    </div>
    <ul className={styles.notes}>
      <li>One progress column per scope: the shared product, then each channel · market. They are ordinary columns: pin, move or hide them from the header menu.</li>
      <li>Hover or click a bar to see what is missing. <b>Go to</b> puts the cursor in that cell and marks it.</li>
      <li>Empty a cell (or fill one) and watch the bars change. Sample rows and sample rules; nothing is saved.</li>
    </ul>
    <GridCard><NexusGrid<Row> {...SHEET_GRID_OPTIONS} rowData={rows} columnDefs={columns} getRowId={getRowId} domLayout="autoHeight"
      onGridReady={onGridReady} onCellValueChanged={onCellValueChanged} /></GridCard>
    <p role="status" className={styles.status}>{notice}</p>
  </div>
}
