import type { ReactNode } from 'react';
export interface StepperStep {
    key: string;
    /**
     * `ReactNode`, not `string` — two builders nest a sub-step list inside the ACTIVE step's label
     * and would lose it otherwise.
     */
    label: ReactNode;
}
export interface StepperProps {
    steps: StepperStep[];
    /** Index of the active step (0-based). Earlier = done, later = upcoming. */
    current: number;
    /** Makes navigable steps clickable. Without it the stepper stays display-only, as before. */
    onSelect?: (index: number, step: StepperStep) => void;
    /** Which steps may be clicked. Defaults to completed ones only. Needs `onSelect`. */
    canSelect?: (index: number) => boolean;
    className?: string;
}
export declare function Stepper({ steps, current, onSelect, canSelect, className }: StepperProps): import("react/jsx-runtime").JSX.Element;
