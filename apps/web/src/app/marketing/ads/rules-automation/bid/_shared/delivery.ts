/**
 * Bid page — the ONE word and tone for what became of a change (audit 2026-10-10 M3, S18). The rule panel's History and
 * the bid panel's History both read it, so one change never reads "Landed" in one panel and "Live" in the other. Pure,
 * tested in Node (`delivery.vitest.test.ts`).
 *
 *   Queued     not sent yet (PENDING, QUEUED). Not "Waiting": on this page that word means asks waiting for a person's
 *              approval (lead decision on audit R6)
 *   Sent       on its way to Amazon (IN_FLIGHT)
 *   Live       Amazon has it (APPLIED, SUCCESS)
 *   Undone     put back since (the feed: "Already undone.", or the op row "rolled back")
 *   Failed     Amazon or the gate refused it (FAILED, REFUSED)
 *   Cancelled  stopped before it was sent (CANCELLED, SKIPPED)
 *   Replaced   a newer change took its place before it was sent (SUPERSEDED)
 *
 * Undo: the change's own handle, or "Can't undo" with its reason (shown on hover and focus) — one look on both panels.
 */

export const CHANGE_STATES = ['waiting', 'sent', 'live', 'undone', 'failed', 'cancelled', 'replaced'] as const
export type ChangeState = (typeof CHANGE_STATES)[number]
export type ChangeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export const CHANGE_STATE_WORD: Readonly<Record<ChangeState, string>> = {
  waiting: 'Queued',
  sent: 'Sent',
  live: 'Live',
  undone: 'Undone',
  failed: 'Failed',
  cancelled: 'Cancelled',
  replaced: 'Replaced',
}

export const CHANGE_STATE_TONE: Readonly<Record<ChangeState, ChangeTone>> = {
  waiting: 'warning',
  sent: 'info',
  live: 'success',
  undone: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
  replaced: 'neutral',
}

const ALREADY_UNDONE = /already undone/i

/** The facts a change carries about itself: its delivery state, why it cannot be undone, the op row's reason. */
export interface ChangeFacts {
  /** The change feed's delivery state (AdMutation / action-log words); null = no record. */
  delivery: string | null | undefined
  /** Why it cannot be undone, as the server says it ("Already undone."). */
  undoBlocked?: string | null
  /** The op row's own note ("rolled back"). */
  reason?: string | null
}

/** What became of a change; null when there is no record (never read as success). */
export function changeStateOf(f: ChangeFacts): ChangeState | null {
  if ((f.undoBlocked && ALREADY_UNDONE.test(f.undoBlocked)) || f.reason?.trim().toLowerCase() === 'rolled back') return 'undone'
  const s = f.delivery?.trim().toUpperCase()
  if (!s) return null
  if (s === 'APPLIED' || s === 'SUCCESS' || s === 'DONE' || s === 'LANDED') return 'live'
  if (s === 'IN_FLIGHT' || s === 'SENT') return 'sent'
  if (s === 'PENDING' || s === 'QUEUED' || s === 'WAITING') return 'waiting'
  if (s === 'FAILED' || s === 'REFUSED') return 'failed'
  if (s === 'SUPERSEDED') return 'replaced'
  if (s === 'CANCELLED' || s === 'SKIPPED') return 'cancelled'
  return 'waiting'
}

/** The state as its word and tone; a dash (neutral) without a record. */
export function changeStateView(f: ChangeFacts): { state: ChangeState | null; word: string; tone: ChangeTone } {
  const state = changeStateOf(f)
  return state ? { state, word: CHANGE_STATE_WORD[state], tone: CHANGE_STATE_TONE[state] } : { state: null, word: '—', tone: 'neutral' }
}

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const CANT_UNDO = 'Can\'t undo'
/** How long a bid change can be undone (the change feed's UNDO_WINDOW for a bid). */
export const UNDO_WINDOW_MS = 24 * 3_600_000

export type UndoView = { kind: 'undo'; changeId: string } | { kind: 'cant'; word: string; reason: string }

/**
 * Undo with the change's own handle, or "Can't undo" with its reason: the server's words, else the window, else plain.
 * `changeId`: the id `POST /advertising/changes/:id/undo` takes (null when the server offers none).
 */
export function undoView(f: { changeId: string | null | undefined; undoBlocked?: string | null; at?: string | null }, now: number = Date.now()): UndoView {
  if (f.changeId) return { kind: 'undo', changeId: f.changeId }
  const said = f.undoBlocked?.trim().replace(/\.$/, '')
  if (said) return { kind: 'cant', word: CANT_UNDO, reason: said }
  const t = f.at ? Date.parse(f.at) : Number.NaN
  if (Number.isFinite(t) && now - t > UNDO_WINDOW_MS) return { kind: 'cant', word: CANT_UNDO, reason: 'Only within 24 h' }
  return { kind: 'cant', word: CANT_UNDO, reason: 'This change has no undo' }
}
