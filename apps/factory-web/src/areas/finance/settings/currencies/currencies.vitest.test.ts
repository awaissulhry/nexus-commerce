import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { messagesFor } from '../../../../lib/i18n/messages'
import { designScreen } from './fixtures'
import { abilitiesOf, currenciesTouched, currencyProblem, draftOf, draftProblems, draftWords, farFrom, plainRate, quoteChoices, readHeld, rowSelectable, shiftDay, switchHeld, typedRate } from './model'

/** Finance › Settings › Currencies & rates (B-W2b-389), its rules without a browser; made-up rates only. */

const feed = (on: boolean) => ({ on, status: on ? ('ACTIVE' as const) : ('NONE' as const), mode: null, accountId: null, lastOkAt: null, lastErrorAt: null, lastError: null, lastEcbDay: null })
const ALL = { view: true, manage: true, manageRates: true }

describe('who may and why an action is held', () => {
  it('reads currencies.view from the session and the rest from the API', () => {
    expect(abilitiesOf(['currencies.view'], { can: { manage: true, manageRates: false } })).toEqual({ view: true, manage: true, manageRates: false })
    expect(abilitiesOf([], { can: { manage: true, manageRates: true } })).toEqual({ view: false, manage: false, manageRates: false })
    const base = { id: 'a', companyId: 'c', code: 'EUR', minorUnits: 2, active: true, base: true, version: 1, rate: null, waits: null, updatedAt: null }
    expect(switchHeld(base, ALL, false)).toEqual({ key: 'held.base', params: { code: 'EUR' } })
    expect(switchHeld({ ...base, code: 'USD', base: false }, { ...ALL, manage: false }, false)).toEqual({ key: 'held.noManage' })
    expect(switchHeld({ ...base, code: 'USD', base: false }, ALL, true)).toEqual({ key: 'held.busy' })
    expect(readHeld(feed(false), ALL, false)).toEqual({ key: 'held.feedOff' })
    expect(readHeld(feed(true), { ...ALL, manageRates: false }, false)).toEqual({ key: 'held.noRates' })
    expect(readHeld(feed(true), ALL, false)).toBeNull()
  })
})

describe('the manual rate', () => {
  it('checks the draft as the domain does and reads it in words', () => {
    expect(draftProblems({ quote: 'USD', day: '2026-11-13', rate: '1,0850' }, 'EUR', '2026-11-13')).toEqual({})
    expect(draftProblems({ quote: 'USD', day: '2026-11-14', rate: '1.08' }, 'EUR', '2026-11-13')).toEqual({ day: 'rates.problem.future' })
    expect(draftProblems({ quote: 'EUR', day: '2026-11-13', rate: '1' }, 'EUR', '2026-11-13')).toEqual({ quote: 'rates.problem.same' })
    expect(draftProblems({ quote: 'USD', day: '2026-11-13', rate: '' }, 'EUR', '2026-11-13')).toEqual({ rate: 'rates.problem.rateEmpty' })
    expect(draftProblems({ quote: 'USD', day: '2026-11-13', rate: '0' }, 'EUR', '2026-11-13')).toEqual({ rate: 'rates.problem.rate' })
    expect(draftWords({ quote: 'USD', day: '2026-11-13', rate: '1,0850' }, 'EUR')).toBe('1 EUR = 1.085 USD')
    expect(draftWords({ quote: 'USD', day: '2026-11-13', rate: 'x' }, 'EUR')).toBeNull()
    expect(typedRate(' 0,9420 ')).toBe('0.9420')
    expect(farFrom({ quote: 'USD', day: '2026-11-13', rate: '1.2' }, '1.0839')).toBe(true)
    expect(farFrom({ quote: 'USD', day: '2026-11-13', rate: '1.09' }, '1.0839')).toBe(false)
    expect(draftOf({ mode: 'set' }, '2026-11-13', 'USD')).toEqual({ quote: 'USD', day: '2026-11-13', rate: '' })
    expect(plainRate('1.08500000')).toBe('1.085')
    expect(plainRate('160.00000000')).toBe('160')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('offers the company’s other currencies first, and a row with a typed rate only to remove', () => {
    const value = designScreen.cases[0]!.model.section.currencies.value!
    expect(quoteChoices(value).slice(0, 4)).toEqual(['USD', 'GBP', 'CHF', 'JPY'])
    expect(quoteChoices(value)).not.toContain('EUR')
    const rows = designScreen.cases[0]!.model.section.rates.value!.days
    expect(rowSelectable(rows[0]!)).toBeNull()
    expect(rowSelectable(rows[1]!)).toEqual({ key: 'rates.notManual' })
  })
})

describe('refusals and live changes in words', () => {
  it('words each refusal code itself, never the API’s English', () => {
    const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'English words', null, [{ path, message: 'x' }])
    expect(currencyProblem(conflict('refusal/MANUAL_KEPT'))).toEqual({ key: 'problem.manualKept', reload: false })
    expect(currencyProblem(conflict('refusal/BASE_OFF'))).toEqual({ key: 'problem.baseOff', reload: false })
    expect(currencyProblem(conflict('refusal/DATABASE'))).toEqual({ key: 'problem.database', reload: true })
    expect(currencyProblem(conflict('version'))).toEqual({ key: 'problem.moved', reload: true })
    expect(currencyProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.forbidden', reload: false })
    expect(currencyProblem(new Error('boom'))).toEqual({ key: 'problem.write', reload: false })
    expect(currenciesTouched({ type: 'currency.rates_changed' })).toBe(true)
    expect(currenciesTouched({ type: 'invoice.issued' })).toBe(false)
  })

  it('has every word of the section in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = messagesFor(locale, ['finance-currencies'])['finance-currencies']!
      for (const key of ['title', 'problem.manualKept', 'held.noRates', 'rates.bulkRemove_other', 'feed.status.ACTIVE', 'source.MANUAL']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})

describe('the design cases', () => {
  it('covers the states and roles the design names', () => {
    const ids = designScreen.cases.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['finance', 'feed-off', 'set-rate', 'correct-far', 'set-held', 'set-refused', 'remove', 'one-company', 'sales', 'loading', 'error', 'no-permission', 'in-page']))
    expect(designScreen.screen).toBe('SCR-435')
  })
})
