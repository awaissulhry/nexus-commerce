/**
 * The rules of `SaveStatus` (B-W2b-09, D6; design 00-page-anatomy §3.3) — pure, tested in Node.
 *
 * One place in the band says what happened to the person's work, in words that are always visible (never a tooltip):
 * "All changes saved · 10:42" / "Saving…" / "1 change not saved — Retry" / "Unsaved changes" (a form tab) / "Offline —
 * 2 changes wait to be sent". "Saved" is said only after the server answered (the app sets the state from the answer),
 * never as a guess. A count the app does not know is not invented: `unsaved` without a count says "Unsaved changes".
 */
import { SAVE_STATUS_LABELS, type SaveStatusLabels } from './SaveStatusLabels'

export type SaveStatusState =
  /** Nothing to say yet (the page opened, nothing changed): draws nothing, the live region stays. */
  | { kind: 'idle' }
  /** The server confirmed every change; `at` = when (ISO), said as a time. */
  | { kind: 'saved'; at?: string | null }
  /** A save is under way. */
  | { kind: 'saving' }
  /** `count` changes the server refused or never got (default 1); `reason` in the app's words. */
  | { kind: 'failed'; count?: number; reason?: string | null }
  /** A form tab with changes not saved yet (`EditModeBar` holds Save); `count` when known. */
  | { kind: 'unsaved'; count?: number | null }
  /** No connection; `count` changes wait to be sent (0 / absent: nothing waits). */
  | { kind: 'offline'; count?: number | null }

export type SaveStatusTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger'

export interface SaveStatusView {
  /** The visible words; '' for idle. */
  text: string
  tone: SaveStatusTone
  /** Draw the Retry button (failed, with an `onRetry`). */
  retry: boolean
}

/** "10:42" in the given language (24 h where the language uses it); the app passes its own writer for the site's zone. */
export function defaultSaveTime(iso: string, locale = 'en'): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
}

const positive = (count: number | null | undefined): number | null => (typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : null)

/** What the band says for a state. */
export function saveStatusView(
  state: SaveStatusState,
  options: { words?: SaveStatusLabels; time?: (iso: string) => string; canRetry?: boolean } = {},
): SaveStatusView {
  const words = options.words ?? SAVE_STATUS_LABELS
  const time = options.time ?? ((iso: string) => defaultSaveTime(iso))
  switch (state.kind) {
    case 'idle':
      return { text: '', tone: 'neutral', retry: false }
    case 'saved': {
      const at = state.at ? time(state.at) : ''
      return { text: at ? words.savedAt(at) : words.saved, tone: 'success', retry: false }
    }
    case 'saving':
      return { text: words.saving, tone: 'info', retry: false }
    case 'failed': {
      const base = words.failed(positive(state.count) ?? 1)
      return { text: state.reason ? `${base} — ${state.reason}` : base, tone: 'danger', retry: !!options.canRetry }
    }
    case 'unsaved': {
      const count = positive(state.count)
      return { text: count ? words.unsavedCount(count) : words.unsaved, tone: 'warning', retry: false }
    }
    case 'offline': {
      const count = positive(state.count)
      return { text: count ? words.offlineCount(count) : words.offline, tone: 'warning', retry: false }
    }
  }
}
