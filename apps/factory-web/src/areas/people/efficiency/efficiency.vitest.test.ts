import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { HOW_COMPUTED, OPERATION_STATES, REVIEW_DECISIONS, REVIEW_REASONS } from '@nexus/factory-domain/people/efficiency/rules'
import { OPEN_REASONS } from '@nexus/factory-domain/people/privacy/figures'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { decide, getOperations, getOverview, getReview, getTrend, openPersonFigures, peopleOfSite } from './api'
import { designScreen as efficiencyScreen, FIGURES, OVERVIEW } from './fixtures'
import {
  dateOfDay,
  dayOfDate,
  daysWithFigures,
  decisionBody,
  decisionHeld,
  deltaOf,
  differenceText,
  efficiencyAddressOf,
  efficiencyAddressText,
  efficiencyCan,
  efficiencyProblem,
  EMPTY_DECISION,
  EMPTY_PERSON,
  hiddenDays,
  individualWhy,
  leftOutWeight,
  linesCsvRows,
  operationHeld,
  operationsRange,
  overviewNotes,
  percentText,
  personHeld,
  printAddress,
  privacyFirst,
  proposedMinutes,
  rangeShown,
  reviewHeld,
  sparkValues,
  stateKey,
  tileHref,
  trendDomain,
  trendRows,
} from './model'
import { designScreen as printScreen } from './print/fixtures'
import { HOW_COUNTS } from './view/FiguresPanels'

/**
 * People › Efficiency (SCR-161 and its print; B-W2b-64 on the API of B-W2b-44): the rights, the address (never a person in it), a hidden
 * day is a gap and never a zero, what the minimum group size leaves out, the review's drafts, the refusals by code, the
 * calls as the API takes them, the file (a hidden line holds no figure), and every design case drawn in Italian and English
 * with no key left on screen and no person outside one person's dialog (Statuto dei Lavoratori art. 4; Owner F2, H3).
 */

const template = (key: string) => [...(templateOf(key)?.permissions ?? [])]
const apiError = (kind: ConstructorParameters<typeof ApiError>[0], path: string, status = 409) => new ApiError(kind, status, kind, 'x', null, [{ path, message: 'x' }])

