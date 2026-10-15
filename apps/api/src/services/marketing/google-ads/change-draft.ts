/**
 * Google Ads changes (2026-10-15) — what every change of a Google Ads account is before it is sent: the operations
 * Google gets (one atomic request), what a person reads before approving (a sentence, from → to lines, counts,
 * warnings, what spends money), the facts it stands on (checked again when it runs) and what it replaced and wrote (for
 * undo). Built from a request and the account's live state, without any call: pure.
 */
import type { GoogleMutateOperation } from './write-client.js'

export interface GoogleChangeDraft {
  /** ONE plain sentence of what it does. */
  summary: string
  /** from → to, as a person reads it (at most 20 lines; the rest is counted in `totals`). */
  changes: Record<string, { from: unknown; to: unknown }>
  totals: Record<string, number>
  /** Sentences a person reads before approving (not about money). */
  warnings: string[]
  /**
   * Why this change can make the account spend more: each a sentence (an ENABLE, a budget raise, a bid raise, …). Empty
   * when it cannot. The person decides each of them; Claude never runs one alone.
   */
  spendsMoney: string[]
  /** What was asked and needs nothing done (already so): said, not sent. */
  skipped: string[]
  operations: GoogleMutateOperation[]
  /** The live facts the change stands on: when they moved, the approved change is not sent. */
  stands: unknown
  /** What it replaces and what it writes, in one shape per tool (AgentChange; undo reads them). */
  before: unknown
  after: unknown
}

export const MAX_CHANGE_LINES = 20

/** A from → to table of at most MAX_CHANGE_LINES lines; the lines left out are counted. */
export function changeLines(lines: Array<[string, unknown, unknown]>): { changes: GoogleChangeDraft['changes']; more: number } {
  const changes: GoogleChangeDraft['changes'] = {}
  let more = 0
  for (const [label, from, to] of lines) {
    if (Object.keys(changes).length >= MAX_CHANGE_LINES) { more += 1; continue }
    let key = label
    for (let n = 2; key in changes; n++) key = `${label} (${n})`
    changes[key] = { from, to }
  }
  return { changes, more }
}

/** "EUR 10.00" from cents. */
export const money = (cents: number | null | undefined, currency: string): string =>
  cents === null || cents === undefined ? '(none)' : `${currency} ${(cents / 100).toFixed(2)}`

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

/** Google's text rules for a keyword (a keyword or a negative): at most 80 characters and 10 words. */
export function keywordTextProblem(text: string): string | null {
  const t = text.trim()
  if (!t) return 'is empty'
  if (t.length > 80) return `has ${t.length} characters (Google allows 80)`
  if (t.split(/\s+/).length > 10) return 'has more than 10 words (Google allows 10)'
  return null
}
