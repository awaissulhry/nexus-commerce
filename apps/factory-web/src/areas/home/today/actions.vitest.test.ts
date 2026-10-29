import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { Locale } from '../../../lib/i18n/locales'
import { acknowledgeRow, actionProblem, assignRow, fetchAssignees, fetchHandled, fetchLayout, resolveRow, saveLayout } from './api'
import { designScreen } from './fixtures'
import { handledView } from './links'
import {
  arrangePanels,
  DEFAULT_LAYOUT,
  lensesInOrder,
  panelRows,
  resolveNoteProblem,
  sectionOrder,
  sectionShown,
  verbHeld,
  verbKey,
  type TodayItem,
  type TodayLayout,
} from './model'

/**
 * Today's alert verbs, "Handled today" and "Arrange Today" (SCR-029; API insights/actions #904): the calls, the rules
 * that hold a verb with its reason, the arrangement, and the design cases drawn in both languages.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(...answers: Array<() => Response>) {
  let index = 0
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => (answers[Math.min(index++, answers.length - 1)] ?? (() => json(500, {})))())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (call = 0) => {
    const [url, init] = fetch.mock.calls[call]!
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, sent }
}

const KEY = 'ORDER_PROMISE:0190f0e2-7777-7000-8000-000000000001'
const CONDITION = 'a'.repeat(32)
const row: Pick<TodayItem, 'key' | 'condition' | 'actions' | 'category'> = {
  key: KEY,
  condition: CONDITION,
  category: 'ALERT',
  actions: { version: 2, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null },
}
const acted = { key: KEY, condition: CONDITION, resolved: false, actions: { version: 3, verbs: ['ASSIGN', 'RESOLVE'], assigned: null, acknowledged: null } }

describe('the alert verbs call the API with the row as it was read', () => {
  it('acknowledge, assign (and take back), resolve: POST …/rows/<key>/<verb> with the condition, the version, the CSRF token and an idempotency key', async () => {
    const api = client(() => json(200, acted))
    await acknowledgeRow(api.api, row)
    await assignRow(api.api, row, '0190f0e2-7777-7000-8000-000000000301')
    await assignRow(api.api, row, null)
    await resolveRow(api.api, row, '  Called the customer.  ')
    const calls = [0, 1, 2, 3].map((index) => api.sent(index))
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', `/api/home/today/rows/${encodeURIComponent(KEY)}/acknowledge`],
      ['POST', `/api/home/today/rows/${encodeURIComponent(KEY)}/assign`],
      ['POST', `/api/home/today/rows/${encodeURIComponent(KEY)}/assign`],
      ['POST', `/api/home/today/rows/${encodeURIComponent(KEY)}/resolve`],
    ])
    expect(calls.map((call) => call.body)).toEqual([
      { condition: CONDITION, version: 2 },
      { condition: CONDITION, version: 2, assigneeId: '0190f0e2-7777-7000-8000-000000000301' },
      { condition: CONDITION, version: 2, assigneeId: null },
      { condition: CONDITION, version: 2, note: 'Called the customer.' },
    ])
    for (const call of calls) {
      expect(call.headers.get('x-csrf-token')).toBe('csrf-1')
      expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
      expect(call.headers.get('x-factory-company')).toBe('DEMO')
    }
    expect(new Set(calls.map((call) => call.headers.get('idempotency-key'))).size).toBe(4)
  })

  it('reads who may act, Handled today and the layout; saves the layout with the version read', async () => {
    const people = { key: KEY, condition: CONDITION, people: [{ id: 'p1', name: 'Marco Esempio', me: false, suggested: true, assigned: false }] }
    const handled = { today: '2026-10-29', count: 1, items: [{ at: '2026-10-29T08:00:00.000Z', verb: 'RESOLVED', kind: 'ORDER_PROMISE', key: KEY, record: { type: 'SalesOrder', id: 'so1', label: 'SO-1' }, companyId: 'c1', note: 'Done.', assignee: null }] }
    const layout = { layout: DEFAULT_LAYOUT, version: 0, updatedAt: null }
    const api = client(
      () => json(200, people),
      () => json(200, handled),
      () => json(200, layout),
      () => json(200, { ...layout, version: 1, updatedAt: '2026-10-29T08:00:00.000Z' }),
    )
    expect(await fetchAssignees(api.api, KEY)).toEqual(people.people)
    expect(api.sent(0).url).toBe(`/api/home/today/rows/${encodeURIComponent(KEY)}/assignees`)
    expect((await fetchHandled(api.api)).count).toBe(1)
    expect(api.sent(1).url).toBe('/api/home/today/handled')
    expect((await fetchLayout(api.api)).version).toBe(0)
    expect((await saveLayout(api.api, DEFAULT_LAYOUT, 0)).version).toBe(1)
    expect(api.sent(3)).toMatchObject({ method: 'PUT', url: '/api/home/today/layout', body: { ...DEFAULT_LAYOUT, version: 0 } })
    expect(handledView(handled as never, '/w/DEMO', new Set()).items[0]!.href).toMatch(/^\/w\/DEMO\/records\/SalesOrder\/so1/)
  })

  it('a refusal is this app’s words: a changed or vanished row and a refused assignee read Today again', () => {
    const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number) => new ApiError(kind, status, 'x', 'x')
    expect(actionProblem(error('conflict', 409))).toEqual({ key: 'today.actions.problem.changed', tone: 'warning', reload: true })
    expect(actionProblem(error('not_found', 404))).toEqual({ key: 'today.actions.problem.gone', tone: 'warning', reload: true })
    expect(actionProblem(error('invalid', 400))).toEqual({ key: 'today.actions.problem.invalid', tone: 'warning', reload: true })
    expect(actionProblem(error('forbidden', 403))).toMatchObject({ key: 'today.actions.problem.forbidden', reload: false })
    expect(actionProblem(error('unavailable', 0))).toMatchObject({ key: 'today.problem.offline' })
    expect(actionProblem(new Error('boom'))).toMatchObject({ key: 'today.actions.problem.failed' })
  })
})

describe('a verb is held with its reason when the person cannot use it now', () => {
  const live = { live: 'live' as const, busy: false }
  it('an approval or a mail: decided in its review; offline; a decision in flight; acknowledged already', () => {
    expect(verbHeld(row, 'ACKNOWLEDGE', live)).toBeNull()
    expect(verbHeld(row, 'RESOLVE', live)).toBeNull()
    expect(verbHeld({ ...row, category: 'APPROVAL', actions: { ...row.actions, verbs: [] } }, 'ASSIGN', live)).toBe('today.actions.held.review')
    expect(verbHeld(row, 'ASSIGN', { live: 'offline', busy: false })).toBe('today.actions.held.offline')
    expect(verbHeld(row, 'RESOLVE', { live: 'live', busy: true })).toBe('today.actions.held.busy')
    const seen = { ...row, actions: { ...row.actions, verbs: ['ASSIGN', 'RESOLVE'] as ('ASSIGN' | 'RESOLVE')[], acknowledged: { by: { id: 'p', name: 'Lucia', me: false }, at: '2026-10-29T07:00:00.000Z' } } }
    expect(verbHeld(seen, 'ACKNOWLEDGE', live)).toBe('today.actions.held.acknowledged')
    expect(verbHeld(seen, 'ASSIGN', live)).toBeNull()
  })

  it('e acknowledges, never with a modifier or in a text field; a resolve note says what was done', () => {
    expect(verbKey('e', { alt: false, ctrl: false, meta: false, inField: false })).toBe('acknowledge')
    expect(verbKey('e', { alt: false, ctrl: false, meta: true, inField: false })).toBeNull()
    expect(verbKey('e', { alt: false, ctrl: false, meta: false, inField: true })).toBeNull()
    expect(verbKey('a', { alt: false, ctrl: false, meta: false, inField: false })).toBeNull()
    expect(resolveNoteProblem('')).toBe('today.resolve.noteNeeded')
    expect(resolveNoteProblem(' ok ')).toBe('today.resolve.noteShort')
    expect(resolveNoteProblem('x'.repeat(1001))).toBe('today.resolve.noteLong')
    expect(resolveNoteProblem('Called the customer')).toBeNull()
  })
})

describe('Arrange Today', () => {
  const arranged: TodayLayout = {
    sections: [
      { id: 'role-panels', hidden: false },
      { id: 'needs-me', hidden: false },
      { id: 'flow', hidden: true },
    ],
    panels: [
      { id: 'mailToSort', hidden: false, width: 'FULL' },
      { id: 'lateOrders', hidden: true, width: 'HALF' },
    ],
    mainLens: 'WORK_ORDERS',
  }

  it('sections in the person’s order (the unnamed ones after); Needs me now always shows', () => {
    expect(sectionOrder(DEFAULT_LAYOUT)).toEqual(['focus-strip', 'needs-me', 'flow', 'role-panels'])
    expect(sectionOrder(arranged)).toEqual(['role-panels', 'needs-me', 'flow', 'focus-strip'])
    expect(sectionShown(arranged, 'flow')).toBe(false)
    expect(sectionShown({ ...arranged, sections: [{ id: 'needs-me', hidden: true }] }, 'needs-me')).toBe(true)
  })

  it('panels in the person’s order with their widths, hidden ones out, new ones after at half; the main lens first', () => {
    const panels = [{ id: 'quotesToApprove' }, { id: 'lateOrders' }, { id: 'mailToSort' }]
    expect(arrangePanels(panels, arranged)).toEqual([
      { id: 'mailToSort', width: 'FULL' },
      { id: 'quotesToApprove', width: 'HALF' },
    ])
    expect(arrangePanels(panels, DEFAULT_LAYOUT).map((panel) => panel.id)).toEqual(['quotesToApprove', 'lateOrders', 'mailToSort'])
    // Rows with no empty space at their end: half beside half or two thirds; a whole-row list alone; one alone fills.
    const rows = (...widths: ('HALF' | 'TWO_THIRDS' | 'FULL')[]) => panelRows(widths.map((width, index) => ({ id: String(index), width }))).map((row) => row.map((panel) => panel.width))
    expect(rows('TWO_THIRDS', 'HALF', 'HALF')).toEqual([['TWO_THIRDS', 'HALF'], ['HALF']])
    expect(rows('HALF', 'HALF', 'HALF')).toEqual([['HALF', 'HALF'], ['HALF']])
    expect(rows('HALF', 'FULL', 'HALF', 'TWO_THIRDS')).toEqual([['HALF'], ['FULL'], ['HALF', 'TWO_THIRDS']])
    expect(rows()).toEqual([])
    const lenses = [{ lens: 'ORDERS' }, { lens: 'WORK_ORDERS' }, { lens: 'LOTS' }]
    expect(lensesInOrder(lenses, 'WORK_ORDERS').map((entry) => entry.lens)).toEqual(['WORK_ORDERS', 'ORDERS', 'LOTS'])
    expect(lensesInOrder(lenses, 'SHIPMENTS').map((entry) => entry.lens)).toEqual(['ORDERS', 'WORK_ORDERS', 'LOTS'])
  })
})

describe('the design cases of the alert verbs, in both languages', () => {
  const render = (id: string, locale: Locale) =>
    renderToString(
      createElement(
        I18nProvider,
        { locale, messages: messagesFor(locale, ['shell']) },
        createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases.find((entry) => entry.id === id)!.model }),
      ),
    )

  it('marks say who a row is assigned to and who acknowledged it; alert rows have their actions menu; mail does not', () => {
    const html = render('owner-acted', 'en')
    expect(html).toContain('Assigned to Marco Esempio')
    expect(html).toContain('Acknowledged by Lucia Demo')
    expect(html).toContain('Assigned to you by Lucia Demo')
    expect(html).toContain('Actions on SO-2026-0042')
    expect(html).not.toContain('Actions on Preventivo 200 giacche')
    expect(html).toContain('Handled today: 4 · Show')
    expect(render('owner-acted', 'it')).toContain('Assegnata a Marco Esempio')
    expect(render('sales-assigned', 'it')).toContain('Assegnata a te da Anna Prova')
  })

  it('the arranged case draws My lists before the work and leaves the flow strip out', () => {
    const html = render('owner-arranged', 'en')
    expect(html.indexOf('id="fw-today-lists"')).toBeLessThan(html.indexOf('id="fw-today-needs"'))
    expect(html).not.toContain('id="fw-today-flow"')
    expect(html).toContain('fw-today-panel--two-thirds')
    expect(html).not.toContain(CATALOGUE.en.home!['today.panels.ordersWaitingDeposit.title'])
    // The default order keeps the approved layout: the tiles first, My lists beside the work.
    const owner = render('owner', 'en')
    expect(owner.indexOf('id="fw-today-day"')).toBeLessThan(owner.indexOf('id="fw-today-needs"'))
    expect(owner).toContain('fw-today-side')
  })

  it('the keys stay in the list footer only; every new message key is in both languages', () => {
    const html = render('owner-acted', 'en')
    const head = html.slice(html.indexOf('id="fw-today-needs"'), html.indexOf('fw-today-group'))
    expect(head).not.toMatch(/<kbd/i)
    for (const key of Object.keys(CATALOGUE.en.home!).filter((entry) => /^today\.(actions|marks|assign|resolve|handled|arrange)\./.test(entry))) {
      expect(CATALOGUE.it.home![key], key).toBeTruthy()
    }
  })
})
