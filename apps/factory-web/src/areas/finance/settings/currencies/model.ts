import { manualRateProblem, normalRate } from '@nexus/factory-domain/money/currency/rates'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Phrase } from '../../_shared/model'
import type { Currencies, Currency, Feed, RateDay, Rates } from './api'

/**
 * Finance › Settings › Currencies & rates, pure (B-W2b-389; design finance.settings sec:currencies): who may (currencies.view
 * reads; the company's currencies with currencies.manage over the company; the rates — a manual rate of a day, the daily ECB
 * switch, reading the file now — with currencies.manage over every company, as the API says in `can`), why each action is
 * held, the manual rate's draft checked as factory-domain checks it, and the API's refusals in words (never its English).
 * Words: `finance-currencies`.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** A part's read: the value, or why it failed; null while the first read runs. */
export interface Read<T> {
  readonly value: T | null
  readonly problem: string | null
}

export interface CurrencyAbilities {
  readonly view: boolean
  /** The company's currencies (the API's word: over this company). */
  readonly manage: boolean
  /** The tenant's rates (the API's word: over every company). */
  readonly manageRates: boolean
}

export const currencyViewOf = (permissions: readonly string[]): boolean => permissions.includes('currencies.view')

export function abilitiesOf(permissions: readonly string[], currencies: Pick<Currencies, 'can'> | null): CurrencyAbilities {
  const view = currencyViewOf(permissions)
  return { view, manage: view && !!currencies?.can.manage, manageRates: view && !!currencies?.can.manageRates }
}

/** The manual rate dialog: a new rate of a day, or the correction of a kept one. */
export type RateDialog = { readonly mode: 'set'; readonly quote?: string; readonly day?: string } | { readonly mode: 'correct'; readonly row: RateDay }

export interface RateDraft {
  quote: string
  day: string
  rate: string
}

export const draftOf = (dialog: RateDialog, today: string, fallbackQuote: string): RateDraft =>
  dialog.mode === 'correct' ? { quote: dialog.row.quote, day: dialog.row.day, rate: dialog.row.manual?.rate ?? dialog.row.rate } : { quote: dialog.quote ?? fallbackQuote, day: dialog.day ?? today, rate: '' }

/** The rate as typed, with a comma or a dot. */
export const typedRate = (text: string): string => text.trim().replace(',', '.')

/** What is wrong with the draft (each a key), or none. */
export function draftProblems(draft: RateDraft, base: string, today: string): { quote?: string; day?: string; rate?: string } {
  const problem = manualRateProblem({ base, quote: draft.quote, day: draft.day.trim(), rate: typedRate(draft.rate) }, today)
  if (!problem) return {}
  if (problem.path === 'quote') return { quote: draft.quote === base ? 'rates.problem.same' : 'rates.problem.quote' }
  if (problem.path === 'day') return { day: draft.day.trim() > today ? 'rates.problem.future' : 'rates.problem.day' }
  if (problem.path === 'rate') return draft.rate.trim() === '' ? { rate: 'rates.problem.rateEmpty' } : { rate: 'rates.problem.rate' }
  return { quote: 'rates.problem.quote' }
}

/** "1 EUR = 1.085 USD" of the draft, or null while the rate is not a rate. */
export function draftWords(draft: RateDraft, base: string): string | null {
  const rate = normalRate(typedRate(draft.rate))
  if (rate === null || !/^[A-Z]{3}$/.test(draft.quote)) return null
  return `1 ${base} = ${rate.replace(/\.?0+$/, '')} ${draft.quote}`
}

/** The ECB's rate of the draft's day and currency in the loaded table, or null. */
export const ecbOfDay = (rates: Rates | null, quote: string, day: string, base: string): string | null => rates?.days.find((row) => row.base === base && row.quote === quote && row.day === day)?.ecb?.rate ?? null

/** Whether the typed rate is more than 5 % from the ECB's of the day (a typing slip is likely). */
export function farFrom(draft: RateDraft, ecb: string | null): boolean {
  const typed = normalRate(typedRate(draft.rate))
  if (typed === null || ecb === null) return false
  const a = Number.parseFloat(typed)
  const b = Number.parseFloat(ecb)
  return b > 0 && Math.abs(a - b) / b > 0.05
}

