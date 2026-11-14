import { isApiError, issuePath } from '../../../../lib/api/errors'
import { writeProblem } from '../../_shared/model'

/**
 * B-W2b-425 (payments, collections and payables on screen): what its parts share — the catalogue
 * (`finance-payments-depth`, read beside `finance`), a key of it for a `finance`-scoped translator, and a refused write in
 * this step's words (a refusal code at its path: `refusal/<CODE>`, `stop/<CODE>`, `writeOff/<CODE>` …). Pure: the tests
 * hold it.
 */

export const PAY_DEPTH = 'finance-payments-depth'

/** The catalogues every view of this step reads (WithMessages replaces the page's: the finance words come along). */
export const PAY_DEPTH_NAMESPACES = ['finance', 'finance-daily', PAY_DEPTH, 'lists'] as const

/** A key of this step's catalogue for a translator scoped to `finance` (the finance DialogFrame, useScopedT). */
export const scoped = (key: string): string => `${PAY_DEPTH}:${key}`

export interface Phrase {
  key: string
  params?: Record<string, string | number>
}

/** A refused write in words (a key a `finance`-scoped translator reads) and whether the record moved meanwhile. */
export interface PayProblem extends Phrase {
  reload: boolean
}

/** The code of an issue at `<prefix>/<CODE>` (`refusal/OWN_PROPOSAL`, `stop/SAME_STOP`), or null. */
export function codeAt(error: unknown, prefix: string): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const match = new RegExp(`^${prefix}/([A-Z_]+)$`).exec(issuePath(issue))
    if (match) return match[1]!
  }
  return null
}

/**
 * A refused write as words, never the API's English: a code this step words at one of `prefixes` (`refusal.<group>.<CODE>`),
 * else the finance words of the kind (moved, a state that does not allow it, no right, a fresh code wanted…).
 */
export function payProblem(error: unknown, group: string, known: readonly string[], prefixes: readonly string[] = ['refusal']): PayProblem {
  for (const prefix of prefixes) {
    const code = codeAt(error, prefix)
    if (code && known.includes(code)) return { key: scoped(`refusal.${group}.${code}`), reload: false }
  }
  const plain = writeProblem(error)
  return plain.params ? { key: plain.key, params: plain.params, reload: plain.reload } : { key: plain.key, reload: plain.reload }
}

/** One CSV cell: quoted when it holds a comma, a quote or a line break (a formula's first sign kept as text). */
export function csvCell(value: string): string {
  const text = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows as CSV with their header line. */
export const csvOf = (header: readonly string[], rows: readonly (readonly string[])[]): string => `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`
