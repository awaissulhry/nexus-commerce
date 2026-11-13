import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { acceptRepromise, calculatePromise, CERTIFICATE_STATES, declineRepromise, listPromises, promiseOnQuote, proposeRepromise, repromiseDraft, withdrawRepromise } from './api'
import { designScreen, FIXTURES } from './fixtures'
import {
  atpRows,
  bridgeSetter,
  bridgeWords,
  calcBodyOf,
  calcFromAtp,
  calcHeld,
  certificateWords,
  changesWords,
  controlsOf,
  csvOfLines,
  decisionHolds,
  EMPTY_CALC,
  formHeld,
  formOf,
  formProblems,
  groupsWords,
  movedSizes,
  NAMESPACE,
  previewStale,
  promiseCan,
  proposeBodyOf,
  queryOf,
  readProblemOf,
  refusalOf,
  rowVerbOf,
  sizeGridOf,
  sizesWords,
  slackWords,
  sourcesInWeek,
  warningKey,
  weekShown,
  type Words,
} from './model'

/**
 * Planning › Promise dates (SCR-109; B-W2b-336 on the APIs of B-W2b-301 and B-W2b-317): the address, who may do what (nobody
 * decides their own re-promise, the Owner included), the lines' words, the re-promise form and its body, refusals in words,
 * the calculator's body and the bridge in our words, Available to promise as rows and weeks, the calls as the API takes them,
 * and every design case drawn in Italian and English with no key left on screen.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale })
const { LIST, LINES, DRAFT, PROPOSAL, ATP, ANSWER, QUOTE, CALC_FORM, PLANNER, SALES } = FIXTURES
const PLANNER_CAN = promiseCan(['planning.promise.view', 'planning.promise.manage', 'planning.view'])
const SALES_CAN = promiseCan(['planning.promise.view', 'orders.manage', 'email.send'])
const OWNER_CAN = promiseCan(['planning.promise.view', 'planning.promise.manage', 'orders.manage', 'email.send', 'planning.view'])

describe('promise dates: the address', () => {
  it('keeps every term; drops what it does not know', () => {
    const controls = controlsOf(new URLSearchParams('site=s1&tile=AT_RISK&risk=LATE&q=SO-1&style=st&weeks=26&week=2026-W48&calc=1&quote=q1&repromise=l1&proposal=p1'))
    expect(controls).toEqual({ site: 's1', tile: 'AT_RISK', risk: 'LATE', q: 'SO-1', style: 'st', weeks: 26, week: '2026-W48', calc: true, quote: 'q1', repromise: 'l1', proposal: 'p1' })
    expect(queryOf(controls)).toBe('site=s1&tile=AT_RISK&risk=LATE&q=SO-1&style=st&weeks=26&week=2026-W48&calc=1&quote=q1&repromise=l1&proposal=p1')
    const plain = controlsOf(new URLSearchParams('tile=NOPE&risk=X&weeks=500&calc=yes'))
    expect(plain).toMatchObject({ tile: null, risk: null, weeks: null, calc: false })
    expect(queryOf(plain)).toBe('')
  })
})

describe('promise dates: who may do what', () => {
  it('Re-promise is the planner’s; Review where one waits; held with the reason', () => {
    const plain = LINES.find((entry) => !entry.waiting)!
    const waiting = LINES.find((entry) => entry.waiting)!
    expect(rowVerbOf(plain, PLANNER_CAN)).toEqual({ label: 'row.repromise', held: null })
    expect(rowVerbOf(plain, SALES_CAN)).toEqual({ label: 'row.repromise', held: 'held.noManage' })
    expect(rowVerbOf({ ...plain, may: { repromise: false } }, PLANNER_CAN).held).toBe('held.mayNot')
    expect(rowVerbOf(waiting, SALES_CAN)).toEqual({ label: 'row.review', held: null })
  })

  it('nobody decides their own proposal — the Owner included; tell needs the right and an address; only the proposer takes it back', () => {
    expect(decisionHolds(PROPOSAL, SALES_CAN, SALES.id)).toEqual({ accept: null, decline: null, tell: null, withdraw: 'held.notProposer' })
    const own = decisionHolds({ ...PROPOSAL, may: { accept: false, tell: false, decline: false, withdraw: true } }, OWNER_CAN, PLANNER.id)
    expect(own).toEqual({ accept: 'held.ownProposal', decline: 'held.ownProposal', tell: 'held.ownProposal', withdraw: null })
    expect(decisionHolds(PROPOSAL, PLANNER_CAN, 'someone-else').accept).toBe('held.noDecide')
    expect(decisionHolds({ ...PROPOSAL, recipients: [] }, SALES_CAN, SALES.id).tell).toBe('held.noRecipient')
    expect(decisionHolds(PROPOSAL, promiseCan(['planning.promise.view', 'orders.manage']), SALES.id).tell).toBe('held.noTell')
    expect(decisionHolds({ ...PROPOSAL, state: 'ACCEPTED' }, SALES_CAN, SALES.id).accept).toBe('held.notWaiting')
  })
})

describe('promise dates: the lines in words', () => {
  it('slack, certificate cover, changes, sizes', () => {
    const { t } = words()
    expect(slackWords(4, t)).toBe('4 days to spare')
    expect(slackWords(-1, t)).toBe('1 day short')
    expect(slackWords(0, t)).toBe('No day to spare')
    expect(slackWords(null, t)).toBe('—')
    expect(certificateWords({ state: 'OK', certificate: 'C', validTo: '2027-03-31' }, words())).toBe('Until 31 Mar 2027')
    expect(certificateWords({ state: 'MISSING', certificate: null, validTo: null }, words('it'))).toBe('Mancante')
    expect(changesWords({ count: 2, slips: 1, lastChangeAt: null }, t)).toBe('2 changes · 1 slip')
    expect(changesWords({ count: 0, slips: 0, lastChangeAt: null }, t)).toBe('None')
    expect(sizesWords(LINES[0]!, t)).toBe('48–52')
    expect(sizesWords(LINES.find((entry) => entry.kind === 'MADE_TO_MEASURE')!, t)).toBe('One made-to-measure unit')
  })

  it('the CSV of the lines (semicolons, no money, no person)', () => {
    const csv = csvOfLines(LINES.slice(0, 1), words()).split('\r\n')
    expect(csv[0]!.split(';')).toEqual(['Customer', 'Order', 'Line', 'Style', 'Colour', 'Sizes', 'Open pieces', 'First promise', 'Current promise', 'Planned finish', 'Finish from', 'Slack days', 'Risk', 'Certificate cover', 'Changes', 'Slips'])
    expect(csv[1]!.split(';').slice(0, 3)).toEqual(['Moto Demo Srl', 'SO-DEMO-1043', '10'])
    expect(csv[1]).toContain('At risk')
  })
})

describe('promise dates: the re-promise form', () => {
  it('starts from the plan; moves only sizes with another day; says every problem', () => {
    const form = formOf(DRAFT)
    expect(form.dates).toEqual({ '48': '2026-12-10', '50': '2026-12-10' })
    expect(form.reasonCode).toBe('MATERIAL_LATE')
    expect(movedSizes(DRAFT, form)).toEqual([
      { size: '48', from: '2026-12-04', to: '2026-12-10' },
      { size: '50', from: '2026-12-04', to: '2026-12-10' },
    ])
    expect(formHeld(formProblems(DRAFT, form))).toBeNull()
    const bad = { ...form, dates: { '48': '2026-11-01', '52': '2026-12-04' }, reasonCode: '' }
    const problems = formProblems(DRAFT, bad)
    expect(problems.sizes).toEqual({ '48': 'problem.past' })
    expect(problems.reason).toBe('problem.reason')
    expect(formHeld(problems)).toBe('held.sizeProblem')
    expect(formHeld(formProblems(DRAFT, { ...form, dates: { '52': '2026-12-04' } }))).toBe('held.nothingMoved')
    expect(formProblems({ ...DRAFT, plan: [{ ...DRAFT.plan[0]!, current: null }] }, form).sizes).toEqual({ '48': 'problem.noPromise' })
  })

  it('the body: sizes moved, the reason, the note, own words only when written; a made-to-measure unit sends no size', () => {
    const form = { ...formOf(DRAFT), note: '  Pelle in ritardo.  ' }
    expect(proposeBodyOf(DRAFT, form)).toEqual({ sizes: [{ size: '48', date: '2026-12-10' }, { size: '50', date: '2026-12-10' }], reasonCode: 'MATERIAL_LATE', reason: 'Pelle in ritardo.' })
    expect(proposeBodyOf(DRAFT, { ...form, note: '', own: true, subject: ' S ', body: ' B ' })).toMatchObject({ message: { subject: 'S', body: 'B' } })
    const mtm = { ...DRAFT, plan: [{ ...DRAFT.plan[0]!, size: null }], proposed: [{ size: null, from: '2026-12-04', to: '2026-12-10' }] }
    expect(proposeBodyOf(mtm, formOf(mtm)).sizes).toEqual([{ date: '2026-12-10' }])
  })

  it('the preview is written again when the days or the reason differ from the plan’s', () => {
    const form = formOf(DRAFT)
    expect(previewStale(DRAFT, form, movedSizes(DRAFT, form))).toBe(false)
    const moved = { ...form, dates: { ...form.dates, '48': '2026-12-11' } }
    expect(previewStale(DRAFT, moved, movedSizes(DRAFT, moved))).toBe(true)
    expect(previewStale(DRAFT, { ...form, reasonCode: 'CAPACITY' }, movedSizes(DRAFT, form))).toBe(true)
  })
})

describe('promise dates: refusals and failed reads in words', () => {
  it('the re-promise refusals of the API', () => {
    const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path }])
    expect(refusalOf(conflict('refusal/OWN_PROPOSAL')).key).toBe('refusal.OWN_PROPOSAL')
    expect(refusalOf(conflict('refusal/STALE')).key).toBe('refusal.STALE')
    expect(refusalOf(conflict('orderLineId')).key).toBe('refusal.WAITING_EXISTS')
    expect(refusalOf(conflict('body/to')).key).toBe('refusal.NO_RECIPIENT')
    expect(refusalOf(conflict('body/sizes/1/date'))).toMatchObject({ key: 'refusal.CERTIFICATE', sizes: [1] })
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/reasonCode' }])).key).toBe('refusal.reason')
    expect(refusalOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/reason' }])).key).toBe('refusal.declineReason')
    expect(refusalOf(new ApiError('unavailable', 503, 'unavailable', 'x')).key).toBe('refusal.offline')
    expect(refusalOf(new Error('x')).key).toBe('refusal.failed')
    expect(readProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('error.forbidden')
  })
})

describe('promise dates: the calculator', () => {
  it('held until a style, a colour and a piece; the body in the scale’s order', () => {
    expect(calcHeld(EMPTY_CALC, null)).toBe('held.noSite')
    expect(calcHeld(EMPTY_CALC, 's1')).toBe('calc.held.style')
    expect(calcHeld({ ...CALC_FORM, quantities: {} }, 's1')).toBe('calc.held.quantity')
    expect(calcHeld({ ...CALC_FORM, country: 'Italia' }, 's1')).toBe('calc.held.country')
    expect(calcHeld(CALC_FORM, 's1')).toBeNull()
    expect(calcBodyOf({ ...CALC_FORM, quantities: { '56': 6, '48': 10, '50': 0 }, country: 'it' }, 's1', ['46', '48', '50', '52', '54', '56'])).toEqual({
      siteId: 's1',
      styleId: CALC_FORM.styleId,
      colourwayId: CALC_FORM.colourwayId,
      sizes: [
        { size: '48', quantity: 10 },
        { size: '56', quantity: 6 },
      ],
      wantedDate: '2026-12-11',
      country: 'IT',
    })
  })

  it('the bridge and the sizes in our words, never the API’s English', () => {
    expect(bridgeWords(ANSWER.bridge, bridgeSetter(ANSWER), words())).toBe('base lead time 15 days + queue at today’s load 6 days + DEMO-LEA-01 Nappa Nero to buy 14 days = 35 days → 21 Dec')
    expect(bridgeWords(ANSWER.bridge, bridgeSetter(ANSWER), words('it'))).toContain('da comprare')
    expect(groupsWords(ANSWER.groups, words())).toBe('48 14 Dec, 50–52 21 Dec, 56 not promised')
    expect(warningKey('NO_ROUTING')).toBe('warning.NO_ROUTING')
    expect(warningKey('SOMETHING_NEW')).toBe('warning.other')
  })
})

describe('promise dates: available to promise', () => {
  it('rows: each colourway’s total, then its sizes in the scale’s order; one week’s size grid', () => {
    const rows = atpRows(ATP)
    expect(rows.map((row) => row.key.split('|')[1] ?? row.kind)).toEqual(['colour', '48', '50', '52', '54', 'colour', '50', '52'])
    expect(weekShown(ATP, null)).toBe(ATP.weeks[0]!.key)
    expect(weekShown(ATP, 'nope')).toBe(ATP.weeks[0]!.key)
    const grid = sizeGridOf(ATP, ATP.weeks[0]!.key)
    expect(grid.sizes.map((entry) => entry.key)).toEqual(ATP.style.sizes)
    expect(grid.value[ATP.colourways[0]!.colourway.id]!['48']).toBe(ATP.colourways[0]!.sizes[0]!.cells[0]!.available)
  })

  it('a week’s sources (the first week takes what is past due or undated); ticked sizes of one colour → the calculator', () => {
    const size48 = ATP.colourways[0]!.sizes[0]!
    expect(sourcesInWeek(size48.sources, size48.cells[0]!, true).map((source) => source.number)).toEqual(['SO-DEMO-1049'])
    expect(sourcesInWeek(size48.sources, size48.cells[2]!, false).map((source) => source.number)).toEqual(['WO-DEMO-0221'])
    const rows = atpRows(ATP)
    expect(calcFromAtp(rows.filter((row) => row.kind === 'size' && row.colourway.id === ATP.colourways[0]!.colourway.id).slice(0, 2), ATP.style.id)).toMatchObject({ styleId: ATP.style.id, quantities: { '48': 1, '50': 1 } })
    expect(calcFromAtp([rows[1]!, rows[6]!], ATP.style.id)).toBeNull()
  })

  it('the certificate states mirror the API’s (apps/factory-api modules/planning/promise/certificates.ts)', () => {
    expect([...CERTIFICATE_STATES]).toEqual(['OK', 'EXPIRING', 'MISSING', 'NOT_NEEDED'])
  })
})

function mockApi(answers: unknown[]) {
  const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init.headers).get('idempotency-key') })
    return new Response(JSON.stringify(answers.shift() ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('promise dates: the calls as the API takes them', () => {
  it('reads the lines, the draft; sends the proposal and sales’ word with one key each', async () => {
    const { api, calls } = mockApi([LIST, DRAFT, { proposal: PROPOSAL, replayed: false }, { told: true, outboundId: null, lineDate: '2026-12-18', replayed: false, proposal: PROPOSAL }, { proposal: PROPOSAL, replayed: false }, { proposal: PROPOSAL, replayed: false }])
    expect((await listPromises(api, { siteId: 's1', tile: 'AT_RISK', q: ' SO ' })).lines).toHaveLength(LINES.length)
    expect(calls[0]!.url).toBe('/api/planning/promises?siteId=s1&tile=AT_RISK&q=SO&limit=300')
    await repromiseDraft(api, 'l1')
    expect(calls[1]!.url).toBe('/api/planning/promises/order-lines/l1/re-promise')
    await proposeRepromise(api, 'l1', { sizes: [{ size: '48', date: '2026-12-10' }], reasonCode: 'MATERIAL_LATE' }, 'k1')
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/api/planning/promises/order-lines/l1/re-promise', key: 'k1' })
    await acceptRepromise(api, 'p1', { tell: true }, 'k2')
    expect(calls[3]).toMatchObject({ method: 'POST', url: '/api/planning/promises/re-promises/p1/accept', body: { tell: true }, key: 'k2' })
    await declineRepromise(api, 'p1', '  why  ', 'k3')
    expect(calls[4]).toMatchObject({ url: '/api/planning/promises/re-promises/p1/decline', body: { reason: 'why' } })
    await withdrawRepromise(api, 'p1', 'k4')
    expect(calls[5]).toMatchObject({ url: '/api/planning/promises/re-promises/p1/withdraw' })
  })

  it('the calculator writes nothing; Use on quote is W1’s own change with the version', async () => {
    const { api, calls } = mockApi([{ today: '2026-11-16', asOf: 'x', market: null, answer: ANSWER }, { quote: { id: 'q1', version: 5, promiseDate: '2026-12-21' } }])
    await calculatePromise(api, calcBodyOf(CALC_FORM, 's1', ['48', '50', '52', '56']))
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/planning/promise/calculate', key: null })
    await promiseOnQuote(api, QUOTE.quote, '2026-12-21', 'k5')
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: `/api/sales/quotes/${QUOTE.quote.id}`, body: { version: 4, promiseDate: '2026-12-21' }, key: 'k5' })
  })

  it('the page is built and reached from the record links', () => {
    expect(OFFICE_PAGES.has('/planning/promise')).toBe(true)
    expect(LIST_PAGES['/planning/promises']).toBe('/planning/promise')
    expect(LIST_PAGES['/planning/promise/atp']).toBe('/planning/promise')
    expect(LIST_PAGES['/planning/exceptions/supply-late']).toBe('/planning/exceptions')
  })
})

const LEFT_KEY = /\b(?:noAccess|page|live|common|error|tiles|tile|lines|col|line|risk|finish|slack|cert|changes|size|row|keys|bulk|held|problem|refusal|notice|proposal|history|repromise|language|decide|done|state|warning|bridge|calc|atp|strategy|sizegrid|csv|supplyLate)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:planning\.promise\.view|planning\.promise\.manage|orders\.manage|email\.send|planning\.exceptions\.manage|purchasing\.view)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
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
})
