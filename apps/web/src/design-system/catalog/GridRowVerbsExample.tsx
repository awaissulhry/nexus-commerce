'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

import { Search } from 'lucide-react'

import { Input } from '../primitives/Input'
import { Kbd } from '../primitives/Kbd'
import { Pill } from '../primitives/Pill'
import { Countdown } from '../components/Countdown'
import {
  GridCard, GridSearchSlot, GridToolbar, NexusGrid, actionsColumn, changeColumn, textColumn, useGridShortcuts,
  type ColDef, type GridApi, type GridReadyEvent, type ICellRendererParams, type NexusGridProps, type RowVerb, type RowVerbs,
} from '../grid'
import type { ChangeValueData } from '../grid/renderers/changeValue'

/*
 * 2026-10-05 — approvals grid G2 + G8 (with G1 and G7 as cells). Verify:
 *  - a waiting row shows Approve (primary) and Reject (danger outline) beside ⋯; the stale row's Approve is HELD —
 *    still focusable, its reason as a tooltip — and Reject still works;
 *  - clicking a verb or the ⋯ never "opens" the row; clicking anywhere else on the row does;
 *  - Tab walks Approve → Reject → ⋯ inside a cell; click a cell (or Tab into the grid and use ↑ ↓), then A approves
 *    and R rejects the focused row, Enter opens it, Esc closes it; typing in the search field never triggers them;
 *  - the scheduled row counts down and offers Undo; the failed row offers Retry. Light and dark, 390 px.
 */
type State = 'waiting' | 'scheduled' | 'failed'
interface RequestRow {
  id: string
  state: State
  what: string
  product: string
  change: ChangeValueData
  runsAt?: number
  heldReason?: string
}

const ROW_ID = (p: { data: RequestRow }) => p.data.id
const TONE: Record<State, 'info' | 'warning' | 'danger'> = { waiting: 'info', scheduled: 'warning', failed: 'danger' }

function StatusCell(p: ICellRendererParams<RequestRow>) {
  const row = p.data
  if (!row) return null
  if (row.state === 'scheduled' && row.runsAt) return <Pill tone="warning" size="sm"><Countdown to={row.runsAt} label={(t) => `Runs in ${t}`} doneLabel="Starting…" /></Pill>
  return <Pill tone={TONE[row.state]} size="sm" dot>{row.state === 'waiting' ? 'Waiting' : 'Failed'}</Pill>
}

type Act = (verb: string, row: RequestRow) => void

function columnsFor(act: { current: Act }): ColDef<RequestRow>[] {
  const approve: RowVerb<RequestRow> = {
    id: 'approve', label: 'Approve', tone: 'primary', onClick: (r) => act.current('Approved', r),
    disabled: (r) => r.heldReason, ariaLabel: (r) => `Approve: ${r.what} ${r.product}`,
  }
  const reject: RowVerb<RequestRow> = { id: 'reject', label: 'Reject', tone: 'danger', onClick: (r) => act.current('Rejected', r), ariaLabel: (r) => `Reject: ${r.what} ${r.product}` }
  const undo: RowVerb<RequestRow> = { id: 'undo', label: 'Undo', onClick: (r) => act.current('Undone', r) }
  const retry: RowVerb<RequestRow> = { id: 'retry', label: 'Retry', tone: 'primary', onClick: (r) => act.current('Retried', r) }
  const verbs = (r: RequestRow): RowVerbs<RequestRow> => (r.state === 'waiting' ? [approve, reject] : r.state === 'scheduled' ? [undo] : [retry])
  return [
    { colId: 'status', headerName: 'Status', width: 150, cellClass: 'nds-ag-cell', cellRenderer: StatusCell },
    { colId: 'what', headerName: 'What', width: 120, ...textColumn<RequestRow>('what') },
    { colId: 'product', headerName: 'Product', width: 130, ...textColumn<RequestRow>('product') },
    { colId: 'change', headerName: 'Change', width: 200, ...changeColumn<RequestRow>('change', { hideLabels: false }) },
    actionsColumn<RequestRow>({
      primary: verbs,
      items: (r) => [{ id: 'automate', label: 'Automate this kind…', onSelect: () => act.current('Automate', r) }],
      menuLabel: (r) => `More actions for ${r.what} ${r.product}`,
    }),
  ]
}

