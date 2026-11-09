import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'

/**
 * "Finish later" (design links.frame sec:drafts; B-W2b-163's `GET|PUT /link/draft`): a long form (measurements, the
 * supplier questionnaire, a claim) keeps a draft WITH THE SENDER, never on the device — personal and health data never
 * land in browser storage. Opening the same link again resumes it; a draft save is not a counted use. The draft lives
 * until the link expires (the API purges it 7 days later), so the band says "finish later from the same link until
 * <the link's expiry>". Pure, so the tests hold it; `useLinkDraft` runs it, `view/LinkDraftBand` draws it.
 */

/** How long after the last change the draft is saved with us. */
export const DRAFT_SAVE_DELAY_MS = 1_500
/** The API's limit for a draft's data (sealed at most 256 KiB; the form's JSON at most 180 KiB). */
export const DRAFT_MAX_BYTES = 180 * 1024

export interface LinkDraftBand {
  /** The band's save words (DS SaveStatus). */
  status: SaveStatusState
  /** The link's expiry: the form can be finished from the same link until then (null before the draft was read). */
  until: string | null
  /** A draft was restored on arrival: when it was saved (null: none, or the person moved on). */
  restoredAt: string | null
  /** The person pressed Finish later and that save landed: the page may be closed. */
  later: boolean
  /** The link stopped taking drafts (used, expired or withdrawn meanwhile): nothing more is saved. */
  dead: boolean
}

export const idleBand = (): LinkDraftBand => ({ status: { kind: 'idle' }, until: null, restoredAt: null, later: false, dead: false })

export type DraftEvent =
  /** The draft was read: the link's expiry, and the restored draft's save time when the page took it. */
  | { readonly type: 'read'; readonly until: string; readonly restoredAt: string | null }
  /** The person changed something: not saved yet. */
  | { readonly type: 'changed' }
  | { readonly type: 'saving' }
  /** The API kept it (`later`: the save Finish later asked for). */
  | { readonly type: 'saved'; readonly at: string; readonly later: boolean }
  | { readonly type: 'failed' }
  /** The link opens nothing any more (404). */
  | { readonly type: 'dead' }
  /** "Go on" or "Start again" answered the restored banner. */
  | { readonly type: 'dismiss' }

export function draftBandStep(band: LinkDraftBand, event: DraftEvent): LinkDraftBand {
  switch (event.type) {
    case 'read':
      return { ...band, until: event.until, restoredAt: event.restoredAt, status: event.restoredAt ? { kind: 'saved', at: event.restoredAt } : band.status }
    case 'changed':
      return band.dead ? band : { ...band, status: { kind: 'unsaved' }, later: false }
    case 'saving':
      return { ...band, status: { kind: 'saving' } }
    case 'saved':
      return { ...band, status: { kind: 'saved', at: event.at }, later: event.later || band.later }
    case 'failed':
      return { ...band, status: { kind: 'failed', count: 1 }, later: false }
    case 'dead':
      return { ...band, status: { kind: 'failed', count: 1 }, later: false, dead: true }
    case 'dismiss':
      return { ...band, restoredAt: null }
  }
}

/** The form's data as the API measures it (UTF-8 JSON bytes). */
export function draftBytes(data: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(data)).length
}

/** Why "Finish later" cannot run now (a `link-frame` key), or null. */
export function finishLaterHeld(band: LinkDraftBand, worthKeeping: boolean, tooBig: boolean): string | null {
  if (band.dead) return 'drafts.held.dead'
  if (!worthKeeping) return 'drafts.held.empty'
  if (tooBig) return 'drafts.held.tooBig'
  if (band.status.kind === 'saving') return 'drafts.held.saving'
  return null
}
