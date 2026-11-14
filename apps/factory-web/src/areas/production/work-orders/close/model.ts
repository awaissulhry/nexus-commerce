import { isApiError, issuePath } from '../../../../lib/api/errors'
import { CLOSE_REASONS, CLOSE_REFUSALS, type CloseCheck, type CloseInput, type CloseReason, type CloseRecord } from './api'

/**
 * B-W2b-424 — the work order close's rules, without a screen (design production.workorders pop:wo-close; MES-012, MES-013):
 * who may close, undo and reopen (from the session's permissions; the API checks every call again), why Close is held
 * (always with its reason, never a dead button), the body the API takes (a reason code exactly when a figure is beyond the
 * tolerance), the Undo's few seconds on screen, the reopen's reason, and an API refusal in this screen's words. Words are
 * message keys of the `costing-close` catalogue (`Phrase`); the views translate them. No person in a figure: the figures
 * are the work order's totals.
 */

/** The catalogue of these screens (messages/<locale>/costing-close.json). */
export const CLOSE_NS = 'costing-close'

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

export interface CloseCan {
  /** workorders.manage: close a completed work order, and undo one's own close for a few seconds. */
  readonly manage: boolean
  /** workorders.reopen: reopen a closed work order with a reason (B-W2b-411; production manager). */
  readonly reopen: boolean
  /** costing.view: the variance at close on the Labour & cost tab. */
  readonly costView: boolean
  /** money.cost: material cost and every amount. */
  readonly cost: boolean
}

export function closeCanOf(permissions: readonly string[]): CloseCan {
  const held = new Set(permissions)
  return { manage: held.has('workorders.manage'), reopen: held.has('workorders.reopen'), costView: held.has('costing.view'), cost: held.has('money.cost') }
}

/**
 * How long the Undo stays on screen after a close (00 §3.4: "a toast with Undo, 12 s, pauses on hover and focus"). The
 * API's own limit is longer (the check's undoSeconds, 60): the screen never offers it past that.
 */
export const UNDO_ON_SCREEN_MS = 12_000

/** The close check is read for a completed work order (the dialog) and a closed one (who closed it, Reopen). */
export const checksClose = (status: string | null | undefined): boolean => status === 'COMPLETED' || status === 'CLOSED'

/** The figures of the dialog in their order (design: planned vs actual quantity, material, minutes, scrap). */
export const FIGURES = ['quantity', 'material', 'minutes', 'scrap'] as const
export type Figure = (typeof FIGURES)[number]

/** A reason's words key; a code this screen does not know yet reads as "another reason". */
export const reasonKey = (code: string | null | undefined): string => (code && (CLOSE_REASONS as readonly string[]).includes(code) ? `reason.${code}` : 'reason.unknown')

/** Whether the chosen reason needs words (OTHER), as the check says. */
export function noteNeeded(check: Pick<CloseCheck, 'reasons'>, reason: CloseReason | null): boolean {
  return !!reason && check.reasons.some((entry) => entry.code === reason && entry.noteNeeded)
}

export const NOTE_MAX = 1000

/**
 * Why Close is held now, or null: the check still reading or failed, the work order not completed, no workorders.manage,
 * costs still waiting to post while the close settles them (the API refuses COSTS_WAITING), a reason missing beyond the
 * tolerance, the words OTHER needs, a note too long, a write running.
 */
export function closeHeld(check: CloseCheck | null, input: { reason: CloseReason | null; note: string }, busy: boolean): Phrase | null {
  if (!check) return phrase('held.reading')
  if (check.refusal?.code === 'NOT_COMPLETED' || check.workOrder.status !== 'COMPLETED') return phrase('held.notCompleted')
  if (!check.closable) return phrase('held.noManage', { permission: 'workorders.manage' })
  if (check.settles && check.waiting.length > 0) return phrase('held.costsWaiting', { count: check.waiting.length })
  if (check.reasonNeeded && !input.reason) return phrase('held.reasonNeeded', { tolerance: check.tolerancePct })
  if (input.reason && noteNeeded(check, input.reason) && !input.note.trim()) return phrase('held.noteNeeded')
  if (input.note.trim().length > NOTE_MAX) return phrase('held.noteLong', { max: NOTE_MAX })
  if (busy) return phrase('held.busy')
  return null
}

/** The body of the close: the reason code only when the check asks for one (the API refuses it otherwise); the note when typed. */
export function closeInput(check: Pick<CloseCheck, 'reasonNeeded' | 'workOrder'>, version: number, input: { reason: CloseReason | null; note: string }): CloseInput {
  return { version, reasonCode: check.reasonNeeded ? input.reason : null, reasonNote: input.note.trim() ? input.note.trim() : null }
}

/** Until when the Undo shows: a few seconds after the close, never past the API's limit for the person who closed it. */
export function undoShownUntil(close: Pick<CloseRecord, 'closedAt' | 'undoUntil' | 'can'>, now: number): number | null {
  if (!close.can.undo || !close.undoUntil) return null
  const limit = Date.parse(close.undoUntil)
  const until = Math.min(now + UNDO_ON_SCREEN_MS, limit)
  return Number.isFinite(until) && until > now ? until : null
}

export const REOPEN_MIN = 3
export const REOPEN_MAX = 1000

/** Why "Reopen…" is held on a closed work order, or null. A work order closed before the close record existed is not reopened. */
export function reopenOpenHeld(check: CloseCheck | null, busy: boolean): Phrase | null {
  if (!check) return phrase('held.reading')
  if (!check.live) return phrase('held.noRecord')
  if (!check.live.can.reopen) return phrase('held.noReopen', { permission: 'workorders.reopen' })
  if (busy) return phrase('held.busy')
  return null
}

/** Why the reopen dialog's button is held: the reason (3 to 1,000 characters), or what holds Reopen itself. */
export function reopenHeld(check: CloseCheck | null, reason: string, busy: boolean): Phrase | null {
  const open = reopenOpenHeld(check, busy)
  if (open) return open
  const length = reason.trim().length
  if (length < REOPEN_MIN) return phrase('reopen.reasonShort', { min: REOPEN_MIN })
  if (length > REOPEN_MAX) return phrase('reopen.reasonLong', { max: REOPEN_MAX })
  return null
}

/** The close that stands on a closed work order in words: settled (its cost closed) or a status only (the accountant's switch was off). */
export const closedPhrase = (close: Pick<CloseRecord, 'settled'>): Phrase => phrase(close.settled ? 'closed.settled' : 'closed.status')

/** A read's failure in this screen's words. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'conflict'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/** A refused write in this screen's words: the API's `refusal/<CODE>` by its code, a version that moved, or the kind. */
export function writeProblem(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.internal')
  const refusal = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))
  const code = refusal?.split('/')[1]
  if (code && (CLOSE_REFUSALS as readonly string[]).includes(code)) return phrase(`refusal.${code}`)
  if (code) return phrase('refusal.other')
  if (error.kind === 'conflict') return phrase('problem.changed')
  return phrase(readProblem(error))
}

/** A live event of this work order's close (closed, undone, reopened): the record reads the check again. */
export const closeTouches = (change: { type: string; fields: Readonly<Record<string, unknown>> }, workOrderId: string): boolean => change.type === 'work_order_close.changed' && change.fields.workOrderId === workOrderId
