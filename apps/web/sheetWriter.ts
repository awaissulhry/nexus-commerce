/**
 * GDS / PES.2 — `SheetWriter`: the ONE write path a sheet has.
 *
 * `saveCell` (roundTrip.ts) saves one cell and paints its answer. That is the right shape for a
 * grid where an operator edits one bid at a time, and the wrong shape for a SHEET, where three
 * things happen that a per-cell call cannot survive:
 *
 *   1. 🔴 **A row has a VERSION, and it moves.** `PATCH /api/products/bulk` CAS-bumps
 *      `Product.version` and answers `currentVersion`. A caller that keeps sending the version it
 *      first read has its SECOND edit to that row refused — 409 VERSION_CONFLICT, "someone else
 *      changed this row", where the someone else was itself. Measured as a live defect in
 *      `products/_sheet/MasterSheet.tsx`: nothing there ever advanced `row.version`.
 *   2. **A fill or a paste is not one cell.** Dragging a value down 20 rows fires 20
 *      `cellValueChanged` events; pasting 20 × 5 from Excel fires 100. Unbatched that is 100
 *      requests against an endpoint rate-limited at 300/min — and, per (1), four of every five
 *      cells in a row are refused because the first one moved the version.
 *   3. **A row must not race itself.** Two batches for the same row in flight at once is the same
 *      conflict by another route, so a row's writes are SERIALISED here.
 *
 * So: cells are queued, coalesced per row inside a short window, and sent as ONE request per row
 * carrying that row's current version. The result advances the version, and every cell in the batch
 * is painted with its own outcome through the same `CellSaveTracker` the rest of the DS reads.
 *
 * It knows no endpoint. The app supplies `commit` — the same reason `useGridViews` asks for a
 * `baseUrl` rather than importing one: the design system must not reach into an app.
 *
 * Pure: no React, no AG import at runtime (types only), tested beside this file.
 */
import type { GridApi } from '@/design-system/grid'

import { CellSaveTracker, SAVED_FADE_MS } from './roundTrip'

/** One queued cell edit. */
export interface SheetWriteCell {
  colId: string
  value: unknown
}

/** What the app is asked to send: every cell of ONE row, with that row's version. */
export interface SheetWriteRequest<T> {
  rowId: string
  /** The row object the grid holds, so the app can read `storage`, locale, product type… */
  row: T | null
  cells: SheetWriteCell[]
  /**
   * The row's version as this writer believes it. `undefined` means the writer was never seeded
   * for this row — send the write WITHOUT an optimistic-concurrency guard rather than guessing a
   * number, and say so in the result.
   */
  expectedVersion?: number
}

/** What the app answers. A refusal is a RESULT, never an exception. */
export interface SheetWriteResult {
  ok: boolean
  /** Why the whole batch was refused. Ignored when `cells` names each one. */
  reason?: string
  /**
   * The row's version AFTER the write. Supply it on success (the endpoint's `currentVersion`) AND
   * on a 409 (the server's `currentVersion`), so a conflict leaves the writer able to retry
   * instead of stuck one version behind for the rest of the session.
   */
  version?: number
  /** Per-cell outcomes, when the server answers per field. Absent ⇒ `ok` applies to every cell. */
  cells?: Record<string, { ok: boolean; reason?: string }>
  /** True when the server's answer means the grid's copy of this row is stale. */
  conflict?: boolean
}

export interface SheetWriterOptions<T> {
  tracker: CellSaveTracker
  /** Send one row's batch. Never throws for a refusal. */
  commit: (req: SheetWriteRequest<T>) => Promise<SheetWriteResult>
  /** The live grid, for repainting cells. May return null before the grid is ready. */
  getApi: () => GridApi<T> | null
  /**
   * How long to gather cells before sending a row's batch. A fill or a paste emits its cells in
   * one synchronous burst, so anything above a frame catches the whole thing; 40ms also absorbs a
   * fast typist tabbing across a row without making a single edit feel deferred.
   */
  flushMs?: number
  /** The row moved under us — the page should refetch. Called once per conflicting row. */
  onConflict?: (rowId: string, serverVersion: number | undefined) => void
  /** Fired after every settled batch, for the status strip and the "saved at" clock. */
  onSettled?: (info: { rowId: string; ok: boolean; savedAt: string }) => void
}

interface RowQueue {
  /** colId → value. A second edit to the same cell inside the window replaces the first. */
  cells: Map<string, unknown>
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
}

export const DEFAULT_SHEET_FLUSH_MS = 40

export class SheetWriter<T> {
  private readonly opts: Required<Pick<SheetWriterOptions<T>, 'tracker' | 'commit' | 'getApi'>> & SheetWriterOptions<T>
  private readonly flushMs: number
  private readonly versions = new Map<string, number>()
  private readonly rows = new Map<string, T | null>()
  private readonly queues = new Map<string, RowQueue>()
  private listeners = new Set<() => void>()
  private destroyed = false

  constructor(options: SheetWriterOptions<T>) {
    this.opts = options as SheetWriter<T>['opts']
    this.flushMs = options.flushMs ?? DEFAULT_SHEET_FLUSH_MS
  }

