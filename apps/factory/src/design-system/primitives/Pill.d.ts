import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import type { Tone } from './tone';
interface PillBaseProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onClick'> {
    /** Active→success · Paused→warning · Archived→neutral · Error→danger */
    tone: Tone;
    /**
     * Makes the pill a `<button>` — a status that is also the control that changes it.
     *
     * The eBay rules list hand-rolled `<button className="h10-pill ok">` with an inline
     * `border: none` to toggle PROPOSE ↔ AUTOPILOT, because a pill was a `<span>` and a `Button`
     * is not a pill. Same shape as `Card`'s `onClick`.
     */
    onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
    /** Engaged state for a pill that toggles; emits `aria-pressed`. Needs `onClick`. */
    pressed?: boolean;
    disabled?: boolean;
    /**
     * Leading status dot, in the pill's own tone.
     *
     * For a pill reporting the health of something CONTINUOUS — a feed that is live or stalled, a
     * connection, a sync — where the dot is what the eye reads before the word. Surfaces were
     * hand-rolling a chip-plus-dot because a Pill was text-only, and a hand-rolled one keeps its
     * green while the thing it describes is broken.
     */
    dot?: boolean;
    /**
     * `md` sizes the pill to sit in a TOOLBAR beside `sm` buttons (28px, pill radius) rather than
     * inside a table cell. Default `sm` is the in-cell status chip every existing consumer gets.
     */
    size?: 'sm' | 'md';
    children: ReactNode;
}
/**
 * R-LX-27 — `compact` is only representable WITH an `icon`, and that is the whole type.
 *
 * A compact pill draws its glyph and moves its words into `.nds-vh`, so a compact pill with no icon
 * is an empty capsule with an invisible label: a control the operator can see and cannot read. It is
 * not a thing to warn about in a comment and fall back from at runtime — it is a state the props
 * should not be able to describe. `compact?: never` on the icon-less member is what says so.
 */
export type PillProps = PillBaseProps & ({
    /**
     * The leading glyph, passed SEPARATELY from `children` rather than as the first child, because
     * `compact` has to hide the words and keep the glyph — and a component cannot tell a glyph from
     * a word inside one `ReactNode`. Every pill may use it; the two toolbar status pills must.
     */
    icon: ReactNode;
    /**
     * Icon only: the words stay in the accessible name (`.nds-vh`) and leave the layout.
     *
     * Measured need (R-LX-27, LX.FIN's DEFECT 2): on `master · IT-GALE-JACKET` at 1440 the sheet
     * toolbar ran `scrollW 1444` against `clientW 1372` — 72px over, with `Customise` and the `⋯`
     * button CLIPPED OFF THE RIGHT EDGE, i.e. unreachable. The two family-status pills that exist
     * only on a childless family (`Setup incomplete` 138.5px + `no children` 92.3px = 230.8px)
     * belonged to no fold group. This is how they give the width back without being deleted.
     *
     * WHO decides: the grid ENGINE measures the bar and hands the flag down
     * (`useToolbarStatusCompaction`, the fold's last tier). A surface never picks a breakpoint —
     * a page-local `@media (max-width: 1440px)` would compact the pills on families whose bar fits.
     */
    compact?: boolean;
} | {
    icon?: ReactNode;
    compact?: never;
});
/** Status pill — matches the H10 `.h10-pill`. Becomes a button when given `onClick`. */
export declare function Pill({ tone, onClick, pressed, disabled, dot, size, icon, compact, className, children, ...rest }: PillProps): import("react/jsx-runtime").JSX.Element;
export {};
