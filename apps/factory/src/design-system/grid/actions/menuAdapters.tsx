'use client'

/**
 * GDS — the row-menu and `⋯`-column adapters for the action registry.
 *
 * Ruling #110 says a verb is declared once and rendered identically by the row context menu, the
 * `⋯` column, the selection bar and the drawer. Until now the registry had exactly ONE adapter —
 * PES.4's `RecordActions`, inside the drawer — so a lane could declare a verb and find it rendered
 * only where it does nothing. These are the missing two (ruling #141).
 *
 * They live in the engine and not in a lane because grid chrome does: a lane that hand-rolled a
 * `⋯` column would be the second place the column's width, pinning and menu behaviour are decided.
 * `/products/next`'s `rowActions()` is the in-codebase precedent and this generalises it — same
 * shape (right-click and `⋯` read ONE list, AG's own items kept below a rule), with the list coming
 * from the registry rather than a page-local function.
 *
 * Both adapters are thin ON PURPOSE. They map; `actionsFor` filters and `runAction` runs. Anything
 * either of them decided for itself would be a rule the other three surfaces do not have.
 */

import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'

import type { MenuItemDef } from '../../components/Menu'
// Inside the grid engine: type-only vendor imports keep Factory independent of the web host.
import type { MenuItemDef as AgMenuItemDef, DefaultMenuItem, GetContextMenuItemsParams } from 'ag-grid-community'
import { actionLabel, actionsFor, isRunnable, ROW, SELECTION, type GridAction } from './registry'

export interface MenuAdapterOptions<T> {
  /** Declared by the lane that owns the data. Neither adapter adds a verb. */
  actions: readonly GridAction<T>[]
  /** Run it. Wire to `useActionPress`'s `press` so every surface runs the same sequence. */
  onSelect: (action: GridAction<T>, rows: T[]) => void
  /**
   * Rows that are not records — a group row, a family footer, an AG pinned total. They get no verbs
   * at all rather than verbs that would act on an id that is not one.
   */
  isRecord?: (row: T) => boolean
}

/**
 * What a right-click on ONE row may offer.
 *
 * 🔴 `row` AND `selection`, never `context` — and the distinction is not pedantic, it is the whole
 * reason these adapters shipped empty the first time. Both adapters originally filtered on `ROW`
 * alone, which is defensible on paper and rendered NOTHING on the only grid in the programme: the
 * family verbs are `selection` (unlink, reparent, delete) and `context` (attach, promote, demote,
 * add variation), and not one of them is `row`. A test asserted the ROW-only rule and nine
 * mutations confirmed it. All of it was consistent, and all of it was wrong; the screen said so.
 *
 * The rule that is actually right: **a right-clicked row is a selection of one.** "Unlink this
 * variation" is the same verb whether you reached it from the bulk bar with one row ticked or from
 * the row's own menu, and a registry that made those different would be two answers to one
 * question. A `context` verb stays out, because the container is not a row — that isolation is the
 * one the original rule got right.
 */
const offered = <T,>(o: MenuAdapterOptions<T>, row: T) =>
  o.isRecord && !o.isRecord(row)
    ? []
    : [...actionsFor(o.actions, ROW, [row]), ...actionsFor(o.actions, SELECTION, [row])]

/**
 * The `⋯` column's items, for `actionsColumn({ items })`.
 *
 * 🔴 A DISABLED verb is kept WITH its reason — a greyed-out, silent entry is the trap
 * `reference_disabled_control_cannot_explain` names. The DS description is a wrapping, keyboard-
 * reachable second line; title stays supplementary. AG has only tooltip, so the visible reason
 * lives in the same row's DS menu. Neither adapter reorders the registry's verbs.
 */
export function actionMenuItems<T>(o: MenuAdapterOptions<T>): (row: T) => MenuItemDef[] {
  return (row) =>
    offered(o, row).map(({ action, availability }): MenuItemDef => {
      const runnable = isRunnable(availability)
      const reason = availability.kind === 'disabled' ? availability.reason : null
      return {
        id: action.id,
        // Resolved against the rows this menu is FOR — one row here, so a callable verb words
        // itself for that row rather than for the selection (#363).
        label: actionLabel(action, [row]) as ReactNode,
        tone: action.danger ? 'danger' : undefined,
        icon: action.danger ? <Trash2 size={14} aria-hidden /> : undefined,
        title: reason ?? undefined,
        description: reason ?? undefined,
        disabled: !runnable,
        onSelect: runnable ? () => o.onSelect(action, [row]) : undefined,
      }
    })
}

