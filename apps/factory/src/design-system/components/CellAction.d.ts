import { type ReactNode } from 'react';
export interface CellActionProps {
    label: string;
    description?: string;
    icon?: ReactNode;
    onActivate(anchor: HTMLElement | null): void;
    onFocusCell?(): void;
}
/** A grid disclosure: one tab stop belongs to the cell; Enter/F2 opens its editor. */
export declare function CellAction({ label, description, icon, onActivate, onFocusCell }: CellActionProps): import("react/jsx-runtime").JSX.Element;
