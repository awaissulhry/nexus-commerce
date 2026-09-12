import { type HTMLAttributes, type ReactNode } from 'react';
export interface Column<T> {
    key: string;
    label: ReactNode;
    render: (row: T) => ReactNode;
    align?: 'left' | 'right' | 'center';
    /**
     * A figures column: right-aligned AND `font-variant-numeric: tabular-nums`.
     *
     * Not implied by `align: 'right'`, because a right-aligned STATUS is not a number. Measured:
     * the DS set `font-variant-numeric` on no selector at all, so every converted money column
     * silently lost the proportional-digit fix its hand-rolled version had — and in a grid,
     * digits lining up is the whole point.
     */
    numeric?: boolean;
    /**
     * Class for this column's `<td>` AND `<th>`. Without it a per-column tweak has to be reached
     * with `:nth-child()`, which breaks the moment a column is hidden or reordered.
     */
    className?: string;
    sortable?: boolean;
    sortValue?: (row: T) => number | string;
    /**
     * Hold this column in place in the Customise dialog — never hidden, never dragged — WITHOUT
     * pinning it to an edge. Position picks the end it holds: past the last movable column it
     * locks to the right, anywhere else to the left. Ignored unless `customizable`.
     */
    prefsLocked?: boolean;
    /** pin this column to the left (sticky); give a numeric `width` so offsets stack */
    sticky?: boolean;
    /** pin this column to the right (sticky); give a numeric `width` so offsets stack */
    stickyRight?: boolean;
    width?: number;
    /** value rendered in the totals row */
    total?: ReactNode;
    /**
     * Plain-text name for the Customise dialog. Only needed when `label` is not a
     * string — most grids here pass JSX (`<Hdr …/>`, `<TipText>…</TipText>`), and
     * a dialog row reading "sku" instead of "SKU" is a worse lie than a verbose
     * prop. Falls back to `label` when it is a string, then to `key`.
     */
    prefsLabel?: string;
}
export interface DataGridProps<T> {
    columns: Array<Column<T>>;
    rows: T[];
    rowKey: (row: T) => string;
    selectable?: boolean;
    selected?: Set<string>;
    onSelectedChange?: (next: Set<string>) => void;
    /** Per-row selection gate (additive): rows where this returns false render a
     *  disabled checkbox and are excluded from select-all. Absent = all rows
     *  selectable (existing behavior — /products/next unchanged). */
    rowSelectable?: (row: T) => boolean;
    /** Tooltip/aria label for a disabled row checkbox. */
    rowSelectableHint?: string;
    /** SCT.1 — hover help for the select-all checkbox (what "all" means here). */
    selectAllHint?: string;
    /** SCT.1 — hover help for a row checkbox. */
    selectRowHint?: string;
    showTotals?: boolean;
    emptyState?: ReactNode;
    /**
     * Render an extra full-width row beneath a row. Return `null`/`undefined` for rows that do not
     * expand; the sub-row is only rendered when `rowKey(row)` is in `expanded`.
     *
     * The GRID owns the `colSpan`, because only it knows the column count — which shifts with
     * `selectable` and with hidden columns, and is exactly the number every hand-rolled version got
     * wrong the moment a column was toggled. The CALLER owns the caret: put it in whichever cell it
     * belongs to, with its own `aria-expanded` — the caret pattern `CampaignsTable` uses today for
     * its own hand-rolled expansion. (It does NOT use this prop; the precedent is the CARET, not
     * the expansion.)
     *
     * Renders ONE full-width cell. For children that must line up under the SAME columns as their
     * parent — a campaign's spend under the same Spend header — use `getSubRows` instead.
     */
    renderExpanded?: (row: T) => ReactNode;
    /** Keys of the currently expanded rows. Controlled — the grid keeps no expansion state. */
    expanded?: Set<string>;
    /**
     * Extra props for each `<tr>` — drag handlers, data-*, title.
     *
     * `rowClassName` covers appearance only; a grid whose ROWS are drop targets needs real
     * handlers. The portfolios list spreads onDragOver/onDragLeave/onDrop onto each row so a rule
     * can be dragged onto a family, and could not adopt the grid without this.
     */
    rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement>;
    /**
     * Extra props for each `<th>` — pointer handlers and `data-*`.
     *
     * Drag-to-reorder columns needs `onPointerDown`/`onMouseEnter`/`onMouseLeave` on the header and
     * `data-col` readable back off the DOM. Without these a grid that already ships column dragging
     * cannot adopt `DataGrid` without DELETING that behaviour.
     */
    headerProps?: (column: Column<T>, index: number) => HTMLAttributes<HTMLTableCellElement>;
    /** Extra props for each `<td>` — the same drag code reads `data-item`/`data-col` off cells. */
    cellProps?: (row: T, column: Column<T>, index: number) => HTMLAttributes<HTMLTableCellElement>;
    /**
     * Children rendered as REAL rows beneath their parent, using the SAME columns — so a child's
     * spend sits under the same Spend header as its parent's.
     *
     * `renderExpanded` gives one full-width cell, which cannot express that. The workaround was
     * flattening parents and children into one `rows` array with a `kind` union and `sort={null}`,
     * which works but costs the grid its sorting. Shown only for rows in `expanded`.
     */
    getSubRows?: (row: T) => T[] | undefined;
    /**
     * Let `getSubRows` children carry their own selection checkbox, and count them in select-all
     * while they are visible. Off by default: the grids using `getSubRows` with `selectable`
     * today render an EMPTY checkbox cell for children, and `rowSelectable` still gates each one.
     */
    subRowSelectable?: boolean;
    /**
     * Row density. `md` (default) is 13px with 11px/14px cells; `sm` is 12.5px / 7px 10px; `xs` is
     * 11.5px / 5px 9px, matching the tier every other control gained.
     *
     * Measured against five real tables: 12px/11px 14px, 12.5px/7px 10px, 12.5px/6px 11px,
     * 11px/6px 10px, 11.5px/5px 9px. At one density the grid added up to 12px per row, which on a
     * page of six stacked tables is the difference between a page and a scroll.
     *
     * It scales UP as well: `lg` (14px) and `xl` (19px) vertical padding. A grid with no density
     * above its default cannot host a density control at all, and the campaigns grid ships a live
     * Compact / Comfortable / Spacious switch whose two looser steps had no DS equivalent.
     */
    size?: 'xl' | 'lg' | 'md' | 'sm' | 'xs';
    initialSort?: {
        key: string;
        dir: 'asc' | 'desc';
    };
    /**
     * Controlled sort (NAF.SB.AS-S1R S1.e — additive, opt-in).
     *
     * Pass `sort` AND `onSortChange` to own the sort state yourself: the grid
     * then renders the order you give it and reports header clicks instead of
     * keeping its own. That is what lets a page put its sort in the URL, choose
     * which direction a first click means per column, or offer a "back to the
     * default order" control — none of which are reachable while the state lives
     * in here.
     *
     * Omit both (every existing consumer) and nothing changes: the grid keeps its
     * own state seeded from `initialSort`, exactly as before. `undefined` means
     * uncontrolled; `null` means controlled-and-currently-unsorted, which is a
     * real state — it renders `rows` in the order they were passed.
     */
    sort?: {
        key: string;
        dir: 'asc' | 'desc';
    } | null;
    onSortChange?: (next: {
        key: string;
        dir: 'asc' | 'desc';
    }) => void;
    /**
     * Per-row class (NAF.SB.M-S3 — additive, opt-in).
     *
     * For pages whose law is *filtering dims, it never removes*: the row stays in
     * the table, in order, and recedes. Returning nothing (every existing
     * consumer) changes nothing. It composes with the built-in `sel` class rather
     * than replacing it.
     *
     * Deliberately a class and not a style, so the page owns what "dimmed" means
     * — a table that greys a row to unreadability has removed it in every sense
     * that matters to the reader.
     */
    rowClassName?: (row: T) => string | undefined;
    /** cap height + scroll (sticky header/footer stay pinned) */
    maxHeight?: number | string;
    className?: string;
    /**
     * Column order + visibility as OPERATOR preferences (additive, opt-in).
     *
     * Omit it and nothing changes: `columns` renders in array order, exactly as
     * every consumer before this. Pass it and the grid gains the same Customise
     * dialog `AdsDataGrid` has had since SGX3 — the same `PreferencesModal`, so
     * the product has one Customise UI rather than a second spelling of it.
     *
     * Pinned columns (`sticky` / `stickyRight`) are **locked**: reorderable in
     * neither direction. The DS pins per column with offsets stacked by `width`,
     * which presumes pinned columns sit contiguously at an edge; the dialog pins
     * positionally. A developer-pinned column dragged into the middle would pin
     * over its neighbours, so the dialog holds them at the ends instead.
     */
    customizable?: boolean;
    /**
     * localStorage key for those preferences. Without it `customizable` still
     * works, but the operator's order dies with the page — so pass it.
     */
    storageKey?: string;
    /**
     * Controlled dialog state, for pages that already host their own Customise
     * button in a toolbar. Omit both and the grid renders its own trigger.
     */
    customizeOpen?: boolean;
    onCustomizeOpenChange?: (open: boolean) => void;
    /** Dialog heading + trigger label (default "Customise"). */
    customizeTitle?: string;
}
/**
 * The universal data grid (`.nds-grid`; the richer `.nds-wsgrid` is the ads console's): sortable headers, row selection
 * with select-all, sticky header, pinned left columns, an optional sticky totals
 * row, and an empty state. Generic over the row type.
 */
export declare function DataGrid<T>({ columns, rows, rowKey, selectable, selected, onSelectedChange, rowSelectable, rowSelectableHint, selectAllHint, selectRowHint, showTotals, emptyState, renderExpanded, expanded, rowProps, size, headerProps, cellProps, getSubRows, subRowSelectable, initialSort, sort: controlledSort, onSortChange, rowClassName, maxHeight, className, customizable, storageKey, customizeOpen, onCustomizeOpenChange, customizeTitle, }: DataGridProps<T>): import("react/jsx-runtime").JSX.Element;
