import { type ReactNode } from 'react';
export interface ShellNavItem {
    id: string;
    label: ReactNode;
    icon: ReactNode;
    href?: string;
    active?: boolean;
    badge?: ReactNode;
    onClick?: () => void;
}
export interface ShellSubItem {
    id: string;
    label: ReactNode;
    href?: string;
    active?: boolean;
    onClick?: () => void;
}
/** A collapsible parent with sub-items (the H10 AMC / Reporting groups). */
export interface ShellNavGroup {
    id: string;
    label: ReactNode;
    icon: ReactNode;
    items: ShellSubItem[];
    defaultOpen?: boolean;
}
export type ShellNavEntry = ShellNavItem | ShellNavGroup;
export interface AppShellProps {
    brand: {
        mark: ReactNode;
        name: ReactNode;
    };
    nav: ShellNavEntry[];
    footer?: ReactNode;
    children: ReactNode;
    className?: string;
}
/**
 * App frame (H10 rail + content). Collapsed 66px icon rail that hover-expands
 * (pure CSS); flat items show an active fill + count badge, while groups expand
 * to reveal sub-items (a group opens by default if it holds the active route, or
 * via `defaultOpen`). Fills its parent — wrap in a `100dvh` container for a
 * full-page layout.
 */
export declare function AppShell({ brand, nav, footer, children, className }: AppShellProps): import("react/jsx-runtime").JSX.Element;
