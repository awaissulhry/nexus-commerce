/**
 * The words and rules of `ReviewChangesModal` (bid page DS lane, 2026-10-10) — pure, tested in Node.
 *
 * The Owner's liked pattern (2026-09-26, the PSIE dialog): one summary line, ONE table old → new, ONE primary button that
 * counts what it does ("Save 3 changes"), then Done with Undo. Promoted from three hand copies — the Control Room's
 * Campaigns review (re-read first so "Now" is today's value, conflicts named, problems block, a tick for a change that
 * lets automation do more), the PSIE Import dialog (summary tiles, one table, Done with Undo) and the shelved brain
 * page's review (Where · What · Now · New · Note, a per-change result after Save). The pages keep their copies for now.
 */
import type { ReactNode } from 'react'

export interface ReviewChange {
  id: string
  /** Where it lands: "Rule A", "IT · Jacket Exact". The column is left out when no change has one. */
  where?: ReactNode
  /** What changes: "Mode", "Lowest bid". */
  what: ReactNode
  /** Today's value (re-read before Save where the host can). */
  now: ReactNode
  /** The value Save writes. */
  next: ReactNode
  /** One short line: why, or what else it does. */
  note?: ReactNode
  /** It lets automation do MORE (a higher mode, a looser limit): counted for the one acknowledgement tick. */
  raise?: boolean
}

/** What became of one change after Save: `ok` = it went through; otherwise `words` say why not ("Refused: the cap is 1 a day"). */
export interface ReviewResult {
  ok: boolean
  words: string
  /**
   * The past-tense verb the Done line counts it under: "saved" (default), "archived", "undone", "restored". A failed one
   * reads "not <verb>" ("1 not undone"). Without it the words tell: a result that starts "Undone", "Archived" (or
   * "Already archived") or "Restored" counts as that (audit S2: after Undo the line said "1 saved").
   */
  verb?: string
}

/** A stored value that changed since the draft was made: Save would overwrite it. */
export interface ReviewConflict { label: string; was: string; now: string }

export type ReviewState =
  | { phase: 'reading' }
  | { phase: 'failed'; error: string }
  | { phase: 'ready'; conflicts?: readonly ReviewConflict[] }
  | { phase: 'saving'; done?: number }
  | { phase: 'done'; results: Readonly<Record<string, ReviewResult>> }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const reviewTitle = (n: number): string => `Review ${plural(n, 'change')}`
export const saveWords = (n: number): string => `Save ${plural(n, 'change')}`
export const raiseCount = (changes: readonly Pick<ReviewChange, 'raise'>[]): number => changes.filter((c) => c.raise).length

export function ackWords(raises: number): string {
  return raises === 1
    ? 'I understand this change lets automation do more, from its next run.'
    : `I understand these ${raises} changes let automation do more, from their next run.`
}

/**
 * Why Save is held, in words (the held button's tooltip and description), or null when it may run. Order: the state of
 * the read, then the form above the table (`lead`: the host's own words, "Type a bid"), then nothing to save, then
 * problems, then the tick.
 */
export function saveHeldReason(args: { state: ReviewState; count: number; problems: number; raises: number; ack: boolean; lead?: string | null }): string | null {
  const { state, count, problems, raises, ack, lead } = args
  if (state.phase === 'reading') return 'Reading today\'s values first'
  if (state.phase === 'failed') return 'Today\'s values could not be read'
  if (state.phase === 'saving') return 'Saving'
  if (state.phase === 'done') return 'Already saved'
  if (lead) return lead
  if (count === 0) return 'Nothing to save'
  if (problems > 0) return problems === 1 ? 'Fix the problem first' : 'Fix the problems first'
  if (raises > 0 && !ack) return 'Tick the box first'
  return null
}

/** The primary button's words: "Save 3 changes", "Saving 2 of 3…". */
export function saveButtonWords(state: ReviewState, count: number, label?: string): string {
  if (state.phase === 'saving') return state.done != null ? `Saving ${state.done} of ${count}…` : 'Saving…'
  return label ?? saveWords(count)
}

/** The one table's columns: Where only when a change has it; Note only when one has it (or a raise); Result once done. */
export function reviewColumns(changes: readonly Pick<ReviewChange, 'where' | 'note' | 'raise'>[], done: boolean): string[] {
  const has = (v: unknown) => v !== undefined && v !== null && v !== ''
  return [
    ...(changes.some((c) => has(c.where)) ? ['Where'] : []),
    'What', 'Now', 'New',
    ...(done ? ['Result'] : changes.some((c) => has(c.note) || c.raise) ? ['Note'] : []),
  ]
}

/** The Note cell: the host's note, or for a raise with none, the plain fact. */
export const reviewNote = (c: Pick<ReviewChange, 'note' | 'raise'>): ReactNode => c.note ?? (c.raise ? 'Lets automation do more' : '')

/**
 * The Result cell's words: the result's own, except where they only repeat the New column ("Rejected | Rejected",
 * "Archived | Archived", audit R2 NICE) — then a plain "Done".
 */
export function resultWords(change: Pick<ReviewChange, 'next'>, result: Pick<ReviewResult, 'ok' | 'words'>): string {
  const same = typeof change.next === 'string' && change.next.trim().toLowerCase() === result.words.trim().toLowerCase()
  return result.ok && same ? 'Done' : result.words
}

const VERB_FROM_WORDS = /^(?:already\s+)?(undone|archived|restored)\b/i

/** The verb a result is counted under: its own, else the one its words start with, else the dialog's (default "saved"). */
export function resultVerb(result: Pick<ReviewResult, 'words' | 'verb'>, fallback = 'saved'): string {
  if (result.verb) return result.verb
  const m = VERB_FROM_WORDS.exec(result.words.trim())
  return m ? m[1].toLowerCase() : fallback
}

/**
 * The Done screen's one line and its tone: "3 saved", "2 saved · 1 not saved", "1 undone", "2 archived", "Nothing saved".
 * Each result counts under its verb (`resultVerb`); `verb` is the dialog's default ("archived" for an archive).
 */
export function doneSummary(
  changes: readonly Pick<ReviewChange, 'id'>[],
  results: Readonly<Record<string, ReviewResult>>,
  verb = 'saved',
): { line: string; tone: 'success' | 'warning' | 'danger' } {
  const told = changes.map((c) => results[c.id]).filter((r): r is ReviewResult => !!r)
  const count = (ok: boolean) => {
    const by = new Map<string, number>()
    for (const r of told) if (r.ok === ok) { const v = resultVerb(r, verb); by.set(v, (by.get(v) ?? 0) + 1) }
    return [...by]
  }
  const went = count(true)
  const failed = count(false)
  const failedTotal = failed.reduce((sum, [, n]) => sum + n, 0)
  const wentWords = went.map(([v, n]) => `${n} ${v}`).join(' · ')
  if (!went.length) {
    const v = failed[0]?.[0] ?? verb
    return { line: failedTotal ? `Nothing ${v} · ${plural(failedTotal, 'change')} not ${v}` : `Nothing ${v}`, tone: 'danger' }
  }
  if (!failedTotal) return { line: wentWords, tone: 'success' }
  return { line: `${wentWords} · ${failed.map(([v, n]) => `${n} not ${v}`).join(' · ')}`, tone: 'warning' }
}
