import type { QualityStatus } from '../../../_shared/stock/api'
import type { ReleaseCheck } from '../api'

/**
 * Release N lots (B-W2a-64; design warehouse.lots lt-grid selection "Release 3 lots": the review lists which can and
 * which cannot, with reasons), pure: each lot's release check read in our words, which lots go, the typed phrase that
 * confirms (one lot: its own code, as the single release's legal weight asks; several: "RELEASE 3"), what holds the
 * button, and each lot's outcome. The DS ReviewChangesModal and ConfirmPhraseField speak English: composed.
 */

export type LineCheck =
  | { state: 'loading' }
  | { state: 'ready'; ready: boolean; mode: 'RELEASE' | 'UNBLOCK'; version: number; status: QualityStatus; open: readonly ReleaseCheck[] }
  | { state: 'error'; problem: string }

export interface ReleaseLine {
  id: string
  code: string
  status: QualityStatus
  check: LineCheck
  /** After Release: released, or refused with its words (a key of warehouse-lots). */
  result: null | { ok: true } | { ok: false; key: string }
}

export interface ReleaseDialogModel {
  lines: ReleaseLine[]
  phrase: string
  note: string
  busy: boolean
  done: boolean
}

export interface ReleaseActions {
  onPhrase?: (phrase: string) => void
  onNote?: (note: string) => void
  onRelease?: () => void
  onClose?: () => void
}

/** A lot goes: its check read, ready, a release (not an unblock), in quarantine. */
export const releasable = (line: ReleaseLine): boolean => line.check.state === 'ready' && line.check.ready && line.check.mode === 'RELEASE' && line.check.status === 'QUARANTINE'

/** Why a lot does not go, as a key of warehouse-lots (its values beside), or null when it goes. */
export function whyNot(line: ReleaseLine): { key: string; params?: Record<string, string | number> } | null {
  if (releasable(line)) return null
  if (line.check.state === 'loading') return { key: 'lt.rel.why.checking' }
  if (line.check.state === 'error') return { key: 'lt.rel.why.failed' }
  const status = line.check.status
  if (status === 'RELEASED') return { key: 'lt.rel.why.released' }
  if (status === 'REJECTED') return { key: 'lt.rel.why.rejected' }
  if (status === 'BLOCKED' || line.check.mode === 'UNBLOCK') return { key: 'lt.rel.why.blocked' }
  return { key: 'lt.rel.why.open', params: { count: line.check.open.length } }
}

const normal = (text: string) => text.trim().replace(/\s+/g, ' ').toUpperCase()

/** The phrase to type: one lot — its code; several — the words with the count (a key of warehouse-lots, translated by the caller). */
export function expectedPhrase(lines: readonly ReleaseLine[], words: (count: number) => string): string {
  const going = lines.filter(releasable)
  return going.length === 1 ? going[0]!.code : words(going.length)
}

export const phraseMatches = (typed: string, expected: string): boolean => expected !== '' && normal(typed) === normal(expected)

/** Why "Release N lots" is held (a key), or null. */
export function releaseHeldKey(model: ReleaseDialogModel, expected: string): string | null {
  if (model.busy) return 'lt.rel.held.busy'
  if (model.lines.some((line) => line.check.state === 'loading')) return 'lt.rel.held.checking'
  if (!model.lines.some(releasable)) return 'lt.rel.held.none'
  if (!phraseMatches(model.phrase, expected)) return 'lt.rel.held.phrase'
  return null
}

/** A refused release in our words (by the API's kind). */
export function releaseRefusalKey(kind: string): string {
  if (kind === 'conflict') return 'lt.rel.result.changed'
  if (kind === 'forbidden' || kind === 'step_up') return 'lt.rel.result.forbidden'
  if (kind === 'invalid') return 'lt.rel.result.refused'
  if (kind === 'unavailable') return 'lt.rel.result.offline'
  return 'lt.rel.result.failed'
}
