import type { PublicSafetyNotice } from '@nexus/factory-domain/compliance/recall/public-notice'

/**
 * links.doc › sec:recall — the public DoC page's safety notice (B-W2b-271 on B-W2b-260's `page.notices`; design "A recall
 * or safety warning for this batch comes first", Reg. (EU) 2023/988 art. 35-36), pure: which words a reader gets (their
 * language like the declaration's, else the first written) and what the notice reaches in words (a message key of
 * `compliance-register-depth`, `publicNotice.reach.*`). The page shows only what the API sent: codes, days and the
 * company's own words. No person, no price.
 */

export type { PublicSafetyNotice }

/** The words in the first of the reader's languages the notice has, else its first language; null when it has none. */
export function noticeWords(notice: Pick<PublicSafetyNotice, 'words'>, chain: readonly string[]): { language: string; words: PublicSafetyNotice['words'][string] } | null {
  const languages = Object.keys(notice.words)
  const primary = (tag: string) => tag.toLowerCase().split('-')[0]!
  const language = chain.map((code) => languages.find((tag) => primary(tag) === code)).find(Boolean) ?? languages[0]
  if (!language) return null
  return { language, words: notice.words[language]! }
}

/** What the notice calls back, as a message key and its values. */
export function reachWords(notice: Pick<PublicSafetyNotice, 'reach' | 'batches' | 'bySerial'>, page: { readonly batch: string | null }): { key: string; params: Record<string, string> } {
  if (notice.reach === 'STYLE') return { key: 'publicNotice.reach.STYLE', params: {} }
  if (notice.reach === 'BATCH') return page.batch ? { key: 'publicNotice.reach.BATCH', params: { batch: page.batch } } : { key: 'publicNotice.reach.BATCHES', params: { batches: notice.batches.join(', ') } }
  if (notice.bySerial) return { key: 'publicNotice.reach.PART_SERIAL', params: { batch: page.batch ?? '' } }
  return { key: page.batch ? 'publicNotice.reach.PART' : 'publicNotice.reach.PART_STYLE', params: { batch: page.batch ?? '' } }
}

/** A calendar day as an instant at its noon UTC (formatting it never moves it to another day). */
export const noonOf = (day: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00Z` : day)
