import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LANE_KINDS as DOMAIN_LANE_KINDS } from '@nexus/factory-domain/production/reports/daily'
import { LINE_STATES as DOMAIN_LINE_STATES } from '@nexus/factory-domain/production/reports/lines'
import { DAILY_REPORT_KEY as DOMAIN_KEY, REPORT_LOCALES as DOMAIN_LOCALES } from '@nexus/factory-domain/production/reports/subscriptions'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_PAGES, OFFICE_NAV } from '../../../shell/nav/office-nav'
import { designScreen as floorScreen } from '../wip/fixtures'
import { changeSubscription, DAILY_REPORT_KEY, getDaily, LANE_KINDS, LINE_STATES, REPORT_LOCALES, subscribe } from './api'
import { canAs, DAILY, LANES, LINE_CARDS, ME, MINE, PEOPLE } from './demo/fixtures'
import { designScreen as reportsScreen } from './fixtures'
import {
  addressOf,
  addressText,
  chartData,
  draftOf,
  lineHref,
  lineScopeOf,
  mySubscription,
  outputPhrase,
  pctText,
  printHref,
  siteEfficiency,
  stationNotes,
  stepLine,
  styleHref,
  subscribeBody,
  subscribeHeld,
  subscribeProblem,
  toggleDay,
  weekdaysPhrase,
} from './model'
import { designScreen as printScreen } from './print/fixtures'

/**
 * Production › Reports (SCR-240, SCR-240-print) and Floor now's Lines (SCR-073 fn-lines; B-W2a-38): the enum lists equal
 * factory-domain's, the pure rules (the address, the chart, the lines' words, the e-mail draft, why Subscribe is held, a
 * refused write in words), the calls as the API takes them, the navigation row, and every design case drawn in Italian
 * and English with no message key or placeholder left on screen and no person of the floor anywhere.
 */

describe('the lists mirror factory-domain', () => {
  it('lane kinds, line states, report key and languages', () => {
    expect(LANE_KINDS).toEqual(DOMAIN_LANE_KINDS)
    expect(LINE_STATES).toEqual(DOMAIN_LINE_STATES)
    expect(DAILY_REPORT_KEY).toBe(DOMAIN_KEY)
    expect(REPORT_LOCALES).toEqual(DOMAIN_LOCALES)
  })
})

describe('the address and the links', () => {
  const site = DAILY.site.id
  it('reads the site and the day, and ignores what is not one', () => {
    expect(addressOf(new URLSearchParams(`site=${site}&date=2026-10-29`))).toEqual({ site, date: '2026-10-29' })
    expect(addressOf(new URLSearchParams('site=nope&date=29/10/2026'))).toEqual({ site: null, date: null })
    expect(addressText({ site, date: null })).toBe(`?site=${site}`)
    expect(addressText({ site: null, date: null })).toBe('')
    expect(printHref('/w/A', { site, date: '2026-10-29' })).toBe(`/w/A/production/reports/print?site=${site}&date=2026-10-29`)
    expect(lineHref('/w/A', 'L')).toBe('/w/A/production/floor?line=L')
    expect(styleHref('/w/A', 'DEMO-JKT 01')).toBe('/w/A/production/work-orders?q=DEMO-JKT%2001')
  })
  it('Floor now: the line scope and [ / ] through the lines', () => {
    const [l1, l2, l3] = LINE_CARDS
    expect(lineScopeOf(new URLSearchParams(`line=${l1!.id}`))).toBe(l1!.id)
    expect(lineScopeOf(new URLSearchParams('line=x'))).toBeNull()
    expect(stepLine(LINE_CARDS, null, 1)).toBe(l1!.id)
    expect(stepLine(LINE_CARDS, null, -1)).toBe(l3!.id)
    expect(stepLine(LINE_CARDS, l1!.id, 1)).toBe(l2!.id)
    expect(stepLine(LINE_CARDS, l3!.id, 1)).toBeNull()
    expect(stepLine([], null, 1)).toBeNull()
  })
})