export function GridRowVerbsExample() {
  const [start] = useState(() => Date.now())
  const [log, setLog] = useState('nothing yet')
  const [opened, setOpened] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const act = useRef<Act>(() => {})
  act.current = (verb, row) => setLog(`${verb} · ${row.what} ${row.product}`)

  const rows = useMemo<RequestRow[]>(() => [
    { id: 'r1', state: 'waiting', what: 'Set price', product: 'XR-GLOVE-M', change: { changes: [{ label: 'Price', from: '€49.90', to: '€44.90' }] } },
    { id: 'r2', state: 'waiting', what: 'Set stock', product: 'XR-HELM-L', change: { changes: [{ label: 'Stock', from: '3', to: '5' }] }, heldReason: 'The stock count is older than 24 h — refresh it first' },
    { id: 'r3', state: 'scheduled', what: 'Set text', product: 'XR-JKT-S', runsAt: start + 14_000, change: { changes: [{ label: 'Title (IT)', from: 'Giacca Gale', to: 'Giacca da moto Gale in pelle' }, { label: 'Bullets', from: null, to: '5 bullets' }], more: 3 } },
    { id: 'r4', state: 'failed', what: 'Publish', product: 'XR-JKT-S', change: { changes: [] } },
  ], [start])
  const columnDefs = useMemo(() => columnsFor(act), [])

  const apiRef = useRef<GridApi<RequestRow> | null>(null)
  const onGridReady = useCallback((e: GridReadyEvent<RequestRow>) => { apiRef.current = e.api }, [])
  const onRowClicked = useCallback<NonNullable<NexusGridProps<RequestRow>['onRowClicked']>>((e) => { if (e.data) setOpened(`${e.data.what} ${e.data.product}`) }, [])

  const focusedRow = () => {
    const cell = apiRef.current?.getFocusedCell()
    return cell ? apiRef.current?.getDisplayedRowAtIndex(cell.rowIndex)?.data ?? null : null
  }
  const hostRef = useRef<HTMLDivElement>(null)
  const hints = useGridShortcuts(hostRef, [
    { key: 'a', label: 'Approve', run: () => { const r = focusedRow(); if (r?.state === 'waiting' && !r.heldReason) act.current('Approved', r) } },
    { key: 'r', label: 'Reject', run: () => { const r = focusedRow(); if (r?.state === 'waiting') act.current('Rejected', r) } },
    { key: 'Enter', label: 'Open', run: () => { const r = focusedRow(); if (r) setOpened(`${r.what} ${r.product}`) } },
    { key: 'Escape', label: 'Close', run: () => setOpened(null) },
    { key: 'x', label: 'Select', disabled: 'Not in this example', run: () => {} },
  ])

  return <section id="row-verbs-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-8)' }}>
    <h3>Row verbs and grid shortcuts — <code>actionsColumn</code> · <code>useGridShortcuts</code></h3>
    <p>Up to two visible verbs per row, each one click, with the ⋯ beside them. A held verb says why. Keys act on the focused row.</p>
    <div ref={hostRef}>
      <GridCard toolbar={<GridToolbar count={<><b>{rows.length}</b> requests</>}>
        <GridSearchSlot><Input size="sm" leadingIcon={<Search size={14} aria-hidden />} placeholder="Type here: A and R stay letters" aria-label="Search requests" value={search} onChange={(e) => setSearch(e.target.value)} /></GridSearchSlot>
      </GridToolbar>}>
        <NexusGrid<RequestRow> density="compact" domLayout="autoHeight" suppressCellFocus={false} rowData={rows} getRowId={ROW_ID} columnDefs={columnDefs} onGridReady={onGridReady} onRowClicked={onRowClicked} />
      </GridCard>
    </div>
    <div id="grid-shortcuts-example" role="list" aria-label="Keyboard shortcuts" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-6) var(--nds-space-14)', fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text)' }}>
      {hints.map((h) => <span role="listitem" key={h.key} style={{ color: h.disabled ? 'var(--nds-text-muted)' : undefined }}><Kbd>{h.keyLabel}</Kbd> {h.label}{h.reason ? ` — ${h.reason}` : ''}</span>)}
    </div>
    <div aria-live="polite" style={{ fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text)' }}>Last action: {log} · Open: {opened ?? 'none'}</div>
  </section>
}