/**
 * Which of AG's own context-menu entries a DS grid keeps: the clipboard, and nothing else.
 *
 * SR.1 measured 10 items on the studio sheet's row menu, 6 of them AG's. Two were actively wrong:
 *
 * 🔴 **`export` / `csvExport` / `excelExport` are REFUSED, and not merely because the toolbar has an
 * Export.** AG's own exporter walks the rows the GRID is holding — which `export/gridCsv.ts`
 * documents at length as the thing this design system does not ship: under SSRM that is the loaded
 * blocks rather than the result set, so the file is a silent subset of what the operator filtered
 * to, and it includes layout rows a page injected. Leaving the entry here would put the dishonest
 * export one right-click away from the honest one, with nothing to tell them apart.
 *
 * 🔴 **`copyWithGroupHeaders` copies a header row that no longer exists.** AG.1-d removed the
 * column-group strip from the studio sheets, so there are no group headers to copy — the entry
 * offers an operation whose output is a blank line.
 *
 * The rest — `autoSizeAll`, `expandAll` / `contractAll`, the chart entries, the pin and sort
 * submenus — are grid-shape verbs that belong in the COLUMN menu, where they already are, or
 * nowhere. A row's context menu is about the ROW.
 *
 * `copyWithHeaders` stays and earns it: a sheet's clipboard round-trips through Excel, and
 * `sheetPasteProcessor` matches a pasted block back onto columns BY HEADER NAME. Copying without
 * them would break the paste path this engine deliberately built.
 */
export const KEPT_AG_MENU_ITEMS: readonly DefaultMenuItem[] = ['copy', 'copyWithHeaders', 'cut', 'paste']

/** AG's defaults, filtered to the clipboard entries — and separators, which only separate. */
export function keepClipboardItems(
  items: readonly (DefaultMenuItem | AgMenuItemDef<unknown>)[],
): (DefaultMenuItem | AgMenuItemDef<unknown>)[] {
  const kept = items.filter((i) => typeof i === 'string' && KEPT_AG_MENU_ITEMS.includes(i as DefaultMenuItem))
  // A trailing or leading separator with nothing on one side draws a rule against nothing.
  return kept as (DefaultMenuItem | AgMenuItemDef<unknown>)[]
}

/**
 * AG's right-click menu, for `getContextMenuItems`.
 *
 * The registry's verbs, then a rule, then AG's CLIPBOARD entries — see `KEPT_AG_MENU_ITEMS` for why
 * the rest are dropped rather than kept below the rule as they used to be. A row that is not a
 * record gets the clipboard alone.
 *
 * ⚠ Memoise the result in the host — but for the right reason. **Not** because it rebuilds AG's
 * column model: AG.1 measured that on 36.1 with a positive control, and a new `getContextMenuItems`
 * identity fires **0** `newColumnsLoaded` / **0** `columnEverythingChanged` / **0**
 * `displayedColumnsChanged`, against 1/1/1 for `columnDefs`. The banked trap is real for column
 * DEFS and was over-generalised to callbacks here (ruling #192). Memoise it because a host that
 * rebuilds this every render is doing avoidable work and, more to the point, cannot then use it as
 * a stable dependency anywhere else.
 */
export function actionContextMenu<T>(o: MenuAdapterOptions<T>) {
  return (p: GetContextMenuItemsParams<T>): (DefaultMenuItem | AgMenuItemDef<T>)[] => {
    const defaults = keepClipboardItems(
      (p.defaultItems ?? []) as (DefaultMenuItem | AgMenuItemDef<unknown>)[],
    ) as (DefaultMenuItem | AgMenuItemDef<T>)[]
    const row = p.node?.data
    if (!row) return defaults
    const own = offered(o, row).map(({ action, availability }): AgMenuItemDef<T> => {
      const runnable = isRunnable(availability)
      const reason = availability.kind === 'disabled' ? availability.reason : null
      return {
        // 🔴 AG takes `name: string`, not a node. A verb whose label is an element would render as
        // "[object Object]" here, so the id is the fallback — visible and wrong-looking, which is
        // better than invisible and wrong. Keep registry labels plain strings.
        //
        // `actionLabel` resolves the callable form FIRST (#363), so a function-worded verb reaches
        // this check as the string it produced — the fallback still catches a genuine ReactNode.
        name: ((l) => (typeof l === 'string' ? l : action.id))(actionLabel(action, [row])),
        // 🔴 The reason goes in AG's `tooltip`, not the name. Appending it read correctly and made
        // the menu ~900px wide on screen — three permission sentences inline turned a context menu
        // into a paragraph laid over the grid. A menu that has to be that wide to be honest is a
        // menu that has stopped being a menu; the tooltip keeps both.
        tooltip: reason ?? undefined,
        cssClasses: action.danger ? ['nds-menu-danger'] : undefined,
        // AG accepts Element|string, never a React node. Use currentColor so the text role owns ink.
        icon: action.danger ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg>' : undefined,
        disabled: !runnable,
        action: runnable ? () => o.onSelect(action, [row]) : undefined,
      }
    })
    if (own.length === 0) return defaults
    return defaults.length > 0 ? [...own, 'separator' as DefaultMenuItem, ...defaults] : own
  }
}
