/**
 * SegmentedControl — a compact single-select toggle on a sunken track, the active
 * segment raised. The space-efficient alternative to a radio group or a row of tabs for
 * 2–4 mutually-exclusive view modes (e.g. List / Board, Live / Official). Accessible
 * `role="radiogroup"` with ArrowLeft/Right roving selection.
 *
 * 🔴 **It imports its own stylesheet.** The docblock used to say "requires
 * `styles/primitives.css`" and leave that to the caller — an instruction four routes silently
 * failed to follow. Measured on prod 2026-08-19: on `/marketing/ads/rules-automation/automations`
 * **0 of the 8,800 loaded CSS rules defined `.nds-seg`**, so the control rendered as
 * run-together plain text ("ActorsLedgerQueueLimits") with no padding and no track. An unstyled
 * component looks like a layout bug, not a missing import, which is why it survived.
 *
 * A component that cannot render correctly on its own is not a shared component. Next dedupes the
 * import, so this costs nothing and cannot regress.
 */
import '../styles/primitives.css';
import { type ReactNode } from 'react';
import type { Size } from './size';
export interface SegmentedOption {
    value: string;
    label: ReactNode;
    icon?: ReactNode;
    /**
     * Disable this segment alone. The group-level `disabled` turns the whole control off; this is
     * for a mode that is unavailable in the current context while its neighbours are not.
     *
     * `move()` skips these. It did NOT before this prop existed — it stepped to the next index and
     * selected it — so adding per-option disable without that fix would have let an arrow key
     * select an option the user cannot select and then fail to focus it, losing focus from the
     * control entirely.
     */
    disabled?: boolean;
    /**
     * Native tooltip for the whole segment.
     *
     * Without it a per-option explanation had to ride inside the `label` node, where it covers the
     * text rather than the segment — so hovering the words showed nothing.
     */
    title?: string;
}
export interface SegmentedControlProps {
    /**
     * Accessible name for the `radiogroup`.
     *
     * A radiogroup with no name is announced as an unlabelled group — the reader hears the options
     * but never what they choose between. Optional only so this does not break the call sites that
     * predate it; pass it.
     */
    ariaLabel?: string;
    options: SegmentedOption[];
    value: string;
    onChange: (value: string) => void;
    size?: Extract<Size, 'sm' | 'md'>;
    disabled?: boolean;
    /** Wrap long choices on narrow surfaces without changing keyboard order. */
    wrap?: boolean;
    className?: string;
}
export declare function SegmentedControl({ options, value, onChange, size, disabled, wrap, ariaLabel, className }: SegmentedControlProps): import("react/jsx-runtime").JSX.Element;