describe('the numbers as drawn', () => {
  it('bars per lane, a line’s efficiency as a point, none for a work centre', () => {
    expect(chartData(LANES)).toEqual([
      { lane: 'L1', good: 42, scrap: 2, rework: 3, efficiency: 86.4 },
      { lane: 'L2', good: 18, scrap: 0, rework: 1, efficiency: 78.8 },
      { lane: 'QC', good: 55, scrap: 1, rework: 2 },
    ])
    // (3318 + 1512) / (3840 + 1920) = 83.85 %.
    expect(siteEfficiency(LANES)).toBe('83.9')
    expect(siteEfficiency([])).toBeNull()
    expect(pctText('83.9', 'it')).toBe('83,9 %')
    expect(pctText('83.9', 'en')).toBe('83.9 %')
    expect(pctText(null, 'en')).toBe('—')
  })
  it('a line card says output against the plan, and per station only who is signed in and machines down (F2)', () => {
    expect(outputPhrase(LINE_CARDS[0]!)).toEqual({ key: 'lines.output.ofPlan', params: { done: 14, planned: 20 } })
    expect(outputPhrase(LINE_CARDS[1]!)).toEqual({ key: 'lines.output.noPlan', params: { done: 0 } })
    expect(stationNotes(LINE_CARDS[0]!)).toEqual({ nobody: ['CUC-02'], down: ['CUC-03 · MAC-DEMO-07'] })
  })
})

describe('the e-mail: draft, held, body, refusals', () => {
  const manager = canAs('manager')
  const inspector = canAs('inspector')
  it('starts from my settings, else 07:00 Monday to Friday, me, each person’s language', () => {
    expect(draftOf(null, ME.id)).toEqual({ sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], language: 'own', recipients: [ME.id] })
    expect(draftOf(MINE, ME.id)).toEqual({ sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], language: 'it', recipients: [ME.id] })
    expect(mySubscription([MINE], DAILY.site.id)).toBe(MINE)
    expect(mySubscription([MINE], 'elsewhere')).toBeNull()
    expect(toggleDay([1, 2], 7)).toEqual([1, 2, 7])
    expect(toggleDay([1, 2], 1)).toEqual([2])
    expect(weekdaysPhrase([5, 4, 3, 2, 1])).toEqual({ key: 'weekdays.workweek' })
    expect(weekdaysPhrase([1, 2, 3, 4, 5, 6, 7])).toEqual({ key: 'weekdays.everyDay' })
    expect(weekdaysPhrase([1, 3])).toEqual({ key: 'weekdays.some', params: { count: 2 } })
  })
  it('holds Subscribe with its reason', () => {
    const draft = draftOf(null, ME.id)
    expect(subscribeHeld(draft, manager, ME.id)).toBeNull()
    expect(subscribeHeld({ ...draft, sendTime: '7' }, manager, ME.id)).toEqual({ key: 'subscribe.held.time' })
    expect(subscribeHeld({ ...draft, weekdays: [] }, manager, ME.id)).toEqual({ key: 'subscribe.held.weekdays' })
    expect(subscribeHeld({ ...draft, recipients: [] }, manager, ME.id)).toEqual({ key: 'subscribe.held.recipients' })
    expect(subscribeHeld({ ...draft, recipients: [ME.id, PEOPLE[1]!.id] }, inspector, ME.id)).toEqual({ key: 'subscribe.held.noSubscribe' })
    expect(subscribeHeld(draft, canAs('sales'), ME.id)).toEqual({ key: 'subscribe.held.noView' })
  })
  it('sends me alone without a list, colleagues with one, null for each person’s language', () => {
    expect(subscribeBody(draftOf(null, ME.id), 's1', ME.id)).toEqual({ siteId: 's1', sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], locale: null })
    expect(subscribeBody({ ...draftOf(null, ME.id), language: 'en', recipients: [ME.id, 'u2'] }, 's1', ME.id)).toEqual({ siteId: 's1', recipients: [ME.id, 'u2'], sendTime: '07:00', weekdays: [1, 2, 3, 4, 5], locale: 'en' })
  })
  it('says a refusal in words, naming the colleague who may not read it', () => {
    const refused = new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/recipients/1', message: 'no' }])
    expect(subscribeProblem(refused, PEOPLE, [ME.id, PEOPLE[2]!.id])).toEqual({ key: 'subscribe.problem.recipient', params: { name: 'Bea Esempio' } })
    expect(subscribeProblem(new ApiError('forbidden', 403, 'forbidden', 'x'), [], [])).toEqual({ key: 'subscribe.problem.forbidden' })
    expect(subscribeProblem(new ApiError('conflict', 409, 'conflict', 'x'), [], [])).toEqual({ key: 'subscribe.problem.changed' })
    expect(subscribeProblem(new Error('x'), [], [])).toEqual({ key: 'subscribe.problem.write' })
  })
})

