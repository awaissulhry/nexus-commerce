/**
 * The Customise dialog's LOGIC, pure — what a tick, a lock, a drag and a bulk pick do to a
 * `PreferencesValue`. Extracted from `usePreferencesPanes` (2026-09-05, the lock contract) so the
 * rules are tested in node rather than trusted, and so the modal and the popover cannot drift.
 *
 * Vocabulary (see `PreferencesModal.tsx`):
 *   - STRUCTURAL lock — `PreferencesColumnSpec.locked`: the grid's own pinned column, no control.
 *   - OPERATOR lock — a key in `value.lockedColumns` (falling back to the specs' `defaultLocked` when
 *     the value predates the control): FROZEN at the left of the scrolling band, always visible, in a
 *     block right after the structural leading columns, in the order the operator locked them.
 *   - a lock implies visible: locking a hidden column shows it; a locked column cannot be unticked.
 */
import type { PreferencesColumnSpec, PreferencesValue } from './PreferencesModal';
export interface AttributeGroup {
    key: string;
    label: string;
    columns: PreferencesColumnSpec[];
}
/** Resolve the complete layout, including hidden attributes. Group IDs belong to the schema. */
export declare function resolveAttributeGroups(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, listLabel?: string): AttributeGroup[];
/** Move a set together without changing visibility or pins. Unknown groups/structural keys are refused. */
export declare function moveAttributesToGroup(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, keys: readonly string[], targetGroup: string): PreferencesValue;
/** Group moves keep their attributes together; before/after is explicit for keyboard controls. */
export declare function moveAttributeGroup(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, key: string, target: string, after?: boolean): PreferencesValue;
/** Reorder a scrolling attribute, moving its display group when dropped into another group. */
export declare function moveAttributeColumn(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, key: string, target: string, after?: boolean): PreferencesValue;
/** Reset only the selected attributes' group assignment, preserving their values, visibility and pins. */
export declare function resetAttributeGroups(value: PreferencesValue, keys: readonly string[]): PreferencesValue;
/** The grouped dialog's visual order, flattened for hosts that render ordinary grid columns. */
export declare function normalizeGroupedPreferences(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, listLabel?: string): PreferencesValue;
/** The operator's locks, or where they start if this value predates the control. */
export declare function effectiveLocks(value: Pick<PreferencesValue, 'lockedColumns'>, defaultLocked: readonly string[]): string[];
/** Keys the operator may tick, drag or lock: every spec that is not structurally locked. */
export declare function togglableKeysOf(allColumns: readonly PreferencesColumnSpec[]): string[];
/** Tick or untick one column. A locked column is not unticked — a lock implies visible. */
export declare function toggleColumn(value: PreferencesValue, key: string, defaultLocked?: readonly string[]): PreferencesValue;
/**
 * Add a SET (a group's columns, a quick pick). Only keys in `togglable` and not already visible are
 * appended, in the given order; a set that adds nothing returns the same value (referentially), so
 * a caller can tell "nothing to do" from "done".
 */
export declare function addColumns(value: PreferencesValue, keys: readonly string[], togglable: ReadonlySet<string>): PreferencesValue;
/** Remove a SET. Locked columns are never removed — a lock implies visible. */
export declare function removeColumns(value: PreferencesValue, keys: readonly string[], defaultLocked?: readonly string[]): PreferencesValue;
/**
 * Is a SET fully in view? Only the keys this grid has and the operator may toggle count, so a pick
 * naming a column this product type lacks still reads "pressed" once every applicable column is in.
 * An empty applicable set is never "pressed" — a control that lights for nothing is lying.
 */
export declare function setHas(value: PreferencesValue, keys: readonly string[], togglable: ReadonlySet<string>): boolean;
/**
 * Lock or unlock one column.
 *
 * LOCK: appended to the lock set (so the frozen block keeps the order the operator locked in) and
 * made visible — a lock implies visible. UNLOCK: removed from the set and moved to the FRONT of the
 * visible order, so it lands right after the frozen block where the operator was looking, rather
 * than jumping back to wherever it sat before it was locked.
 */
export declare function toggleLock(value: PreferencesValue, key: string, defaultLocked: readonly string[]): PreferencesValue;
/**
 * Drag one row onto another in the "In view" list.
 *
 * Two orders live in one list: the frozen block is `lockedColumns`, the rest is `visibleColumns`.
 * A drop is honoured only WITHIN a block — a locked row may not be dragged out of the frozen block
 * (that is what the padlock is for) and an unlocked row may not be dropped into it. A refused drop
 * returns the same value, so the caller can leave the list exactly as it was.
 */
export declare function moveVisible(value: PreferencesValue, dragKey: string, targetKey: string, defaultLocked: readonly string[], 
/** Which edge a lock freezes a column to (default left); a drop across the two edges is refused. */
sideOf?: (key: string) => 'left' | 'right'): PreferencesValue;
/**
 * The "In view" order the dialog renders: structural leading → the operator's frozen block (in
 * `lockedColumns` order) → visible (draft order, locks excluded) → hidden → the operator's
 * RIGHT-side locks (`lockSide: 'right'`, e.g. an actions bookend) → structural trailing.
 * Structural columns keep their place from `allColumns` (leading = before the first togglable spec,
 * trailing = after the last), exactly as the grid's own lead/trail bridge reads them. The list reads
 * in SCREEN order — measured 2026-09-05 on /products/next: a right-frozen `actions` listed at the TOP
 * with the left locks said the opposite of what the grid showed.
 */
export declare function orderedForDisplay(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, defaultLocked: readonly string[]): PreferencesColumnSpec[];
/**
 * "In view · n of N": n = every non-structural column on screen (visible OR locked — a lock implies
 * visible), N = every non-structural column the grid has. Locking a column must not shrink either
 * side (measured 2026-09-05: "10 of 12" read "9 of 11" after one lock, because the denominator was
 * the TOGGLABLE set, which a lock leaves).
 */
export declare function inViewCount(allColumns: readonly PreferencesColumnSpec[], value: PreferencesValue, defaultLocked: readonly string[]): {
    shown: number;
    total: number;
};
