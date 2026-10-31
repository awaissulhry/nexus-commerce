import type { CellSaveState } from '../editors/roundTrip'
import { mergeLabels } from '../../lib/labels'
import { CELL_SAVE_MARK_LABELS, type CellSaveMarkLabels } from './CellSaveMarkLabels'
export interface CellSaveMarkProps {
  state: CellSaveState | null | undefined
  /** Its words in the person's language (B-W2b-04): each mark's accessible name. Default English. */
  labels?: Partial<CellSaveMarkLabels>
}
const GLYPHS = { saving: '↻', waiting: '…', unknown: '?' } as const
/** Shape and words distinguish identical waiting/unknown washes without a new tab stop. */
export function CellSaveMark({ state, labels }: CellSaveMarkProps) {
  if (!state || !(state in GLYPHS)) return null
  const mark = state as keyof typeof GLYPHS
  return <span className="nds-save-mark" data-state={state} role="img" aria-label={mergeLabels(CELL_SAVE_MARK_LABELS, labels)[mark]}>{GLYPHS[mark]}</span>
}
