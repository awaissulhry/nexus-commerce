import type { PrivacyLevel } from './privacyNoteModel'

/**
 * `PrivacyNote`'s words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface PrivacyNoteLabels {
  /** What a view shows, by level. */
  levels: Record<PrivacyLevel, string>
  /** Said when opening the view is recorded. */
  recorded: string
  /** The note's name for a screen reader. */
  region: string
}

export const PRIVACY_NOTE_LABELS: PrivacyNoteLabels = {
  levels: {
    line: 'Line totals',
    team: 'Team totals',
    individual: 'One person’s data',
    protected: 'Protected data',
  },
  recorded: 'Opening this is recorded',
  region: 'Privacy',
}
