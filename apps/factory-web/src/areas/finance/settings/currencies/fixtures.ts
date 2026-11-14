import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { COMPANY, inShell, type Role } from '../../_demo/fixtures'
import { designScreen as financeSettings } from '../fixtures'
import { FinanceSettingsView } from '../view/FinanceSettingsView'
import type { Currencies, Currency, RateDay, Rates } from './api'
import type { CurrencyAbilities } from './model'
import { CurrenciesSection, type CurrenciesSectionModel } from './view/CurrenciesSection'

/**
 * SCR-435 — Finance › Settings › Currencies & rates (design finance.settings sec:currencies; B-W2b-389; PLT-132, PLT-133),
 * with made-up data only: the company's own currency (EUR), its document currencies with the rate a document of today
 * takes (USD at the ECB's, GBP at a rate typed for the day, CHF waiting for a rate, JPY switched off), the daily ECB rates in
 * test mode (FAKE: made-up rates), the rates per day on the shared list frame (the ECB's and the typed one side by side, one
 * flagged far from the ECB's), the manual rate dialog (set, correct, refused, held with why), removing typed rates, the
 * states (loading, failed, empty, no permission) and the roles: Finance (every company), Finance of one company (rates held),
 * Sales (read only). Every rate is invented; nothing here is a real rate of any day.
 */

const TODAY = '2026-11-13'
const uid = (n: number) => `0190f0e2-0389-7000-8000-${String(n).padStart(12, '0')}`

const rate = (quote: string, value: string, source: 'ECB' | 'MANUAL', rateDate = TODAY) => ({ base: 'EUR', quote, rate: value, rateDate, source, how: 'STORED' as const, words: `1 EUR = ${value.replace(/\.?0+$/, '')} ${quote}` })
const currency = (n: number, code: string, over: Partial<Currency> = {}): Currency => ({ id: uid(n), companyId: COMPANY, code, minorUnits: code === 'JPY' ? 0 : 2, active: true, base: false, version: 1, rate: null, waits: null, updatedAt: '2026-11-10T09:00:00.000Z', ...over })

const FEED_ON = { on: true, status: 'ACTIVE' as const, mode: 'FAKE' as const, accountId: uid(90), lastOkAt: '2026-11-13T15:30:04.000Z', lastErrorAt: null, lastError: null, lastEcbDay: TODAY }
const FEED_OFF = { on: false, status: 'NONE' as const, mode: null, accountId: null, lastOkAt: null, lastErrorAt: null, lastError: null, lastEcbDay: null }

const CURRENCIES: Currencies = {
  company: { id: COMPANY, code: 'DEMO', legalName: 'Demo Pelletteria S.r.l.', base: 'EUR' },
  today: TODAY,
  currencies: [
    currency(1, 'EUR', { base: true }),
    currency(2, 'USD', { rate: rate('USD', '1.08500000', 'ECB') }),
    currency(3, 'GBP', { rate: rate('GBP', '0.85500000', 'MANUAL') }),
    currency(4, 'CHF', { waits: 'No exchange rate of EUR to CHF for 2026-11-13 or the 7 days before.' }),
    currency(5, 'JPY', { active: false }),
  ],
  offered: ['JPY', 'CZK', 'DKK', 'HUF', 'PLN', 'RON', 'SEK', 'NOK', 'CAD', 'AUD'],
  feed: FEED_ON,
  can: { manage: true, manageRates: true },
}

const day = (n: number, quote: string, date: string, ecb: string | null, manual: string | null, far = false): RateDay => ({
  key: `EUR:${quote}:${date}`,
  base: 'EUR',
  quote,
  day: date,
  ecb: ecb ? { id: uid(100 + n), rate: ecb } : null,
  manual: manual ? { id: uid(200 + n), rate: manual, version: 1, overriddenBy: { id: uid(300), name: 'Fiona Conti' }, updatedAt: `${date}T10:15:00.000Z` } : null,
  rate: manual ?? ecb ?? '0',
  source: manual ? 'MANUAL' : 'ECB',
  words: `1 EUR = ${manual ?? ecb} ${quote}`,
  farFromEcb: far,
})

const RATES: Rates = {
  from: '2026-10-14',
  to: TODAY,
  today: TODAY,
  truncated: false,
  canManage: true,
  days: [
    day(1, 'GBP', TODAY, '0.8512', '0.855'),
    day(2, 'USD', TODAY, '1.085', null),
    day(3, 'GBP', '2026-11-12', '0.8509', null),
    day(4, 'USD', '2026-11-12', '1.0839', '1.2', true),
    day(5, 'GBP', '2026-11-11', '0.8521', null),
    day(6, 'USD', '2026-11-11', '1.0861', null),
  ],
}

const ALL: CurrencyAbilities = { view: true, manage: true, manageRates: true }

const base = (over: Partial<CurrenciesSectionModel> = {}): CurrenciesSectionModel => ({
  can: ALL,
  currencies: { value: CURRENCIES, problem: null },
  rates: { value: RATES, problem: null },
  quote: null,
  period: 30,
  dialog: null,
  dialogProblem: null,
  removing: null,
  busy: false,
  notice: null,
  ...over,
})

