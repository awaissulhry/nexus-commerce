import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MRP_ACTIONS } from '@nexus/factory-domain/planning/actions/messages'
import { PROTECTABLE_FIELDS } from '@nexus/factory-domain/planning/planned-orders/rules'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { designScreen } from '../fixtures'
import { viewOf } from '../model'
import { convertPlanned, decideActionMessages, editPlanned, getItemProfile, INPUT_COUNTS, listActionMessages, resetPlanned, shiftPlanned } from './api'
import { DELAYS, MESSAGES, PLANNED, PROFILE } from './fixtures'
import { convertHeld, convertReach, decideHeld, DEPTH_NAMESPACE, depthCan, editHeld, heldOf, materialLateOf, messageHref, messageRecord, messageWhat, profileChart, protection, selectHeld, shiftHeld, sizesText, toMakeCount, walkOf, weekName } from './model'

/**
 * B-W2b-335 — the W2b parts of What to buy & make (SCR-055): who may do what, why a planned order cannot be made real (said
 * from the row), what a selection reaches, the protected cell and its plan value, the material that makes demand late, an
 * action message in our words with what it opens, the projected stock's chart and walk, the calls as the API takes them,
 * and every W2b design case in both languages with no key or placeholder on screen.
 */

const planner = depthCan(['planning.view', 'planning.planned.convert', 'planning.firm', 'planning.planned.edit', 'planning.actions.manage', 'workorders.manage'])
const owner = { ...planner, subcontract: true }
const reader = depthCan(['planning.view'])

describe('To make: a planned order, said from the row', () => {
  it('is its own view and its tile counts the planned orders not made real', () => {
    expect(viewOf('toMake')).toBe('toMake')
    expect(toMakeCount({ status: 'ready', value: { siteId: 's', run: null, counts: { make: 3, subcontract: 1, firm: 1 }, plannedOrders: [] } })).toBe(4)
    expect(toMakeCount({ status: 'loading' })).toBeNull()
  })

  it('a held row says why: made real, no order line, no released revision', () => {
    expect(heldOf(PLANNED[0]!)).toBeNull()
    expect(heldOf(PLANNED[3]!)).toBe('held.noRevision')
    expect(heldOf({ ...PLANNED[0]!, demand: [] })).toBe('held.noDemand')
    expect(heldOf({ ...PLANNED[0]!, status: 'CONVERTED' })).toBe('held.converted')
    expect(heldOf({ ...PLANNED[0]!, held: true })).toBe('held.other')
  })

  it('a selection makes real what can be, by kind, and the buttons say the missing right', () => {
    const reach = convertReach(PLANNED)
    expect(reach.make.map((row) => row.id)).toEqual([PLANNED[0]!.id, PLANNED[1]!.id])
    expect(reach.subcontract.map((row) => row.id)).toEqual([PLANNED[2]!.id])
    expect(convertHeld('MAKE', 2, planner)).toBeNull()
    expect(convertHeld('SUBCONTRACT', 1, planner)).toBe('held.noSubcontract')
    expect(convertHeld('SUBCONTRACT', 1, owner)).toBeNull()
    expect(convertHeld('MAKE', 0, planner)).toBe('held.noMake')
    expect(convertHeld('MAKE', 2, reader)).toBe('held.noConvert')
    expect(shiftHeld(PLANNED, reader)).toBe('held.noEdit')
    expect(shiftHeld(PLANNED, planner)).toBeNull()
    expect(selectHeld(PLANNED[0]!, reader)).toBe('held.noRight')
    expect(editHeld(PLANNED[2]!, planner)).toBe('held.firm')
  })

  it('a kept date carries the plan’s value; the sizes read short; the material sets the late day', () => {
    expect(protection(PLANNED[0]!, 'dueDate')).toEqual({ protectedNow: true, plan: '2026-11-24' })
    expect(protection(PLANNED[0]!, 'startDate')).toEqual({ protectedNow: false, plan: null })
    expect(sizesText(PLANNED[0]!)).toBe('48 ×2 · 50 ×4 · 52 ×2')
    expect(materialLateOf(PLANNED[0]!, DELAYS)?.daysLate).toBe(5)
    expect(materialLateOf(PLANNED[2]!, DELAYS)).toBeNull()
  })
})

describe('action messages in our words', () => {
  it('names the record and what to do from the action, days and quantities', () => {
    expect(messageRecord(MESSAGES[0]!)).toEqual({ key: 'msg.rec.poLine', params: { number: 'PO-2026-0003', line: '10' } })
    expect(messageWhat(MESSAGES[0]!)).toEqual({ key: 'msg.EXPEDITE', params: { from: '2026-11-20', to: '2026-11-14' } })
    expect(messageWhat(MESSAGES[1]!)).toEqual({ key: 'msg.CANCEL_plain' })
    expect(messageWhat(MESSAGES[2]!)).toEqual({ key: 'msg.INCREASE', params: { from: '8.0000', to: '10.0000', unit: 'PCS' } })
  })

  it('opens the purchase order of a PO line, the Why of a firm planned order, nothing for a planned order', () => {
    expect(messageHref(MESSAGES[0]!, '/w/DEMO', OFFICE_PAGES)).toEqual({ kind: 'page', href: expect.stringContaining('/w/DEMO/purchasing/orders/') })
    expect(messageHref(MESSAGES[3]!, '/w/DEMO', OFFICE_PAGES)).toEqual({ kind: 'why', lineId: MESSAGES[3]!.record.id })
    expect(messageHref(MESSAGES[2]!, '/w/DEMO', OFFICE_PAGES)).toBeNull()
    expect(decideHeld(MESSAGES, reader)).toBe('held.noActions')
    expect(decideHeld(MESSAGES, planner)).toBeNull()
    expect(decideHeld([{ ...MESSAGES[0]!, may: { decide: false } }], planner)).toBe('held.notLatest')
  })
})

