'use client'

/**
 * MX.G — the Matrix cells in the grid lab: EVERY §3.4 state, on a 6-row fixture, 36px rows.
 *
 * `docs/2026-09-13-matrix-page-design.md` §3.4 is the table; `matrixCells.ts`'s `MatrixCellState`
 * names its rows. This scenario renders one grid whose cells cover all 35 members — the preview
 * builder (`buildPreviewMatrix`, the page's own fixture engine) supplies the shape and a STATE SHEET
 * forces the members a hash-driven fixture does not reach on six rows — and prints a coverage
 * legend computed from the data, so "every state rendered" is a set claim on screen rather than an
 * adjective in a ledger. `window.__matrixLab` exposes the same numbers to a probe.
 *
 * The write path is the real one: `writeGate` → `matrixWrite` (the engine's routing branch) →
 * `applyCells` (the page's in-memory store, versions + CAS) → the grid repaints from the store's
 * answer. Every decision — sent or refused — is logged, so a fill over `fulfilment` writing NOTHING
 * and a fill over `syncBuffer` writing something are both witnessed by the same instrument.
 *
 * 🔴 The store is applied to the PRISTINE read, and the grid is handed a CLONE of the rows. The
 * column's `valueSetter` mutates `params.data` in place (AG requires it); if the store then read the
 * same object, Buffer / Mode / Sale writes would compare equal to themselves and answer `noop` — a
 * zero-change round trip that cannot test the write. Measured here first; MX.P's page must isolate
 * the same way (ledger: REQUEST TO MX.P).
 *
 * Lab-only: this folder may import `ag-grid-*` and the app's own fixture modules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValueChangedEvent, ColDef, ColGroupDef, GridApi, GridReadyEvent, ICellRendererParams } from 'ag-grid-community'

import { Pill } from '@/design-system/primitives'
import {
  CellSaveTracker,
  GridSheet,
  MATRIX_CELL_COPY,
  MATRIX_CELL_KINDS,
  NexusGrid,
  SAVED_FADE_MS,
  SHEET_GRID_OPTIONS,
  matrixCellState,
  matrixColumnDef,
  matrixWrite,
  writeGate,
  type FulfilmentMethod,
  type MatrixCellKind,
  type MatrixCells,
  type MatrixWriteDecision,
} from '@/design-system/grid'
import type { MatrixCellState } from '@/design-system/grid/renderers/matrixCells'
import type { MatrixRead, MatrixRowRead, MatrixWriteOutcome } from '@/app/products/[id]/edit/_studio/matrix/contract'
import { buildPreviewMatrix, type PreviewCoordinateInput, type PreviewRowInput } from '@/app/products/[id]/edit/_studio/matrix/fixtures'
import { applyCells } from '@/app/products/[id]/edit/_studio/matrix/store'

import { registerLabModules } from './labModules'

registerLabModules()

/* ── the fixture: six real-shaped rows, seven coordinate kinds ─────────────────────────────── */

const ROWS: PreviewRowInput[] = [
  { id: 'p', sku: 'GALE-JACKET', isParent: true, basePrice: 105, status: 'ACTIVE' },
  { id: 'v1', sku: 'GALE-JACKET-BLK-S', isParent: false, basePrice: 105, status: 'ACTIVE' },
  { id: 'v2', sku: 'GALE-JACKET-BLK-M', isParent: false, basePrice: 105, status: 'ACTIVE' },
  { id: 'v3', sku: 'GALE-JACKET-BLK-L', isParent: false, basePrice: 105, status: 'ACTIVE' },
  { id: 'v4', sku: 'GALE-JACKET-NVY-S', isParent: false, basePrice: 105, status: 'DRAFT' },
  { id: 'v5', sku: 'GALE-JACKET-NVY-M', isParent: false, basePrice: 105, status: 'ACTIVE' },
]

