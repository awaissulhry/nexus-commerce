import type { CellSaveState } from '../editors/roundTrip'
export interface CellSaveMarkProps { state: CellSaveState | null | undefined }
const MARKS = {
  saving: { glyph: '↻', label: 'Saving — the write is in flight' },
  waiting: { glyph: '…', label: 'Waiting — the write has not answered yet' },
  unknown: { glyph: '?', label: 'Save result unknown — check the recorded value before trying again' },
} as const
/** Shape and words distinguish identical waiting/unknown washes without a new tab stop. */
export function CellSaveMark({ state }: CellSaveMarkProps) {
  if (!state || !(state in MARKS)) return null
  const mark = MARKS[state as keyof typeof MARKS]
  return <span className="nds-save-mark" data-state={state} role="img" aria-label={mark.label}>{mark.glyph}</span>
}
