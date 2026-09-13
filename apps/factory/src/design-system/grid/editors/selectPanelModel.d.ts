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