/** Amazon IT + DE (→ ONE EU inventory group), Amazon UK (GBP, its own full group), eBay IT (+ the preview alias ②), Shopify (GLOBAL), Etsy unconnected (→ `Not listed`). */
const COORDS: PreviewCoordinateInput[] = [
  { channel: 'AMAZON', market: 'IT', label: 'Amazon · IT', connected: true, accountId: 'acc-amz' },
  { channel: 'AMAZON', market: 'DE', label: 'Amazon · DE', connected: true, accountId: 'acc-amz' },
  { channel: 'AMAZON', market: 'UK', label: 'Amazon · UK', connected: true, accountId: 'acc-amz' },
  { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'acc-ebay' },
  { channel: 'SHOPIFY', market: 'GLOBAL', label: 'Shopify', connected: true, accountId: 'acc-shop' },
  { channel: 'ETSY', market: 'GLOBAL', label: 'Etsy', connected: false, accountId: null },
]

/** The lab's clock — frozen, so `Sent <ago>` compares to itself across screenshots. */
const LAB_NOW = Date.UTC(2026, 8, 13, 5, 50, 0)

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * THE STATE SHEET — the members a hash-driven fixture does not reach on six rows, forced onto named
 * cells so the coverage legend below can count all 35. Each line names the state it produces.
 */