function fakeApi(answer: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const api: ApiClient = createApiClient({ baseUrl: 'http://api.test', fetch: (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch })
  return { api, calls }
}

describe('efficiency: who may do what', () => {
  it('reads the rights by name: the manager decides, the supervisor reads, nobody holds one person by template', () => {
    expect(efficiencyCan(template('production_manager'))).toMatchObject({ view: true, review: true })
    expect(efficiencyCan(template('floor_supervisor'))).toMatchObject({ view: true, review: false })
    expect(efficiencyCan(template('sales')).view).toBe(false)
  })
})

describe('efficiency: the address', () => {
  it('keeps the scope and ignores what is not a date; no person term exists', () => {
    const address = efficiencyAddressOf(new URLSearchParams('from=2026-10-01&to=bad&line=l1&style=s1&compare=1&day=2026-10-02&open=o1&employeeId=e1'))
    expect(address).toEqual({ from: '2026-10-01', to: null, lineId: 'l1', styleId: 's1', compare: true, day: '2026-10-02', open: 'o1' })
    expect(efficiencyAddressText(address)).toBe('?from=2026-10-01&line=l1&style=s1&compare=1&day=2026-10-02&open=o1')
    expect(efficiencyAddressText(address)).not.toContain('employee')
  })

  it('the print keeps the scope, not the pop-up or the day; the grid reads the day when one is chosen', () => {
    const address = efficiencyAddressOf(new URLSearchParams('from=2026-10-01&day=2026-10-02&open=o1'))
    expect(printAddress('/w/D', address)).toBe('/w/D/people/efficiency/print?from=2026-10-01')
    expect(operationsRange(address)).toEqual({ from: '2026-10-02', to: '2026-10-02' })
    expect(operationsRange({ from: 'a', to: 'b', day: null })).toEqual({ from: 'a', to: 'b' })
  })

  it('shows the address first, then the answer, then this month so far; a day survives the date picker', () => {
    const now = new Date(2026, 10, 2, 9)
    expect(rangeShown({ from: null, to: null }, null, now)).toEqual({ from: '2026-11-01', to: '2026-11-02' })
    expect(rangeShown({ from: null, to: null }, { from: 'a', to: 'b' }, now)).toEqual({ from: 'a', to: 'b' })
    expect(rangeShown({ from: 'x', to: null }, { from: 'a', to: 'b' }, now)).toEqual({ from: 'x', to: 'b' })
    expect(dayOfDate(dateOfDay('2026-03-29'))).toBe('2026-03-29')
  })

  it('what the page says first stays first, whatever the storage says', () => {
    expect(privacyFirst(['tiles', 'privacy', 'review'])).toEqual(['privacy', 'tiles', 'review'])
    expect(privacyFirst(['tiles'])).toEqual(['privacy', 'tiles'])
  })
})

describe('efficiency: figures in words', () => {
  it('a day with too few people or nothing to show is a GAP, never a zero; the target stays', () => {
    const line = { targetPercent: '85.0', points: [{ date: '2026-10-01', tooFew: false, efficiency: '80.0', onStandardEfficiency: null, earnedMinutes: '1', attendedMinutes: '2' }, { date: '2026-10-02', tooFew: true, efficiency: null, onStandardEfficiency: null, earnedMinutes: null, attendedMinutes: null }] }
    const rows = trendRows(line, (date) => date)
    expect(rows[0]).toEqual({ day: '2026-10-01', efficiency: 80, target: 85 })
    expect(rows[1]).toEqual({ day: '2026-10-02', target: 85 })
    expect('efficiency' in rows[1]!).toBe(false)
    expect(hiddenDays(line)).toBe(1)
    expect(sparkValues([{ date: 'a', tooFew: true, actualMinutes: null, differencePercent: null }, { date: 'b', tooFew: false, actualMinutes: '1', differencePercent: '4.5' }])).toEqual([null, 4.5])
  })

  it('both series share one scale from zero', () => {
    expect(trendDomain([{ day: 'a', efficiency: 80, target: 85 }])).toEqual([0, 100])
    expect(trendDomain([{ day: 'a', efficiency: 123, target: 85 }])).toEqual([0, 130])
  })

  it('offers only days with something to show, newest first', () => {
    const points = (date: string, tooFew: boolean, earned: string | null) => ({ date, tooFew, efficiency: null, onStandardEfficiency: null, earnedMinutes: earned, attendedMinutes: null })
    expect(daysWithFigures([{ points: [points('2026-10-01', false, '1'), points('2026-10-03', false, '1'), points('2026-10-02', true, null), points('2026-10-04', false, null)] }])).toEqual(['2026-10-03', '2026-10-01'])
  })

  it('says a percentage, a signed difference and a movement; unknown is a dash', () => {
    expect(percentText('78.4', 'en')).toBe('78.4 %')
    expect(percentText(null, 'it')).toBe('—')
    expect(differenceText('30.0', 'en')).toBe('+30.0 %')
    expect(differenceText('-15.0', 'en')).toBe('-15.0 %')
    expect(deltaOf('80', '75', 'points', 'en')).toBe('+5.0')
    expect(deltaOf('70', '75', 'minutes', 'en')).toBe('−5')
    expect(deltaOf(null, '75', 'points', 'en')).toBeNull()
  })

  it('a tile links to its source list only once that page is built', () => {
    expect(tileHref('efficiency', '/w/D', new Set())).toBe('#fw-ef-lines')
    expect(tileHref('attended', '/w/D', new Set())).toBeNull()
    expect(tileHref('attended', '/w/D', new Set(['/people/attendance']))).toBe('/w/D/people/attendance')
    expect(tileHref('offStandard', '/w/D', new Set(['/production/labour']))).toBe('/w/D/production/labour?kind=OFF_STANDARD')
  })

  it('a row with too few people says so and cannot be chosen', () => {
    expect(operationHeld({ tooFew: true })).toBe('tooFew.short')
    expect(operationHeld({ tooFew: false })).toBeNull()
    expect(reviewHeld({ tooFew: true })).toBe('held.oneAtATime')
    expect(stateKey({ state: null }, true)).toBe('state.TOO_FEW_PEOPLE')
    expect(stateKey({ state: 'REVIEW' }, false)).toBe('state.REVIEW')
  })
})

describe('efficiency: what is left out is said, in proportion', () => {
  it('names the gate, the provisional figures, the hidden lines and the trainee days', () => {
    expect(overviewNotes({ attendance: { open: false, provisional: true }, hiddenGroups: 2, traineeDaysLeftOut: 1 }).map((note) => note.key)).toEqual(['notes.attendanceOff', 'notes.provisional', 'notes.hiddenLines', 'notes.traineeDays'])
    expect(overviewNotes({ attendance: { open: true, provisional: false }, hiddenGroups: 0, traineeDaysLeftOut: 0 })).toEqual([])
  })

  it('a queue that hides as much as it shows reads as a warning, never as the whole picture', () => {
    expect(leftOutWeight({ count: 3, leftOut: 0 })).toBe('none')
    expect(leftOutWeight({ count: 3, leftOut: 1 })).toBe('some')
    expect(leftOutWeight({ count: 3, leftOut: 3 })).toBe('most')
    expect(leftOutWeight({ count: 0, leftOut: 4 })).toBe('most')
  })

  it('the how panel says every line of the rule, one for one', () => {
    expect(HOW_COUNTS).toEqual({ formulas: HOW_COMPUTED.formulas.length, sources: HOW_COMPUTED.sources.length, exclusions: HOW_COMPUTED.exclusions.length })
  })
})

describe('efficiency: the standard review', () => {
  it('holds a decision until it has its reason, and Change until it has minutes', () => {
    const can = { review: true }
    expect(decisionHeld(EMPTY_DECISION, { review: false }, false)).toBe('held.noReview')
    expect(decisionHeld(EMPTY_DECISION, can, false)).toBe('held.pickDecision')
    expect(decisionHeld({ ...EMPTY_DECISION, decision: 'KEEP', reason: 'no' }, can, false)).toBe('held.reason')
    expect(decisionHeld({ decision: 'CHANGE', reason: 'three', proposed: 'x' }, can, false)).toBe('held.proposed')
    expect(decisionHeld({ decision: 'CHANGE', reason: 'three', proposed: '1,25' }, can, false)).toBeNull()
    expect(decisionHeld({ decision: 'KEEP', reason: 'three', proposed: '' }, can, true)).toBe('held.busy')
  })

  it('takes minutes in either language, as the API keeps them', () => {
    expect(proposedMinutes('1,25')).toBe('1.25')
    expect(proposedMinutes(' 3.1 ')).toBe('3.1')
    expect(proposedMinutes('0')).toBeNull()
    expect(proposedMinutes('1.2345')).toBeNull()
    expect(proposedMinutes('abc')).toBeNull()
  })

  it('a decision carries the last decision read, and minutes only with Change', () => {
    expect(decisionBody('s1', { decision: 'CHANGE', reason: ' why ', proposed: '1,5' }, 'd1')).toEqual({ siteId: 's1', decision: 'CHANGE', reason: 'why', proposedMinutes: '1.5', basedOn: 'd1' })
    expect(decisionBody('s1', { decision: 'KEEP', reason: 'why', proposed: '1,5' }, null)).toEqual({ siteId: 's1', decision: 'KEEP', reason: 'why', proposedMinutes: null, basedOn: null })
  })
})

describe('efficiency: one person', () => {
  it('holds Show figures until person and purpose are said', () => {
    expect(personHeld(EMPTY_PERSON, false)).toBe('held.pickPerson')
    expect(personHeld({ ...EMPTY_PERSON, personId: 'p' }, false)).toBe('held.pickPurpose')
    expect(personHeld({ personId: 'p', reason: 'PAY_QUERY', note: '' }, false)).toBeNull()
    expect(personHeld({ personId: 'p', reason: 'PAY_QUERY', note: 'x'.repeat(501) }, false)).toBe('held.noteLong')
  })

  it('says why the panel offers nobody: the gate first', () => {
    expect(individualWhy(false, false)).toBe('individual.gateOff')
    expect(individualWhy(false, true)).toBe('individual.gateOff')
    expect(individualWhy(true, false)).toBe('individual.notYours')
    expect(individualWhy(true, true)).toBe('individual.available')
  })

  it('every refusal of the figures says the same words, whoever the id names', () => {
    expect(efficiencyProblem(apiError('conflict', 'gate/PERFORMANCE')).words.key).toBe('refused.gatePerformance')
    expect(efficiencyProblem(apiError('forbidden', 'figures/NOT_ALLOWED', 403)).words.key).toBe('refused.notAllowed')
    expect(efficiencyProblem(apiError('conflict', 'refusal/STATION_SITE')).words.key).toBe('refused.STATION_SITE')
  })
})

describe('efficiency: refusals in words', () => {
  it('reads the review refusals and a long range by code; the rest are People words', () => {
    expect(efficiencyProblem(apiError('conflict', 'refusal/REVIEW_MOVED')).words.key).toBe('refused.REVIEW_MOVED')
    expect(efficiencyProblem(apiError('conflict', 'refusal/TOO_FEW_PEOPLE')).words.key).toBe('refused.TOO_FEW_PEOPLE')
    expect(efficiencyProblem(apiError('invalid', 'querystring/to', 400)).words.key).toBe('refused.range')
    expect(efficiencyProblem(new Error('x')).ns).toBe('people')
  })
})

describe('efficiency: the calls', () => {
  it('reads by site and scope; never a person key, never a sort', async () => {
    const { api, calls } = fakeApi({})
    for (const read of [getOverview(api, { siteId: 's1', from: '2026-10-01', compare: true }), getTrend(api, { siteId: 's1', lineId: 'l1' }), getOperations(api, { siteId: 's1', styleId: 'st' }), getReview(api, 's1')]) await read.catch(() => undefined)
    expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
      '/people/efficiency?siteId=s1&from=2026-10-01&compare=previous',
      '/people/efficiency/trend?siteId=s1&lineId=l1',
      '/people/efficiency/operations?siteId=s1&styleId=st',
      '/people/efficiency/review?siteId=s1',
    ])
    for (const call of calls) expect(call.url).not.toMatch(/employee|worker|person|sort|groupBy/i)
  })

  it('a decision is one command with its key and what was read', async () => {
    const { api, calls } = fakeApi({ routingOperationId: 'o1', decision: 'KEEP', style: { id: 'a', revisionId: 'b' } })
    await decide(api, 'o1', { siteId: 's1', decision: 'KEEP', reason: 'why', proposedMinutes: null, basedOn: 'd1' }, 'key-1')
    expect(new URL(calls[0]!.url).pathname).toBe('/people/efficiency/review/o1/decide')
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe('key-1')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ siteId: 's1', decision: 'KEEP', reason: 'why', proposedMinutes: null, basedOn: 'd1' })
  })

  it('one person is opened with the site in the body and the purpose; the people come from the register', async () => {
    const { api, calls } = fakeApi(FIGURES)
    await openPersonFigures(api, 'e1', { siteId: 's1', from: null, to: null, reason: 'PAY_QUERY', note: null }, 'key-2')
    expect(new URL(calls[0]!.url).pathname).toBe('/people/efficiency/people/e1/figures')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ siteId: 's1', reason: 'PAY_QUERY', note: null })
    const register = fakeApi({ employees: [], nextCursor: null, today: '2026-11-02' })
    await peopleOfSite(register.api, 's1')
    expect(new URL(register.calls[0]!.url).pathname).toBe('/people/employees')
  })
})

