import type { InputHTMLAttributes, ReactNode } from 'react';
import type { Tone } from './tone';
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
    /**
     * Accent colour of the box. Defaults to the primary blue.
     *
     * A tick that performs a destructive or irreversible action should not look like every other
     * tick — `.ap-ack` ("Push to Amazon now") sits in an amber acknowledgement card and had to
     * re-declare its accent at the call site because the primitive only knew one colour.
     */
    tone?: Tone;
    label?: ReactNode;
}
/** Native checkbox tinted with the H10 accent (`accent-color`), 15px, with label. */
export declare const Checkbox: import("react").ForwardRefExoticComponent<CheckboxProps & import("react").RefAttributes<HTMLInputElement>>;
