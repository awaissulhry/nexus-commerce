/**
 * Lightbox — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * Photos run in order and do not wrap: on the first photo "Previous" is held ("This is the first photo."), on the last
 * "Next" is. ← and → move, Esc closes. The counter reads "2 of 4".
 */

import { LIGHTBOX_LABELS, type LightboxLabels } from './LightboxLabels'

export type LightboxDirection = -1 | 1

/** "2 of 4" (index is 0-based). B-W2b-F41: in `words`, English by default. */
export function lightboxCounter(index: number, count: number, words: Pick<LightboxLabels, 'counter'> = LIGHTBOX_LABELS): string {
  return words.counter(Math.min(count, index + 1), count)
}

/** The index a step lands on, or null at an end (no wrap). */
export function lightboxStep(index: number, count: number, direction: LightboxDirection): number | null {
  const next = index + direction
  return next < 0 || next >= count ? null : next
}

/** Why Previous / Next is held, or null when it moves. */
export function lightboxHeld(index: number, count: number, direction: LightboxDirection, words: Pick<LightboxLabels, 'only' | 'first' | 'last'> = LIGHTBOX_LABELS): string | null {
  if (lightboxStep(index, count, direction) != null) return null
  if (count <= 1) return words.only
  return direction < 0 ? words.first : words.last
}

/** ← = previous, → = next; any other key is not the lightbox's. */
export function lightboxKey(key: string): LightboxDirection | null {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  return null
}

/** A photo's alt when the caller has none better: "Photo 2 of 4 from Jonas K." */
export function photoAlt(index: number, count: number, from?: string | null): string {
  return `Photo ${lightboxCounter(index, count)}${from ? ` from ${from}` : ''}`
}

/** A strip thumbnail's name: "Photo 2 of 4", "Photo 2 of 4, shown now". */
export function lightboxThumbLabel(index: number, count: number, current: boolean, words: Pick<LightboxLabels, 'thumb'> = LIGHTBOX_LABELS): string {
  return words.thumb(Math.min(count, index + 1), count, current)
}