  /**
   * Record what the server last told us about these rows. Called after every page load and after
   * every refetch. An UNKNOWN row is left unknown on purpose: seeding a guess would arm the
   * optimistic-concurrency guard with a number nobody read.
   */
  seed(rows: ReadonlyArray<{ id: string; version?: number; row?: T }>): void {
    for (const r of rows) {
      // A row with a write in flight owns its version; a refetch that landed mid-save must not
      // wind it back to the value the server had before that save.
      if (typeof r.version === 'number' && !this.queues.get(r.id)?.inFlight) this.versions.set(r.id, r.version)
      if (r.row !== undefined) this.rows.set(r.id, r.row)
    }
  }

  /** What this writer believes a row's version to be — the number the next write will send. */
  versionOf(rowId: string): number | undefined {
    return this.versions.get(rowId)
  }

  /**
   * Queue one cell. Paints it `saving` immediately, so a burst of 100 pasted cells reads as work in
   * progress from the first frame rather than after the first response.
   */
  set(rowId: string, colId: string, value: unknown, row?: T): void {
    if (this.destroyed) return
    if (row !== undefined) this.rows.set(rowId, row)
    const q = this.queues.get(rowId) ?? { cells: new Map<string, unknown>(), timer: null, inFlight: false }
    q.cells.set(colId, value)
    this.queues.set(rowId, q)
    this.opts.tracker.set(rowId, colId, 'saving')
    this.repaint(rowId, [colId])
    this.emit()
    this.schedule(rowId)
  }

  private schedule(rowId: string): void {
    const q = this.queues.get(rowId)
    if (!q || q.inFlight) return // the flight's completion re-schedules whatever arrived meanwhile
    if (q.timer) clearTimeout(q.timer)
    q.timer = setTimeout(() => {
      q.timer = null
      void this.flushRow(rowId)
    }, this.flushMs)
  }

  /** Send every queued cell now, and resolve when the sheet is quiet. Used by tests and by Publish. */
  async flush(): Promise<void> {
    for (const [rowId, q] of this.queues) {
      if (q.timer) {
        clearTimeout(q.timer)
        q.timer = null
      }
      if (!q.inFlight) void this.flushRow(rowId)
    }
    // Settle: a batch's completion can enqueue the next one for the same row.
    while ([...this.queues.values()].some((q) => q.inFlight || q.cells.size > 0)) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  private async flushRow(rowId: string): Promise<void> {
    const q = this.queues.get(rowId)
    if (!q || q.inFlight || q.cells.size === 0 || this.destroyed) return

    const batch = [...q.cells.entries()].map(([colId, value]) => ({ colId, value }))
    q.cells.clear()
    q.inFlight = true
    this.emit()

    let result: SheetWriteResult
    try {
      result = await this.opts.commit({
        rowId,
        row: this.rows.get(rowId) ?? null,
        cells: batch,
        expectedVersion: this.versions.get(rowId),
      })
    } catch (err) {
      // `commit` is documented not to throw; if it does anyway, that is a refusal with a reason,
      // never a silent success and never an unhandled rejection over a sheet full of cells.
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }

    if (typeof result.version === 'number') this.versions.set(rowId, result.version)
    if (result.conflict) this.opts.onConflict?.(rowId, result.version)

    const settledCols: string[] = []
    for (const { colId } of batch) {
      const own = result.cells?.[colId]
      const ok = own ? own.ok : result.ok
      const reason = own?.reason ?? (ok ? undefined : result.reason)
      this.opts.tracker.set(rowId, colId, ok ? 'saved' : 'refused', reason)
      settledCols.push(colId)
    }
    q.inFlight = false
    this.repaint(rowId, settledCols)
    this.emit()
    this.opts.onSettled?.({ rowId, ok: result.ok, savedAt: new Date().toISOString() })

    // A `saved` mark fades; a `refused` one stays until the operator edits the cell again.
    const fading = settledCols.filter((c) => this.opts.tracker.get(rowId, c)?.state === 'saved')
    if (fading.length) {
      setTimeout(() => {
        const cleared = fading.filter((c) => this.opts.tracker.get(rowId, c)?.state === 'saved')
        for (const c of cleared) this.opts.tracker.clear(rowId, c)
        if (cleared.length) {
          this.repaint(rowId, cleared)
          this.emit()
        }
      }, SAVED_FADE_MS)
    }

    if (q.cells.size > 0) this.schedule(rowId) // cells that arrived while this batch was in flight
    else if (!q.timer) this.queues.delete(rowId)
  }

  /**
   * Repaint exactly the cells that changed state.
   *
   * Deliberately NOT a whole-grid refresh: a paste settles 20 batches, and refreshing every row 20
   * times is what turns a working sheet into a stuttering one.
   */
  private repaint(rowId: string, columns: string[]): void {
    const api = this.opts.getApi()
    if (!api || api.isDestroyed()) return
    const node = api.getRowNode(rowId)
    if (node) api.refreshCells({ rowNodes: [node], columns, force: true })
  }

  /** Cells queued or in flight — what the status strip calls "unsaved". */
  get pending(): number {
    let n = 0
    for (const q of this.queues.values()) n += q.cells.size + (q.inFlight ? 1 : 0)
    return n
  }

  get busy(): boolean {
    for (const q of this.queues.values()) if (q.inFlight) return true
    return false
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  destroy(): void {
    this.destroyed = true
    for (const q of this.queues.values()) if (q.timer) clearTimeout(q.timer)
    this.queues.clear()
    this.listeners.clear()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}
