import { formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import { listAddress } from '../../../../lib/records/record-links'
import type { KeyNumber, KeyNumbers } from './api'

/**
 * My numbers' rules (design home.today `key-numbers`, pop:number-explain; B-W2a-79): which lens's numbers show (the lens
 * picked in the flow strip, else the first that has numbers), how a value is said, where a tile goes (the area list that
 * shows exactly its rows when that page is built, else its report), and the line under it. Pure.
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The section's state: the answer (null while reading), a failed read's message key, and `/w/<company>` for the links. */
export interface KeyNumbersState {
  readonly value: KeyNumbers | null
  readonly problem: string | null
  readonly prefix: string
  /** Design cases: the number whose "How this number is made" is open. */
  readonly explainOpen?: string | null
}

/** The numbers of the lens the flow strip shows (null: the first lens with numbers). */
export function numbersOfLens(numbers: KeyNumbers | null, lens: string | null): { lens: string; numbers: KeyNumber[] } | null {
  if (!numbers || numbers.lenses.length === 0) return null
  const picked = (lens && numbers.lenses.find((entry) => entry.lens === lens)) || numbers.lenses[0]!
  return { lens: picked.lens, numbers: picked.numbers }
}

/** The value as the tile says it; null when there is none (the tile then says why). */
export function valueText(number: Pick<KeyNumber, 'unit' | 'value' | 'currency'>, locale: Locale): string | null {
  if (number.value === null || number.value === undefined) return null
  if (number.unit === 'PERCENT') return `${formatNumber(number.value, locale, { maximumFractionDigits: 1 })} %`
  if (number.unit === 'MONEY') {
    const amount = number.value / 100
    return number.currency ? formatNumber(amount, locale, { style: 'currency', currency: number.currency, maximumFractionDigits: amount >= 10_000 ? 0 : 2 }) : formatNumber(amount, locale, { maximumFractionDigits: 0 })
  }
  return formatNumber(number.value, locale)
}

/** A target as words ("Target 95 %", "Target 0"). */
export function targetText(number: Pick<KeyNumber, 'unit' | 'target'>, t: Translate, locale: Locale): string | null {
  if (!number.target) return null
  const value = number.unit === 'PERCENT' ? `${formatNumber(number.target.value, locale)} %` : formatNumber(number.target.value, locale)
  return t(number.target.direction === 'AT_MOST' ? 'numbers.targetAtMost' : 'numbers.targetAtLeast', { value })
}

/** Where a tile goes (company-free): the exact list when its page is built, else the report with the number's filters. */
export function numberHref(number: Pick<KeyNumber, 'list' | 'report'>, built: ReadonlySet<string>): string | null {
  const list = number.list ? listAddress(number.list.api, number.list.query, built) : null
  if (list) return list
  if (!number.report) return null
  const qs = new URLSearchParams(number.report.filters).toString()
  return `/home/reports/${encodeURIComponent(number.report.key)}${qs ? `?${qs}` : ''}`
}

/** The report a number's explanation opens ("Open the report"), company-free. */
export function reportOfNumber(number: Pick<KeyNumber, 'report'>): string | null {
  return number.report ? numberHref({ list: null, report: number.report }, new Set()) : null
}

/** The words of a number without a value. */
export function problemKey(number: Pick<KeyNumber, 'problem' | 'value'>): string {
  if (number.problem === 'NO_DATA') return 'numbers.noData'
  if (number.problem === 'MIXED_CURRENCIES') return 'numbers.mixed'
  return 'numbers.unavailable'
}
