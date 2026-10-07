'use client'

/**
 * MX.P — the Matrix's STATE: one `MatrixRead`, and the ONE door every write and every verb goes through.
 *
 * `MatrixRead.source` is the discriminator for everything below, decided ONCE by `source.ts` on the
 * probe's own status and never re-inferred here:
 *
 *   preview   `store.ts` is the server. `applyCells` / `applyVerb` / `revertOperation` run in memory
 *             with the same versions, CAS and restore-by-value the service will have, and NOTHING
 *             leaves the browser — the Network panel is the proof (0 PATCH/POST to `/studio/matrix`).
 *   live      `PATCH …/studio/matrix` and `POST …/studio/matrix/verbs`; the server's verdict is
 *             refetched after every applied write, because the page derives no number of its own.
 *
 * Per-cell outcomes reach the SAME `CellSaveTracker` the sheet already uses (`useMasterSheet`'s),
 * keyed by `<coordinateKey>.<kind>`, so a Matrix cell wears exactly the round-trip marks an
 * Information cell wears — `saving` → `saved` (fades) | `refused` (stays, reason on hover). A
 * `conflict` repaints from the current read and refetches in live mode, like every sheet cell.
 *
 * Live (Amazon sheet gaps): `useListingValuesLive` re-reads when this family's listings change elsewhere — at once
 * when idle, otherwise owed until the write in flight settles or the open editor closes. An applied write tells the
 * other windows of this browser (`listing.values_changed`, local), so they move even without the server's stream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { SAVED_FADE_MS, type CellSaveTracker, type GridApi } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

import { useListingValuesLive } from '../useListingValuesLive'
import {
  MATRIX_COPY,
  MATRIX_ENDPOINTS,
  type CoordinateKey,
  type MatrixCells,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixVerbRequest,
  type MatrixWritableKind,
  type MatrixWriteCell,
  type MatrixWriteOutcome,
  type VerbOperation,
  type VerbPreview,
} from './contract'
import { buildPreviewMatrix } from './fixtures'
import { previewVerb } from './preview'
import { fetchMatrix, patchMatrix, previewCoordinateInputs, previewRowInputs, type CoordinateSourceOptions, type MatrixSource } from './source'
import { applyCells, applyVerb, revertOperation } from './store'
import { afterLiveWrite } from './refusals'

export const matrixColId = (key: CoordinateKey, kind: string): string => `${key}.${kind}`

export interface UseMatrixOptions {
  productId: string
  accountId: string | null
  locale: string | null
  /** The sheet's rows — the preview's row inputs. `null` until the sheet has answered. */
  rows: ReadonlyArray<{ id: string; sku: string; isParent: boolean; basePrice: number | null; status: string }> | null
  coordinates: CoordinateSourceOptions
  /** The sheet's tracker — ONE set of round-trip marks for the page. */
  tracker: CellSaveTracker
  getApi: () => GridApi<{ id: string }> | null
  can: (permission: string) => boolean
  /** Every settled write, refusals included — the caller gates its clock on `ok` (#705). */
  onSettled?: (info: { ok: boolean; savedAt: string }) => void
  /** A cell the server refused, with its reason — the page says it the way it says its own refusals. */
  onRefused?: (reason: string) => void
}

