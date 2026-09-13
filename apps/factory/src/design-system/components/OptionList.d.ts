import { type ReactNode } from 'react';
/**
 * OptionList — the checkbox option list, declared ONCE.
 *
 * WHY THIS EXISTS
 * `MultiSelect` (the accordion's picker) and `GridSetFilter` (the same filter inside AG's column
 * menu) rendered this list TWICE: the same `nds-combo-search` box, the same `nds-ms-opt` rows, the
 * same `nds-combo-empty`, the same `searchOptions()` ranking — duplicated JSX, kept in step by
 * hand. `grid/theme/grid.css` states the promise the duplication was meant to keep: *"the list
 * reuses the MultiSelect option rows … so a filter in the header menu reads exactly like the same
 * filter in the accordion."* It reused the CSS CLASSES, not the component.
 *
 * The drift was already real when this was extracted (2026-08-31): `MultiSelect` had a Select-all
 * row and `GridSetFilter` did not, so the Brand filter in the accordion and the Brand filter in the
 * column menu — which that comment promises are the same control — behaved differently. A shared
 * class name keeps two files LOOKING the same while they diverge in behaviour, and no CSS-level
 * guard can see it.
 *
 * WHAT EACH SIDE KEEPS
 * This component owns the search box, the Select-all row, the option rows and the empty state.
 * The SHELL stays with the caller, because the two shells genuinely differ: `MultiSelect` scrolls
 * the whole popover (`.nds-ms-pop`), while the grid filter keeps its search box fixed above a
 * scrolling list (`.nds-ag-filter-list`) and adds a Clear footer. `listClassName` is that seam —
 * the caller names the scroll container, and everything inside it is identical by construction.
 *
 * THE SEARCH QUERY IS INTERNAL. Both callers unmount this component when their popup closes, so
 * the query resets on close without either of them tracking it. `MultiSelect` previously cleared
 * it on Escape only, which meant a click-away left the next open pre-filtered.
 */
export interface OptionListItem {
    value: string;
    label: ReactNode;
}
export interface OptionListProps {
    options: OptionListItem[];
    value: string[];
    onChange: (next: string[]) => void;
    /** Force the search box; it otherwise appears past `SEARCH_THRESHOLD` options. */
    searchable?: boolean;
    searchPlaceholder?: string;
    /** Class for the scroll container the rows live in — the caller owns the shell. */
    listClassName?: string;
    /** The Select-all row. On by default: both callers want it, and that is the point. */
    selectAll?: boolean;
    emptyLabel?: string;
}
/** Past this many options a picker gets a search box without being asked. */
export declare const SEARCH_THRESHOLD = 7;
export declare function OptionList({ options, value, onChange, searchable, searchPlaceholder, listClassName, selectAll, emptyLabel, }: OptionListProps): import("react/jsx-runtime").JSX.Element;
