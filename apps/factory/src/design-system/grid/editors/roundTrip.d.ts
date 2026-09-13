/**
 * GDS — the per-cell server round-trip, as a state machine the grid can paint.
 *
 *   idle → saving → saved (fades after a moment) | refused (stays red, reason on hover)
 *
 * The inventory editor batches its edits (pending → Apply → per-change results); the ads bid and
 * budget cells save ONE cell per edit and must show each cell's own outcome. This tracker holds
 * that outcome per cell; `roundTripClassRules` turns it into AG `cellClassRules` so the cell
 * carries `nds-cell-is-saving` / `-saved` / `-refused` (tokens: `--nds-grid-saving-bg`,
 * `--nds-grid-refused-*`). A refused write is a RESULT, never an exception — it stays visible
 * until the operator edits the cell again.
 *
 * Pure: no React, no AG import at runtime (types only), tested beside this file.
 */
import type { CellClassRules, GridApi } from 'ag-grid-community';
/**
 * 🔴 Five states, and the two new ones exist because THREE is a lie.
 *
 * `waiting` and `unknown` are both "we do not know yet", which the old union could only express as
 * `refused` — and a refusal is a claim about the SERVER, not about us. Measured 2026-09-02: a write
 * that took 34 s (a dev connection-pool limit, not the route) was painted `refused` at 30 s by a
 * client-side timeout, and then **succeeded**. The operator was told their change was not saved,
 * about a change that was.
 *
 * - `waiting`   — the flight is still open past the patience window. We have no answer. NOT a failure.
 * - `unknown`   — the fetch itself rejected. It may or may not have been applied server-side, and
 *                 the only honest thing is to say so and go and look.
 *
 * A timeout cannot know. Neither can a dropped connection.
 */
export type CellSaveState = 'saving' | 'waiting' | 'saved' | 'refused' | 'unknown';
export interface CellSaveEntry {
    state: CellSaveState;
    reason?: string;
    at: number;
}
export declare const SAVED_FADE_MS = 1500;
export declare class CellSaveTracker {
    private readonly cells;
    private listeners;
    static key(rowId: string, colId: string): string;
    get(rowId: string, colId: string): CellSaveEntry | undefined;
    set(rowId: string, colId: string, state: CellSaveState, reason?: string, now?: number): void;
    clear(rowId: string, colId: string): void;
    /**
     * Drop EVERY mark. For a reload that discards the edits the marks were about (#663).
     *
     * 🔴 A mark outliving its value is a lie with a tooltip: measured 2026-09-02, Reload replaced a
     * refused cell's typed value with the stored one and left the refusal on it, so the sheet showed
     * a red cell, "1 cell blocked" and "1 change not saved" about a change that no longer existed.
     * Clearing the rows and clearing the marks are the same operation and must not be two calls a
     * caller can do half of — which is why `SheetWriter.discard()` does both.
     */
    clearAll(): void;
    /** Drop `saved` marks older than the fade — called by the grid on a timer, never by a renderer. */
    sweep(now?: number): string[];
    subscribe(fn: () => void): () => void;
    get size(): number;
    /** A background read must preserve edits that were refused or have not been confirmed. */
    get hasUnconfirmedChanges(): boolean;
    private emit;
}
/** AG `cellClassRules` that read the tracker. `getRowId` is the page's own. */
export declare function roundTripClassRules<T>(tracker: CellSaveTracker, getRowId: (data: T) => string): CellClassRules<T>;
export interface SaveOutcome {
    ok: boolean;
    /** Why the server refused — shown on the cell. */
    reason?: string;
    /**
     * The row's version AFTER the write, when the server reports one.
     *
     * 🔴 This field is load-bearing, and its absence was a real defect. `PATCH /api/products/bulk`
     * CAS-bumps `Product.version` inside the write transaction and answers `currentVersion`; a caller
     * that keeps sending the version it first read has its SECOND edit to that row refused with 409
     * VERSION_CONFLICT — "someone else changed this row", when the someone else was itself. The web
     * `saveSheetCell` returned the version correctly and this type dropped it on the floor, so the
     * defect was invisible to the compiler. Whoever owns the row's version must read it from here.
     */
    version?: number;
}
/**
 * Run one cell's save through the tracker and repaint the cell at each step. The caller's `save`
 * returns the server's answer; it never throws for a refusal (a refusal is an outcome).
 */
export declare function saveCell<T>(api: GridApi<T>, tracker: CellSaveTracker, rowId: string, colId: string, save: () => Promise<SaveOutcome>): Promise<SaveOutcome>;
