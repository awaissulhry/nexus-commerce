import type { InputHTMLAttributes, ReactNode } from 'react';
import type { Size } from './size';
export interface NumberStepperProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'onChange' | 'value' | 'prefix'> {
    value: number | '';
    onChange: (next: number) => void;
    min?: number;
    max?: number;
    step?: number;
    /** trailing unit inside the track, e.g. `%` or `€` */
    suffix?: ReactNode;
    size?: Extract<Size, 'sm' | 'md'>;
    /** dims the value without disabling the control — a stepper whose value is not in effect yet */
    muted?: boolean;
    decrementLabel?: string;
    incrementLabel?: string;
}
/**
 * A joined −/number/+ control: ONE bordered track with hairline dividers, not three boxes.
 *
 * Two surfaces hand-rolled it (`.az-bias-edit` in the placement cockpit, `.h10-hv-step` in
 * keyword harvest) because building it from `Button` + `Input` + `Button` gives three separate
 * borders and three radii — visibly not one control.
 *
 * The native spinners are suppressed in CSS, which is the point of the ± buttons: a `<input
 * type="number">` spinner is ~13px, appears on hover, and is unusable on touch.
 *
 * Clamping lives here rather than at the call site, so `min`/`max` cannot be bypassed by the
 * buttons — and a value typed past a bound is clamped on change, not silently kept.
 */
export declare const NumberStepper: import("react").ForwardRefExoticComponent<NumberStepperProps & import("react").RefAttributes<HTMLInputElement>>;
