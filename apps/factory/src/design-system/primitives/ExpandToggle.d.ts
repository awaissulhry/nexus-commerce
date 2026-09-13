import type { ButtonHTMLAttributes } from 'react';
export interface ExpandToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'aria-expanded'> {
    expanded: boolean;
    /** Accessible name — what the click does, not what the state is. */
    label: string;
    /** Chevron size in px. The 20×20 hit area does not change with it. */
    size?: number;
}
export declare function ExpandToggle({ expanded, label, size, className, ...rest }: ExpandToggleProps): import("react/jsx-runtime").JSX.Element;
