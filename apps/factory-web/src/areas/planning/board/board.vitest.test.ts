import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SCHEDULE_REASONS, SCHEDULE_STATUSES } from '@nexus/factory-domain/planning/schedule/backward'
import { READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { designScreen as allocationScreen } from '../allocation/fixtures'
import { getBoard, moveSlot, placeByDueDate, placeSlot, publishPlan, removeSlot, TRAY_CHIPS, type Board } from './api'
import { BOARD, designScreen, ME, NOW, SLOTS, TODAY, WORK_ORDERS } from './fixtures'
import {
  bandPublishHeld,
  controlsOf,
  DEFAULT_CONTROLS,
  drawBoard,
  dropHeldOf,
  keptWorkOrders,
  NAMESPACE,
  nextFreePlace,
  overFromIssues,
  overFromMove,
  planMove,
  previewPublishHeld,
  problemRows,
  queryOf,
  refusalOf,
  refusalWords,
  shiftFrom,
  slotPlace,
  trayCardOf,
  windowFrom,
  type BoardControls,
  type Words,
} from './model'

/**
 * Planning › Planning board (SCR-122; B-W2a-45 on the schedule API of B-W2a-34 and the DS PlanningBoard of B-W2a-14):
 * the address, the API's board → the DS lanes, buckets and cards (both views, filters, highlights, draft bars that load
 * nothing, "Moved by" only for another planner), the app's held drops, what a move asks of the API (the time of day
 * kept, a tray drop's operation, back to the tray), refusals and publish holds in our words from codes and figures, the
 * calls as the API takes them (versions, idempotency keys), and every design case of SCR-122 and SCR-126 drawn in
 * Italian and English with no key or placeholder on screen.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale, timeZone: 'Europe/Rome' })
const controls = (over: Partial<BoardControls> = {}): BoardControls => ({ ...DEFAULT_CONTROLS, ...over })
const [WO101, WO102, , WO104, WO105] = WORK_ORDERS
const LINE1 = BOARD.lanes[0]!
const LINE2 = BOARD.lanes[1]!
const CUT = BOARD.lanes[2]!
const key = (lane: { kind: string; id: string }) => `${lane.kind}:${lane.id}`

describe('planning board: the address', () => {
  it('reads and writes every choice; the defaults stay out of the address', () => {
    expect(controlsOf(new URLSearchParams(''))).toEqual(DEFAULT_CONTROLS)
    const all = controls({ site: 's1', view: 'orders', zoom: 'WEEK', from: '2026-11-23', q: 'WO-01', lanes: ['LINE:a', 'LINE:b'], styles: ['st'], statuses: ['RELEASED'], material: true, late: false, materialMark: true, wo: 'w1' })
    const qs = queryOf(all)
    expect(qs).toBe('site=s1&view=orders&zoom=WEEK&from=2026-11-23&q=WO-01&lane=LINE%3Aa%2CLINE%3Ab&style=st&status=RELEASED&material=1&hl=material&wo=w1')
    expect(controlsOf(new URLSearchParams(qs))).toEqual(all)
    expect(queryOf(DEFAULT_CONTROLS)).toBe('')
    expect(controlsOf(new URLSearchParams('zoom=YEAR&from=yesterday&status=NOPE')).zoom).toBe('DAY')
    expect(controlsOf(new URLSearchParams('hl=')).late).toBe(false)
  })

  it('starts a week on Monday and a month on the 1st; ‹ › move a week of days, four weeks, three months', () => {
    expect(windowFrom({ from: null, zoom: 'DAY' }, '2026-11-18')).toBe('2026-11-18')
    expect(windowFrom({ from: null, zoom: 'WEEK' }, '2026-11-18')).toBe('2026-11-16')
    expect(windowFrom({ from: '2026-11-22', zoom: 'WEEK' }, '2026-11-18')).toBe('2026-11-16')
    expect(windowFrom({ from: null, zoom: 'MONTH' }, '2026-11-18')).toBe('2026-11-01')
    expect(shiftFrom({ from: null, zoom: 'DAY' }, '2026-11-18', 1)).toBe('2026-11-25')
    expect(shiftFrom({ from: null, zoom: 'WEEK' }, '2026-11-18', -1)).toBe('2026-10-19')
    expect(shiftFrom({ from: null, zoom: 'MONTH' }, '2026-11-18', 1)).toBe('2027-02-01')
  })
})

describe('planning board: the API board on the DS board', () => {
  it('draws the lanes with their capacity per day, closed days, and the formula in words', () => {
    const drawn = drawBoard(BOARD, controls(), words(), ME)
    expect(drawn.lanes.map((lane) => lane.label)).toEqual(['Linea 1', 'Linea 2', 'Taglio', 'Controllo finale', 'Laboratorio Beta'])
    const line1 = drawn.lanes[0]!
    expect(line1.capacity?.['2026-11-17']).toBe(3060)
    expect(line1.capacity?.['2026-11-21']).toBe(0)
    expect(line1.capacityWords?.['2026-11-17']).toBe('8 people × 450 working min × 85% efficiency = 3,060 min available.')
    expect(line1.capacityWords?.['2026-11-20']).toContain('Also booked here: 900 min of work not on the board yet')
    expect(drawn.lanes[1]!.closed?.['2026-11-20']).toBe('Inventario')
    // A workshop has no capacity in standard minutes: not known, never 0.
    expect(drawn.lanes[4]!.capacity).toBeUndefined()
    expect(drawn.buckets[0]).toMatchObject({ id: '2026-11-16', label: 'Mon 16 Nov', today: true })
    expect(drawWords('it').buckets[0]!.label).toBe('lun 16 nov')
  })

  it('puts each bar at its first day with its span; a draft or held bar loads nothing; "Moved by" only for another planner', () => {
    const drawn = drawBoard(BOARD, controls(), words(), ME)
    const sewing = drawn.cards.find((card) => card.id === SLOTS[1]!.id)!
    expect(sewing).toMatchObject({ label: 'WO-0101', laneId: key(LINE1), bucketId: '2026-11-17', span: 2, minutes: 3600 })
    expect(sewing.note).toBeUndefined()
    const rush = drawn.cards.find((card) => card.id === SLOTS[4]!.id)!
    expect(rush.note).toBe('Moved by Marta Esempio at 16 Nov, 09:12')
    expect(rush.marks?.map((mark) => mark.label)).toEqual(['Rush', 'Kept over capacity'])
    expect(drawn.cards.find((card) => card.id === SLOTS[3]!.id)!.late).toBe(true)
    // The tray: the most urgent first, with its chips in words.
    const tray = drawn.cards.filter((card) => card.laneId === null)
    expect(tray.map((card) => card.id)).toEqual([trayCardOf(WO105!.id), trayCardOf(WO104!.id)])
    expect(tray[0]!.marks?.map((mark) => mark.label)).toEqual(['Material 23 Nov', 'Past its latest safe start'])
    expect(tray[1]!.marks?.map((mark) => mark.label)).toEqual(['Draft · books no capacity'])
    const draftBar = drawBoard({ ...BOARD, slots: [{ ...SLOTS[1]!, booksCapacity: false }] }, controls(), words(), ME).cards[0]!
    expect(draftBar.load).toEqual([0, 0])
  })

  it('the highlights switch the late stripes and the material marks', () => {
    const plain = drawBoard(BOARD, controls({ late: false, materialMark: false }), words(), ME)
    expect(plain.cards.some((card) => card.late)).toBe(false)
    expect(plain.cards.flatMap((card) => card.marks ?? []).some((mark) => mark.label.startsWith('Material'))).toBe(false)
  })

  it('the orders view has one lane per open work order; filters keep lines, styles, statuses, material and the number', () => {
    const orders = drawBoard(BOARD, controls({ view: 'orders' }), words(), ME)
    expect(orders.lanes.map((lane) => lane.label)).toEqual(['WO-0101', 'WO-0102', 'WO-0103', 'WO-0104', 'WO-0105'])
    expect(orders.cards.filter((card) => card.laneId === `WO:${WO101!.id}`)).toHaveLength(3)
    expect([...keptWorkOrders(BOARD, controls({ q: 'wo-0102' }))]).toEqual([WO102!.id])
    expect([...keptWorkOrders(BOARD, controls({ material: true }))]).toEqual([WO105!.id])
    expect([...keptWorkOrders(BOARD, controls({ statuses: ['DRAFT'] }))]).toEqual([WO104!.id])
    expect([...keptWorkOrders(BOARD, controls({ lanes: [key(CUT)] }))].sort()).toEqual([WO101!.id, WO104!.id].sort())
    const twoLines = drawBoard(BOARD, controls({ lanes: [key(LINE1)] }), words(), ME)
    expect(twoLines.lanes.map((lane) => lane.id)).toEqual([key(LINE1)])
  })

  it('clips a bar that reaches into the window from before', () => {
    expect(slotPlace({ startAt: '2026-11-13T07:00:00.000Z', endAt: '2026-11-17T16:00:00.000Z' }, BOARD.buckets, 'Europe/Rome')).toEqual({ bucketId: '2026-11-16', span: 2 })
    expect(slotPlace({ startAt: '2026-12-13T07:00:00.000Z', endAt: '2026-12-14T16:00:00.000Z' }, BOARD.buckets, 'Europe/Rome')).toBeNull()
  })
})

function drawWords(locale: 'it' | 'en') {
  return drawBoard(BOARD, controls(), words(locale), ME)
}

describe('planning board: drops the app holds, and what a move asks of the API', () => {
  const t = words().t
  it('holds a bar on a lane that does not do its operation, a part on a work centre, another order in the orders view', () => {
    expect(dropHeldOf(BOARD, controls(), { id: SLOTS[1]!.id, laneId: key(LINE1) }, { laneId: key(CUT), bucketId: '2026-11-17' }, t)).toBe('Taglio does not do Op 20 Cucito: it is done at Cucito.')
    expect(dropHeldOf(BOARD, controls(), { id: SLOTS[1]!.id, laneId: key(LINE1) }, { laneId: key(LINE2), bucketId: '2026-11-17' }, t)).toBeNull()
    expect(dropHeldOf(BOARD, controls(), { id: SLOTS[5]!.id, laneId: 'WORKSHOP:x' }, { laneId: key(CUT), bucketId: '2026-11-17' }, t)).toBe('A part of an order goes to a line or a workshop, not to a work centre.')
    expect(dropHeldOf(BOARD, controls({ view: 'orders' }), { id: SLOTS[1]!.id, laneId: `WO:${WO101!.id}` }, { laneId: `WO:${WO102!.id}`, bucketId: '2026-11-17' }, t)).toContain('stays with its own work order')
    // A tray card: the lane must do one of its operations still to place.
    expect(dropHeldOf(BOARD, controls(), { id: trayCardOf(WO104!.id), laneId: null }, { laneId: 'WORK_CENTRE:' + BOARD.lanes[3]!.id, bucketId: '2026-11-18' }, t)).toBe('No operation of WO-0104 still to place is done on Controllo finale.')
    expect(dropHeldOf(BOARD, controls(), { id: trayCardOf(WO104!.id), laneId: null }, { laneId: key(CUT), bucketId: '2026-11-18' }, t)).toBeNull()
  })

  it('moves a bar by whole days keeping its time of day, to another lane, back to the tray; a tray drop places its operation', () => {
    const now = new Date(NOW)
    const moved = planMove(BOARD, controls(), { cardId: SLOTS[1]!.id, from: { laneId: key(LINE1), bucketId: '2026-11-17' }, to: { laneId: key(LINE2), bucketId: '2026-11-19' } }, now)
    expect(moved).toEqual({ kind: 'move', slotId: SLOTS[1]!.id, version: 2, workOrderId: WO101!.id, lane: { kind: 'LINE', id: LINE2.id }, startAt: '2026-11-19T07:00:00.000Z' })
    // Into today: never before now.
    const today = planMove(BOARD, controls(), { cardId: SLOTS[2]!.id, from: { laneId: key(BOARD.lanes[3]!), bucketId: '2026-11-19' }, to: { laneId: key(BOARD.lanes[3]!), bucketId: TODAY } }, now)
    expect(today).toMatchObject({ kind: 'move', startAt: NOW })
    expect(planMove(BOARD, controls(), { cardId: SLOTS[1]!.id, from: { laneId: key(LINE1), bucketId: '2026-11-17' }, to: { laneId: null, bucketId: null } }, now)).toEqual({ kind: 'remove', slotId: SLOTS[1]!.id, version: 2, workOrderId: WO101!.id })
    const placed = planMove(BOARD, controls(), { cardId: trayCardOf(WO104!.id), from: { laneId: null, bucketId: null }, to: { laneId: key(LINE1), bucketId: '2026-11-20' } }, now)
    expect(placed).toEqual({ kind: 'place', workOrderId: WO104!.id, operationId: WO104!.operations[1]!.id, lane: { kind: 'LINE', id: LINE1.id }, startAt: '2026-11-19T23:00:00.000Z' })
    // The orders view moves in time only.
    expect(planMove(BOARD, controls({ view: 'orders' }), { cardId: SLOTS[1]!.id, from: { laneId: `WO:${WO101!.id}`, bucketId: '2026-11-17' }, to: { laneId: `WO:${WO101!.id}`, bucketId: '2026-11-18' } }, now)).toEqual({ kind: 'move', slotId: SLOTS[1]!.id, version: 2, workOrderId: WO101!.id, startAt: '2026-11-18T07:00:00.000Z' })
  })

  it('finds the next free day on the same lane, and reads the cells over capacity', () => {
    const drawn = drawBoard(BOARD, controls(), words(), ME)
    const move = { cardId: SLOTS[4]!.id, to: { laneId: key(LINE1), bucketId: '2026-11-18' } }
    expect(nextFreePlace(drawn, move)).toEqual({ laneId: key(LINE1), bucketId: '2026-11-19' })
    expect(overFromMove([{ laneId: key(LINE1), bucketId: '2026-11-18', booked: 3400, available: 3060 }, { laneId: key(LINE1), bucketId: '2026-11-19', booked: 10, available: 3060 }])).toEqual([{ where: '2026-11-18', laneId: key(LINE1), booked: 3400, available: 3060 }])
  })
})

describe('planning board: refusals and holds in our words', () => {
  it('a 409 says who moved the bar and when (the name read from the API, the time in the site zone)', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'Moved by Marta Esempio at 16 Nov 09:12 (version 5; you had version 4). Reload the board.', null, [{ path: 'body/version', message: 'The current version is 5.' }, { path: 'updatedAt', message: '2026-11-16T08:12:00.000Z' }])
    const refusal = refusalOf(error)
    expect(refusal).toEqual({ code: 'MOVED_BY', name: 'Marta Esempio', at: '2026-11-16T08:12:00.000Z' })
    expect(refusalWords(refusal, words())).toBe('Moved by Marta Esempio at 16 Nov, 09:12 · the board was read again.')
    expect(refusalWords(refusal, words('it'))).toBe('Spostato da Marta Esempio, 16 nov, 09:12 · il tabellone è stato riletto.')
  })

  it('reads an overload with its days, a changed plan, the API conflicts by their shape, and the kinds', () => {
    const over = new ApiError('conflict', 409, 'conflict', 'Linea 1 would be at 111.1% on Wed 18 Nov (+340.0 min over). Keep it there with a reason, or choose another place.', null, [{ path: 'body/overloadReason', message: '…' }, { path: 'over/2026-11-18', message: '3400.0 of 3060.0 min (111.1%), +340.0 over.' }])
    expect(refusalOf(over)).toEqual({ code: 'OVERLOAD' })
    expect(overFromIssues(over, 'LINE:x')).toEqual([{ where: '2026-11-18', laneId: 'LINE:x', booked: 3400, available: 3060 }])
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'The working plan changed since it was read (version 3); it is now at version 4. Review it again.', null, [{ path: 'body/version', message: '' }]))).toEqual({ code: 'PLAN_CHANGED' })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'Op 20 Cucito of WO-0101 already has a bar on the board: move that one.'))).toEqual({ code: 'ALREADY_ON_BOARD' })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'Linea 2 does Cucito; Op 10 Taglio is done at Taglio.'))).toEqual({ code: 'LANE_DOES_NOT' })
    expect(refusalOf(new ApiError('conflict', 409, 'conflict', 'Something new.'))).toEqual({ code: 'CONFLICT' })
    expect(refusalOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ code: 'FORBIDDEN' })
    expect(refusalOf(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ code: 'OFFLINE' })
  })

  it('holds Publish to floor with its reason: permission, no plan, nothing changed since vN, nothing on the days', () => {
    expect(bandPublishHeld(BOARD.plan)).toBeNull()
    expect(bandPublishHeld({ ...BOARD.plan, mayPublish: false })).toEqual({ code: 'permission' })
    expect(bandPublishHeld({ ...BOARD.plan, version: null })).toEqual({ code: 'noPlan' })
    expect(bandPublishHeld({ ...BOARD.plan, publishHeld: 'Nothing changed since v3 was published for Tue 17 Nov to Mon 23 Nov.' })).toEqual({ code: 'nothingChanged', version: 3 })
    expect(bandPublishHeld({ ...BOARD.plan, publishHeld: 'The working plan has nothing on Tue 17 Nov to Mon 23 Nov to publish.' })).toEqual({ code: 'nothingOnDays' })
    const preview = designScreen.cases.find((entry) => entry.id === 'publish')!.model.dialog as { preview: { value: Parameters<typeof previewPublishHeld>[0] } }
    expect(previewPublishHeld(preview.preview.value)).toBeNull()
    expect(previewPublishHeld({ ...preview.preview.value, diff: { moved: 0, added: 0, removed: 0, byLane: [] } })).toEqual({ code: 'nothingChanged', version: 3 })
    expect(previewPublishHeld({ ...preview.preview.value, slots: 0 })).toEqual({ code: 'nothingOnDays' })
  })

  it('says each problem from its figures', () => {
    expect(problemRows(BOARD, words()).map((row) => row.words)).toEqual([
      'Linea 1 is at 111% on Wed 18 Nov (+340 min over).',
      'WO-0102 finishes 1 day after its due date.',
      'WO-0105 finishes 4 days after its due date.',
    ])
    expect(problemRows(BOARD, words('it'))[0]!.words).toBe('Linea 1 è al 111% il mer 18 nov (+340 min oltre).')
  })
})

type Call = { method: string; url: string; headers: Headers; body: unknown }

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('planning board: the calls as the API takes them', () => {
  const stored = { ...SLOTS[1]! }
  const answer = { slot: stored, planVersion: 13, schedule: null, over: [], replayed: false }
  it('reads the board of a window and moves a bar with its version (PATCH), each write with its own key', async () => {
    const { api, calls } = mockApi([{ status: 200, body: BOARD }, { status: 200, body: answer }, { status: 201, body: answer }, { status: 200, body: { removed: stored.id, workOrderId: WO101!.id, planVersion: 14, replayed: false } }])
    const board: Board = await getBoard(api, { siteId: 's1', from: '2026-11-16', bucket: 'WEEK' })
    expect(board.lanes).toHaveLength(5)
    expect(calls[0]!.url).toBe('/api/planning/schedule?siteId=s1&from=2026-11-16&bucket=WEEK')
    await moveSlot(api, stored.id, { version: 2, lane: { kind: 'LINE', id: 'l2' }, startAt: '2026-11-19T07:00:00.000Z' })
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: `/api/planning/schedule/slots/${stored.id}`, body: { version: 2, lane: { kind: 'LINE', id: 'l2' }, startAt: '2026-11-19T07:00:00.000Z' } })
    await placeSlot(api, { workOrderId: WO104!.id, operationId: 'op', lane: { kind: 'LINE', id: 'l1' }, startAt: '2026-11-20T07:00:00.000Z', overloadReason: 'Straordinario' })
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/api/planning/schedule/slots', body: { overloadReason: 'Straordinario' } })
    await removeSlot(api, stored.id, 3)
    expect(calls[3]).toMatchObject({ method: 'POST', url: `/api/planning/schedule/slots/${stored.id}/remove`, body: { version: 3 } })
    const keys = calls.slice(1).map((call) => call.headers.get('idempotency-key'))
    expect(new Set(keys).size).toBe(3)
    expect(calls[1]!.headers.get('x-csrf-token')).toBe('csrf-demo')
  })

  it('previews and applies Place all by due date with the plan version, publishes the reviewed version', async () => {
    const placed = { planVersion: 13, applied: true, slots: [], skipped: [], overbooked: 0, replayed: false }
    const published = { version: { id: 'v', number: 4, coversFrom: '2026-11-17', coversTo: '2026-11-23', effectiveFrom: '2026-11-17T05:00:00.000Z', publishedAt: NOW, publishedBy: null }, slots: 6, diff: { moved: 2, added: 3, removed: 1 }, replayed: false }
    const { api, calls } = mockApi([{ status: 200, body: { ...placed, applied: false } }, { status: 200, body: placed }, { status: 201, body: published }])
    await placeByDueDate(api, { siteId: 's1', apply: false })
    expect(calls[0]!.headers.get('idempotency-key')).toBeNull()
    await placeByDueDate(api, { siteId: 's1', apply: true, version: 12, overloadReason: 'Sabato' })
    expect(calls[1]).toMatchObject({ body: { siteId: 's1', apply: true, version: 12, overloadReason: 'Sabato' } })
    expect(calls[1]!.headers.get('idempotency-key')).toBeTruthy()
    const answer2 = await publishPlan(api, { siteId: 's1', version: 12, coversFrom: '2026-11-17', coversTo: '2026-11-23' })
    expect(answer2.version.number).toBe(4)
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/api/planning/schedule/publish', body: { siteId: 's1', version: 12 } })
  })
})

describe('the board and the allocation are built pages the API lists open', () => {
  it('opens the built pages', () => {
    expect(OFFICE_PAGES.has('/planning/board')).toBe(true)
    expect(OFFICE_PAGES.has('/planning/allocation')).toBe(true)
    expect(LIST_PAGES['/planning/schedule']).toBe('/planning/board')
    expect(LIST_PAGES['/planning/allocation']).toBe('/planning/allocation')
  })
})

const LEFT_KEY = /\b(?:band|save|plan|more|toolbar|filters|woStatus|board|bucket|closed|capacity|lane|card|mark|chip|status|reason|readiness|held|refusal|error|problems|problem|notice|dialog|bar|drop|publish|place|legend|versions|keys|lanes|kind|window|load)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Not keys: e-mail and the domain of made-up data. */
const SAID = /\b(?:example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, allocationScreen] as unknown as DesignScreen<unknown>[]) {
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

  it('the dynamic words exist in both languages (statuses, reasons, chips, refusals, checks, readiness)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const status of SCHEDULE_STATUSES) {
        has(`status.${status}`)
        has(`reason.${status}`)
      }
      for (const reason of SCHEDULE_REASONS) has(`reason.${reason}`)
      for (const chip of TRAY_CHIPS) has(`chip.${chip}`)
      for (const word of READINESS_WORDS) has(`readiness.${word}`)
      for (const code of ['MOVED_BY', 'MOVED', 'MOVED_SOMEONE', 'OVERLOAD', 'PLAN_CHANGED', 'LANE_DOES_NOT', 'ALREADY_ON_BOARD', 'PART_THERE', 'NOT_OPEN', 'LANE_ARCHIVED', 'NO_WORKING_TIME', 'PART_LANE', 'OPERATION_DONE', 'NOTHING_TO_PLACE', 'NOTHING_CHANGED', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'INVALID', 'OFFLINE', 'SIGNED_OUT', 'FAILED']) has(`refusal.${code}`)
      for (const code of ['permission', 'nothingChanged', 'nothingOnDays', 'nothingOnRange', 'cannot', 'noPlan']) has(`publish.held.${code}`)
      for (const code of ['OVERBOOKED', 'IN_THE_PAST', 'MATERIAL_NOT_READY']) {
        has(`publish.check.${code}.pass`)
        has(`publish.check.${code}.warn`, 2)
      }
      for (const status of ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED']) has(`woStatus.${status}`)
      for (const problem of ['forbidden', 'offline', 'failed', 'noSite']) has(`error.${problem}`)
    }
  })
})

