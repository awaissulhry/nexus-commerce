import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
export interface AxisChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
    /** The axis as the operator names it — "Colore", "Taglia". */
    label: ReactNode;
    /**
     * Trailing count. A string or number is wrapped in a neutral `Tag` ("2 values"), which is what
     * the design asks for; a node is rendered as given, for the caller that needs another tone.
     */
    count?: ReactNode;
    /** Engaged — emits `aria-pressed`, which is also what drives the visual. */
    pressed?: boolean;
    /**
     * Spread onto the GRIP: `draggable`, `onDragStart`, `onDragEnd`, pointer handlers. The grip is a
     * `<span>`, never a nested `<button>` — a button inside a button is invalid and the chip itself
     * is the button.
     */
    dragHandleProps?: HTMLAttributes<HTMLSpanElement>;
    /** Hide the grip on a chip that cannot be reordered (a single axis). Default: shown. */
    grip?: boolean;
}
/**
 * VP.5 — `AxisChip`: one shared variation axis in the Variants page's family band.
 *
 * Spec `docs/2026-09-11-variants-page-spec.md` §3.1, canvas artboard 1:
 *
 *     ⠿ Colore  [2 values]     ×     ⠿ Taglia  [10 values]
 *
 * A `<button>`, because clicking it opens the *Manage shared axes* modal, and 28px
 * (`--nds-control-h-sm`) because every control in a 40px band is on the `sm` tier — the rule
 * `scripts/check-control-census.mjs` enforces. Radius `--nds-radius-lg`, hairline
 * `--nds-border`, focus and pressed lifted from `.nds-btn` so it cannot drift from the buttons
 * standing beside it.
 *
 * It is NOT `FilterChip`: that is a `radius-full` capsule that TOGGLES a facet and tints blue when
 * engaged, and an axis chip neither filters nor toggles. It is NOT `Tag`: a tag is a static span,
 * and this one is pressed, focused, dragged and opens a dialog. The count inside it IS a `Tag`,
 * which is exactly what a tag is for.
 *
 * The grip is a slot rather than a behaviour: the chip does not know whether its list is
 * reorderable, and `OrderedList` already owns the DS's drag idiom. Give it `dragHandleProps` and
 * the handle drags; give it nothing and the grip is an affordance the row's own drag provides.
 */
export declare function AxisChip({ label, count, pressed, dragHandleProps, grip, className, ...rest }: AxisChipProps): import("react/jsx-runtime").JSX.Element;
