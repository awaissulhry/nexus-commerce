import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CORRECTION_KINDS } from '@nexus/factory-domain/people/close/rules'
import { MATCH_STATES } from '@nexus/factory-domain/people/reports/attendance/report'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { getAttendance, getEarnings, openEarningsByWorker } from './api'
import { designScreen as reportsScreen, EARNINGS, REPORT, WORKERS } from './fixtures'
import {
  absenceCodes,
  absenceMinutes,
  amountText,
  attendanceCsvRows,
  cellMinutes,
  changedCells,
  earningsCsvRows,
  earningsRange,
  groupLabel,
  lineRows,
  matches,
  matchWords,
  monthChoices,
  monthRows,
  NEW_SEND,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  reportsProblem,
  sendHeld,
  shareText,
  workerRows,
} from './model'
import { designScreen as printScreen } from './print/fixtures'

/**
 * People › People reports (SCR-264 and its PDF; B-W2b-64 on the API of B-W2b-48 and B-W2b-43): the rights (per worker needs the right
 * AND the grain), "worker" never in the address, months, the match check, hidden groups in the files, the reason Send is
 * held (pay never reaches a link), the calls, and every design case drawn in both languages with no person outside the
 * record and the list the right opens.
 */

function fakeApi(answer: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const api: ApiClient = createApiClient({ baseUrl: 'http://api.test', fetch: (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch })
  return { api, calls }
}

describe('people reports: rights and address', () => {
  it('per worker needs both the right and the pay grain', () => {
    expect(reportsCan(['people.earnings.records']).records).toBe(false)
    expect(reportsCan(['money.pay']).records).toBe(false)
    expect(reportsCan(['people.earnings.records', 'money.pay'])).toMatchObject({ records: true, pay: true })
  })

  it('keeps the filters; a list of workers is never an address term', () => {
    const address = reportsAddressOf(new URLSearchParams('month=2026-10&to=2026-11&group=team&team=t1&earnings=worker'))
    expect(address).toEqual({ month: '2026-10', to: '2026-11', group: 'team', teamId: 't1', earnings: 'line' })
    expect(reportsAddressText(address)).toBe('?month=2026-10&to=2026-11&group=team&team=t1')
    expect(reportsAddressOf(new URLSearchParams('month=oct')).month).toBeNull()
  })

  it('offers months newest first across a year end, and a range never runs backwards', () => {
    expect(monthChoices('2026-02', 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11'])
    expect(earningsRange('2026-10', null)).toEqual({ from: '2026-10', to: '2026-10' })
    expect(earningsRange('2026-10', '2026-09')).toEqual({ from: '2026-10', to: '2026-10' })
    expect(earningsRange('2026-10', '2026-11')).toEqual({ from: '2026-10', to: '2026-11' })
  })
})

describe('people reports: attendance', () => {
  it('a column per absence code; a hidden group has no figure, not a zero', () => {
    expect(absenceCodes(REPORT.groups)).toEqual(['FER', 'MAL'])
    expect(absenceMinutes(REPORT.groups[0]!.figures, 'FER')).toBe(480)
    expect(absenceMinutes(REPORT.groups[0]!.figures, 'XXX')).toBe(0)
    expect(absenceMinutes(null, 'FER')).toBeNull()
    expect(groupLabel({ code: null, name: null })).toBeNull()
  })

  it('says the match from its state, the month in the language', () => {
    expect(matchWords({ state: 'DIFFERS', cells: 2 }, '2026-10', 'it')).toEqual({ key: 'match.DIFFERS', params: { month: 'ottobre 2026', count: 2 } })
  })

  it('reads a closed day\'s cell by kind and code', () => {
    const cells = { presentMinutes: 1, ordinaryMinutes: 2, nightMinutes: 3, holidayMinutes: 4, overtimeDayMinutes: 5, overtimeNightMinutes: 6, overtimeHolidayMinutes: 7, absences: [{ codeId: 'x', code: 'FER', minutes: 8 }] }
    expect(CORRECTION_KINDS.map((kind) => cellMinutes(cells, kind, 'FER'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(cellMinutes(cells, 'ABSENCE', 'MAL')).toBe(0)
  })

  it('searches the row names, whatever the case', () => {
    expect(matches('L-A · Linea giacche', ' giacche ')).toBe(true)
    expect(matches('L-A · Linea giacche', 'PANT')).toBe(false)
    expect(matches(null, '')).toBe(true)
  })

  it('a cell corrected twice shows once', () => {
    const entry = (kind: 'ORDINARY' | 'ABSENCE', absenceCode: string | null) => ({ id: 'x', kind, absenceCode, minutesBefore: 1, minutesAfter: 2, reason: 'r', at: 'a', by: 'b' })
    expect(changedCells({ corrections: [entry('ORDINARY', null), entry('ORDINARY', null), entry('ABSENCE', 'FER')] })).toEqual([{ kind: 'ORDINARY', absenceCode: null }, { kind: 'ABSENCE', absenceCode: 'FER' }])
  })

  it('the file writes a hidden group empty', () => {
    const rows = attendanceCsvRows(REPORT, ['FER', 'MAL'], { noGroup: 'None', tooFew: 'Too few' }, 'en')
    expect(rows[2]).toEqual(['L-C · Linea guanti', 'Too few', null, null, null, null, null, null, null, null])
    expect(rows[0]!.length).toBe(rows[2]!.length)
  })

  it('a closed gate is said in words', () => {
    expect(reportsProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'gate/ATTENDANCE', message: 'x' }])).words.key).toBe('attendance.gateOff')
  })
})

describe('people reports: earnings', () => {
  it('lines, months and workers share one row; a hidden group has nothing', () => {
    expect(lineRows(EARNINGS)[2]).toMatchObject({ label: 'L-C · Linea guanti', earnings: null, tooFew: true })
    expect(monthRows(EARNINGS, 'en')[0]).toMatchObject({ label: 'October 2026', pieces: '6980' })
    expect(workerRows(WORKERS).map((row) => row.label)).toEqual(['Giulia Esempio · D-0001', 'Paolo Prova · D-0002'])
  })

  it('keeps the API\'s order of workers: by name, never by amount', () => {
    const rows = workerRows(WORKERS)
    expect(rows[0]!.earnings).toBeGreaterThan(rows[1]!.earnings!)
    expect(workerRows({ workers: [...WORKERS.workers].reverse() }).map((row) => row.id)).toEqual([...WORKERS.workers].reverse().map((row) => row.employeeId))
  })

  it('writes amounts from minor units with no currency it was not told; unknown is a dash', () => {
    expect(amountText(1845000, 'en')).toBe('18,450.00')
    expect(amountText(null, 'en')).toBe('—')
    expect(shareText('5.0', 'en')).toBe('5.0 %')
  })

  it('the file of lines holds no figure of a hidden group', () => {
    expect(earningsCsvRows(lineRows(EARNINGS), { noLine: 'None', tooFew: 'Too few' }, 'en')[2]).toEqual(['L-C · Linea guanti', 'Too few', null, null, null, null])
  })
})

describe('people reports: Send report', () => {
  it('is held with why: pay figures never reach a link, and no link carries a report yet', () => {
    expect(sendHeld(NEW_SEND)).toBe('send.heldNoLink')
    expect(sendHeld({ ...NEW_SEND, report: 'earnings' })).toBe('send.heldPay')
  })
})

describe('people reports: the calls', () => {
  it('reads groups only; never a person key', async () => {
    const { api, calls } = fakeApi({})
    await getAttendance(api, { siteId: 's1', month: '2026-10', groupBy: 'team', teamId: 't1' }).catch(() => undefined)
    await getEarnings(api, { companyId: 'c1', from: '2026-10', to: '2026-10', siteId: null }).catch(() => undefined)
    expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual(['/people/reports/attendance?siteId=s1&month=2026-10&groupBy=team&teamId=t1', '/people/reports/earnings?companyId=c1&from=2026-10&to=2026-10'])
  })

  it('per worker is a recorded POST with its own key', async () => {
    const { api, calls } = fakeApi({ workers: [] })
    await openEarningsByWorker(api, { companyId: 'c1', from: '2026-10', to: '2026-10', siteId: 's1' })
    expect(calls[0]!.init.method).toBe('POST')
    expect(new URL(calls[0]!.url).pathname).toBe('/people/reports/earnings/by-worker')
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBeTruthy()
  })
})

const LEFT_KEY = /(?:^|[>\s"])(?:band|attendance|match|differences|kind|day|earnings|send|print|privacy|scope|section|common|held|arrange)\.[a-zA-Z]/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const NAMESPACES = ['shell', 'lists', 'records', 'people', 'people-efficiency', 'people-reports', 'ds-words']

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [reportsScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the prints never name a person', () => {
    for (const item of printScreen.cases) {
      const html = render(printScreen as unknown as DesignScreen<unknown>, item.model, 'en')
      for (const worker of WORKERS.workers) expect(html).not.toContain(worker.name)
    }
  })

  it('the dynamic words exist in both languages (match states, cell kinds)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['people-reports'])['people-reports']!)
      for (const state of MATCH_STATES) expect(t(`match.${state}`, { month: 'x', count: 2 })).not.toContain('match.')
      for (const kind of CORRECTION_KINDS) expect(t(`kind.${kind}`)).not.toBe(`kind.${kind}`)
    }
  })
})