interface CurrenciesCase {
  role: Role
  section: CurrenciesSectionModel
  /** Shown inside the whole Finance settings page (SCR-083) instead of alone. */
  inPage?: boolean
}

function CurrenciesDesign({ model }: { model: CurrenciesCase }) {
  const section = createElement(CurrenciesSection, { model: model.section })
  if (!model.inPage) return inShell('/finance/settings', section, model.role)
  const page = financeSettings.cases.find((item) => item.id === 'finance')!.model
  return inShell('/finance/settings', createElement(FinanceSettingsView, { model: page.settings, currencies: section }), model.role)
}

const NO_RATES: Rates = { ...RATES, days: [] }

export const designScreen = defineDesignScreen<CurrenciesCase>({
  screen: 'SCR-435',
  title: 'Finance settings › Currencies & rates: base currency, document currencies, daily ECB rates (test mode), the rates per day with a manual rate',
  view: CurrenciesDesign,
  cases: [
    { id: 'finance', label: 'Finance · EUR base; USD at the ECB’s, GBP typed for the day, CHF waits for a rate; daily ECB rates on (test mode)', model: { role: 'finance', section: base() }, note: 'The typed 1.2 of 12/11 is flagged: more than 5% from the ECB’s.' },
    { id: 'in-page', label: 'Finance · The section in its place on Finance settings (after Costing)', model: { role: 'finance', section: base(), inPage: true } },
    { id: 'feed-off', label: 'Finance · Daily ECB rates off (the default) and no rate yet: Read today’s rates held with why', model: { role: 'finance', section: base({ currencies: { value: { ...CURRENCIES, feed: FEED_OFF, currencies: CURRENCIES.currencies.map((entry) => (entry.base || !entry.active ? entry : { ...entry, rate: null, waits: `No exchange rate of EUR to ${entry.code} for 2026-11-13 or the 7 days before.` })) }, problem: null }, rates: { value: NO_RATES, problem: null } }) } },
    { id: 'set-rate', label: 'Finance · Set a rate for a day: CHF, today, 0,9420 (how it reads, live)', model: { role: 'finance', section: base({ dialog: { mode: 'set', quote: 'CHF', day: TODAY }, draft: { quote: 'CHF', day: TODAY, rate: '0,9420' } }) } },
    { id: 'correct-far', label: 'Finance · Correct the typed USD rate of 12/11: 1.2 is more than 5% from the ECB’s 1.0839 (a warning)', model: { role: 'finance', section: base({ dialog: { mode: 'correct', row: RATES.days[3]! } }) } },
    { id: 'set-held', label: 'Finance · A future day and a rate of 0: Save held with why', model: { role: 'finance', section: base({ dialog: { mode: 'set' }, draft: { quote: 'USD', day: '2026-11-20', rate: '0' } }) } },
    { id: 'set-refused', label: 'Finance · Refused: a typed rate is kept for that day already (said in words)', model: { role: 'finance', section: base({ dialog: { mode: 'set', quote: 'GBP', day: TODAY }, draft: { quote: 'GBP', day: TODAY, rate: '0.856' }, dialogProblem: { key: 'problem.manualKept', reload: false } }) } },
    { id: 'remove', label: 'Finance · Two typed rates chosen: Remove 2 typed rates (asks first)', model: { role: 'finance', section: base({ selected: [RATES.days[0]!.key, RATES.days[3]!.key], removing: [RATES.days[0]!, RATES.days[3]!] }) } },
    { id: 'saved', label: 'Finance · Saved (notice); the ECB file read: 1 day kept', model: { role: 'finance', section: base({ notice: { tone: 'success', words: { key: 'notice.read_one', params: { count: 1 } } } }) } },
    { id: 'unreadable', label: 'Finance · The ECB file could not be read now (the rates kept stay)', model: { role: 'finance', section: base({ notice: { tone: 'danger', words: { key: 'problem.unreadable' } } }) } },
    { id: 'one-company', label: 'Finance of one company · Its currencies changed; the rates (every company’s) held with why', model: { role: 'finance', section: base({ can: { view: true, manage: true, manageRates: false } }) } },
    { id: 'sales', label: 'Sales · Read only: every action held with the missing right', model: { role: 'sales', section: base({ can: { view: true, manage: false, manageRates: false } }) } },
    { id: 'loading', label: 'Loading', model: { role: 'finance', section: base({ currencies: { value: null, problem: null }, rates: { value: null, problem: null } }) } },
    { id: 'error', label: 'The read failed (in words, Try again)', model: { role: 'finance', section: base({ currencies: { value: null, problem: 'problem.read.unavailable' } }) } },
    { id: 'rates-error', label: 'The rates could not be read (Try again); the rest shown', model: { role: 'finance', section: base({ rates: { value: null, problem: 'problem.read.unavailable' } }) } },
    { id: 'no-permission', label: 'No permission (currencies.view)', model: { role: 'sales', section: base({ can: { view: false, manage: false, manageRates: false } }) } },
  ],
})
