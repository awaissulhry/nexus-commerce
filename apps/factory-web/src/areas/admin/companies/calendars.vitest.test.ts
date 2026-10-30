import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { companyWriteProblem, conflictDates, dayIn, draftHeld, EMPTY_DRAFT, holidayRows, nationalDaysIn, sitesWords, weekChanged, weekHeld, weekWords, type SiteDays } from './calendars/model'
import { designScreen } from './fixtures'
import { COMPANY_TABS } from './model'

/**
 * Admin › Company › Calendars › Working days and holidays (B-W2a-59): the pure rules (runs of days in one row, the sites
 * that decide a date the other way, the national list's days of a year, a 409's dates, the week and the Add dialog's
 * holds) and every SCR-008 calendars case drawn in Italian and English with no message key on screen.
 */

const day = (date: string, kind: 'HOLIDAY' | 'CLOSURE' | 'WORKING', name: string, holidaySet: string | null = null) => ({ id: `d-${date}`, date, kind, name, holidaySet })
const site = (code: string, days: SiteDays['days']): SiteDays => ({ site: { id: `s-${code}`, code, name: `Site ${code}` }, calendar: days.length ? { id: `c-${code}`, version: 1 } : null, days })
const words = (key: string, params?: Readonly<Record<string, string | number>>) => `${key}${params ? JSON.stringify(params) : ''}`

describe('the holidays list', () => {
  it('joins consecutive days of the same kind and name into one row, in date order', () => {
    const rows = holidayRows([day('2027-08-16', 'CLOSURE', 'Summer'), day('2027-08-09', 'CLOSURE', 'Summer'), day('2027-08-10', 'CLOSURE', 'Summer'), day('2027-08-15', 'HOLIDAY', 'Ferragosto', 'IT'), day('2027-08-11', 'CLOSURE', 'Summer')])
    expect(rows.map((row) => [row.from, row.to, row.days, row.kind])).toEqual([
      ['2027-08-09', '2027-08-11', 3, 'CLOSURE'],
      ['2027-08-15', '2027-08-15', 1, 'HOLIDAY'],
      ['2027-08-16', '2027-08-16', 1, 'CLOSURE'],
    ])
  })

  it('does not join a national day with a hand-made one of the same name', () => {
    expect(holidayRows([day('2027-12-25', 'HOLIDAY', 'Natale', 'IT'), day('2027-12-26', 'HOLIDAY', 'Natale')]).length).toBe(2)
  })

  it('names the sites that open a company holiday or close a company working day ("All sites but …")', () => {
    const rows = holidayRows([day('2027-12-08', 'HOLIDAY', 'Immacolata', 'IT'), day('2027-12-11', 'WORKING', 'Saturday stock count')], [site('DS1', [{ date: '2027-12-08', kind: 'WORKING', name: 'Count' }]), site('DN1', [{ date: '2027-12-11', kind: 'CLOSURE', name: 'Closed' }]), site('EP1', [])])
    expect(rows[0]!.overrides).toEqual([{ site: { id: 's-DS1', code: 'DS1', name: 'Site DS1' }, dates: ['2027-12-08'], open: true }])
    expect(rows[1]!.overrides.map((entry) => [entry.site.code, entry.open])).toEqual([['DN1', false]])
    expect(sitesWords(rows[0]!, words)).toBe('acal.sites.allBut{"sites":"acal.sites.open{\\"code\\":\\"DS1\\"}"}')
    expect(sitesWords(holidayRows([day('2027-01-01', 'HOLIDAY', 'Capodanno', 'IT')], [site('DS1', [])])[0]!, words)).toBe('acal.sites.all')
  })

  it('a site that also closes a company holiday does not override it', () => {
    expect(holidayRows([day('2027-01-06', 'HOLIDAY', 'Epifania', 'IT')], [site('DS1', [{ date: '2027-01-06', kind: 'CLOSURE', name: 'Closed' }])])[0]!.overrides).toEqual([])
  })
})