export interface MatrixState {
  read: MatrixRead | null
  /** `loading` until the probe AND (in preview) the sheet rows have answered. */
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** What the probe saw — `The Matrix service answered HTTP 404` — for the ledger and the footer. */
  probeNote: string | null
  reload: () => void
  /** Read again QUIETLY (the live re-read): the grid keeps its read; it waits for an open editor or a write in flight. */
  refresh: () => void
  /** The one door. Per-cell outcomes are painted through the tracker; the read is replaced. */
  write: (cells: readonly MatrixWriteCell[]) => Promise<MatrixWriteOutcome[]>
  previewVerbRun: (req: MatrixVerbRequest) => Promise<VerbPreview>
  applyVerbRun: (preview: VerbPreview) => Promise<VerbOperation>
  revert: (op: VerbOperation) => Promise<void>
  /** `MATRIX_COPY.pinnedThisSession(n)` — pins made from the grid this session, and a one-step undo. */
  pinnedThisSession: number
  undoLastPin: (() => void) | null
  /** A row's cells on a coordinate, read at PAINT time. */
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  rowOf: (rowId: string) => MatrixRowRead | null
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** The `listing.values_changed` fields a cell write moves — the words the server's write services announce with. */
const FIELDS_OF: Readonly<Record<MatrixWritableKind, readonly string[]>> = {
  syncMode: ['quantityMode', 'quantity'], syncQty: ['quantityMode', 'quantity'], syncBuffer: ['stockBuffer', 'quantity'],
  fulfilment: ['fulfilment'], price: ['price'], salePrice: ['salePrice'],
}

/** Each cell names the listing it was read from (the PRISTINE read), so a write onto another listing is a conflict. */
const withListing = (c: MatrixWriteCell, read: MatrixRead): MatrixWriteCell => {
  if (c.expectedListingId) return c
  const listingId = read.rows.find((r) => r.id === c.rowId)?.cells[c.coordinateKey]?.listingId
  return listingId ? { ...c, expectedListingId: listingId } : c
}

type ChangedListing = { listingId: string; productId: string; version: number }

/** The listings an applied write moved, at their new versions: the server's list, else the cell's own listing. */
function changedListings(outcomes: readonly MatrixWriteOutcome[], read: MatrixRead): ChangedListing[] {
  const out = new Map<string, ChangedListing>()
  for (const o of outcomes) {
    if (o.outcome !== 'applied') continue
    if (o.listings?.length) { for (const l of o.listings) out.set(l.listingId, { listingId: l.listingId, productId: l.productId, version: l.version }); continue }
    const listingId = read.rows.find((r) => r.id === o.rowId)?.cells[o.coordinateKey]?.listingId
    if (listingId) out.set(listingId, { listingId, productId: o.rowId, version: o.version })
  }
  return [...out.values()]
}

export function useMatrix(opts: UseMatrixOptions): MatrixState {
  const { productId, accountId, locale, rows, coordinates, tracker, getApi, can } = opts
  const [probe, setProbe] = useState<MatrixSource | null>(null)
  const [read, setRead] = useState<MatrixRead | null>(null)
  const [nonce, setNonce] = useState(0)
  const readRef = useRef<MatrixRead | null>(null)
  const byRow = useRef(new Map<string, MatrixRowRead>())
  const optsRef = useRef(opts)
  optsRef.current = opts
  const [pins, setPins] = useState<Array<{ rowId: string; coordinateKey: CoordinateKey; before: MatrixCells }>>([])
  /* The live rule's view of what this page holds — refilled IN PLACE by `commitRead`, so an event dispatched in the
     same tick as a commit (this tab's own echo) already sees the new versions. */
  const liveMembers = useRef(new Set<string>())
  const liveVersions = useRef(new Map<string, number>())

  /* The read, its ref and its row index move TOGETHER, synchronously: a repaint issued in the same
     tick as a store write must already see the new cells, and React state alone lands a frame late. */
  const commitRead = useCallback((next: MatrixRead | null) => {
    readRef.current = next
    liveMembers.current.clear()
    liveVersions.current.clear()
    if (next?.source === 'live') {
      for (const r of next.rows) {
        liveMembers.current.add(r.id)
        for (const c of Object.values(r.cells)) if (c.listingId) liveVersions.current.set(c.listingId, Math.max(liveVersions.current.get(c.listingId) ?? -1, c.version))
      }
    }
    /* 🔴 The grid reads CLONES. The engine's `valueSetter` MUTATES the `MatrixCells` object the
       column's reader returns (AG discards a value whose getter did not move), and `applyCells`
       must compare the write against the PRISTINE read — on the same object a Buffer/Mode/Sale write
       compares equal to itself and answers `noop` (MX.G, departure 7; the grid lab isolates the
       same way). Every commit rebuilds the clones, so the grid never paints a stale draft. */
    const m = new Map<string, MatrixRowRead>()
    for (const r of clone(next?.rows ?? [])) m.set(r.id, r)
    byRow.current = m
    setRead(next)
  }, [])

  useEffect(() => {
    /* The rows AG holds are the sheet's; the cells live here. A new read must repaint every cell,
       because nothing in `rowData` changed identity. */
    const api = getApi()
    if (api && !api.isDestroyed()) api.refreshCells({ force: true })
  }, [read, getApi])

  /* ── the probe ──────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const ctrl = new AbortController()
    setProbe(null)
    fetchMatrix(productId, { accountId, locale, signal: ctrl.signal }).then((r) => { if (!ctrl.signal.aborted) setProbe(r) })
    return () => ctrl.abort()
  }, [productId, accountId, locale, nonce])

  /* ── preview: the fixtures on the REAL rows, built once per row set ─────────────────────── */

  const rowSignature = useMemo(() => (rows ? rows.map((r) => r.id).join('|') : null), [rows])
  const coordSignature = useMemo(
    () => coordinates.marketplaces.map((m) => `${m.channel}:${m.code}:${m.connected !== false}`).join('|') + '//' + coordinates.channels.map((c) => c.id).join('|'),
    [coordinates],
  )
  const builtFor = useRef<string | null>(null)
  useEffect(() => {
    if (!probe) { builtFor.current = null; commitRead(null); return }
    if (probe.kind === 'live') { builtFor.current = null; commitRead(probe.read); return }
    if (probe.kind === 'error') { builtFor.current = null; commitRead(null); return }
    if (!rows || rowSignature === null) return
    const sig = `${rowSignature}//${coordSignature}`
    /* A sheet re-read with the same rows keeps the in-memory edits: rebuilding the fixtures would
       silently discard every write the operator made in this session. */
    if (builtFor.current === sig && readRef.current?.source === 'preview') return
    builtFor.current = sig
    commitRead(buildPreviewMatrix(productId, previewRowInputs(rows), previewCoordinateInputs(coordinates)))
    setPins([])
  }, [probe, rows, rowSignature, coordSignature, coordinates, productId, commitRead])

  /* Reload RE-PROBES (so the page flips to `live` the moment the Matrix service answers 200) and
     keeps the in-memory read while the probe still says preview: a reload that rebuilt the fixtures
     would discard every edit the operator made this session without a word. */
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  /* ── live: this family's listings changed elsewhere ─────────────────────────────────────── */

  /* `seq` counts live requests; `owedSeq` is the newest one still owed (0 = none). A write whose own re-read started
     after every owed request already shows them, so it pays the debt; anything later is fetched once it settles. */
  const live = useMemo(() => {
    const l = { writes: 0, writeEpoch: 0, seq: 0, owedSeq: 0, fetching: false, again: false, alive: true }
    let watching: { api: GridApi<{ id: string }>; onStop: () => void } | null = null
    const openEditor = (): GridApi<{ id: string }> | null => {
      const api = optsRef.current.getApi()
      return api && !api.isDestroyed() && api.getEditingCells().length > 0 ? api : null
    }
    const idle = () => l.writes === 0 && !openEditor()
    const unwatch = () => {
      if (watching && !watching.api.isDestroyed()) watching.api.removeEventListener('cellEditingStopped', watching.onStop)
      watching = null
    }
    /* An open editor is never repainted under the person: the re-read waits for it to close (and, when the close
       commits a value, for that write to settle). */
    const owe = () => {
      l.owedSeq = l.seq
      const api = openEditor()
      if (!api || watching?.api === api) return
      unwatch()
      const onStop = () => { unwatch(); setTimeout(flush, 0) }
      api.addEventListener('cellEditingStopped', onStop)
      watching = { api, onStop }
    }
    const run = async (): Promise<void> => {
      if (l.fetching) { l.again = true; return }
      l.fetching = true
      const { productId: pid, accountId: acc, locale: loc } = optsRef.current
      const epoch = l.writeEpoch
      const got = await fetchMatrix(pid, { accountId: acc, locale: loc })
      l.fetching = false
      const o = optsRef.current
      const stale = !l.alive || o.productId !== pid || o.accountId !== acc || o.locale !== loc || readRef.current?.source !== 'live'
      /* A transport failure keeps what the page holds; the next event or Reload reads again. */
      if (!stale && got.kind === 'live') {
        if (l.writeEpoch !== epoch || !idle()) owe()
        else commitRead(got.read)
      }
      const more = l.again && !stale
      l.again = false
      if (more) void run()
    }
    function flush() {
      if (!l.alive || l.owedSeq === 0 || !idle()) return
      l.owedSeq = 0
      void run()
    }
    return {
      state: l,
      request: () => { l.seq += 1; if (idle()) void run(); else owe() },
      /** A live write (a cell, a verb, a revert) starts: no live re-read lands while one is in flight. */
      begin: () => { l.writes += 1; l.writeEpoch += 1 },
      /** It settled; `coveredSeq` = `seq` when its own re-read started, `null` when it did not re-read. */
      end: (coveredSeq: number | null) => {
        l.writes -= 1
        if (l.owedSeq !== 0 && coveredSeq !== null && l.owedSeq <= coveredSeq) l.owedSeq = 0
        flush()
      },
      dispose: () => { l.alive = false; unwatch() },
    }
  }, [commitRead])
  useEffect(() => { live.state.alive = true; return live.dispose }, [live])

  const liveFamily = read?.source === 'live' ? read.productId : null
  useListingValuesLive({
    familyId: liveFamily,
    memberIds: liveMembers.current,
    knownVersions: liveVersions.current,
    enabled: liveFamily !== null,
    onStock: live.request,
    onFull: live.request,
  })

  /* ── the marks ──────────────────────────────────────────────────────────────────────────── */

  const repaint = useCallback((rowId: string, colId: string) => {
    const api = getApi()
    if (!api || api.isDestroyed()) return
    const node = api.getRowNode(rowId)
    if (node) api.refreshCells({ rowNodes: [node], columns: [colId], force: true })
  }, [getApi])

  const mark = useCallback((outcomes: readonly MatrixWriteOutcome[]) => {
    const savedAt = new Date().toISOString()
    let anyOk = false
    for (const o of outcomes) {
      const colId = matrixColId(o.coordinateKey, o.cell)
      if (o.outcome === 'applied' || o.outcome === 'noop') {
        anyOk = anyOk || o.outcome === 'applied'
        tracker.set(o.rowId, colId, 'saved')
        setTimeout(() => { if (tracker.get(o.rowId, colId)?.state === 'saved') { tracker.clear(o.rowId, colId); repaint(o.rowId, colId) } }, SAVED_FADE_MS)
      } else {
        /* A conflict is never retried: the cell says so (its hover leads with the reason, then the fresh read). */
        const reason = o.reason ?? (o.outcome === 'conflict' ? MATRIX_COPY.changedElsewhere : 'Refused')
        tracker.set(o.rowId, colId, 'refused', reason)
        if (o.outcome === 'refused') optsRef.current.onRefused?.(reason)
      }
      repaint(o.rowId, colId)
    }
    optsRef.current.onSettled?.({ ok: anyOk || outcomes.every((o) => o.outcome === 'noop'), savedAt })
  }, [tracker, repaint])

  /* ── the one door ───────────────────────────────────────────────────────────────────────── */

  const write = useCallback(async (cells: readonly MatrixWriteCell[]): Promise<MatrixWriteOutcome[]> => {
    const current = readRef.current
    if (!current || cells.length === 0) return []
    for (const c of cells) { tracker.set(c.rowId, matrixColId(c.coordinateKey, c.cell), 'saving'); repaint(c.rowId, matrixColId(c.coordinateKey, c.cell)) }
    if (current.source === 'preview') {
      /* Pins are remembered BEFORE the store moves, so the footer's Undo can restore by value. */
      const pinned: Array<{ rowId: string; coordinateKey: CoordinateKey; before: MatrixCells }> = []
      for (const c of cells) {
        if (c.cell !== 'syncQty' && !(c.cell === 'syncMode' && c.value === 'PINNED')) continue
        const before = current.rows.find((r) => r.id === c.rowId)?.cells[c.coordinateKey]
        if (before && before.sync && before.sync.mode === 'FOLLOW') pinned.push({ rowId: c.rowId, coordinateKey: c.coordinateKey, before: clone(before) })
      }
      const { read: next, result } = applyCells(current, cells)
      commitRead(next)
      const applied = new Set(result.results.filter((r) => r.outcome === 'applied').map((r) => `${r.rowId}|${r.coordinateKey}`))
      const kept = pinned.filter((p) => applied.has(`${p.rowId}|${p.coordinateKey}`))
      if (kept.length) setPins((p) => [...p, ...kept])
      mark(result.results)
      return result.results
    }
    live.begin()
    let covered: number | null = null
    try {
      const result = await patchMatrix(productId, cells.map((c) => withListing(c, current)), { accountId })
      const after = afterLiveWrite(result.results)
      if (after === 'reread') {
        const seqAtReread = live.state.seq
        const again = await fetchMatrix(productId, { accountId, locale })
        if (again.kind === 'live') { commitRead(again.read); covered = seqAtReread }
      } else if (after === 'restore' && readRef.current) {
        /* A refusal wrote nothing, but the grid EDITED its clone of the cells (the engine's valueSetter): the typed
           number would stay on screen, and the cell's own hover would describe it as saved. Re-commit the stored read
           — a new object, so every cell repaints from fresh clones of what the server holds. */
        commitRead({ ...readRef.current })
      }
      const changed = changedListings(result.results, current)
      for (const c of changed) liveVersions.current.set(c.listingId, Math.max(liveVersions.current.get(c.listingId) ?? -1, c.version))
      mark(result.results)
      if (changed.length) {
        /* The other windows of this browser move at once, server stream or not; this tab already holds these versions. */
        const fields = [...new Set(result.results.filter((o) => o.outcome === 'applied').flatMap((o) => FIELDS_OF[o.cell] ?? []))]
        emitInvalidation({ type: 'listing.values_changed', id: current.productId, fields, meta: { source: 'local', productId: current.productId, listings: changed, fields } })
      }
      return result.results
    } catch (e) {
      /* A transport failure is an UNKNOWN outcome, not a refusal: say so, and ask for a re-read. */
      const reason = e instanceof Error ? e.message : String(e)
      for (const c of cells) { const colId = matrixColId(c.coordinateKey, c.cell); tracker.set(c.rowId, colId, 'unknown', `Connection lost — refresh to see whether this saved. (${reason})`); repaint(c.rowId, colId) }
      optsRef.current.onSettled?.({ ok: false, savedAt: new Date().toISOString() })
      return cells.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell, outcome: 'refused' as const, reason, version: c.expectedVersion }))
    } finally {
      live.end(covered)
    }
  }, [productId, accountId, locale, tracker, repaint, mark, commitRead, live])

  /* ── verbs: preview → apply → revert ────────────────────────────────────────────────────── */

  const previewVerbRun = useCallback(async (req: MatrixVerbRequest): Promise<VerbPreview> => {
    const current = readRef.current
    if (!current) throw new Error('The Matrix has not loaded')
    if (current.source === 'preview') return previewVerb(current, { ...req, commit: false }, { can, simulated: true })
    const res = await fetch(`${getBackendUrl()}${MATRIX_ENDPOINTS.verbs(productId)}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...req, commit: false }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error((body as { message?: string } | null)?.message ?? `The verb preview was refused (HTTP ${res.status})`)
    return body as VerbPreview
  }, [productId, can])

  const applyVerbRun = useCallback(async (preview: VerbPreview): Promise<VerbOperation> => {
    const current = readRef.current
    if (!current) throw new Error('The Matrix has not loaded')
    if (current.source === 'preview') {
      const { read: next, operation, results } = applyVerb(current, preview)
      commitRead(next)
      mark(results)
      return operation
    }
    live.begin()
    let covered: number | null = null
    try {
      const res = await fetch(`${getBackendUrl()}${MATRIX_ENDPOINTS.verbs(productId)}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: { verb: preview.verb }, targets: preview.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error((body as { message?: string } | null)?.message ?? `The verb was refused (HTTP ${res.status})`)
      const seqAtReread = live.state.seq
      const again = await fetchMatrix(productId, { accountId, locale })
      if (again.kind === 'live') { commitRead(again.read); covered = seqAtReread }
      return (body as { operation: VerbOperation }).operation
    } finally {
      live.end(covered)
    }
  }, [productId, accountId, locale, mark, commitRead, live])

  const revert = useCallback(async (op: VerbOperation) => {
    const current = readRef.current
    if (!current) return
    if (current.source === 'preview') {
      const next = revertOperation(current, op)
      commitRead(next)
      return
    }
    live.begin()
    let covered: number | null = null
    try {
      const res = await fetch(`${getBackendUrl()}${MATRIX_ENDPOINTS.revert(productId, op.id)}`, { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error(`The revert was refused (HTTP ${res.status})`)
      const seqAtReread = live.state.seq
      const again = await fetchMatrix(productId, { accountId, locale })
      if (again.kind === 'live') { commitRead(again.read); covered = seqAtReread }
    } finally {
      live.end(covered)
    }
  }, [productId, accountId, locale, commitRead, live])

  /* ── the footer's one-step undo of the last pin, through the store ──────────────────────── */

  const undoLastPin = useMemo(() => {
    if (pins.length === 0) return null
    return () => {
      const current = readRef.current
      const last = pins[pins.length - 1]
      if (!current || !last) return
      const op: VerbOperation = { id: `undo-pin-${Date.now().toString(36)}`, verb: 'pin-quantity', appliedAt: new Date().toISOString(), applied: 1, refused: 0, before: [{ rowId: last.rowId, coordinateKey: last.coordinateKey, cells: last.before }] }
      const next = current.source === 'preview' ? revertOperation(current, op) : current
      commitRead(next)
      setPins((p) => p.slice(0, -1))
      for (const kind of ['syncMode', 'syncQty', 'syncBuffer'] as const) repaint(last.rowId, matrixColId(last.coordinateKey, kind))
    }
  }, [pins, repaint, commitRead])

  const cellsOf = useCallback((rowId: string, key: CoordinateKey): MatrixCells | null => byRow.current.get(rowId)?.cells[key] ?? null, [])
  const rowOf = useCallback((rowId: string): MatrixRowRead | null => byRow.current.get(rowId) ?? null, [])

  const status: MatrixState['status'] = probe?.kind === 'error' ? 'error' : read ? 'ready' : 'loading'
  return {
    read,
    status,
    error: probe?.kind === 'error' ? probe.message : null,
    probeNote: probe?.kind === 'preview' ? probe.reason : null,
    reload,
    refresh: live.request,
    write,
    previewVerbRun,
    applyVerbRun,
    revert,
    pinnedThisSession: pins.length,
    undoLastPin,
    cellsOf,
    rowOf,
  }
}
