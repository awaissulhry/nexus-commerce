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
 * ## ⚠ What the version guard actually protects against
 *
 * EDITOR versus EDITOR, and nothing else. `Product.version` advances only on the CAS path this
 * writer uses; **124 other write sites** — sync jobs, bulk operations, the pricing engine — never
 * bump it (confirmed by construction, 2026-09-01). So two operators editing the same row are safe
 * from each other, and a winning CAS can still overwrite a sync job's write with neither side
 * noticing. Do not read `expectedVersion` here as "this row cannot be clobbered".
 *
 * That is inherited, not introduced — the surface this replaced had the identical blind spot — and
 * closing it is an architecture decision about who bumps the version, not something a writer can
 * fix from the client. Stated here because a lane adopting this will otherwise reasonably assume
 * the guard is broader than it is.
 *
 * Pure: no React, no AG import at runtime (types only), tested beside this file.
 */
import type { GridApi } from 'ag-grid-community'

import { CellSaveTracker, SAVED_FADE_MS } from './roundTrip'

/**
 * What an edit MEANS, beyond the value.
 *
 * `set`   — write this value on this row. The ordinary case, and the default.
 * `pin`   — give this row its own value where it was inheriting one. On the master sheet that is
 *           the same wire operation as `set` (a child storing a value simply wins in the resolver),
 *           which is exactly why the intent must travel: the SHEET cannot tell the two apart, and
 *           the drawer that asked for it can.
 * `reset` — return the cell to the layer above. 🔴 This is NOT "write null" in general. On the
 *           master scope it happens to be — clearing a child's own value lets the parent show
 *           through — but on a channel scope it means clearing the explicit `*Override` and
 *           setting `followMaster*` back to true, which is a different ROUTE, not a different
 *           value. A writer that hardcoded null would silently blank channel listings.
 *
 * So the intent is carried to `commit` and the APP decides what it costs. That keeps the invariant
 * (ONE write path) without the design system having to know any endpoint.
 */
/**
 * How long a single row's commit may hang before the writer gives up on it.
 *
 * Generous on purpose: this is a backstop against a request that never settles, not a latency
 * budget. A slow-but-alive server should win the race; only a dead one should lose it.
 */
const COMMIT_TIMEOUT_MS = 30_000

export type SheetWriteIntent = 'set' | 'pin' | 'reset' | 'reset-list'

/** One queued cell edit. */
export interface SheetWriteCell {
  colId: string
  value: unknown
  /** Defaults to `set` when the caller says nothing. */
  intent: SheetWriteIntent
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
  /**
   * 🔴 The REQUEST never reached an answer — a dropped connection, not a server verdict.
   *
   * A `commit` that catches its own network error and returns `{ ok: false }` is indistinguishable
   * from a server saying no, and the writer would paint `refused` — telling the operator a change
   * failed when it may well have applied. Measured 2026-09-02 against a real API restart:
   * `net::ERR_CONNECTION_REFUSED`, and the cell painted `refused` because `commitMasterRow`
   * swallows the rejection at its own `catch`. The writer's `unknown` path was unreachable.
   *
   * A commit that cannot tell should set this; the writer then paints `unknown` and asks the host
   * to re-read.
   */
  unreachable?: boolean
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
  cells?: Record<string, { ok: boolean; reason?: string; unreachable?: boolean }>
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
   * A QUIET row read, for reconciling after an unreachable write.
   *
   * 🔴 It must NOT set a loading state or tear the grid down. The first version of this called the
   * host's full `reload()`, which begins `setLoading(true)` — so the grid dropped its rows and the
   * `unknown` mark went with them, one second after it appeared. Measured against a real API
   * restart: the operator's edit vanished, the sheet emptied, and a loading state sat there for the
   * whole cold boot. **The one thing they needed was the thing that got destroyed.**
   *
   * Returns the row's current cell values keyed by colId, or `null` if the read did not answer —
   * `null` means "still unreachable", never "the row is empty".
   */
  readRow?: (rowId: string) => Promise<Record<string, unknown> | null>
  /** Scoped read with fresh concurrency tokens and optional domain checks for reset/reference cells. */
  readBack?: (request: SheetWriteRequest<T>) => Promise<{ values: Record<string, unknown>; version?: number; row?: T; matches?: Record<string, boolean | null> } | null>
  onReconciled?: (info: { rowId: string; ok: boolean; savedAt: string }) => void
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
  /** colId → the pending edit. A second edit to the same cell inside the window replaces the first. */
  cells: Map<string, { value: unknown; intent: SheetWriteIntent }>
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
}

