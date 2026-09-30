import type { ColDef } from 'ag-grid-community';
import type { ListboxOption } from '../../components';
export interface SelectEditorParams {
    options: ListboxOption[];
    placeholder?: string;
}
/**
 * The `ColDef` fragment: editable, AG's rich select, its options.
 *
 * 🔴 The column's VALUE is the code (`'PK'`), the operator reads the label (`'Pakistan'`), and
 * `formatValue` is the only thing that bridges them — it drives the closed display, every row of
 * the open list, AND what `searchType` matches against, so typing "Pak" finds a value spelled
 * "PK". Losing it would leave an operator picking country codes out of a list of 268.
 *
 * `cellEditorPopup` is deliberately NOT set: the rich select declares `isPopup()` itself, and
 * pinning it here would override the editor's own answer. Popups parent to `document.body`
 * (`NexusGrid`'s `popupParent`), so the list is clamped to the window rather than to a grid box
 * that can run past the fold.
 */
/**
 * D13 — the affordance a closed list wears AT REST.
 *
 * 🔴 The Owner: *"the status column… should really be a dropdown."* It already was one — the wire
 * sends `kind: 'select'` with `[ACTIVE, DRAFT, INACTIVE]` and the editor mounts AG's rich select on
 * Enter. **What was missing was any way to know that without trying it.** A closed-list cell and a
 * free-text cell rendered identically at rest, so the only way to discover the list was to guess.
 *
 * That is the same class as a disabled control that cannot explain itself: the capability existed
 * and the operator had no way to see it.
 *
 * Lives in the ENGINE, beside the editor it advertises, so a lane cannot ship a select column
 * without the affordance — and so the two can never disagree about which columns are closed lists.
 * DS.2 owns the look (`grid.css`: `.nds-cell-is-select` cursor, `.nds-ag-chev` glyph, deliberately
 * at full strength — an informative glyph is not dimmed).
 */
export declare const SELECT_CELL_CLASS = "nds-cell-is-select";
/** The row that empties a list from its editor — one label for every list (`selectPanelModel.ts`). */
export { SELECT_CLEAR_LABEL } from './selectPanelModel';
/**
 * The same lucide `ChevronDown` every other DS select uses — one glyph convention, not a new one.
 *
 * With `onOpen` it is the list's button: one click opens the editor. It was a picture that looked like one (and the
 * cell wears `cursor: pointer`), so a click only selected the cell and the list needed a double-click (P0, measured in
 * production 2026-09-29). It stays `aria-hidden`: the keyboard opens the list with Enter or F2 on the focused cell.
 */
export declare function SelectChevron({ onOpen }?: {
    onOpen?: () => void;
}): import("react/jsx-runtime").JSX.Element;
type StartsEditing = {
    startEditingCell(params: {
        rowIndex: number;
        colKey: string;
        rowPinned?: 'top' | 'bottom' | null;
    }): void;
};
type EditedNode = {
    rowIndex: number | null;
    rowPinned?: 'top' | 'bottom' | null;
};
/**
 * `onOpen` for a cell's chevron: start editing that cell, exactly as a double-click would. `undefined` for a cell AG
 * will not edit (`column.isCellEditable`), so a locked cell wears the passive glyph: the action chevron showed a pointer
 * there, `startEditingCell` silently did nothing and no reason was given (audit B21). A click then selects the cell, as
 * on any locked cell, and a double-click or Enter explains why.
 */
export declare function openCellEditor(api: StartsEditing, node: EditedNode, colKey: string): () => void;
export declare function openCellEditor<N extends EditedNode>(api: StartsEditing, node: N, colKey: string, column: {
    isCellEditable(node: N): boolean;
} | null | undefined): (() => void) | undefined;
/**
 * 🔴 AG.1-f — this now mounts the DS `ListboxPanel` inside AG's popup, NOT `agRichSelectCellEditor`.
 *
 * Measured against D18, three requirements could not be expressed through `IRichCellEditorParams`:
 * content-fitted width, right-align-on-overflow, and a conditional flip. The width one is the
 * Owner's actual complaint — `valueListMaxWidth` is not a maximum, AG writes it inline as
 * `width / min-width / max-width` all pinned to one value, so a **7-option** list and a
 * **268-option** list both rendered at exactly **320×240** against a 130px cell. The DS popover
 * already resolves `clamp(anchor, content, 320)` and owns the placement rules, so the geometry lives
 * there and `SelectPanelEditor` is the AG integration.
 *
 * `cellEditorPopup` is still deliberately NOT set: the editor declares `isPopup()` itself, and
 * pinning it here would override the component's own answer. Popups parent to `document.body`
 * (`NexusGrid`'s `popupParent`), so the panel clamps to the window rather than to a grid box that
 * can run past the fold.
 *
 * `placeholder` is kept in the signature — every call site passes it and the DS panel will take it
 * when `ListboxPanel` grows a placeholder row; dropping the parameter would silently discard what
 * ~23 columns already say about their empty state.
 */
export declare const selectEditor: (options: ListboxOption[], placeholder?: string) => Pick<ColDef, "editable" | "cellEditor" | "cellEditorParams" | "cellEditorPopup" | "cellEditorPopupPosition">;
