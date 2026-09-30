/**
 * GDS — the value boundary between a sheet cell and the DS `ListboxPanel` (AG.1-f, spec D18).
 *
 * ## Why this is a separate `.ts` with no imports
 *
 * `apps/web`'s vitest runs in a node environment and cannot render a component, so a rule living
 * inside the editor `.tsx` can only be asserted, never tested — the same split as `longTextState.ts`
 * and `provenance.ts`. What is testable here is the CONVERSION, which is where the bugs live: the
 * cell speaks the wire's language (`null`, a code like `'PK'`) and the panel speaks the DOM's
 * (`undefined`, a string), and those two vocabularies do not agree about "nothing".
 *
 * 🔴 **`null` and `''` and `undefined` are one state to an operator and three to the code.** The
 * cell may hold any of them for "not set"; the panel highlights an option only for a defined
 * string. Collapsing them at the boundary — once, here — is what stops each consumer inventing its
 * own answer, which is the shape that made a byte cap read as "no cap" one file over.
 */
/**
 * The row that empties a list, in every list of the sheets: select and yes/no cells, the category, product-type,
 * reference and policy pickers, and "Set every row…". It read "Clear", "Empty", "Not set" or "No policy selected"
 * depending on the list (audit B16).
 */
export declare const SELECT_CLEAR_LABEL = "Clear";
/** What the panel should highlight, given whatever the cell holds. `undefined` = nothing selected. */
export declare function panelValueOf(cellValue: unknown): string | undefined;
/**
 * What the cell should store, given what the operator chose.
 *
 * 🔴 `null`, not `''`, for the empty row. The sheet's write path treats them differently:
 * `writeGate` deliberately does NOT fold `''` into `null` (a cleared text cell and an unset one are
 * different intents on the wire), so returning `''` here would send an empty string where every
 * other "unset" on this sheet sends null.
 */
export declare function cellValueOf(chosen: string): string | null;
/**
 * Did the operator actually change anything?
 *
 * Used to decide between `stopEditing()` and `stopEditing(true)`: committing an unchanged value
 * would fire `cellValueChanged` for a no-op. `writeGate` would then suppress the write — but it
 * would also paint the cell `saving` for a frame and stamp `lastSavedAt`, which is a lie about
 * having saved something. Cheaper and more honest to cancel.
 */
export declare function isUnchanged(cellValue: unknown, chosen: string): boolean;
/**
 * The options a list editor shows: the stored value first when the list does not hold it, so it stays visible and can be
 * kept (a stored eBay brand, a value from an older category list). Without it the editor opened with nothing selected and
 * the value could not be seen, let alone kept (P0, 2026-09-30).
 */
export declare function withStoredValue<T extends {
    value: string;
    label: unknown;
}>(options: T[], cellValue: unknown, note: string): Array<T | {
    value: string;
    label: string;
    trailing: string;
}>;
/**
 * The printable key that opened the editor by typing (AG's `eventKey`), or `''` for Enter, F2, double-click and Space. A
 * space would start a search that highlights row 1, so Space then Enter replaced the stored value (code review 2026-09-30).
 */
export declare function typedStart(eventKey: string | null | undefined): string;
/**
 * AG's editor `stopEditing(suppressNavigateAfterEdit?, event?)`. It never cancels: it ENDS the edit with the value last
 * reported. `stopEditing(true)` read as "cancel" saved the abandoned edit — a measure's Escape saved it (audit B09,
 * 2026-09-30). A cancel is the grid API's `api.stopEditing(true)` (`GridCancel`).
 */
export type EditorStop = (suppressNavigateAfterEdit?: boolean, event?: KeyboardEvent) => void;
/** The grid API's own stop: `stopEditing(true)` is a real cancel, and no value is written. */
export type GridCancel = {
    stopEditing(cancel?: boolean): void;
};
/** The part of a React keyboard event `keepGridOffEnter` reads. */
type EnterEvent = {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    nativeEvent: {
        isComposing: boolean;
    };
    preventDefault(): void;
    stopPropagation(): void;
};
/**
 * For a popup editor's root, in the CAPTURE phase: the two Enters the grid must not get. An Enter that confirms an IME
 * composition is the operator's, not a save (audit B18). Ctrl/Cmd+Enter would make AG write this value into every cell of
 * the selected ranges, unfenced and unasked (audit B14); it saves this one cell and moves down, as Enter does. Every
 * other Enter is left to the grid, which ends the edit and moves down (GridSheet: "Enter commits and moves DOWN").
 * `true` = handled here.
 */
export declare function keepGridOffEnter(e: EnterEvent, stop: EditorStop): boolean;
export {};