export const DEFAULT_SHEET_FLUSH_MS = 40

/**
 * Did the write land? Compares what the operator typed against what the row now holds.
 *
 * 🔴 NOT `===`. The server normalises: a numeric column typed as `5` reads back as `"5"`, a text
 * one comes back trimmed, and an empty cell can be `''`, `null` or absent depending on the column.
 * Strict equality would call every one of those "not saved; retype to try again" — telling the
 * operator to redo work that is already in the database, which is the same lie the 30s timeout used
 * to tell, arriving by a third road.
 *
 * The question this answers is deliberately narrow: **does the row now hold what they typed?** If
 * it does, they have nothing to redo, whatever route the value took to get there.
 */
export function sheetValuesMatch(stored: unknown, typed: unknown): boolean {
  const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')
  if (blank(stored) || blank(typed)) return blank(stored) && blank(typed)
  if (typeof stored === 'boolean' || typeof typed === 'boolean') return stored === typed
  if (Array.isArray(stored) || Array.isArray(typed)) return Array.isArray(stored) && Array.isArray(typed) && stored.length === typed.length && stored.every((value, i) => sheetValuesMatch(value, typed[i]))
  if (typeof stored === 'object' || typeof typed === 'object') {
    if (typeof stored !== 'object' || typeof typed !== 'object') return false
    const left = Object.keys(stored as object).sort(), right = Object.keys(typed as object).sort()
    return left.length === right.length && left.every((key, i) => key === right[i] && sheetValuesMatch((stored as Record<string, unknown>)[key], (typed as Record<string, unknown>)[key]))
  }
  return String(stored).trim() === String(typed).trim()
}

export class SheetWriter<T> {
  /** rowId → the values typed but unresolved, merged across every batch the outage swallowed. */
  private readonly unreachableRows = new Map<string, Record<string, SheetWriteCell>>()
  /** rowIds with a reconcile loop already running — one per row, never one per batch. */
  private readonly reconciling = new Set<string>()
  private readonly opts: Required<Pick<SheetWriterOptions<T>, 'tracker' | 'commit' | 'getApi'>> & SheetWriterOptions<T>
  private readonly flushMs: number
  private readonly versions = new Map<string, number>()
  private readonly rows = new Map<string, T | null>()
  private readonly queues = new Map<string, RowQueue>()
  private listeners = new Set<() => void>()
  private destroyed = false
  private generation = 0

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
      // MONOTONIC, and that is the whole rule. `Product.version` only ever increments, so a seed
      // carrying a LOWER number is a stale read — a page refetch that was already in flight when a
      // save landed, answering with the version from before it. Adopting it would arm the next
      // write with a version the server has already moved past and refuse it 409.
      //
      // Guarding only "a write is in flight" is not enough: the damaging order is the refetch
      // resolving AFTER the save completes, when nothing is in flight at all.
      const known = this.versions.get(r.id)
      if (typeof r.version === 'number' && (known === undefined || r.version > known)) this.versions.set(r.id, r.version)
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
  set(rowId: string, colId: string, value: unknown, opts: { row?: T; intent?: SheetWriteIntent } = {}): void {
    if (this.destroyed) return
    if (opts.row !== undefined) this.rows.set(rowId, opts.row)
    const q = this.queues.get(rowId) ?? { cells: new Map<string, { value: unknown; intent: SheetWriteIntent }>(), timer: null, inFlight: false }
    // The LAST edit to a cell inside the window wins — its intent along with its value, so a
    // reset following a set is a reset and not a set carrying a stale null.
    q.cells.set(colId, { value, intent: opts.intent ?? 'set' })
    this.queues.set(rowId, q)
    this.opts.tracker.set(rowId, colId, 'saving')
    this.repaint(rowId, [colId])
    this.emit()
    this.schedule(rowId)
  }