describe('efficiency: the file', () => {
  it('a hidden line is written empty, with no figure to subtract', () => {
    const rows = linesCsvRows(OVERVIEW.lines, { noLine: 'No line', tooFew: 'Too few' }, 'en')
    expect(rows[2]).toEqual(['L-C · Linea guanti', 'Too few', null, null, null, null, null, null])
    expect(rows[0]![1]).toBe('8')
  })
})

const LEFT_KEY = /(?:^|[>\s"])(?:band|tile|tileHint|tiles|notes|how|trend|lines|tooFew|operations|state|decision|review|history|bulk|sent|held|refused|individual|person|purpose|keys|arrange|print|privacy|scope|section|common)\.[a-zA-Z]/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const NAMESPACES = ['shell', 'lists', 'records', 'people', 'people-efficiency', 'ds-words']

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [efficiencyScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('no person appears outside one person\'s dialog, and the print names nobody', () => {
    for (const item of efficiencyScreen.cases) {
      const html = render(efficiencyScreen as unknown as DesignScreen<unknown>, item.model, 'en')
      if (!item.id.startsWith('person')) expect(html, item.id).not.toContain(FIGURES.person.name)
    }
    for (const item of printScreen.cases) expect(render(printScreen as unknown as DesignScreen<unknown>, item.model, 'en')).not.toContain(FIGURES.person.name)
  })

  it('the dynamic words exist in both languages (states, decisions, reasons, purposes, history)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['people-efficiency'])['people-efficiency']!)
      const has = (key: string) => expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const state of OPERATION_STATES) has(`state.${state}`)
      for (const decision of REVIEW_DECISIONS) {
        has(`decision.${decision}`)
        has(`history.${decision}`)
      }
      for (const reason of REVIEW_REASONS) has(`review.reason.${reason}`)
      for (const reason of OPEN_REASONS) has(`purpose.${reason}`)
    }
  })
})
