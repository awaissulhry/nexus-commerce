/**
 * GDS — the actions column fits its buttons (Owner 2026-10-23: "super dynamic and never go out of shape").
 *
 * 🔴 The width was a GUESS. `actionsColumnWidth` (`rowVerbs.ts`) picks 56 / 120 / 200 from the NUMBER of verbs, and a
 * page could pass a number of its own. Neither knows the labels, the font, the density or the language. Measured on
 * the live Approvals page (2026-10-23, Inter 600 12.5px): Approve 76 + Reject 62 + ⋯ 28 + two 6px gaps + the cell's
 * padding and borders = more than 200 px, in a 200 px column — the end of every waiting row was cut. Harvest terms
 * drew the same three buttons. A saved layout also stored the width, so an old number outlived the code that chose it.
 *
 * Now every `ActionsCell` measures its own buttons and reports the width its row needs. This file keeps the widest
 * row per grid and column and sets the column to it:
 *   · grow-only while the grid lives, so scrolling past a row with fewer buttons never makes the column jump;
 *   · measured again from the rows on screen when the grid's width or the density changes (`refitActionsColumns`);
 *   · held: any other change of the width (a saved layout, a view, an auto-size) is put straight back.
 * When the buttons need more than `ACTIONS_MAX_SHARE` of the grid (a phone), the verbs that do not fit move into the
 * ⋯ menu (`verbsThatFit`): every action stays reachable and nothing is cut.
 *
 * The rules are pure and tested (`actionsFit.vitest.test.ts`). The coordinator only calls the grid api it is handed,
 * with no AG import at run time, so this file is mirrored byte-for-byte in Factory, like `cells.tsx` that imports it.
 */
import type { ColumnResizedEvent, GridApi } from 'ag-grid-community'

/** The most of the grid's width the actions column may take before verbs move into the ⋯ menu. */
export const ACTIONS_MAX_SHARE = 0.5

/** The `⋯` trigger (`.nds-btn.sm.icon`) before one was drawn and measured. */
export const ACTIONS_MENU_WIDTH = 28

/** One row's buttons, measured on screen. */
export interface ActionsGeometry {
  /** Each verb's button width, in the order the verbs are offered. */
  verbs: readonly number[]
  /** The `⋯` trigger's width. */
  menu: number
  /** The row has `⋯` items of its own, so the `⋯` shows even when every verb fits. */
  hasItems: boolean
  /** The gap between two buttons. */
  gap: number
  /** The cell's padding and borders, left and right together. */
  chrome: number
}

/** The width a row needs with its first `shown` verbs as buttons and the rest in the `⋯` menu, in whole px. */
export function actionsRowWidth(g: ActionsGeometry, shown = g.verbs.length): number {
  const parts = g.verbs.slice(0, shown)
  const widths = g.hasItems || shown < g.verbs.length ? [...parts, g.menu] : parts
  if (!widths.length) return Math.ceil(g.chrome)
  const sum = widths.reduce((total, w) => total + w, 0) + g.gap * (widths.length - 1)
  return Math.ceil(sum + g.chrome)
}

/** How many verbs stay buttons in `room` px: all when they fit, else the most that fit beside a `⋯` (0 = only the `⋯`). */
export function verbsThatFit(g: ActionsGeometry, room: number): number {
  for (let n = g.verbs.length; n > 0; n--) if (actionsRowWidth(g, n) <= room) return n
  return 0
}

/** The width of a column that fits its widest row: grow-only, so a narrower row never shrinks it. */
export function grownWidth(current: number, need: number): number {
  return Math.max(current, Math.ceil(need))
}

/* ── the coordinator: one per grid and column ─────────────────────────────────────────────── */

interface ColumnFit {
  /** The widest row since the last refit; 0 = no row measured yet. */
  need: number
  /** Each mounted cell's "measure again". */
  cells: Set<() => void>
  /** A width check is already queued. */
  queued: boolean
}

const grids = new WeakMap<GridApi, Map<string, ColumnFit>>()

/**
 * Set the column to its fitted width once the reports of this commit are in, unless it already is: one write per
 * column per task. A microtask, not a frame: it lands before the browser paints (no frame of the old width), and a
 * tab in the background — where `requestAnimationFrame` does not run — is fitted too (measured: a background tab kept
 * the 200 px first paint until it was shown).
 */
function hold(api: GridApi, colId: string, fit: ColumnFit): void {
  if (fit.queued) return
  fit.queued = true
  queueMicrotask(() => {
    fit.queued = false
    if (!fit.need || api.isDestroyed()) return
    const column = api.getColumn(colId)
    if (column && Math.abs(column.getActualWidth() - fit.need) >= 1) api.setColumnWidths([{ key: colId, newWidth: fit.need }], true)
  })
}

function fitOf(api: GridApi, colId: string): ColumnFit {
  let columns = grids.get(api)
  if (!columns) {
    const own = (columns = new Map())
    grids.set(api, own)
    // Any other width change — a saved layout, a view, an auto-size — is put back to the fitted width.
    api.addEventListener('columnResized', (event: ColumnResizedEvent) => {
      for (const column of event.columns ?? (event.column ? [event.column] : [])) {
        const fit = own.get(column.getColId())
        if (fit?.need) hold(api, column.getColId(), fit)
      }
    })
    // A wider or narrower grid can fold or unfold verbs: every row measures again.
    api.addEventListener('gridSizeChanged', () => refitActionsColumns(api))
  }
  let fit = columns.get(colId)
  if (!fit) columns.set(colId, (fit = { need: 0, cells: new Set(), queued: false }))
  return fit
}

export interface ActionsFitMember {
  /** The width this row needs now (`actionsRowWidth` of what it draws). */
  report(need: number): void
  /** The cell unmounted. The column keeps its width. */
  leave(): void
}

/** A mounted cell joins its column. `measure` runs when the grid asks every row to measure again. */
export function joinActionsFit(api: GridApi, colId: string, measure: () => void): ActionsFitMember {
  const fit = fitOf(api, colId)
  fit.cells.add(measure)
  return {
    report(need) {
      fit.need = grownWidth(fit.need, need)
      hold(api, colId, fit)
    },
    leave() {
      fit.cells.delete(measure)
    },
  }
}

/** Measure every mounted row again and fit each actions column of this grid to them (its width or density changed). */
export function refitActionsColumns(api: GridApi): void {
  const columns = grids.get(api)
  if (!columns || api.isDestroyed()) return
  for (const [colId, fit] of columns) {
    // Only fresh reports count: a row that now folds reports after it re-renders, not with its old width.
    fit.need = 0
    for (const measure of [...fit.cells]) measure()
    hold(api, colId, fit)
  }
}
