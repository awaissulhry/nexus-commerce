import type { ReactNode } from 'react';
export interface CustomizableColumn {
    key: string;
    label: ReactNode;
    visible: boolean;
    /** Fixed columns cannot be hidden or moved. */
    locked?: boolean;
}
export interface ColumnCustomizerProps {
    open: boolean;
    onClose: () => void;
    columns: CustomizableColumn[];
    onApply: (columns: CustomizableColumn[]) => void;
    className?: string;
}
/** Compatibility entry point for the canonical Nexus column modal. New grids use PreferencesModal. */
export declare function ColumnCustomizer({ open, onClose, columns, onApply, className }: ColumnCustomizerProps): import("react/jsx-runtime").JSX.Element;
