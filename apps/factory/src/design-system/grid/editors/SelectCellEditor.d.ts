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
/** The same lucide `ChevronDown` every other DS select uses — one glyph convention, not a new one. */
export declare function SelectChevron(): import("react/jsx-runtime").JSX.Element;
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
