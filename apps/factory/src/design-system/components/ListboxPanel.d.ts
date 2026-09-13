/**
 * ListboxPanel — the closed-list popover panel, with no trigger and no opinion about where it sits.
 *
 * Extracted from `Listbox` for D18 so the grid's `=`-mode editor and the studio's selects render the
 * SAME panel rather than two that resemble each other. `Listbox` is now this plus a trigger; AG's
 * custom cell editor is this plus AG's own mounting. One implementation, one look.
 *
 * 🔴 THIS COMPONENT DOES NOT POSITION ITSELF, and that is deliberate rather than an omission.
 * `position` comes from `style`, which whoever owns placement supplies — `Listbox` passes
 * `usePopoverPosition`'s output; AG passes coordinates for its own popup. `.nds-combo-pop`
 * deliberately no longer declares `position: fixed`, because a class that positions itself is wrong
 * for any consumer that is not the one it was written for: inside AG's absolutely-positioned popup a
 * `fixed` child anchors to the VIEWPORT, ignores AG's placement and does not move when the popup
 * does (AG.1, D18 gotcha 4). It would look correct in isolation and be wrong in the grid.
 *
 * 🔴 IT OWNS ITS OWN KEYBOARD, and that is also the fix for a bug that did not exist yet. In
 * `Listbox` the handler sat on the wrapper `div` and reached the portalled panel only because React
 * propagates events through the REACT tree, not the DOM tree. Mounted by anyone outside that tree —
 * exactly what AG does — the panel would have had no keyboard support and thrown no error. Behaviour
 * that is a property of the tree rather than of the component vanishes silently when the tree
 * changes, so it lives here now.
 *
 * 🔴 IT ALWAYS HAS A FOCUS TARGET. The only focus management used to be `autoFocus` on the search
 * input, and D18 hides that below 9 options — so on exactly the short lists D18 simplified there
 * would have been nothing focusable and the arrow keys would have landed nowhere. The container is
 * `tabIndex={-1}` and takes focus when there is no search field.
 *
 * 🔴 THE HIGHLIGHT CAN BE DRIVEN FROM OUTSIDE (`activeIndex`), and that exists because owning the
 * keyboard is not the same as being ABLE to receive it. `FormulaCellEditor` keeps DOM focus in the
 * cell's input — the operator is typing a formula — so this panel's own `onKeyDown` never fires, and
 * two attempts to forward the keys to it failed on the live page (a React handler cannot
 * `stopPropagation` past AG's lower native listener; a re-dispatching capture listener recursed).
 * The editor therefore had to drop ↑/↓ and ship Tab-accepts-best-match instead
 * (`FormulaCellEditor.tsx`, the keyboard note). An external index is the fix that does not race
 * anyone: whoever holds focus reads the keys it already receives and tells the panel what is
 * highlighted. Leave it undefined and nothing about this component changes.
 *
 * Requires `styles/components.css`.
 */
import { type CSSProperties } from 'react';
import type { ListboxOption } from './Listbox';
/**
 * Past this many options the panel offers its own search field (D18: search at 9+, so the field
 * appears when there are MORE than 8). Below it the list is short enough to read.
 */
export declare const LISTBOX_SEARCH_THRESHOLD = 8;
export interface ListboxPanelProps {
    options: ListboxOption[];
    /** the currently selected value; highlighted and scrolled into view on mount */
    value?: string;
    /** the operator chose an option */
    onCommit: (value: string) => void;
    /** Escape, or any other reason the owner should close without changing anything */
    onCancel: () => void;
    /**
     * Filter the list from OUTSIDE, and render no search field of the panel's own.
     *
     * For a caller that already has the text the operator is typing — the grid's `=`-mode editor
     * filters `$column` autocomplete from a cell the operator is typing INTO, so a second input
     * inside the panel would be a second place to type. Leave it undefined and the panel owns its
     * own query, with the field appearing past `LISTBOX_SEARCH_THRESHOLD`.
     */
    query?: string;
    /** force the panel's own search field below the threshold */
    searchable?: boolean;
    searchPlaceholder?: string;
    /** a "nothing selected" row at the top of the list */
    emptyLabel?: string;
    /**
     * Take DOM focus on mount. Default true — without it the arrow keys have nowhere to land. AG
     * focuses its own popup on open, so it can pass `false` to yield rather than have the two fight.
     */
    autoFocus?: boolean;
    /** Placement, supplied by whoever owns it. See the note above on why this is not optional in practice. */
    style?: CSSProperties;
    className?: string;
    /**
     * The panel's DOM node, for whoever measures it to place it. `Listbox` hands this to
     * `usePopoverPosition`; AG uses it for its own popup sizing.
     */
    panelRef?: React.Ref<HTMLDivElement>;
    /**
     * Drive the highlight from OUTSIDE. Undefined — the default — leaves the panel exactly as it was:
     * it keeps its own index, resets it when an external `query` changes, and moves it on ↑/↓ when it
     * has focus.
     *
     * Supplied, the panel is controlled: it renders this index, never sets its own, and scrolls that
     * row into view when the number changes (the caller cannot — the scroll container is in here).
     * An index past the end of the list highlights nothing rather than throwing; the caller learns the
     * real length from `onMatchesChange`, which is also the ONLY honest way to index this list, because
     * the panel re-ranks and groups what it is given (`searchOptions` + `groupOptions`) and a caller
     * counting its own array would be counting a different one.
     */
    activeIndex?: number;
    /** The panel's own ↑/↓ moved the highlight. Fires in both modes; controlled callers store it. */
    onActiveIndexChange?: (index: number) => void;
    /** The flat, ranked, grouped list this panel is actually showing — index space for `activeIndex`. */
    onMatchesChange?: (matches: readonly ListboxOption[]) => void;
    /**
     * Give every option a stable DOM id (`${idPrefix}-o${index}`), so a caller keeping focus in its own
     * field can point `aria-activedescendant` at the highlighted row. Without this a screen reader
     * follows focus, which never moves, and hears nothing as the operator walks the list.
     */
    idPrefix?: string;
    /** Accessible name when embedded beneath an autocomplete input. */
    ariaLabel?: string;
    /** A combobox input can own keyboard focus while its options stay out of the Tab order. */
    optionTabIndex?: number;
}
export declare function ListboxPanel({ options, value, onCommit, onCancel, query, searchable, searchPlaceholder, emptyLabel, autoFocus, style, className, panelRef, activeIndex, onActiveIndexChange, onMatchesChange, idPrefix, ariaLabel, optionTabIndex, }: ListboxPanelProps): import("react/jsx-runtime").JSX.Element;
