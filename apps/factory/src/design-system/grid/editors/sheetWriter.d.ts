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
import type { GridApi } from 'ag-grid-community';
import { CellSaveTracker } from './roundTrip';
import { type CoordinateKey, type MatrixCells, type MatrixWriteCell } from '../matrix/contract';
export type SheetWriteIntent = 'set' | 'pin' | 'reset' | 'reset-list';
/** What moved between the cell the server served and the cell the editor reported. */
export type VariationThemeChangeKind = 'none' | 'order' | 'set' | 'theme' | 'reset';
export interface VariationThemeChange {
    kind: VariationThemeChangeKind;
    /** Included axisKeys before and after, IN DELIVERY ORDER. */
    before: string[];
    after: string[];
    /** Amazon: the enum code before and after; `null` when the coordinate has no theme. */
    themeBefore: string | null;
    themeAfter: string | null;
    /** True when the SET of included axes moved — the fact §3.5 gates a locked coordinate on. */
    setChanged: boolean;
    /** True when only the ORDER moved. eBay allows this on a live listing (`orderChangeAllowed`). */
    orderOnly: boolean;
    /** The operator asked to drop this coordinate's override (`reset: true`, contract §3.3). */
    reset: boolean;
}
/** The minimum shape this branch reads off a variation-theme cell. Wider than the producer, on purpose. */
export interface VariationThemeWriteFacts {
    /** `familyKey` is the FAMILY's own spelling (`Colore`), which is what `variation-axes` requires. */
    axes: Array<{
        axisKey: string;
        familyKey?: string;
        target: string | null;
        included: boolean;
    }>;
    theme: {
        code: string;
    } | null;
    write: {
        endpoint: 'variation-axes' | 'projection';
        expectedVersion: number;
        aliasKey: string;
        coordinate: {
            channel: string | null;
            market: string;
            accountId: string | null;
        };
        childIds?: string[];
    } | null;
    /**
     * OPTIONAL OVERRIDE only. The family spellings come from `axes[].familyKey` on the cell itself —
     * see `familySpellings` for why relying on a caller to pass this index was a live defect.
     */
    axisFamilyKeys?: Record<string, string>;
    locked?: {
        setChangeIs: 'relist' | 'new-parent' | 'in-place';
        orderChangeAllowed: boolean;
        reason: string;
    } | null;
    writable?: boolean;
    writeBlockedReason?: string | null;
    /** Set by the editor when the operator pressed `Reset to rule`. Never on the server's own read. */
    resetRequested?: boolean;
}
/**
 * Did anything move, and what?
 *
 * `set` vs `order` is the distinction the whole locked-commit rule turns on, so it is computed from
 * the two lists rather than from a flag either side might forget to set: the SET is the two lists as
 * multisets, the ORDER is the two lists as sequences. A coordinate whose target names changed (an
 * eBay aspect re-pointed) is a `set` change too — the delivered names are what a buyer picks from.
 */