// ---- held -----------------------------------------------------------------------------------------------------------

export const manageHeld = (can: CurrencyAbilities, busy: boolean): Phrase | null => (!can.manage ? phrase('held.noManage') : busy ? phrase('held.busy') : null)
export const ratesHeld = (can: CurrencyAbilities, busy: boolean): Phrase | null => (!can.manageRates ? phrase('held.noRates') : busy ? phrase('held.busy') : null)

/** Why switching a currency off (or on) waits, or null. */
export function switchHeld(currency: Currency, can: CurrencyAbilities, busy: boolean): Phrase | null {
  if (currency.base) return phrase('held.base', { code: currency.code })
  if (currency.id === null) return phrase('held.base', { code: currency.code })
  return manageHeld(can, busy)
}

/** Why "Read today's rates" waits, or null. */
export function readHeld(feed: Feed, can: CurrencyAbilities, busy: boolean): Phrase | null {
  return ratesHeld(can, busy) ?? (feed.on ? null : phrase('held.feedOff'))
}

/** A row may be picked for "Remove the manual rates" only when it has one. */
export const rowSelectable = (row: RateDay): Phrase | null => (row.manual ? null : phrase('rates.notManual'))

// ---- refusals ----------------------------------------------------------------------------------------------------------

export type CurrencyProblem = Phrase & { reload: boolean }

const REFUSALS: Readonly<Record<string, string>> = {
  CURRENCY_ON: 'problem.currencyOn',
  BASE_OFF: 'problem.baseOff',
  MANUAL_KEPT: 'problem.manualKept',
  MANUAL_GONE: 'problem.manualGone',
  ECB_ROW: 'problem.ecbRow',
  FEED_OFF: 'problem.feedOff',
  ECB_UNREADABLE: 'problem.unreadable',
  DATABASE: 'problem.database',
}

/** A refused write in words: its refusal code, a moved row (read again), a missing right, an invalid value. */
export function currencyProblem(error: unknown): CurrencyProblem {
  if (!isApiError(error)) return { key: 'problem.write', reload: false }
  const paths = error.issues.map(issuePath)
  const refusal = paths.map((path) => /^refusal[/.]([A-Z_]+)$/.exec(path)?.[1]).find((code) => code !== undefined)
  if (refusal && REFUSALS[refusal]) return { key: REFUSALS[refusal]!, reload: refusal === 'MANUAL_GONE' || refusal === 'DATABASE' }
  if (error.kind === 'conflict') return { key: paths.some((path) => path.split(/[./]/).includes('version')) ? 'problem.moved' : 'problem.state', reload: true }
  if (error.kind === 'invalid') return { key: 'problem.invalid', reload: false }
  if (error.kind === 'forbidden') return { key: 'problem.forbidden', reload: false }
  if (error.kind === 'unavailable') return { key: 'problem.unavailable', reload: false }
  return { key: 'problem.write', reload: false }
}

/** A live event of this section (another person's change shows at once). */
export const currenciesTouched = (change: { type: string }): boolean => change.type === 'currency.changed' || change.type === 'currency.rates_changed'

// ---- the table ---------------------------------------------------------------------------------------------------------

export const RATE_PERIODS = [30, 90, 365] as const
export type RatePeriod = (typeof RATE_PERIODS)[number]

/** A day moved by whole days. */
export const shiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** The currencies a manual rate may be kept for: the company's other document currencies first, then the rest offered. */
export function quoteChoices(currencies: Currencies | null): string[] {
  if (!currencies) return []
  const own = currencies.currencies.filter((entry) => entry.active && !entry.base).map((entry) => entry.code)
  return [...own, ...currencies.offered.filter((code) => code !== currencies.company.base && !own.includes(code))]
}

/** The rate without its trailing zeros ("1.08500000" → "1.085"). */
export const plainRate = (rate: string): string => (rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate)