describe('the projected stock of a material', () => {
  it('draws the balance and the safety line on one scale, below 0 included; J / K walk the grid’s order', () => {
    const chart = profileChart(PROFILE)
    expect(chart.data).toHaveLength(PROFILE.rows.length)
    expect(chart.domain[0]).toBeLessThan(-200)
    expect(chart.domain[1]).toBeGreaterThan(120)
    expect(chart.ticks).toContain(0)
    expect(chart.ticks[0]).toBe(chart.domain[0])
    expect(chart.data[0]).toMatchObject({ week: 'W44', projected: 120, safety: 40 })
    expect(weekName({ key: 'PAST' }).kind).toBe('past')
    expect(walkOf(['a', 'b', 'c'], 'b')).toEqual({ index: 1, previous: 'a', next: 'c' })
    expect(walkOf(['a', 'b', 'c'], 'a').previous).toBeNull()
  })
})

describe('the calls as the API takes them', () => {
  it('previews before writing, sends the versions read, decides with the note', async () => {
    const calls: { method: string; url: string; body: unknown; headers: Headers }[] = []
    const answers: unknown[] = [
      { preview: true, made: 0, held: 0, results: [] },
      { plannedOrder: { ...PLANNED[0]!, held: null } },
      { plannedOrder: { ...PLANNED[0]!, held: null }, reset: ['dueDate'], restored: true },
      { preview: true, changed: 0, rows: [] },
      { decided: 1 },
      { siteId: 's', run: null, counts: { open: 0, done: 0, ignored: 0 }, byAction: [], messages: [] },
      { ...PROFILE },
    ]
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) })
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' })
    await convertPlanned(api, [{ id: 'p1', version: 3 }], true)
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/planning/planned-orders/convert', body: { rows: [{ id: 'p1', version: 3 }], preview: true } })
    await editPlanned(api, 'p1', 3, { dueDate: '2026-11-21' })
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: '/api/planning/planned-orders/p1', body: { version: 3, dueDate: '2026-11-21' } })
    await resetPlanned(api, 'p1', 4, ['dueDate'])
    expect(calls[2]).toMatchObject({ url: '/api/planning/planned-orders/p1/reset', body: { version: 4, fields: ['dueDate'] } })
    await shiftPlanned(api, 's', [{ id: 'p1', version: 5 }], 2, true)
    expect(calls[3]).toMatchObject({ url: '/api/planning/planned-orders/bulk', body: { siteId: 's', shiftDays: 2, rows: [{ id: 'p1', version: 5 }], preview: true } })
    await decideActionMessages(api, [{ id: 'm1', version: 1 }], 'IGNORED', ' not now ')
    expect(calls[4]).toMatchObject({ url: '/api/planning/action-messages/decide', body: { messages: [{ id: 'm1', version: 1 }], status: 'IGNORED', note: 'not now' } })
    for (const call of [calls[1]!, calls[2]!, calls[4]!]) expect(call.headers.get('idempotency-key')).toBeTruthy()
    await listActionMessages(api, 's', true)
    expect(calls[5]!.url).toContain('status=OPEN%2CDONE%2CIGNORED')
    await getItemProfile(api, { siteId: 's', itemId: 'i', itemColourId: null })
    expect(calls[6]!.url).toContain('itemColourId=none')
  })
})

const LEFT_KEY = /\b(?:held|notice|view|tile|problem|make|msg|log|profile|convert|shift|dates|decide|late|where|orders|state|row|sizes|protected|field|kind|bulk|col|action|lot|plan|common|uom)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:planning\.(?:view|run|decide|firm|planned\.convert|planned\.edit|actions\.manage)|purchasing\.(?:view|manage|send|subcontract\.manage)|workorders\.(?:manage|release)|money\.cost|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('the W2b design cases draw in both languages with no key left on screen', () => {
  it('SCR-055 B-W2b-335 cases × it, en', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const cases = screen.cases.filter((item) => item.id.startsWith('w2b-335-'))
    expect(cases.length).toBeGreaterThanOrEqual(20)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('every code the API may send has its words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!)
      const said = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale} ${key}`).not.toBe(key)
      for (const action of MRP_ACTIONS) {
        said(`action.${action}`)
        said(`msg.${action}_plain`)
        said(`msg.byAction.${action}`, { count: 2 })
      }
      for (const field of PROTECTABLE_FIELDS) said(`field.${field}`)
      for (const key of INPUT_COUNTS) said(`log.count.${key}`)
      for (const type of ['PurchaseOrderLine', 'WorkOrder', 'SubcontractOrder', 'PlannedWorkOrder', 'MaterialRequirement']) said(`msg.type.${type}`)
      for (const error of ['conflict', 'invalid_state', 'validation_failed', 'forbidden', 'other']) said(`convert.error.${error}`)
      for (const source of ['PLANNED', 'FIRM', 'PURCHASE_ORDER']) said(`profile.source.${source}`)
    }
  })
})