function forceStates(read: MatrixRead): MatrixRead {
  const out = clone(read)
  const at = (rowId: string, key: string) => out.rows.find((r) => r.id === rowId)!.cells[key]!
  const blockInventory = (c: MatrixCells, reason: string) => {
    for (const k of ['syncMode', 'syncQty', 'syncBuffer'] as const) { c.writable[k] = false; c.writeBlockedReason[k] = reason }
  }
  const sync = (c: MatrixCells, s: Partial<NonNullable<MatrixCells['sync']>>) => { c.sync = { ...c.sync!, ...s } }
  const queue = (c: MatrixCells, q: Partial<NonNullable<MatrixCells['queue']>>) => { c.queue = { ...c.queue!, ...q } }

  /* AMAZON:EU — the region inventory group: fulfilment × sync × queue. */
  const eu = (id: string) => at(id, 'AMAZON:EU')
  Object.assign(eu('v1').fulfilment!, { method: 'FBM', source: 'set', guard: 'FBM', reported: null })                 // fulfilment-set
  sync(eu('v1'), { kind: 'FOLLOW', mode: 'FOLLOW', intended: 403, held: 403, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false, via: null }) // follow
  queue(eu('v1'), { state: 'sent', at: '2026-09-13T05:48:00.000Z', reason: null, syncType: 'QUANTITY_UPDATE', via: null }) // queue-sent
  eu('v1').writable = { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true }; eu('v1').writeBlockedReason = {}
  Object.assign(eu('v2').fulfilment!, { method: 'FBM', source: 'derived', guard: 'FBM', reported: null })             // fulfilment-derived
  sync(eu('v2'), { kind: 'PINNED', mode: 'PINNED', intended: 10, held: 10, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false, via: null }) // pinned
  queue(eu('v2'), { state: 'queued', at: '2026-09-13T05:49:00.000Z', reason: null, syncType: 'QUANTITY_UPDATE', via: null }) // queue-queued
  eu('v2').writable = { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: false }; eu('v2').writeBlockedReason = { syncBuffer: 'A pinned listing ignores its buffer — set it to Follow first' }
  Object.assign(eu('v3').fulfilment!, { method: 'FBM', source: 'set', guard: 'FBA', reported: null })                 // fulfilment-guard-differs
  sync(eu('v3'), { kind: 'PAUSED', via: 'POLICY', mode: 'FOLLOW', intended: null, held: 7, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }) // paused-policy
  queue(eu('v3'), { state: 'paused', at: null, reason: null, syncType: null, via: 'POLICY' })                          // queue-paused
  eu('v3').writable = { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: true }; eu('v3').writeBlockedReason = {}
  Object.assign(eu('v4').fulfilment!, { method: 'FBM', source: 'set', guard: 'FBM', reported: 'AFN' })                // fulfilment-reported-differs
  sync(eu('v4'), { kind: 'PAUSED', via: 'LISTING', mode: 'PINNED', intended: null, held: 5, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }) // paused-listing
  queue(eu('v4'), { state: 'paused', at: null, reason: null, syncType: null, via: 'LISTING' })
  eu('v4').writable = { fulfilment: true, syncMode: true, syncQty: true, syncBuffer: false }; eu('v4').writeBlockedReason = { syncBuffer: 'A pinned listing ignores its buffer — set it to Follow first' }
  Object.assign(eu('v5').fulfilment!, { method: 'FBA', source: 'set', guard: 'FBA', reported: null })
  sync(eu('v5'), { kind: 'FBA_EXCLUDED', via: null, mode: 'FOLLOW', intended: null, held: null, buffer: 0, poolAvailable: 403, routedLocations: ['IT-MAIN'], fbaAtAmazon: 49, oversold: false }) // amazon-managed
  queue(eu('v5'), { state: 'never', at: null, reason: null, syncType: null, via: null })                              // queue-never
  eu('v5').writable = { fulfilment: true }; eu('v5').writeBlockedReason = {}; blockInventory(eu('v5'), MATRIX_CELL_COPY.amazonManaged)

  /* AMAZON:IT — listing × price × sale. */
  const it = (id: string) => at(id, 'AMAZON:IT')
  it('p').listing = { state: 'listed', externalId: 'B0F7J163XJ', detail: '1 listing', published: true }
  it('v1').listing = { state: 'listed', externalId: null, detail: null, published: true }                              // listed
  it('v1').price = { value: 105, currency: 'EUR', source: 'master', formula: null, clamped: null }                    // price-master
  it('v1').sale = { value: 89, start: '2026-09-12', end: '2026-09-30' }                                               // sale-set
  it('v1').writable.price = true; it('v1').writable.salePrice = true; delete it('v1').writeBlockedReason.price
  it('v2').listing = { state: 'draft', externalId: null, detail: null, published: false }                             // draft
  it('v2').price = { value: 99, currency: 'EUR', source: 'override', formula: null, clamped: null }                   // price-override
  it('v2').writable.price = true; delete it('v2').writeBlockedReason.price
  it('v3').listing = { state: 'excluded', externalId: null, detail: null, published: false }                          // excluded
  it('v3').price = { value: 99.75, currency: 'EUR', source: 'formula', formula: '= $basePrice * 0.95', clamped: null } // price-formula
  it('v3').writable.price = false; it('v3').writeBlockedReason.price = 'A formula owns this cell — edit the formula'
  it('v4').listing = { state: 'not-set-up', externalId: null, detail: null, published: false }                        // not-set-up
  it('v4').price = { value: 80, currency: 'EUR', source: 'override', formula: null, clamped: 'floor' }                // price-clamped
  it('v4').writable.price = true; delete it('v4').writeBlockedReason.price
  it('v5').listing = { state: 'needs-value', externalId: null, detail: null, published: true }                        // needs-value
  it('v5').sale = { value: null, start: null, end: null }                                                             // sale-none

  /* AMAZON:DE — the four Matrix words + the `not buyable` detail. */
  const de = (id: string) => at(id, 'AMAZON:DE')
  de('v1').listing = { state: 'suppressed', externalId: null, detail: null, published: true }                         // suppressed
  de('v2').listing = { state: 'closed', externalId: null, detail: null, published: true }                             // closed
  de('v3').listing = { state: 'error', externalId: null, detail: null, published: true }                              // error
  de('v4').listing = { state: 'ended', externalId: null, detail: null, published: false }                             // ended
  de('v5').listing = { state: 'listed', externalId: null, detail: 'not buyable', published: true }

  /* AMAZON:UK — a full group in GBP: the pool-side states and the queue failures. */
  const uk = (id: string) => at(id, 'AMAZON:UK')
  sync(uk('v1'), { kind: 'UNCOUNTED', via: null, mode: 'FOLLOW', intended: null, held: 0, buffer: 0, poolAvailable: null, routedLocations: [], fbaAtAmazon: null, oversold: false }) // uncounted
  queue(uk('v1'), { state: 'sending', at: '2026-09-13T05:49:30.000Z', reason: null, syncType: 'QUANTITY_UPDATE', via: null }) // queue-sending
  sync(uk('v2'), { kind: 'CLOSED', via: null, mode: 'FOLLOW', intended: null, held: 0, buffer: 0, poolAvailable: 12, routedLocations: ['UK-MAIN'], fbaAtAmazon: null, oversold: false }) // offer-closed
  queue(uk('v2'), { state: 'never', at: null, reason: null, syncType: null, via: null })
  blockInventory(uk('v2'), MATRIX_CELL_COPY.closedHint)
  sync(uk('v3'), { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 12, held: 500, buffer: 0, poolAvailable: 12, routedLocations: ['UK-MAIN'], fbaAtAmazon: null, oversold: true }) // oversold
  queue(uk('v3'), { state: 'failed', at: '2026-09-13T05:40:00.000Z', reason: 'Amazon: 8541 — the quantity exceeds what the pool can back', syncType: 'QUANTITY_UPDATE', via: null }) // queue-failed
  sync(uk('v4'), { kind: 'FOLLOW', via: null, mode: 'FOLLOW', intended: 9, held: 9, buffer: 3, poolAvailable: 12, routedLocations: ['UK-MAIN'], fbaAtAmazon: null, oversold: false })
  queue(uk('v4'), { state: 'dead', at: '2026-09-13T04:10:00.000Z', reason: 'MAX_RETRIES_EXCEEDED after 3 attempts', syncType: 'PRICE_UPDATE', via: null }) // queue-dead
  for (const id of ['v1', 'v3', 'v4', 'v5']) { uk(id).writable = { ...uk(id).writable, fulfilment: true, syncMode: true, syncQty: true, syncBuffer: uk(id).sync?.mode === 'FOLLOW' } }
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5']) { uk(id).price = { value: 89 + Number(id.slice(1)), currency: 'GBP', source: 'override', formula: null, clamped: null }; uk(id).writable.price = true; delete uk(id).writeBlockedReason.price }
  return out
}