export declare function variationThemeChange(before: VariationThemeWriteFacts | null | undefined, after: VariationThemeWriteFacts | null | undefined): VariationThemeChange;
/** What the app must send, or why nothing may be sent. */
export type VariationThemeWrite = {
    send: false;
    reason: string;
    change: VariationThemeChange;
} | {
    send: false;
    /** A locked coordinate whose axis SET moved: design §3.5 says this is an OPERATION, not a cell
     *  edit. The plan Modal opens (VT.4); nothing is written either way. */
    plan: {
        setChangeIs: 'relist' | 'new-parent' | 'in-place';
        reason: string;
    };
    change: VariationThemeChange;
} | {
    send: true;
    endpoint: 'variation-axes' | 'projection';
    /** Query the client must send back VERBATIM (contract §1's `coordinate`). */
    query: {
        channel: string | null;
        market: string;
        accountId: string | null;
        aliasKey: string;
    };
    /** The request body, exactly as §3.1 / §3.2 / §3.3 define it. */
    body: Record<string, unknown>;
    change: VariationThemeChange;
};
export declare function variationThemeWrite(column: {
    kind?: string;
}, before: VariationThemeWriteFacts | null | undefined, after: VariationThemeWriteFacts | null | undefined): VariationThemeWrite;
export interface MatrixWriteColumn {
    kind: string;
    coordinateKey: CoordinateKey;
    rowId: string;
}
export type MatrixWriteDecision = {
    send: true;
    cell: MatrixWriteCell;
} | {
    send: false;
    reason: string;
};
export declare const MATRIX_NOT_A_COLUMN = "Not a Matrix column";
export declare const MATRIX_NO_LISTING = "No listing on this coordinate";
export declare const MATRIX_FULFILMENT_INLINE = "Fulfilment is set through Set fulfilment\u2026 \u2014 never written inline";
export declare const MATRIX_UNCHANGED = "Unchanged";
export declare function matrixWrite(column: MatrixWriteColumn, cell: MatrixCells | null | undefined, before: unknown, after: unknown): MatrixWriteDecision;
/** One queued cell edit. */
export interface SheetWriteCell {
    colId: string;
    value: unknown;
    /** Defaults to `set` when the caller says nothing. */
    intent: SheetWriteIntent;
}
/** What the app is asked to send: every cell of ONE row, with that row's version. */
export interface SheetWriteRequest<T> {
    rowId: string;
    /** The row object the grid holds, so the app can read `storage`, locale, product type… */
    row: T | null;
    cells: SheetWriteCell[];
    /**
     * The row's version as this writer believes it. `undefined` means the writer was never seeded
     * for this row — send the write WITHOUT an optimistic-concurrency guard rather than guessing a
     * number, and say so in the result.
     */
    expectedVersion?: number;
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
    unreachable?: boolean;
    ok: boolean;
    /** Why the whole batch was refused. Ignored when `cells` names each one. */
    reason?: string;
    /**
     * The row's version AFTER the write. Supply it on success (the endpoint's `currentVersion`) AND
     * on a 409 (the server's `currentVersion`), so a conflict leaves the writer able to retry
     * instead of stuck one version behind for the rest of the session.
     */
    version?: number;
    /** Per-cell outcomes, when the server answers per field. Absent ⇒ `ok` applies to every cell. */
    cells?: Record<string, {
        ok: boolean;
        reason?: string;
        unreachable?: boolean;
    }>;
    /** True when the server's answer means the grid's copy of this row is stale. */
    conflict?: boolean;
}
export interface SheetWriterOptions<T> {
    tracker: CellSaveTracker;
    /** Send one row's batch. Never throws for a refusal. */
    commit: (req: SheetWriteRequest<T>) => Promise<SheetWriteResult>;
    /** The live grid, for repainting cells. May return null before the grid is ready. */
    getApi: () => GridApi<T> | null;
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
    readRow?: (rowId: string) => Promise<Record<string, unknown> | null>;
    /** Scoped read with fresh concurrency tokens and optional domain checks for reset/reference cells. */
    readBack?: (request: SheetWriteRequest<T>) => Promise<{
        values: Record<string, unknown>;
        version?: number;
        row?: T;
        matches?: Record<string, boolean | null>;
    } | null>;
    onReconciled?: (info: {
        rowId: string;
        ok: boolean;
        savedAt: string;
    }) => void;
    /**
     * How long to gather cells before sending a row's batch. A fill or a paste emits its cells in
     * one synchronous burst, so anything above a frame catches the whole thing; 40ms also absorbs a
     * fast typist tabbing across a row without making a single edit feel deferred.
     */
    flushMs?: number;
    /** The row moved under us — the page should refetch. Called once per conflicting row. */
    onConflict?: (rowId: string, serverVersion: number | undefined) => void;
    /** Fired after every settled batch, for the status strip and the "saved at" clock. */
    onSettled?: (info: {
        rowId: string;
        ok: boolean;
        savedAt: string;
    }) => void;
    /**
     * R-VT-15 — the server said NO, and this is the only moment its sentence exists.
     *
     * 🔴 The defect measured by VT.F2: a refused commit showed **no sentence anywhere**. The reason
     * reached `tracker.set(rowId, colId, 'refused', reason)` and stopped there — a red cell mark whose
     * words the operator could only reach by DOUBLE-CLICKING the cell again
     * (`useProductSheetInteraction.explainRefusal`). So the two most useful refusals in this programme
     * — *"Map each shared axis once to a nonempty channel value"* and *"Title needs a choice: Edit the
     * shared Italian or Pin on Amazon · IT · it."* — were invisible at the moment they happened, on
     * every column, because this is the one write path every column uses.
     *
     * Only cells the server REFUSED are reported. A cell that got no answer at all (`unknown` — a
     * rejected fetch, a timeout, `unreachable`) is NOT a refusal and carries the reconciler's own
     * sentence instead; announcing it as a refusal would be the same lie the `unknown` state exists to
     * avoid. One call per settled batch, so a paste that refuses twenty cells is one event with
     * twenty entries and the surface decides how to say it.
     *
     * The ENGINE does not choose a surface: a toast provider is a property of the route, and a DS
     * component reaching for one is how `reference_ds_toast_two_providers` happens.
     */
    onRefused?: (refusals: ReadonlyArray<{
        rowId: string;
        colId: string;
        reason?: string;
    }>) => void;
}
export declare const DEFAULT_SHEET_FLUSH_MS = 40;
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
export declare function sheetValuesMatch(stored: unknown, typed: unknown): boolean;
export declare class SheetWriter<T> {
    /** rowId → the values typed but unresolved, merged across every batch the outage swallowed. */
    private readonly unreachableRows;
    /** rowIds with a reconcile loop already running — one per row, never one per batch. */
    private readonly reconciling;
    private readonly opts;
    private readonly flushMs;
    private readonly versions;
    private readonly rows;
    private readonly queues;
    private listeners;
    private destroyed;
    private generation;
    constructor(options: SheetWriterOptions<T>);
    /**
     * Record what the server last told us about these rows. Called after every page load and after
     * every refetch. An UNKNOWN row is left unknown on purpose: seeding a guess would arm the
     * optimistic-concurrency guard with a number nobody read.
     */
    seed(rows: ReadonlyArray<{
        id: string;
        version?: number;
        row?: T;
    }>): void;
    /** What this writer believes a row's version to be — the number the next write will send. */
    versionOf(rowId: string): number | undefined;
    /**
     * Queue one cell. Paints it `saving` immediately, so a burst of 100 pasted cells reads as work in
     * progress from the first frame rather than after the first response.
     */
    set(rowId: string, colId: string, value: unknown, opts?: {
        row?: T;
        intent?: SheetWriteIntent;
    }): void;
    private schedule;
    /** Send every queued cell now, and resolve when the sheet is quiet. Used by tests and by Publish. */
    flush(): Promise<void>;
    private flushRow;
    /**
     * Repaint exactly the cells that changed state.
     *
     * Deliberately NOT a whole-grid refresh: a paste settles 20 batches, and refreshing every row 20
     * times is what turns a working sheet into a stuttering one.
     */
    private repaint;
    /** Cells queued or in flight — what the status strip calls "unsaved". */
    get pending(): number;
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
    private reconcile;
    /**
     * Is any row currently unreachable? The sheet's header states the outage ONCE from this — a
     * page-level fact, not a per-cell one, and it clears as soon as a read answers.
     */
    get unreachable(): boolean;
    get unknownCount(): number;
    get busy(): boolean;
    subscribe(fn: () => void): () => void;
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
    arm(): void;
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
    discard(): void;
    /** Idempotent: a second call flushes nothing again and leaves the writer destroyed. */
    destroy(): void;
    private emit;
}
