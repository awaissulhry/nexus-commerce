import type { ButtonHTMLAttributes, ReactNode } from 'react';
export interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
    /** engaged — emits `aria-pressed`, which is also what drives the visual */
    pressed?: boolean;
    /** trailing count, e.g. how many rows this facet matches */
    count?: ReactNode;
    /** small trailing badge for an exceptional state, e.g. "3 failed" */
    badge?: ReactNode;
    /**
     * `md` sizes the chip to a 40px bar beside `sm` buttons (28px, `--nds-control-h-sm`) — the same
     * `md` the Pill uses for that seat. Default is the 24px filter-row chip.
     */
    size?: 'md';
    /** Short visible label in a constrained sheet toolbar; keep the full accessible name. */
    compactLabel?: ReactNode;
    children: ReactNode;
}
/**
 * A chip that TOGGLES a filter. Two surfaces hand-rolled it (`.h10-cl-sum .chip`, `.hl-fchip`)
 * because `Pill` and `Tag` are static spans and `Button active` is a rectangular radius-lg fill,
 * not a tinted capsule.
 *
 * NOT `.esm-chip`, which an earlier version of this comment wrongly claimed — a session caught
 * it. That is a two-action token (the label applies a preset, a separate button deletes it), and
 * this component IS a `<button>`, so a remove control inside it would be a button nested in a
 * button. Use `TokenChip`.
 *
 * The two measurable ones agree on the shape — white fill, hairline border, `--nds-radius-full`
 * — so the capsule here is unanimous, not a pick. They disagree on the engaged TEXT, and one of
 * them is wrong: `.hl-fchip.on` is blue-600 on blue-50, **4.36:1, under AA**. This uses blue-900
 * at 7.41:1, which is what `.h10-cl-sum .chip.on` already does and what the DS pill palette
 * already encodes.
 *
 * The failure badge rises too: #a3211a on #fbdedb (5.94:1) → the DS note-error pair at 9.23:1.
 */
export declare function FilterChip({ pressed, count, badge, size, compactLabel, children, className, ...rest }: FilterChipProps): import("react/jsx-runtime").JSX.Element;