/* ── the scenario ───────────────────────────────────────────────────────────────────────── */

interface WriteLogEntry {
  at: number
  colId: string
  rowId: string
  source: string | undefined
  decision: MatrixWriteDecision | { send: false; reason: 'gate' }
  outcome?: MatrixWriteOutcome
}
interface LabWindow {
  __matrixLab?: {
    coverage: Record<string, number>
    missing: string[]
    unknownQueue: string[]
    writes: WriteLogEntry[]
    picks: Array<{ rowId: string; method: FulfilmentMethod }>
    jumps: string[]
  }
}

const kindOf = (colId: string): MatrixCellKind | null => {
  const k = colId.slice(colId.lastIndexOf('.') + 1)
  return (MATRIX_CELL_KINDS as readonly string[]).includes(k) ? (k as MatrixCellKind) : null
}
const coordOf = (colId: string) => colId.slice(0, colId.lastIndexOf('.'))

export function MatrixScenario() {
  const [read, setRead] = useState<MatrixRead>(() => forceStates(buildPreviewMatrix('gale-lab', ROWS, COORDS)))
  const readRef = useRef(read)
  readRef.current = read
  const tracker = useMemo(() => new CellSaveTracker(), [])
  const apiRef = useRef<GridApi<MatrixRowRead> | null>(null)
  const [writes, setWrites] = useState<WriteLogEntry[]>([])
  const [picks, setPicks] = useState<Array<{ rowId: string; method: FulfilmentMethod }>>([])
  const [jumps, setJumps] = useState<string[]>([])

  /* The grid's rows are a CLONE per read — see the file header. */
  const rowData = useMemo(() => clone(read.rows), [read])

  const coverage = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const row of read.rows) for (const c of read.coordinates) for (const kind of MATRIX_CELL_KINDS) {
      const s = matrixCellState(kind, row.cells[c.key] ?? null)
      counts[s] = (counts[s] ?? 0) + 1
    }
    return counts
  }, [read])
  const missing = MATRIX_CELL_STATES.filter((s) => !(coverage[s] > 0))
  /* A queue row whose `state` is not one of the seven — the discriminator folds it into `absent`; the lab NAMES it. */
  const unknownQueue = useMemo(() => {
    const out: string[] = []
    for (const row of read.rows) for (const c of read.coordinates) {
      const q = row.cells[c.key]?.queue
      if (q && !['sent', 'queued', 'sending', 'failed', 'dead', 'paused', 'never'].includes(q.state)) out.push(`${row.id}:${c.key}=${String(q.state)}`)
    }
    return out
  }, [read])

  useEffect(() => {
    /* MX.F: a probe handle is DEV-ONLY — `scripts/check-global-exposure.mjs` ratchets unguarded window globals at 0. */
    if (process.env.NODE_ENV !== 'production') {
      ;(window as unknown as LabWindow).__matrixLab = { coverage, missing, unknownQueue, writes, picks, jumps }
    }
  }, [coverage, missing, unknownQueue, writes, picks, jumps])

  const onPickFulfilment = useCallback((method: FulfilmentMethod, p: ICellRendererParams) => {
    const rowId = (p.data as MatrixRowRead | undefined)?.id ?? p.node?.id ?? '?'
    setPicks((x) => [...x, { rowId, method }])
  }, [])
  const onJump = useCallback((p: ICellRendererParams) => {
    setJumps((x) => [...x, (p.data as MatrixRowRead | undefined)?.id ?? '?'])
  }, [])
  const rowIdOf = useCallback((r: MatrixRowRead) => r.id, [])
  const now = useCallback(() => LAB_NOW, [])

  const columnDefs = useMemo<(ColDef<MatrixRowRead> | ColGroupDef<MatrixRowRead>)[]>(() => {
    const identity: ColDef<MatrixRowRead> = {
      colId: 'sku', headerName: 'SKU', field: 'sku', pinned: 'left', width: 200, editable: false, suppressFillHandle: true, suppressMovable: true,
      cellClass: (p) => (p.data?.role === 'parent' ? 'nds-ag-cell nds-cell-strong' : 'nds-ag-cell'),
    }
    const groups = read.coordinates.map<ColGroupDef<MatrixRowRead>>((c) => {
      const cells = (d: MatrixRowRead | undefined) => d?.cells[c.key] ?? null
      const children: ColDef<MatrixRowRead>[] = c.connected && c.cells.length
        ? c.cells.map((kind) => matrixColumnDef<MatrixRowRead>(kind, { colId: `${c.key}.${kind}`, coordinate: c, cells, tracker, rowIdOf, onJump, onPickFulfilment, now }))
        : [{ colId: `${c.key}.notListed`, headerName: MATRIX_CELL_COPY.notListed, width: 120, editable: false, suppressFillHandle: true, suppressMovable: true, valueGetter: () => MATRIX_CELL_COPY.notListed, cellClass: 'nds-ag-cell nds-cell-muted' }]
      return { groupId: `grp-${c.key}`, headerName: c.label, headerClass: 'nds-ag-group-start', children }
    })
    return [identity, ...groups]
  }, [read.coordinates, tracker, rowIdOf, onJump, onPickFulfilment, now])

  const onGridReady = useCallback((e: GridReadyEvent<MatrixRowRead>) => { apiRef.current = e.api }, [])
  const getRowId = useCallback((p: { data: MatrixRowRead }) => p.data.id, [])

  const onCellValueChanged = useCallback((e: CellValueChangedEvent<MatrixRowRead>) => {
    const colId = e.colDef.colId ?? ''
    const kind = kindOf(colId)
    const rowId = e.data.id
    const gate = writeGate({ colId, source: e.source, oldValue: e.oldValue, newValue: e.newValue })
    const log = (entry: Omit<WriteLogEntry, 'at'>) => setWrites((x) => [...x, { at: Date.now(), ...entry }])
    if (!gate.write || !kind) { log({ colId, rowId, source: e.source, decision: { send: false, reason: 'gate' } }); return }
    const key = coordOf(colId)
    const decision = matrixWrite({ kind, coordinateKey: key, rowId }, e.data.cells[key] ?? null, e.oldValue, e.newValue)
    if (!decision.send) { log({ colId, rowId, source: e.source, decision }); return }
    tracker.set(rowId, colId, 'saving')
    const repaint = () => { const api = apiRef.current; const node = api?.getRowNode(rowId); if (api && node) api.refreshCells({ rowNodes: [node], columns: [colId], force: true }) }
    repaint()
    /* The store, on the PRISTINE read. Synchronous today; a `setTimeout` keeps the saving mark visible for a frame. */
    setTimeout(() => {
      const { read: next, result } = applyCells(readRef.current, [decision.cell])
      const outcome = result.results[0]
      tracker.set(rowId, colId, outcome?.outcome === 'applied' || outcome?.outcome === 'noop' ? 'saved' : 'refused', outcome?.reason)
      log({ colId, rowId, source: e.source, decision, outcome })
      setRead(next)
      setTimeout(() => { tracker.clear(rowId, colId); repaint() }, SAVED_FADE_MS)
    }, 120)
  }, [tracker])

  return (
    <section data-gds-scenario="matrix" style={{ display: 'grid', gap: 12 }}>
      <header style={{ display: 'grid', gap: 4 }}>
        <h2 className="nds-type-lg font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>Matrix cells — every §3.4 state on six rows</h2>
        <p className="nds-type-sm" style={{ margin: 0, maxWidth: 1000, color: 'var(--nds-text-2)' }}>
          One group per coordinate in contract order: the Amazon EU inventory group ONCE (Fulfilment · Mode · Qty · Buffer · Sync), the
          EU markets with Listing · Price · Sale only, Amazon UK as a full GBP group, eBay IT twice (① and the preview alias ②), Shopify,
          and Etsy as one <i>Not listed</i> column. Edit a Qty on a Follow row and the store pins it (✎, version +1). Drag the fill
          handle over Buffer and it writes; over Fulfilment the handle is not there. Choosing a Fulfilment opens nothing here — the pick
          is recorded below, because the dialog is the page&rsquo;s.
        </p>
      </header>
      <GridSheet height={36 * 6 + 30 + 28 + 2 + 20} density="compact">
        <NexusGrid<MatrixRowRead>
          {...SHEET_GRID_OPTIONS}
          fill
          rows="text"
          rowData={rowData}
          getRowId={getRowId}
          columnDefs={columnDefs}
          onGridReady={onGridReady}
          onCellValueChanged={onCellValueChanged}
          tooltipShowDelay={300}
          rowHeight={36}
        />
      </GridSheet>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span className="nds-type-sm" style={{ color: 'var(--nds-text-2)' }}>Coverage ({MATRIX_CELL_STATES.length - missing.length} of {MATRIX_CELL_STATES.length} states on screen):</span>
        {MATRIX_CELL_STATES.map((s) => (
          <Pill key={s} tone={coverage[s] > 0 ? 'success' : 'danger'} size="sm" data-matrix-state={s} data-count={coverage[s] ?? 0}>
            {s} · {coverage[s] ?? 0}
          </Pill>
        ))}
      </div>
      <div className="nds-type-sm" style={{ color: 'var(--nds-text-2)', display: 'grid', gap: 4 }}>
        <span><b>Writes</b> ({writes.length}) — every decision, sent or not:</span>
        <ul className="nds-type-xs" data-matrix-writes style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2, fontFamily: 'var(--nds-font-mono)' }}>
          {writes.slice(-12).map((w, i) => (
            <li key={`${w.at}-${i}`}>
              {w.rowId} · {w.colId} · source={w.source ?? '—'} → {w.decision.send ? `SENT ${JSON.stringify(w.decision.cell.value)} v${w.decision.cell.expectedVersion} → ${w.outcome?.outcome ?? '?'}${w.outcome?.reason ? ` (${w.outcome.reason})` : ''} v${w.outcome?.version ?? '?'}` : `NOT SENT — ${w.decision.reason}`}
            </li>
          ))}
        </ul>
        <span><b>Fulfilment picks</b> ({picks.length}): {picks.map((p) => `${p.rowId} → ${p.method}`).join(' · ') || 'none yet'} · <b>Sync jumps</b> ({jumps.length}): {jumps.join(' · ') || 'none yet'}</span>
      </div>
    </section>
  )
}

/** Every member of `MatrixCellState`, in `matrixCells.ts` declaration order — the legend's set. */
const MATRIX_CELL_STATES: readonly MatrixCellState[] = [
  'absent',
  'listed', 'draft', 'excluded', 'not-set-up', 'needs-value', 'suppressed', 'closed', 'error', 'ended',
  'fulfilment-set', 'fulfilment-derived', 'fulfilment-guard-differs', 'fulfilment-reported-differs',
  'follow', 'pinned', 'paused-policy', 'paused-listing', 'amazon-managed', 'uncounted', 'offer-closed', 'oversold',
  'queue-sent', 'queue-queued', 'queue-sending', 'queue-failed', 'queue-dead', 'queue-paused', 'queue-never',
  'price-master', 'price-override', 'price-formula', 'price-clamped',
  'sale-set', 'sale-none',
]
