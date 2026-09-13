import type { InputHTMLAttributes, ReactNode } from 'react';
export interface RadioCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'title'> {
    title: ReactNode;
    description?: ReactNode;
    /** Visual highlight (the `.on` state). Pair with the radio's checked state. */
    selected?: boolean;
    /**
     * `row` drops the border, radius, padding and selected wash, leaving a plain option ROW.
     *
     * Three pickers are structurally identical to this component but are rows, not cards
     * (`.h10-rb-ctrl`, `.h10-sb-type`, `.h10-rtm-opt`) — as cards they would box nine options in
     * one dialog. All three also pass an `on` class that NO rule styles, so their selected state
     * is carried by the radio dot alone; `row` gives them a real one.
     */
    variant?: 'card' | 'row';
}
/**
 * Selectable card with a radio + title + description (H10 `.h10-radio-card`,
 * e.g. the targeting-type picker). Selected = primary border + wash.
 */
export declare function RadioCard({ title, description, selected, variant, className, ...rest }: RadioCardProps): import("react/jsx-runtime").JSX.Element;
