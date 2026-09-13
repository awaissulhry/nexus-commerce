import { type MouseEvent, type ReactNode } from 'react';
export interface WorkspaceNavItem {
    id: string;
    label: string;
    href: string;
    icon?: ReactNode;
    active?: boolean;
    badge?: string | number;
}
export interface WorkspaceNavGroup {
    id: string;
    label: string;
    items: readonly WorkspaceNavItem[];
    collapsible?: boolean;
}
export interface WorkspaceSubheaderProps {
    /** The existing page header. A render function places the optional view menu beside its title. */
    header: ReactNode | ((titleMenu: ReactNode) => ReactNode);
    tabs?: ReactNode;
    navigationLabel: string;
    groups: readonly WorkspaceNavGroup[];
    views?: {
        label: string;
        selectedId: string;
        items: readonly WorkspaceNavItem[];
    };
    /** Browser-native links by default; adapters may preserve their router's navigation semantics. */
    onNavigate?: (event: MouseEvent<HTMLAnchorElement>, item: WorkspaceNavItem) => void;
    /** Actual shell elements, observed for resizing, pinning and hover expansion. */
    chrome?: {
        header: HTMLElement | null;
        primaryNavigation: HTMLElement | null;
    };
}
/** The toggle column exists only in this subheader. Render page content as its NEXT sibling. */
export declare function WorkspaceSubheader({ header, tabs, navigationLabel, groups, views, onNavigate, chrome }: WorkspaceSubheaderProps): import("react/jsx-runtime").JSX.Element;
