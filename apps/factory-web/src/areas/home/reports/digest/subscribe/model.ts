import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { ReportFilter } from '../../api'
import type { ReportSubscription, SubscribeBody } from './api'

/** "E-mail me this" rules (B-W2b-435; DG1:01), pure. Words are message keys of `home-digest`. */

export interface EmailMeDraft {
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly locale: 'it' | 'en'
  /** The report's filters by key (null: the report's default / every value). */
  readonly filters: Readonly<Record<string, string | null>>
}

/** A new draft: 07:00 on working days, my language, the filters the page shows now (only the report's own keys). */
export function newDraft(filters: readonly ReportFilter[], shown: Readonly<Record<string, string>>, locale: 'it' | 'en'): EmailMeDraft {
  return { sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], locale, filters: Object.fromEntries(filters.map((filter) => [filter.key, shown[filter.key] ?? null])) }
}

/** The draft of a subscription as stored. */
export function draftOfSubscription(filters: readonly ReportFilter[], row: ReportSubscription): EmailMeDraft {
  return { sendTime: row.sendTime, weekdays: [...row.weekdays], locale: row.locale, filters: Object.fromEntries(filters.map((filter) => [filter.key, row.filters[filter.key] ?? null])) }
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index])

/** How many fields a draft changes from the stored subscription (all of them count as one when there is none). */
export function draftChanges(draft: EmailMeDraft, row: ReportSubscription | null, filters: readonly ReportFilter[]): number {
  if (!row) return 1
  let count = 0
  if (draft.sendTime !== row.sendTime) count += 1
  if (!same(draft.weekdays, row.weekdays)) count += 1
  if (draft.locale !== row.locale) count += 1
  for (const filter of filters) if ((draft.filters[filter.key] ?? null) !== (row.filters[filter.key] ?? null)) count += 1
  return count
}

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/** Why the save waits (a message key), or null. */
export function emailMeHeld(draft: EmailMeDraft, changes: number): string | null {
  if (changes === 0) return 'emailMe.held.nothing'
  if (!TIME.test(draft.sendTime)) return 'emailMe.held.time'
  if (draft.weekdays.length === 0) return 'emailMe.held.days'
  return null
}

export const bodyOf = (draft: EmailMeDraft, active: boolean, version: number): SubscribeBody => ({ sendTime: draft.sendTime, weekdays: [...draft.weekdays], locale: draft.locale, filters: { ...draft.filters }, active, version })

/** A refused write as a message key. */
export function emailMeProblem(error: unknown): string {
  if (!isApiError(error)) return 'emailMe.error.save'
  const paths = error.issues.map(issuePath)
  if (paths.includes('subscription/OWN_MAIL')) return 'emailMe.error.ownMail'
  if (error.kind === 'conflict') return 'emailMe.error.stale'
  if (error.kind === 'forbidden') return 'emailMe.error.forbidden'
  if (error.kind === 'unavailable') return 'emailMe.error.offline'
  if (paths.some((path) => path.startsWith('body'))) return 'emailMe.error.invalid'
  return 'emailMe.error.save'
}

export function emailMeReadProblem(error: unknown): string {
  if (!isApiError(error)) return 'emailMe.error.read'
  if (error.kind === 'forbidden') return 'emailMe.error.forbidden'
  if (error.kind === 'unavailable') return 'emailMe.error.offline'
  return 'emailMe.error.read'
}
