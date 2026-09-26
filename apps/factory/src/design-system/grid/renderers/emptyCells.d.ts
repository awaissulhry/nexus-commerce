export type GridEmptyCells = 'dash' | 'blank';
export declare const GridEmptyCellsContext: import("react").Context<GridEmptyCells>;
/** The empty-cell mode in force here. `dash` outside any `NexusGrid` that says otherwise. */
export declare function useGridEmptyCells(): GridEmptyCells;
/** What a blank cell announces. A sighted operator sees nothing; a screen reader still hears the fact. */
export declare const BLANK_CELL_LABEL = "No value";
