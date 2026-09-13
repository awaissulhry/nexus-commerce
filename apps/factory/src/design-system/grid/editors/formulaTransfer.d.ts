import type { FillOperationParams, ProcessCellForExportParams } from 'ag-grid-community';
/** Locate the repeating source cell in displayed order, so sorting/filtering cannot change its meaning. */
export declare function formulaFillSourceIndex(target: number, current: number, count: number, direction: 'up' | 'down' | 'left' | 'right'): number;
/** Copy/fill carries the expression; the existing cell-save handler evaluates it for each target row. */
export declare function formulaTransfer<TRow>(input: {
    exprFor: (row: TRow, column: string) => string | null;
    canEditRow?: (row: TRow) => boolean;
}): {
    processCellForClipboard: (p: ProcessCellForExportParams<TRow>) => string;
    cellSelection: {
        handle: {
            mode: "fill";
            setFillValue: (p: FillOperationParams<TRow>) => string | false;
        };
    };
};