  private schedule(rowId: string): void {
    const q = this.queues.get(rowId)
    if (!q || q.inFlight) return // the flight's completion re-schedules whatever arrived meanwhile
    /*
     * 🔴 While the row is unreachable the queue HOLDS. Typing during an outage must not each spawn
     * their own doomed flight — nothing typed is lost, it waits, and the reconcile loop flushes it
     * the moment a read answers. Without this, every keystroke against a dead port started another
     * reconcile loop of its own.
     */
    if (this.unreachableRows.has(rowId)) return
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
    // A held queue (unreachable row) is not going to settle — waiting on it hangs Publish for as
    // long as the outage lasts. Those cells are safe in the queue; the reconcile loop sends them.
    const settling = () =>
      [...this.queues.entries()].some(([id, q]) => !this.unreachableRows.has(id) && (q.inFlight || q.cells.size > 0))
    while (settling()) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  private async flushRow(rowId: string): Promise<void> {
    const q = this.queues.get(rowId)
    if (!q || q.inFlight || q.cells.size === 0 || this.destroyed || this.unreachableRows.has(rowId)) return
    const generation = this.generation

    const batch: SheetWriteCell[] = [...q.cells.entries()].map(([colId, e]) => ({ colId, value: e.value, intent: e.intent }))
    q.cells.clear()
    q.inFlight = true
    this.emit()

    let result: SheetWriteResult
    let rejected = false
    try {
      /*
       * 🔴 RACED, because a promise that never settles is not a rejection and `try/catch` cannot see
       * it. Without this, one hung request latches `q.inFlight = true` for the life of the page:
       * `schedule()` returns early on every later edit to that row, so those edits enter the queue
       * and are NEVER SENT — while `set()` has already painted each cell `saving`. Silent data loss
       * wearing a progress indicator. `flush()`'s settle loop would also spin forever, so a Publish
       * that flushes first hangs with it.
       *
       * The loser resolves rather than throws: it takes the same path as any other refusal, so the
       * cell paints refused WITH A REASON, `inFlight` clears, the row accepts writes again, and
       * `flush()` terminates. Fixed here rather than at the caller because `commit` is called from
       * exactly one place and a per-caller timeout is a convention every future caller can forget.
       */
      /*
       * 🔴 NO RACE. This used to resolve a loser after 30 s with "the server did not answer within
       * 30s — this change was not saved", and that sentence was a lie the client could not possibly
       * know to be true. Measured 2026-09-02: a write took 34 s (a dev connection-pool limit, not
       * the route), was painted `refused` at 30 s, and then **succeeded** — `updated: 1`. The
       * operator was told their change had failed about a change that had saved, and the natural
       * response to that is to retype a value that is already there.
       *
       * **A flight is in flight until its fetch SETTLES.** The patience timer below paints, and
       * paints only: it never resolves the promise, never clears `inFlight`, and never unblocks the
       * row. So a slow answer is still the answer, and a second write cannot overtake the first.
       *
       * The original race existed for a real reason — a promise that never settles latches
       * `inFlight` for the life of the page. That risk is now carried by the `waiting` mark, which
       * tells the operator the truth (we have not heard back) instead of inventing a verdict.
       */
      const patience = setTimeout(() => {
        for (const { colId } of batch) {
          this.opts.tracker.set(rowId, colId, 'waiting', 'Still waiting — the server has not answered. This change is not confirmed.')
        }
        this.repaint(rowId, batch.map((b) => b.colId))
        this.emit()
      }, COMMIT_TIMEOUT_MS)
      try {
        result = await this.opts.commit({
          rowId,
          row: this.rows.get(rowId) ?? null,
          cells: batch,
          expectedVersion: this.versions.get(rowId),
        })
      } finally {
        clearTimeout(patience)
      }
    } catch (err) {
      /*
       * 🔴 A REJECTED FETCH IS NOT A REFUSAL. The connection dropped; the request may or may not
       * have been applied on the server, and nothing here can tell which. `unknown` says so and the
       * host reconciles by reading the row back — the one action that can actually answer it.
       * Painting `refused` here would be the same lie as the timeout, arriving by a different road.
       */
      rejected = true
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }

    if (generation !== this.generation) return
    if (typeof result.version === 'number') this.versions.set(rowId, result.version)
    if (result.conflict) this.opts.onConflict?.(rowId, result.version)


    const settledCols: string[] = []
    for (const { colId } of batch) {
      const own = result.cells?.[colId]
      const ok = own ? own.ok : result.ok
      const reason = own?.reason ?? (ok ? undefined : result.reason)
      /* `unknown`, not `refused`, when the FETCH rejected — see the catch above. A refusal is a
         statement about the server's answer, and here there was none. */
      // `rejected` covers a commit that THREW; `result.unreachable` covers one that caught its own
      // network error and said so. Both mean the same thing: no answer, so no verdict.
      const noAnswer = rejected || (own?.unreachable ?? result.unreachable) === true
      const state = ok ? 'saved' : noAnswer ? 'unknown' : 'refused'
      if (!q.cells.has(colId)) this.opts.tracker.set(rowId, colId, state, noAnswer ? 'Connection lost — refresh to see whether this saved.' : reason)
      settledCols.push(colId)
    }
    q.inFlight = false
    this.repaint(rowId, settledCols)
    this.emit()
    this.opts.onSettled?.({ rowId, ok: result.ok, savedAt: new Date().toISOString() })
    // The writer cannot read the row back itself — it does not own the read. It asks, quietly,
    // and keeps asking until something answers.
    if (rejected || result.unreachable === true) {
      void this.reconcile(rowId, Object.fromEntries(batch.filter(b => result.cells?.[b.colId]?.unreachable ?? (rejected || result.unreachable === true)).map(b => [b.colId, b])))
    }

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

  /**
   * Resolve an `unknown` cell by READING THE ROW BACK — never by guessing.
   *
   * A write that died on the wire may or may not have applied, and the only thing that can answer
   * that is the row itself. So: retry with backoff until a read answers, then compare what the
   * operator typed against what the database holds.
   *
   * - the DB holds the intended value/state → `saved`
   * - the DB holds something else → `refused`, with the typed value kept visible for review.
   *   A mismatch cannot distinguish a rejected write from a later change by another writer.
   *
   * The backoff is 2s, 4s, 8s, then capped — a dev API cold-boots in tens of seconds, and hammering
   * a closed port neither speeds it up nor tells us anything new.
   */
  private async reconcile(rowId: string, typed: Record<string, SheetWriteCell>): Promise<void> {
    if (!this.opts.readRow && !this.opts.readBack) return
    const generation = this.generation
    // Merge: a second batch swallowed by the same outage joins the set this loop will resolve,
    // rather than starting a rival loop that resolves half of it.
    this.unreachableRows.set(rowId, { ...this.unreachableRows.get(rowId), ...typed })
    this.emit()
    if (this.reconciling.has(rowId)) return
    this.reconciling.add(rowId)
    let waitMs = 2000
    while (!this.destroyed) {
      await new Promise((r) => setTimeout(r, waitMs))
      /* 🔴 `reconciling` is the loop's OWN cancellation flag, not just a re-entry guard. `discard()`
         clears it because the writes this loop is reasoning about have been thrown away — and
         without this check the loop carried on reading and would have landed a `saved`/`refused`
         verdict on cells that no longer hold what it was comparing. Found by the discard test:
         four reads after the cancel where one was expected. */
      if (this.destroyed || generation !== this.generation || !this.reconciling.has(rowId)) return
      const request = { rowId, row: this.rows.get(rowId) ?? null, cells: Object.values(this.unreachableRows.get(rowId) ?? typed), expectedVersion: this.versions.get(rowId) }
      const read = this.opts.readBack
        ? await this.opts.readBack(request).catch(() => null)
        : await this.opts.readRow!(rowId).then(values => values ? { values } : null).catch(() => null)
      if (this.destroyed || generation !== this.generation || !this.reconciling.has(rowId)) return
      const outstanding = this.unreachableRows.get(rowId) ?? typed
      if (read) {
        const snapshot = read as { values: Record<string, unknown>; version?: number; row?: T; matches?: Record<string, boolean | null> }
        this.seed([{ id: rowId, version: snapshot.version, ...(snapshot.row !== undefined ? { row: snapshot.row } : {}) }])
        let unresolved = false
        let ok = true
        for (const [colId, cell] of Object.entries(outstanding)) {
          const known = Object.prototype.hasOwnProperty.call(snapshot.values, colId)
          const landed = snapshot.matches && Object.prototype.hasOwnProperty.call(snapshot.matches, colId) ? snapshot.matches[colId] : known ? sheetValuesMatch(snapshot.values[colId], cell.value) : null
          if (landed === null) { unresolved = true; continue }
          ok = ok && landed
          if (this.queues.get(rowId)?.cells.has(colId)) continue
          this.opts.tracker.set(
            rowId,
            colId,
            landed ? 'saved' : 'refused',
            landed ? undefined : 'The stored value differs from this edit. Review it before trying again.',
          )
        }
        if (unresolved) { waitMs = Math.min(waitMs * 2, 30_000); continue }
        this.unreachableRows.delete(rowId)
        this.reconciling.delete(rowId)
        this.repaint(rowId, Object.keys(outstanding))
        this.emit()
        this.opts.onReconciled?.({ rowId, ok, savedAt: new Date().toISOString() })
        // Anything typed during the outage was queued, not lost. Send it now that we can.
        if (this.queues.get(rowId)?.cells.size) this.schedule(rowId)
        return
      }
      // Still nothing. Say so on the mark rather than leaving a stale sentence.
      for (const colId of Object.keys(outstanding)) {
        if (!this.queues.get(rowId)?.cells.has(colId)) this.opts.tracker.set(rowId, colId, 'unknown', 'Connection lost — checking whether this saved…')
      }
      this.repaint(rowId, Object.keys(outstanding))
      this.emit()
      waitMs = Math.min(waitMs * 2, 30_000)
    }
    this.reconciling.delete(rowId)
  }

  /**
   * Is any row currently unreachable? The sheet's header states the outage ONCE from this — a
   * page-level fact, not a per-cell one, and it clears as soon as a read answers.
   */
  get unreachable(): boolean {
    return this.unreachableRows.size > 0
  }
  get unknownCount(): number {
    return [...this.unreachableRows.values()].reduce((total, cells) => total + Object.keys(cells).length, 0)
  }

  get busy(): boolean {
    for (const q of this.queues.values()) if (q.inFlight) return true
    return false
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Tear down — and SEND whatever is still queued first.
   *
   * 🔴 This used to clear the queues, which silently dropped any cell edited inside the flush
   * window (~40ms) immediately before an unmount: type, navigate, and the edit is gone with nothing
   * on screen having said so. The old edit page protects against exactly this with an unmount flush
   * (`MasterDataTab.tsx:400`), and the parity audit's data-loss landmine calls it out by name — a
   * rebuild must not quietly lose that net just because its window is smaller. A small window is
   * still a window, and the operator has no way to know they landed in it.
   *
   * Fire-and-forget by necessity: teardown is synchronous and cannot await, which is the same
   * bargain the old page's unmount flush makes. The request outlives the component; `commit` reads
   * refs and the repaint path already guards a destroyed grid.
   */
  /**
   * 🔴 Re-arm a writer after `destroy()`. This exists because of React StrictMode, and the bug it
   * closes was invisible in every way that matters.
   *
   * A host memoises the writer and cleans it up on unmount:
   *
   *     const writer = useMemo(() => new SheetWriter({…}), [tracker, commit])
   *     useEffect(() => () => writer.destroy(), [writer])
   *
   * StrictMode mounts, runs the cleanup, and mounts again — and `useMemo` returns the SAME instance,
   * because its dependencies did not change. The host is then holding a destroyed writer for the
   * life of the page, and `set()` returns on its first line.
   *
   * **What that looked like: autosave silently dead on the master sheet.** The cell showed the
   * typed value (AG updates its own data; only the SAVE is dead), the tracker never painted
   * `saving` because `set()` returns before that line, no request was made, and nothing anywhere
   * said so. Measured 2026-09-02: `set weave_type destroyed=true` on the first keystroke of a fresh
   * page, server value unchanged across three attempts.
   *
   * The fix is the banked one: **arm in the effect BODY**, so the second mount undoes the first
   * cleanup — `useEffect(() => { writer.arm(); return () => writer.destroy() }, [writer])`.
   * Anything that only ever sets a flag TRUE in a cleanup has this shape.
   *
   * Deliberately narrow: it clears `destroyed` and nothing else. Queues, versions and rows survive
   * a destroy/arm pair, which is what makes it safe to call on every mount — the writer picks up
   * exactly where it was rather than forgetting what it knew.
   */
  arm(): void {
    this.destroyed = false
  }

  /**
   * Throw away every queued edit and every mark, WITHOUT sending anything (#663).
   *
   * The opposite of `destroy()`, which fires the queue at the server on the way out because the
   * operator's intent was to save. Here the intent is to discard, so nothing is sent — and the
   * marks go with the values they describe, in one call, because a caller who cleared the queue and
   * forgot the tracker would leave exactly the stale red cell this exists to prevent.
   *
   * The writer stays usable: the operator is still on the sheet, and the next keystroke queues.
   */
  discard(): void {
    this.generation++
    for (const q of this.queues.values()) if (q.timer) clearTimeout(q.timer)
    this.queues.clear()
    // A reconcile loop in flight is about writes that are being thrown away; its verdict would
    // land on cells that no longer hold what it is reasoning about.
    this.unreachableRows.clear()
    this.reconciling.clear()
    this.opts.tracker.clearAll()
    this.emit()
  }

  /** Idempotent: a second call flushes nothing again and leaves the writer destroyed. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.generation++
    for (const [rowId, q] of this.queues) {
      if (q.timer) clearTimeout(q.timer)
      if (q.cells.size === 0) continue
      const cells: SheetWriteCell[] = [...q.cells.entries()].map(([colId, e]) => ({ colId, value: e.value, intent: e.intent }))
      // No await, no outcome painting: there is nothing left to paint it on.
      void Promise.resolve(
        this.opts.commit({ rowId, row: this.rows.get(rowId) ?? null, cells, expectedVersion: this.versions.get(rowId) }),
      ).catch(() => {
        /* the component is gone; a refusal has no surface left to report on */
      })
    }
    this.queues.clear()
    // The header's outage line is a claim about a loop that is about to stop running. It goes too.
    this.unreachableRows.clear()
    this.reconciling.clear()
    this.listeners.clear()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}
