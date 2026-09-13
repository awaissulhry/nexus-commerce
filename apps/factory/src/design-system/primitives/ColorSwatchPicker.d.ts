/**
 * ColorSwatchPicker — pick a colour from a FIXED palette, not from the whole spectrum.
 *
 * A free colour input looks more capable and is worse for this job. Operators pick colours that
 * collide with each other, that collide with the status tones the product already uses to mean
 * something, and that fail contrast on one of the two themes — and once picked, those colours
 * live in the database and spread to every surface that renders the thing. A closed palette is
 * the only version where "choose a colour" cannot produce an unreadable result.
 *
 * The values are the design system's own ramps, so a tag coloured here sits in the same visual
 * family as everything around it rather than next to it.
 *
 * These are IDENTIFIERS, not statuses: the palette is deliberately drawn from ramps that do not
 * carry meaning on their own. Where a colour must mean success or danger, use a tone, not this.
 */
export interface ColorSwatchPickerProps {
    /** Currently selected hex, or null for "no colour". */
    value: string | null;
    onChange: (hex: string) => void;
    /** Accessible name for the radio group. */
    ariaLabel?: string;
    disabled?: boolean;
    className?: string;
}
/**
 * Eight, and eight is the point: enough that two tags in view rarely share one, few enough that
 * the whole set is visible without a scroll and a person can remember which is which.
 *
 * The values themselves live in `tokens/colors.ts` as `tagSwatches`, beside `accountIdentity`
 * which solves the identical problem. They are PERSISTED tag data rather than styling, so they
 * belong in the token tier where colour is defined once — and raw hex in a primitive is exactly
 * what the DS token-guard exists to reject.
 */
export declare const SWATCHES: ReadonlyArray<{
    hex: string;
    name: string;
}>;
export declare function ColorSwatchPicker({ value, onChange, ariaLabel, disabled, className, }: ColorSwatchPickerProps): import("react/jsx-runtime").JSX.Element;
