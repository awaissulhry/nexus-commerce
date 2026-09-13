import type { ReactNode } from 'react';
export interface SummaryTableProps {
    label: string;
    columns: readonly string[];
    rows: ReadonlyArray<{
        id: string;
        cells: readonly ReactNode[];
    }>;
}
/** Compact, read-only comparisons inside cards and drawers. Interactive datasets use NexusGrid. */
export declare function SummaryTable({ label, columns, rows }: SummaryTableProps): import("react/jsx-runtime").JSX.Element;
