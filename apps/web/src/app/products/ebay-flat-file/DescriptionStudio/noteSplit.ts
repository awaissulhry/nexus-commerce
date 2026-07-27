/**
 * DS-6 — theme-note splitting (pure; the renderer lives in ThemeNote.tsx).
 *
 * A theme's `notes` field carries two very different things at once:
 *
 *   • the ⚠ FLAGS — short, operator-facing, actionable ("Italian copy … —
 *     operator sign-off required before setting as default"). These gate a
 *     push and must never be collapsed, truncated or tooltip-only.
 *   • the DETAIL — the design/engineering record (why sections were omitted,
 *     which dependencies to weigh). The built-in "Xavia Modernist" note is
 *     ~2,000 characters of it.
 *
 * The Studio used to dump the whole string into a Banner, three times over
 * (editor, push dock, confirm). The result was a wall of amber text taller
 * than the pane holding it, which then overflowed and painted across the panes
 * below. Splitting on ⚠ — the same marker `notes.includes('⚠')` already uses
 * to mean "draft copy" — keeps every warning loud while the record folds away.
 */

export interface SplitNote {
  /** Each ⚠-flagged segment, marker stripped. Always rendered in full. */
  flags: string[]
  /** Everything before the first ⚠ — the long-form record. */
  detail: string
}

export function splitThemeNote(notes: string | null | undefined): SplitNote {
  const text = (notes ?? '').trim()
  if (!text) return { flags: [], detail: '' }
  const parts = text.split('⚠')
  return {
    detail: parts[0].trim(),
    flags: parts.slice(1).map((s) => s.trim()).filter(Boolean),
  }
}

/** True when a note carries at least one ⚠ flag — the draft-copy gate. */
export const noteIsFlagged = (notes: string | null | undefined): boolean =>
  (notes ?? '').includes('⚠')
