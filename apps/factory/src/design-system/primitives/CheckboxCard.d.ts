import type { InputHTMLAttributes, ReactNode } from 'react';
export interface CheckboxCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'title'> {
    title: ReactNode;
    description?: ReactNode;
    /** Visual highlight (the `.on` state). Pair with the checkbox's checked state. */
    selected?: boolean;
    /** `row` drops the border, radius, padding and wash — see `RadioCard`. */
    variant?: 'card' | 'row';
}
/**
 * The multi-select twin of `RadioCard`: a whole card that is a checkbox.
 *
 * `RadioCard` had no sibling, so a surface offering several non-exclusive cards (`.h10-ai-mod`)
 * had to hand-roll the whole-card click target. Shares `RadioCard`'s stylesheet exactly — the
 * only difference is the input type and the ARIA that follows from it.
 */
export declare const CheckboxCard: import("react").ForwardRefExoticComponent<CheckboxCardProps & import("react").RefAttributes<HTMLInputElement>>;
