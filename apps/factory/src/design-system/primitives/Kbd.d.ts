import type { ReactNode } from 'react';
export interface KbdProps {
    className?: string;
    children: ReactNode;
}
/** Keyboard key chip (e.g. ⌘, K). */
export declare function Kbd({ className, children }: KbdProps): import("react/jsx-runtime").JSX.Element;
