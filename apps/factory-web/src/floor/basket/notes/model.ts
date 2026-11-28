import type { HelpRead } from '../help/api'

/**
 * owb-fl8 step 3 — the Notes tile (settle 1: the basket's 4th tile is Notes, not Chat; pick C): the office's notes for the floor of
 * this basket's work order (fl1's `notes`, today's for-the-floor notes), read only, newest first. No thread, no composer, no unread
 * count, no "seen" (nothing records who read a note). Pure.
 */

export type FloorNote = HelpRead['notes'][number]

/** Newest first; a note with a time the phone cannot read goes last, in the read's order. */
export function newestFirst(notes: readonly FloorNote[]): FloorNote[] {
  const time = (note: FloorNote) => {
    const value = Date.parse(note.at)
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value
  }
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => time(b.note) - time(a.note) || a.index - b.index)
    .map((entry) => entry.note)
}

/** What Listen reads: the notes' words, newest first (the office's words as written, never translated). */
export const notesSpeech = (notes: readonly FloorNote[]): string => newestFirst(notes).map((note) => note.words).join('. ')
