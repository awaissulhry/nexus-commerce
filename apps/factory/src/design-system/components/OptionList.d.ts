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
    /**
     * The fewest options that may stay selected (Step 4.3 #2 — a content-language picker can never
     * drop to none). Default 0 = today's behaviour for every caller. An option that would break the
     * minimum stays checked, focusable and announced (`aria-disabled` + its title) and ignores the
     * toggle; the Select-all row is not offered, because its "clear all" half would break it.
     */
    minSelected?: number;
    /** Text the search field starts with — the key that opened a grid cell by typing (AG's `eventKey`). */
    initialQuery?: string;
    /**
     * The list is open (an eBay FREE_TEXT aspect with suggestions): a typed value no option spells is offered as an
     * `Add "…"` row at the top, ticked like any other (the same rule as `ListboxPanel.allowCustom`).
     */
    allowCustom?: boolean;
    /**
     * With `allowCustom`: the typed text a grid's Enter should save — set while NO option matches it (the Add row is then
     * the only row, as in `ListboxPanel`), `''` otherwise, so a search used to find an option never adds itself.
     */
    onCustomDraft?: (text: string) => void;
}
/** The next selection after toggling `v`, never dropping below `minSelected`. PURE. */
export declare function nextSelection(value: readonly string[], v: string, minSelected?: number): string[];
/** Past this many options a picker gets a search box without being asked. */
export declare const SEARCH_THRESHOLD = 7;
export declare function OptionList({ options, value, onChange, searchable, searchPlaceholder, listClassName, selectAll, emptyLabel, minSelected, initialQuery, allowCustom, onCustomDraft, }: OptionListProps): import("react/jsx-runtime").JSX.Element;