describe('the national list, a 409 and the holds', () => {
  it('counts the national list days of the shown year only', () => {
    const days = [day('2026-12-25', 'HOLIDAY', 'Natale', 'IT'), day('2027-01-01', 'HOLIDAY', 'Capodanno', 'IT'), day('2027-06-24', 'HOLIDAY', 'Patrono')]
    expect(nationalDaysIn(days, 2027)).toBe(1)
    expect(nationalDaysIn(days, 2028)).toBe(0)
  })

  it('reads the days already set from a 409 (`body/days/<date>`, either path shape)', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/days/2027-08-15' }, { path: ['body', 'days', '2027-08-14'] }, { path: 'body/days/2027-08-15' }])
    expect(conflictDates(error)).toEqual(['2027-08-14', '2027-08-15'])
    expect(companyWriteProblem(error)).toBe('acal.add.conflict')
    expect(conflictDates(new ApiError('invalid', 400, 'invalid', 'x'))).toEqual([])
  })

  it('says the company-wide rule for a 403 and a stale version for a 409 without days', () => {
    expect(companyWriteProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('acal.problem.wholeCompany')
    expect(companyWriteProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('ps.problem.conflict')
    expect(companyWriteProblem(new ApiError('unavailable', 0, 'network', 'x'))).toBe('ps.problem.unknown')
  })

  it('holds Add until a first day and a name, and a last day not before the first', () => {
    expect(draftHeld(EMPTY_DRAFT)).toBe('acal.add.needDate')
    expect(draftHeld({ ...EMPTY_DRAFT, from: '2027-06-24' })).toBe('acal.add.needName')
    expect(draftHeld({ ...EMPTY_DRAFT, from: '2027-08-20', to: '2027-08-09', name: 'x' })).toBe('acal.add.toBefore')
    expect(draftHeld({ ...EMPTY_DRAFT, from: '2027-01-01', to: '2028-06-01', name: 'x' })).toBe('acal.add.tooLong')
    expect(draftHeld({ ...EMPTY_DRAFT, from: '2027-06-24', name: 'Patrono' })).toBeNull()
  })

  it('the working week: changed, held when empty, said as a run or as days', () => {
    expect(weekChanged([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBe(false)
    expect(weekChanged([1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6])).toBe(true)
    expect(weekHeld([])).toBe('acal.week.atLeastOne')
    const name = (weekday: number) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekday]!
    expect(weekWords([1, 2, 3, 4, 5], name)).toBe('Mon – Fri')
    expect(weekWords([1, 3, 5], name)).toBe('Mon, Wed, Fri')
  })

  it("today is the company's own day (its zone)", () => {
    expect(dayIn('Europe/Rome', new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01')
    expect(dayIn('UTC', new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31')
  })

  it('the Calendars tab sits between Defaults and Activity', () => {
    expect(COMPANY_TABS).toEqual(['legal', 'sites', 'defaults', 'calendars', 'activity'])
  })
})

describe('the admin-calendars words', () => {
  it('the same keys and placeholders in it and en, no empty text', () => {
    const en = CATALOGUE.en['admin-calendars'] ?? {}
    const itc = CATALOGUE.it['admin-calendars'] ?? {}
    expect(Object.keys(en).length).toBeGreaterThan(60)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(itc[key]?.trim(), key).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })
})

/** A key left on screen: one of this tab's (`acal.`), the page kit's (`ps.`, `cal.`) or the grid's (`calendar.`). */
const LEFT_KEY = /\b(?:acal|ps|cal|calendar)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('every calendars case of SCR-008 draws in both languages with no key on screen', () => {
  const screen = designScreen as DesignScreen<unknown>
  const cases = screen.cases.filter((item) => item.id.startsWith('record-calendars') || item.id === 'holidays-entry')
  it('has the states the design names', () => {
    expect(cases.map((item) => item.id)).toEqual(
      expect.arrayContaining(['holidays-entry', 'record-calendars', 'record-calendars-add', 'record-calendars-conflict', 'record-calendars-none', 'record-calendars-read-only', 'record-calendars-loading', 'record-calendars-error', 'record-calendars-week']),
    )
  })
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      const View = screen.view as ComponentType<{ model: unknown }>
      for (const item of cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        if (item.id === 'record-calendars') {
          expect(html).toContain(locale === 'it' ? 'Giorni lavorativi e festività 2027' : 'Working days and holidays 2027')
          expect(html).toContain(locale === 'it' ? 'Tutti gli stabilimenti tranne DS1 (aperto)' : 'All sites but DS1 (open)')
          expect(html).toContain('Ferragosto')
        }
        if (item.id === 'record-calendars-none') expect(html).toContain(locale === 'it' ? 'Imposta il calendario della società' : 'Set up the company calendar')
      }
    })
  }
})
