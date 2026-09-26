'use client'

/**
 * What an EMPTY cell draws in this grid — the dash, or nothing.
 *
 * `dash` (the default) is the metrics reading: a number grid must tell "nothing was measured" from a
 * measured 0, and the dash is how it says the first one. `blank` is the EDITING reading: in a product
 * sheet an empty cell is simply a value nobody has entered yet — 58% of master·IT's rendered cells on
 * a 41-row family (195 of 336, measured 2026-09-26) — and a wall of dashes buried the values between
 * them. Spreadsheets and PIM grids leave that cell blank.
 *
 * The grid decides, not the cell: `NexusGrid emptyCells="blank"` provides this context to every cell
 * renderer inside it (AG renders React cells through portals, so the provider above `AgGridReact`
 * reaches them — the same path `GridDensityProvider` takes to the DS `Thumbnail`). A renderer never
 * takes the mode as a prop, so two cells in one grid cannot disagree.
 *
 * A measured zero is NOT an empty cell and keeps its dash in both modes — see `EmptyValue`.
 *
 * A `.ts` module with no JSX, like `emptyValue.ts`, so the rule stays node-testable.
 */
import { createContext, useContext } from 'react'

export type GridEmptyCells = 'dash' | 'blank'

export const GridEmptyCellsContext = createContext<GridEmptyCells>('dash')

/** The empty-cell mode in force here. `dash` outside any `NexusGrid` that says otherwise. */
export function useGridEmptyCells(): GridEmptyCells {
  return useContext(GridEmptyCellsContext)
}

/** What a blank cell announces. A sighted operator sees nothing; a screen reader still hears the fact. */
export const BLANK_CELL_LABEL = 'No value'
