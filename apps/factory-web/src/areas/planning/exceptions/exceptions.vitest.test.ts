import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EXCEPTION_KINDS } from '@nexus/factory-domain/planning/exceptions/detect'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { acknowledgeExceptions, listExceptions, resolveException, snoozeException } from './api'
import { designScreen, ROWS } from './fixtures'
import { ackHeld, acknowledgeable, apiQueryOf, controlsOf, csvOfRows, fixesOf, impactOf, NAMESPACE, neighboursOf, noteProblem, queryOf, refusalOf, resolveHeld, selectHeld, sentenceOf, snoozeHeld, statusOf, titleOf, visibleRows, whatOf, type Words } from './model'

/**
 * Planning › Exceptions (SCR-125; B-W2a-70 on the exception API of B-W2a-22): the address, what each saved view asks
 * the API (so a tile and its list agree), the exceptions said in our words from their kind and facts, what may be done
 * and why not, the fixes each points to, refusals in words, the calls as the API takes them, and every design case
 * drawn in Italian and English with no key or placeholder left on screen.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => {
  const messages = messagesFor(locale, [NAMESPACE, 'buying'])
  const units = createTranslator(locale, messages.buying!)
  return { t: createTranslator(locale, messages[NAMESPACE]!), unit: (uom) => units(`uom.${uom}`), locale, timeZone: 'Europe/Rome' }
}
const byKind = (kind: string) => ROWS.find((row) => row.kind === kind)!
const KINDS = [...EXCEPTION_KINDS]

describe('exceptions: the address and the saved views', () => {
  it('keeps site, view, type, search and the open detail in the address', () => {
    const controls = controlsOf(new URLSearchParams('site=s1&view=mine&kind=SHORT&q=lea&open=e1'), KINDS)
    expect(controls).toEqual({ site: 's1', view: 'mine', kind: 'SHORT', q: 'lea', open: 'e1' })
    expect(queryOf(controls)).toBe('site=s1&view=mine&kind=SHORT&q=lea&open=e1')
    expect(controlsOf(new URLSearchParams('view=nope&kind=NOPE'), KINDS)).toMatchObject({ view: 'queue', kind: null })
    expect(queryOf({ site: null, view: 'queue', kind: null, q: ' ', open: null })).toBe('')
  })

  it('each view asks the API its own filters; To clear leaves the snoozed out', () => {
    expect(apiQueryOf('queue', null)).toEqual({ kind: null, status: ['NEW', 'ACKNOWLEDGED'], snoozed: false })
    expect(apiQueryOf('new', 'SHORT')).toEqual({ kind: 'SHORT', status: ['NEW'] })
    expect(apiQueryOf('mine', null)).toMatchObject({ status: ['NEW', 'ACKNOWLEDGED'], mine: true })
    expect(apiQueryOf('snoozedToday', null)).toMatchObject({ snoozed: true, limit: 200 })
    expect(apiQueryOf('resolved', null).status).toEqual(['RESOLVED'])
  })

  it('Snoozed until today keeps the snoozes that end by the end of the day; the search reads the facts too', () => {
    const snoozed = ROWS.filter((row) => row.snoozed)
    expect(visibleRows(ROWS, 'snoozedToday', '', '2026-11-16T22:59:59.000Z').map((row) => row.id)).toEqual(snoozed.map((row) => row.id))
    expect(visibleRows(ROWS, 'snoozedToday', '', '2026-11-16T10:00:00.000Z')).toEqual([])
    expect(visibleRows(ROWS, 'queue', 'po-demo-0091', '').map((row) => row.kind)).toEqual(['SUPPLY_LATE'])
    expect(visibleRows(ROWS, 'queue', 'L2', '').map((row) => row.kind)).toContain('LANE_OVERLOADED')
  })
})

describe('exceptions: in our words, never the API’s sentence', () => {
  it('says each kind from its facts, in both languages', () => {
    const en = words('en')
    expect(sentenceOf(byKind('SHORT'), en)).toBe('DEMO-LEA-01 Nero: 200 ft² short for SO-DEMO-1043, needed 14/11/2026; nothing is ordered for it yet. Ordered today it arrives 6 days late.')
    expect(titleOf(byKind('SHORT'), en)).toBe('SO-DEMO-1043 will be 6 days late')
    expect(sentenceOf(byKind('SUPPLY_LATE'), en)).toContain('PO-DEMO-0091 arrives 20/11/2026; it is needed 12/11/2026 (8 days late).')
    expect(sentenceOf(byKind('LANE_OVERLOADED'), en)).toBe('L2 is booked 112% from 23/11/2026 to 29/11/2026 (17,200 of 15,300 min).')
    expect(whatOf(byKind('PAST_DUE'), en)).toBe('SO-DEMO-1038 line 20')
    expect(impactOf(byKind('SUPPLY_LATE'), en)).toBe('2 orders · 8 days late')
    expect(impactOf(byKind('EXCESS'), en)).toBe('—')
    expect(titleOf(byKind('SHORT'), words('it'))).toBe('SO-DEMO-1043 sarà in ritardo di 6 giorni')
    for (const locale of LOCALES) for (const row of ROWS) expect(sentenceOf(row, words(locale)), `${locale} ${row.kind}`).not.toMatch(/\{|s\.[A-Z]/)
  })

  it('every kind, status and refusal has its words in both languages', () => {
    for (const locale of LOCALES) {
      const { t } = words(locale)
      for (const kind of KINDS) expect(t(`kind.${kind}`), `${locale} ${kind}`).not.toBe(`kind.${kind}`)
      for (const status of ['NEW', 'ACKNOWLEDGED', 'SNOOZED_RUN', 'RESOLVED', 'CLEARED']) expect(t(`status.${status}`)).not.toBe(`status.${status}`)
      for (const code of ['failed', 'resolved', 'acknowledged', 'changed', 'until', 'note', 'sites', 'invalid', 'forbidden', 'gone', 'offline']) expect(t(`refusal.${code}`)).not.toBe(`refusal.${code}`)
    }
  })
})

describe('exceptions: what a person may do, and the fixes', () => {
  const planner = { manage: true }
  const viewer = { manage: false }
  it('acknowledge only a new one; snooze and resolve an open one; nothing without planning.exceptions.manage', () => {
    expect(ackHeld(byKind('SHORT'), planner)).toBeNull()
    expect(ackHeld(byKind('SUPPLY_LATE'), planner)).toBe('held.acknowledged')
    expect(ackHeld(byKind('SHORT'), viewer)).toBe('held.noManage')
    expect(snoozeHeld(byKind('SUPPLY_LATE'), planner)).toBeNull()
    const resolved = { ...byKind('SHORT'), status: 'RESOLVED' as const }
    expect(resolveHeld(resolved, planner)).toBe('held.resolved')
    expect(selectHeld(resolved)).toBe('held.resolvedRow')
    expect(acknowledgeable(ROWS).map((row) => row.status)).toEqual(acknowledgeable(ROWS).map(() => 'NEW'))
    expect(statusOf(ROWS.find((row) => row.snoozed)!)).toBe('SNOOZED')
  })

  it('a resolve note is 3 to 1000 characters', () => {
    expect(noteProblem('ok')).toBe('resolve.noteShort')
    expect(noteProblem('Line cancelled.')).toBeNull()
    expect(noteProblem('x'.repeat(1001))).toBe('resolve.noteLong')
  })

  it('each fix is a real link to the record it points to', () => {
    const place = { prefix: '/w/DEMO', siteId: 's1' }
    const short = fixesOf(byKind('SHORT'), place)
    expect(short.map((fix) => fix.id)).toEqual(['buy', 'board', 'wo', 'material'])
    expect(short[0]!.href).toBe(`/w/DEMO/planning/mrp?site=s1&view=all&line=${byKind('SHORT').requirementId}`)
    expect(short[1]!.href).toContain('/w/DEMO/planning/board?site=s1&wo=')
    expect(fixesOf(byKind('SUPPLY_LATE'), place)[0]).toMatchObject({ id: 'chase', href: `/w/DEMO/purchasing/orders/${byKind('SUPPLY_LATE').record!.id}` })
    const lane = fixesOf(byKind('LANE_OVERLOADED'), place)
    expect(lane[0]!.href).toBe(`/w/DEMO/planning/board?site=s1&lane=${encodeURIComponent(`LINE:${byKind('LANE_OVERLOADED').record!.id}`)}&from=2026-11-23`)
    expect(lane[1]!.href).toBe('/w/DEMO/planning/capacity?site=s1&from=2026-11-23&bucket=WEEK')
  })

  it('K / J go on from the place a snoozed or resolved exception had when it left the queue', () => {
    const order = ['e1', 'e2', 'e3']
    expect(neighboursOf(order, 'e2', null)).toEqual({ prev: 'e1', next: 'e3' })
    expect(neighboursOf(order, 'e3', null)).toEqual({ prev: 'e2', next: null })
    // e2 was snoozed: the queue is now e1, e3; J opens e3 (the row in its place), K opens e1.
    expect(neighboursOf(['e1', 'e3'], 'e2', { id: 'e2', at: 1 })).toEqual({ prev: 'e1', next: 'e3' })
    expect(neighboursOf(['e1', 'e2'], 'e3', { id: 'e3', at: 2 })).toEqual({ prev: 'e2', next: null })
    expect(neighboursOf(['e1', 'e3'], 'e2', null)).toEqual({ prev: null, next: null })
  })

  it('a refused write in words', () => {
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'The exception is resolved already.'))).toBe('refusal.resolved')
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'This PlanningException changed since it was read'))).toBe('refusal.changed')
    expect(refusalOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/until', message: 'later' }]))).toBe('refusal.until')
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('refusal.forbidden')
  })

  it('the CSV speaks the row in words', () => {
    const csv = csvOfRows(ROWS.slice(0, 1), words('en'))
    expect(csv.split('\r\n')[0]).toBe('Type;What;In words;Orders affected;Days late;Owner;Age (days);Status;First found;Last seen')
    expect(csv).toContain('Short;DEMO-LEA-01 Nappa bovina 1,2 mm · Nero;')
  })
})

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> } {
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('exceptions: the calls as the API takes them', () => {
  it('lists with the view’s filters, then acknowledges, snoozes and resolves with versions and keys', async () => {
    const row = ROWS[0]!
    const { api, calls } = mockApi([
      { status: 200, body: { siteId: 's1', tiles: { open: 1, new: 1, mine: 0, snoozedUntilToday: 0 }, latestRun: null, exceptions: [row], nextCursor: null } },
      { status: 200, body: { exceptions: [{ ...row, status: 'ACKNOWLEDGED', version: 2 }], replayed: false } },
      { status: 200, body: { exception: { ...row, snoozed: true, version: 3 }, replayed: false } },
      { status: 200, body: { exception: { ...row, status: 'RESOLVED', version: 4 }, replayed: false } },
    ])
    expect((await listExceptions(api, 's1', apiQueryOf('queue', 'SHORT'))).exceptions).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/planning/exceptions?siteId=s1&status=NEW%2CACKNOWLEDGED&kind=SHORT&snoozed=false&limit=50')
    await acknowledgeExceptions(api, [{ id: row.id, version: 1 }])
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/planning/exceptions/acknowledge', body: { exceptions: [{ id: row.id, version: 1 }] } })
    await snoozeException(api, row.id, 2, null)
    expect(calls[2]).toMatchObject({ url: `/api/planning/exceptions/${row.id}/snooze`, body: { version: 2, until: null } })
    await resolveException(api, row.id, 3, '  Bought elsewhere.  ')
    expect(calls[3]).toMatchObject({ url: `/api/planning/exceptions/${row.id}/resolve`, body: { version: 3, note: 'Bought elsewhere.' } })
    for (const call of calls.slice(1)) expect(call.headers.get('idempotency-key')).toBeTruthy()
  })

  it('the page is built and reached from the record links', () => {
    expect(OFFICE_PAGES.has('/planning/exceptions')).toBe(true)
    expect(LIST_PAGES['/planning/exceptions']).toBe('/planning/exceptions')
  })
})

const LEFT_KEY = /\b(?:page|live|noAccess|keys|held|row|col|kind|view|tile|list|bulk|error|empty|common|notice|refusal|status|owner|what|words|s|title|impact|fix|detail|snooze|resolve|csv|today)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Said on purpose: permission names in the held reasons, and the made-up mail domain. */
const SAID = /\b(?:planning\.(?:view|run|exceptions\.manage)|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
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
