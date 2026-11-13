import type { TaskRow, Words } from '../api'

/**
 * A request of the approval engine in words from its codes (B-W2b-382; follow-up XF7:01, after B-W2b-377): its kind's words
 * (`kindLabel`, Italian and English) and its record as its kind reads it (`record.label`: numbers and codes, no money). The
 * API's `summary` is an English sentence built by each kind's checker: no screen of Home › Approvals draws it — not a row,
 * not the review, not a notice after a decision, not a line of Approve N, not the conversation's title. PURE.
 */

export type RequestFacts = Pick<TaskRow, 'kindLabel' | 'record'>
type Translate = (key: string, params?: Record<string, string | number>) => string

/** Words of either language in the person's. */
export const saidIn = (words: Words, locale: string): string => (locale === 'it' ? words.it : words.en)

/** "Purchase order: PO2 · rev 1" — the kind, and its record when the kind names one (approvals-depth `row.task`). */
export function requestWords(task: RequestFacts, locale: string, t: Translate): string {
  const kind = saidIn(task.kindLabel, locale)
  return task.record.label ? t('row.task', { kind, label: task.record.label }) : kind
}

/** The request's short name in a list of several (Approve N): its record, else its kind. */
export const requestName = (task: RequestFacts, locale: string): string => task.record.label ?? saidIn(task.kindLabel, locale)
