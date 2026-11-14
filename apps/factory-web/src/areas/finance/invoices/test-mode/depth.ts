import { isApiError, issuePath } from '../../../../lib/api/errors'
import { writeProblem, type Phrase } from '../../_shared/model'

/**
 * B-W2b-417 (invoices in depth on screen): what its parts share — the catalogue (`finance-invoices-depth`, read beside
 * `finance`), a refusal's code (`refusal/<CODE>` on a 409) and a refused write in this step's words. Pure: the tests hold it.
 */

export const DEPTH = 'finance-invoices-depth'

/** The catalogues every view of this step reads (WithMessages replaces the page's: the finance words come along). */
export const DEPTH_NAMESPACES = ['finance', 'finance-daily', DEPTH, 'lists'] as const

/** A key of this step's catalogue, for a translator scoped to `finance` (the finance DialogFrame, useScopedT). */
export const scoped = (key: string): string => `${DEPTH}:${key}`

/** A refused write in words (a key a `finance`-scoped translator reads) and whether the record moved meanwhile. */
export interface DepthProblem extends Phrase {
  reload: boolean
}

/** The code of a 409 `refusal/<CODE>` (B-W2b-392's and -401's refusals), or null. */
export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
    if (match) return match[1]!
  }
  return null
}

/**
 * A refused write as words, never the API's English: a refusal code this step words (`refusal.<CODE>`), else the finance
 * words of the kind (moved, a state that does not allow it, no right, a fresh code wanted…).
 */
export function depthProblem(error: unknown, known: readonly string[] = []): DepthProblem {
  const code = refusalCode(error)
  if (code && known.includes(code)) return { key: scoped(`refusal.${code}`), reload: code === 'DATABASE' }
  const plain = writeProblem(error)
  return plain.params ? { key: plain.key, params: plain.params, reload: plain.reload } : { key: plain.key, reload: plain.reload }
}

/** Months of a year in the person's language ("ottobre 2026", "October 2026") for a `YYYY-MM`. */
export function monthName(month: string, locale: 'it' | 'en'): string {
  const [year, number] = month.split('-').map(Number)
  if (!year || !number) return month
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 15)))
}
