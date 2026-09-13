import type { MenuItemDef } from '../../components/Menu';
import type { MenuItemDef as AgMenuItemDef, DefaultMenuItem, GetContextMenuItemsParams } from 'ag-grid-community';
import { type GridAction } from './registry';
export interface MenuAdapterOptions<T> {
    /** Declared by the lane that owns the data. Neither adapter adds a verb. */
    actions: readonly GridAction<T>[];
    /** Run it. Wire to `useActionPress`'s `press` so every surface runs the same sequence. */
    onSelect: (action: GridAction<T>, rows: T[]) => void;
    /**
     * Rows that are not records — a group row, a family footer, an AG pinned total. They get no verbs
     * at all rather than verbs that would act on an id that is not one.
     */
    isRecord?: (row: T) => boolean;
}
/**
 * The `⋯` column's items, for `actionsColumn({ items })`.
 *
 * 🔴 A DISABLED verb is kept WITH its reason — a greyed-out, silent entry is the trap
 * `reference_disabled_control_cannot_explain` names. The DS description is a wrapping, keyboard-
 * reachable second line; title stays supplementary. AG has only tooltip, so the visible reason
 * lives in the same row's DS menu. Neither adapter reorders the registry's verbs.
 */
export declare function actionMenuItems<T>(o: MenuAdapterOptions<T>): (row: T) => MenuItemDef[];
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
export declare const KEPT_AG_MENU_ITEMS: readonly DefaultMenuItem[];
/** AG's defaults, filtered to the clipboard entries — and separators, which only separate. */
export declare function keepClipboardItems(items: readonly (DefaultMenuItem | AgMenuItemDef<unknown>)[]): (DefaultMenuItem | AgMenuItemDef<unknown>)[];
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
export declare function actionContextMenu<T>(o: MenuAdapterOptions<T>): (p: GetContextMenuItemsParams<T>) => (DefaultMenuItem | AgMenuItemDef<T>)[];
