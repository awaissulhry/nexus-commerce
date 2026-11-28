import { isLocale, type Locale } from '../../lib/i18n/locales'
import type { QueueItem } from '../queue/model'

/**
 * owb-fl8 step 4 — the Me page's rules, without React or the network (design § 5zf B "Me"; P/floor.js floorMe): my team and its
 * leader, what I can do, My day (today's, behind the PIN), the language (the site's floor languages), Large words, Sound, Tell the
 * office (an idea · something is wrong · thank you; with or without my name; voice or words), Change person, My record (one tick
 * on this phone, two at the office: today's queue) and the strip "Saved on this phone". Pure, so the tests hold them.
 *
 * Walls: a suggestion without the name carries `withName: false` and nothing that names the worker; it goes ONLY online (server B:
 * the sync ledger keeps the worker and the device, so the queue refuses it, ANON_ONLINE). A named one may wait on the phone.
 */

export const SUGGESTION_KINDS = ['IDEA', 'WRONG', 'THANKS'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export const SUGGESTION_MAX = 500

export interface SuggestionDraft {
  readonly kind: SuggestionKind | null
  readonly words: string
  /** A voice note recorded and not sent yet (in this page's memory only). */
  readonly voice: { readonly blob: Blob; readonly seconds: number } | null
}

export const NEW_SUGGESTION: SuggestionDraft = Object.freeze({ kind: null, words: '', voice: null })

export type SuggestionHeld = 'kind' | 'empty' | 'voiceOffline' | 'anonOffline' | null

/**
 * Why "Send" cannot go now: no kind yet; an idea or a wrong thing says what (words or voice; a thank you may go alone); a voice note
 * needs the network; a message without the name goes only online.
 */
export function suggestionHeld(draft: SuggestionDraft, online: boolean, withName: boolean): SuggestionHeld {
  if (!draft.kind) return 'kind'
  if (draft.kind !== 'THANKS' && draft.words.trim() === '' && !draft.voice) return 'empty'
  if (!online && draft.voice) return 'voiceOffline'
  if (!online && !withName) return 'anonOffline'
  return null
}

/** What goes to the office: the kind, the words, the voice note's file, and whether the name goes with it. Never a worker id. */
export function suggestionPayload(draft: SuggestionDraft, withName: boolean, voiceFileId: string | null): Record<string, unknown> {
  const words = draft.words.trim().slice(0, SUGGESTION_MAX)
  return { kind: draft.kind, ...(words ? { words } : {}), ...(voiceFileId ? { voiceFileId } : {}), withName }
}

/** A suggestion may wait on the phone only with the name (the queue keeps who and which phone). */
export const mayQueueSuggestion = (withName: boolean): boolean => withName

// ---- the page --------------------------------------------------------------------------------------------------------------

/** The person's place on the floor, by today's right: a team leader holds `floor.lead`. */
export const roleOf = (permissions: readonly string[]): 'LEADER' | 'WORKER' => (permissions.includes('floor.lead') ? 'LEADER' : 'WORKER')

/** The site's floor languages this web speaks, in the site's order (an unknown tag is left out, never shown raw). */
export function floorLanguages(floorLocales: readonly string[]): Locale[] {
  return [...new Set(floorLocales.filter((tag): tag is Locale => isLocale(tag)))]
}

/** "Saved on this phone": this person's actions not yet recorded by the office (waiting, or refused and to be sent again). */
export function savedHere(items: readonly Pick<QueueItem, 'state' | 'workerId' | 'refusal'>[], workerId: string | null): number {
  if (!workerId) return 0
  return items.filter((item) => item.workerId === workerId && (item.state === 'waiting' || (item.state === 'refused' && item.refusal !== null && !item.refusal.final))).length
}

/** The net strip stands when the network is gone or something waits; else the page stays short. */
export const netStripShown = (online: boolean, waiting: number): boolean => !online || waiting > 0
