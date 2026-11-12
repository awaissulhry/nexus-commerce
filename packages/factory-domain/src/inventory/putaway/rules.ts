import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Put away by scan (B-W2b-292; SCM-202; design floor.move "Two scans and no taps for a put-away"), the pure rule of the
 * suggested place. The bin scanned confirms where it goes; the suggestion only says where to take it:
 *
 *   1. goods not released (quarantine, blocked, rejected, on hold): the site's quality place (its QUALITY default, else its
 *      only quarantine place): they never go to an open shelf;
 *   2. the site's PUT_AWAY default for the item's kind (then the site's fallback; B-W2b-289 defaultPlaceFor);
 *   3. else where the same lot already lies (the place with the most of it, a dock or a quarantine place left out);
 *   4. else none: the worker picks a bin and scans it.
 * A suggestion is never the place it lies in.
 */

export const SUGGESTION_REASONS = ['QUALITY', 'DEFAULT', 'SAME_LOT'] as const
export type SuggestionReason = (typeof SUGGESTION_REASONS)[number]

export interface SuggestPlace {
  readonly id: string
  readonly code: string
}

export interface SameLotPlace extends SuggestPlace {
  readonly kind: string
  readonly onHand: Decimal | string
}

/** Places a put-away never suggests for released goods: where goods wait (a dock, quarantine) and outside places. */
const NOT_STORAGE = new Set(['RECEIVING', 'QUARANTINE', 'SUBCONTRACTOR', 'CUSTOMER', 'TRANSIT', 'SHIPPING'])

export function suggestPlace(ask: {
  readonly fromId: string
  readonly released: boolean
  readonly qualityPlace: SuggestPlace | null
  readonly defaultPlace: SuggestPlace | null
  readonly sameLot: readonly SameLotPlace[]
}): { readonly location: SuggestPlace; readonly why: SuggestionReason } | null {
  if (!ask.released) return ask.qualityPlace && ask.qualityPlace.id !== ask.fromId ? { location: ask.qualityPlace, why: 'QUALITY' } : null
  if (ask.defaultPlace && ask.defaultPlace.id !== ask.fromId) return { location: ask.defaultPlace, why: 'DEFAULT' }
  const best = [...ask.sameLot]
    .filter((place) => place.id !== ask.fromId && !NOT_STORAGE.has(place.kind) && new Dec(place.onHand).gt(0))
    .sort((a, b) => new Dec(b.onHand).comparedTo(new Dec(a.onHand)) || a.code.localeCompare(b.code))[0]
  return best ? { location: { id: best.id, code: best.code }, why: 'SAME_LOT' } : null
}
