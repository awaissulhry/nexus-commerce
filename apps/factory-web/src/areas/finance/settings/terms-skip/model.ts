import { conventionWords, normalSkipMonths, SKIP_MONTHS_MAX, skipMonthsProblems } from '@nexus/factory-domain/money/terms/due-dates'
import type { Locale } from '../../../../lib/i18n/locales'

/**
 * Skipped months and days from the end of the month in payment terms, pure (B-W2b-417 on B-W2b-396's terms API; FIN-076;
 * design finance.settings sec:terms "… instalments, early-payment discount, skip August (W2b)"): the months offered, one
 * month toggled (kept in calendar order, each once), the draft's problem as factory-domain checks it (at most 11: one month
 * stays to pay in), and the conventions in the words the documents print (factory-domain conventionWords).
 */

export { SKIP_MONTHS_MAX }

export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

/** A month's name in the person's language ("agosto", "August"). */
export const monthOf = (month: number, locale: Locale): string => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, month - 1, 15)))

/** The months skipped after one is ticked or unticked (calendar order, each once). */
export const toggleMonth = (months: readonly number[], month: number, on: boolean): number[] => normalSkipMonths(on ? [...months, month] : months.filter((entry) => entry !== month))

/** The draft's problem as a key of `finance-invoices-depth`, or null. */
export const skipProblem = (months: readonly number[]): string | null => (skipMonthsProblems(months).length > 0 ? 'skip.problem' : null)

/** The conventions as the documents print them (null: none), for the dialog's live words. */
export const conventionsText = (conventions: { fromEndOfMonth: boolean; skipMonths: readonly number[] }, locale: Locale): string | null => conventionWords({ fromEndOfMonth: conventions.fromEndOfMonth, skipMonths: normalSkipMonths(conventions.skipMonths) }, locale === 'it' ? 'it' : 'en')
