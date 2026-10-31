/**
 * PrivacyNote's rules (B-W2b-28, design part PrivacyNote): every view that touches people says, before anything is read,
 * what level of personal data it shows and who may see more (GDPR art. 5; Statuto art. 4).
 *
 * - **Levels**, least to most personal: `line` (line totals), `team` (team totals), `individual` (one person's data),
 *   `protected` (special-category data: fitness judgements, injury details). The tone follows: line and team neutral,
 *   individual info, protected warning — always with the level's icon and words.
 * - **Segments**, in this order and only when given: the level (or the host's own words for it), who may see more, the
 *   law, "Opening this is recorded". The same words in the band pill and in the panel: nothing is said only on hover.
 */

export type PrivacyLevel = 'line' | 'team' | 'individual' | 'protected'
export type PrivacyTone = 'neutral' | 'info' | 'warning'

export const PRIVACY_LEVELS: readonly PrivacyLevel[] = ['line', 'team', 'individual', 'protected']

export function privacyTone(level: PrivacyLevel): PrivacyTone {
  return level === 'protected' ? 'warning' : level === 'individual' ? 'info' : 'neutral'
}

/** The plain-text sentence of a note (for a print or an export header): "Line totals · HR sees more · Opening this is recorded". */
export function privacyNoteText(parts: { level: string; whoMore?: string; law?: string; recorded?: string | false }): string {
  return [parts.level, parts.whoMore, parts.law, parts.recorded || undefined].filter((p): p is string => !!p && p.trim() !== '').join(' · ')
}