describe('the calls', () => {
  function recording(answer: unknown): { api: ApiClient; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    return { api, calls }
  }
  it('reads the day of a site, subscribes with an Idempotency-Key, and turns off at the version', async () => {
    const read = recording(DAILY)
    await getDaily(read.api, { siteId: DAILY.site.id, date: '2026-10-29' })
    expect(read.calls[0]!.url).toBe(`http://api.test/production/reports/daily?siteId=${DAILY.site.id}&date=2026-10-29`)
    const write = recording({ subscriptions: [MINE] })
    await subscribe(write.api, { siteId: 's1', sendTime: '07:00', weekdays: [1], locale: null }, 'key-1')
    expect(JSON.parse(String(write.calls[0]!.init.body))).toEqual({ reportKey: 'production.daily', siteId: 's1', sendTime: '07:00', weekdays: [1], locale: null })
    expect(new Headers(write.calls[0]!.init.headers).get('idempotency-key')).toBe('key-1')
    const off = recording({ subscription: { ...MINE, active: false } })
    await changeSubscription(off.api, MINE.id, { version: 2, active: false }, 'key-2')
    expect(off.calls[0]!.init.method).toBe('PATCH')
    expect(JSON.parse(String(off.calls[0]!.init.body))).toEqual({ version: 2, active: false })
  })
})

describe('navigation', () => {
  it('Production › Reports › Production reports, with production.reports.view; the print page is a built page', () => {
    const production = OFFICE_NAV.areas.find((area) => area.id === 'production')!
    const reports = (production.sections ?? []).find((section) => section.id === 'production-reports')!
    expect(reports.items.map((item) => [item.href, item.permission])).toEqual([['/production/reports', 'production.reports.view']])
    expect(OFFICE_PAGES.has('/production/reports')).toBe(true)
    expect(OFFICE_PAGES.has('/production/reports/print')).toBe(true)
  })
})

const LEFT_KEY =
  /\b(?:noAccess|band|live|scope|daily|common|error|tile|chart|kind|lane|col|subscribe|weekday|weekdays|print|lines|floor|list|status)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs production.reports.view"). */
const SAID = /\b(?:production\.reports\.[a-z]+|workorders\.view)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen and no person of the floor', () => {
  for (const screen of [reportsScreen, printScreen, floorScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (states, kinds, weekdays, problems)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production-reports'])['production-reports']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const state of LINE_STATES) has(`lines.state.${state}`)
      for (const kind of LANE_KINDS) has(`kind.${kind}`)
      for (const day of [1, 2, 3, 4, 5, 6, 7]) has(`weekday.${day}`)
      for (const key of ['workweek', 'everyDay']) has(`weekdays.${key}`)
      has('weekdays.some', { count: 1 })
      has('weekdays.some', { count: 3 })
      for (const key of ['busy', 'noView', 'time', 'weekdays', 'recipients', 'noSubscribe']) has(`subscribe.held.${key}`)
      for (const key of ['write', 'forbidden', 'changed', 'someone', 'settings']) has(`subscribe.problem.${key}`)
      has('subscribe.problem.recipient', { name: 'x' })
      for (const key of ['read', 'forbidden', 'notFound', 'offline']) has(`error.${key}`)
      has('lines.workOrders', { count: 1, numbers: 'x' })
      has('lines.machineDown', { count: 2 })
    }
  })
})
