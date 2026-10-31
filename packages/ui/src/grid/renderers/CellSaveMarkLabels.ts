/** `CellSaveMark`'s words (B-W2b-04): the accessible name of each unresolved save. English by default. */
export interface CellSaveMarkLabels {
  saving: string
  waiting: string
  unknown: string
}

export const CELL_SAVE_MARK_LABELS: CellSaveMarkLabels = {
  saving: 'Saving — the write is in flight',
  waiting: 'Waiting — the write has not answered yet',
  unknown: 'Save result unknown — check the recorded value before trying again',
}
