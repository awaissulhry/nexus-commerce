import type { Issue } from '../core/errors'

/**
 * Deciding the lines of a plan (design 02 "What to buy & make": Set aside, Undo, Draft PO; MaterialRequirement's
 * decision), pure. A line's numbers are its run's snapshot and never change; only its decision does, and only while its
 * run is the site's latest DONE run (the …_supply_guards trigger refuses any other run's line):
 *
 *   OPEN → IGNORED    set aside, with a reason (planning.decide)
 *   IGNORED → OPEN    opened again (the Undo of a set aside)
 *   OPEN → ORDERED    a purchase order line buys it (B-W1-30's Draft PO, through the planning hook), a BUY line only
 *
 * A newer run starts every line OPEN again: what the planner set aside is not carried over (PLN-076, "protect planner
 * edits across reruns", is W2b).
 *
 * The reason of a set aside is kept in decisionNote as `<REASON>` or `<REASON>: <note>` (no column of its own).
 */

export const SET_ASIDE_REASONS = ['CUSTOMER_SUPPLIES', 'SUBSTITUTE', 'STOCK_NOT_IN_SYSTEM', 'OTHER'] as const
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number]

export const SET_ASIDE_WORDS: Readonly<Record<SetAsideReason, string>> = Object.freeze({
  CUSTOMER_SUPPLIES: 'the customer supplies it',
  SUBSTITUTE: 'a substitute is used',
  STOCK_NOT_IN_SYSTEM: 'the stock is there but not in the system yet',
  OTHER: 'another reason',
})

export const DECISIONS = ['OPEN', 'ORDERED', 'IGNORED'] as const
export type Decision = (typeof DECISIONS)[number]

export const RUN_STATUSES = ['RUNNING', 'DONE', 'FAILED', 'SUPERSEDED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const MAX_NOTE = 500
/** At most this many lines in one decision. */
export const MAX_DECIDED_LINES = 200

/** The note stored for a set aside. */
export function decisionNoteOf(reason: SetAsideReason, note: string | null | undefined): string {
  const text = note?.trim() ?? ''
  return text === '' ? reason : `${reason}: ${text}`
}

/** A stored note read back: its reason (OTHER when it names none) and its words. */
export function readDecisionNote(stored: string | null): { readonly reason: SetAsideReason; readonly note: string | null } | null {
  if (stored === null) return null
  const match = /^([A-Z_]+)(?:: ([\s\S]*))?$/.exec(stored)
  if (match && (SET_ASIDE_REASONS as readonly string[]).includes(match[1]!)) return { reason: match[1] as SetAsideReason, note: match[2] ?? null }
  return { reason: 'OTHER', note: stored }
}

/** A set aside as typed: OTHER needs a note; a note is at most MAX_NOTE characters. */
export function setAsideProblems(input: { readonly reason: SetAsideReason; readonly note?: string | null | undefined }): Issue[] {
  const note = input.note?.trim() ?? ''
  const problems: Issue[] = []
  if (input.reason === 'OTHER' && note === '') problems.push({ path: 'body/note', message: 'Say why the lines are set aside.' })
  if (note.length > MAX_NOTE) problems.push({ path: 'body/note', message: `At most ${MAX_NOTE} characters.` })
  return problems
}

/** What a line's decision may move to now; null when it may, else why not (a 409 for the caller). */
export function decisionProblem(line: { readonly decision: Decision; readonly action: 'BUY' | 'MAKE' }, runStatus: RunStatus, to: Decision): string | null {
  if (runStatus === 'SUPERSEDED') return 'A newer plan replaced this one: decide the lines of the latest plan.'
  if (runStatus !== 'DONE') return `The plan is ${runStatus === 'RUNNING' ? 'still running' : 'a failed run'}; its lines cannot be decided.`
  if (to === 'IGNORED') {
    if (line.decision === 'IGNORED') return 'The line is set aside already.'
    if (line.decision === 'ORDERED') return 'The line is ordered already; take it off its purchase order first.'
    return null
  }
  if (to === 'OPEN') return line.decision === 'IGNORED' ? null : line.decision === 'OPEN' ? 'The line is open already.' : 'An ordered line opens again only when its purchase order line is removed.'
  if (line.action !== 'BUY') return 'Only a line to buy is ordered with a purchase order line.'
  return line.decision === 'OPEN' ? null : line.decision === 'ORDERED' ? 'The line is ordered already.' : 'The line is set aside: open it again first.'
}
