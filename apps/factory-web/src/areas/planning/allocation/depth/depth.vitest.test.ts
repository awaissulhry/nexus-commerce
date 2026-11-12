import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HOLD_CODES, WARNING_CODES } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { apiErrorFrom } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { drawAllocation, NAMESPACE } from '../model'
import { ALLOCATION, designScreen, WORKSHOPS } from '../fixtures'
import { bringInHouse, createSubcontractOrders, getAllocationWorkshops, getKitTiming, getWorkOrderWorkshops, sendOutside } from './api'
import {
  createOrdersHeld,
  decorateCards,
  decorateLanes,
  DEPTH_NAMESPACE,
  dropHeldFor,
  holdWords,
  kitFacts,
  kitProblemOf,
  madeWords,
  kitSentence,
  orderableParts,
  outsideDoneWords,
  partChange,
  partProblemWords,
  slotsOf,
  standingWords,
  switchHeld,
  switchRefusalOf,
  switchRefusalWords,
  warningWords,
  workshopCapacityWords,
  workshopDetail,
  type Words,
} from './model'

/**
 * Lines & subcontractors in depth (SCR-126; B-W2b-338 on B-W2b-321's API): workshop columns with their reasons (held for
 * what does not depend on the work; a card held by its own verdict), warnings said and never held, the operations chip,
 * the kit timing in words, an operation's switch and its refusals, "Create subcontract orders (n)", the calls as the API
 * takes them, and every new design case drawn in both languages with no key or placeholder left.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => ({ t: createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!), locale })
const plain = (locale: 'it' | 'en' = 'en') => ({ t: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), locale })
const [BETA, GAMMA] = WORKSHOPS.workshops
const card = (number: string, part = false) => ALLOCATION.cards.find((entry) => entry.workOrder.number === number && (entry.slot !== null) === part)!
const ready = { status: 'ready' as const, value: WORKSHOPS }

describe('allocation in depth: workshop columns with their reasons', () => {
  it('a column is held for what does not depend on the work (no valid DURC), and says what it is approved for', () => {
    const lanes = decorateLanes(drawAllocation(ALLOCATION, plain()).lanes, ready, ALLOCATION.site.name, words())
    const beta = lanes.find((lane) => lane.label === 'Laboratorio Beta')!
    const gamma = lanes.find((lane) => lane.label === 'Laboratorio Gamma')!
    expect(beta.held).toBeNull()
    expect(beta.detail).toContain('Approved for sewing, finishing')
    expect(beta.detail).toContain('DURC until')
    expect(gamma.held).toMatch(/^No valid DURC: it expired on .*5 Nov/)
    expect(lanes.find((lane) => lane.label === 'Linea 1')!.held).toBeUndefined()
    expect(workshopCapacityWords(BETA!, words())).toBe('Next 4 weeks: sewing: 1,350 of 9,600 min booked (14%). 800 min more proposed by the plan. · all work: 30 of 240 garments booked (13%).')
    expect(workshopCapacityWords(GAMMA!, words('it'))).toContain('non ha una capacità settimanale')
    expect(workshopDetail(GAMMA!, words('it'))).toBe('Approvato per cucito')
  })

  it('fails closed: while the check is read or after it failed, every workshop column is held', () => {
    const drawn = drawAllocation(ALLOCATION, plain()).lanes
    expect(decorateLanes(drawn, { status: 'loading' }, 'x', words()).filter((lane) => lane.held).map((lane) => lane.label)).toEqual(['Laboratorio Beta', 'Laboratorio Gamma'])
    expect(decorateLanes(drawn, { status: 'error' }, 'x', words()).find((lane) => lane.label === 'Laboratorio Beta')!.held).toMatch(/could not be read/)
    expect(dropHeldFor(ALLOCATION, { status: 'loading' }, card('WO-0101').id, `WORKSHOP:${BETA!.id}`, words())).toMatch(/^Checking/)
  })

  it('a card is held by its own verdict while it is dragged: not approved for armour pockets; a line or the tray never', () => {
    expect(dropHeldFor(ALLOCATION, ready, card('WO-0104').id, `WORKSHOP:${BETA!.id}`, words())).toBe('Not approved for sewing (Op 30 Tasche paraschiena): being reviewed, not approved yet.')
    expect(dropHeldFor(ALLOCATION, ready, card('WO-0104').id, `WORKSHOP:${BETA!.id}`, words('it'))).toBe('Non approvato per cucito (Op 30 Tasche paraschiena): in valutazione, non ancora approvato.')
    expect(dropHeldFor(ALLOCATION, ready, card('WO-0101').id, `WORKSHOP:${BETA!.id}`, words())).toBeNull()
    expect(dropHeldFor(ALLOCATION, ready, card('WO-0101').id, `LINE:${ALLOCATION.lanes[1]!.id}`, words())).toBeNull()
    expect(dropHeldFor(ALLOCATION, ready, card('WO-0101').id, null, words())).toBeNull()
    const unlisted = { status: 'ready' as const, value: { ...WORKSHOPS, workOrders: [] } }
    expect(dropHeldFor(ALLOCATION, unlisted, card('WO-0101').id, `WORKSHOP:${BETA!.id}`, words())).toBe('Whether Laboratorio Beta is approved for WO-0101 is not known yet: the board reads it again.')
    // Nothing left to make outside (the check lists no outside work): the drop on a workshop is held, as the kit timing's 409.
    const noWork = { status: 'ready' as const, value: { ...WORKSHOPS, workOrders: WORKSHOPS.workOrders.map((entry) => (entry.workOrder.number === 'WO-0101' ? { ...entry, operations: [] } : entry)) } }
    expect(dropHeldFor(ALLOCATION, noWork, card('WO-0101').id, `WORKSHOP:${BETA!.id}`, words())).toBe('WO-0101 has no work left to send out: nothing it makes is left, so it stays on our lines.')
    expect(dropHeldFor(ALLOCATION, noWork, card('WO-0101').id, `LINE:${ALLOCATION.lanes[1]!.id}`, words())).toBeNull()
    expect(kitProblemOf(apiErrorFrom(409, { error: { code: 'conflict', message: 'WO-0101 has no work left to send out.' } }))).toBe('noWork')
    expect(kitProblemOf(apiErrorFrom(409, { error: { code: 'conflict', message: 'Something else.' } }))).toBe('failed')
  })

  it('every hold and warning code has our words in both languages; the sentence shapes give the detail', () => {
    for (const locale of LOCALES) {
      for (const code of HOLD_CODES) expect(holdWords({ code, words: '' }, BETA!, 'Sito', words(locale)), `${locale} ${code}`).not.toMatch(/al\.|\{/)
      for (const code of WARNING_CODES) expect(warningWords({ code, words: '' }, BETA!, words(locale)), `${locale} ${code}`).not.toMatch(/al\.|\{/)
    }
    expect(holdWords({ code: 'SUPPLIER_STATUS', words: 'Beta is blocked as a supplier since 2 Nov: no new purchase order goes to it; pick another approved source.' }, BETA!, 'x', words())).toBe('Laboratorio Beta is blocked as a supplier: no new order goes to it.')
    expect(holdWords({ code: 'NO_VALID_DURC', words: '' }, { name: 'X', durc: { checked: true, state: 'MISSING', expiresOn: null } }, 'x', words())).toMatch(/^No valid DURC on file \(D\.Lgs\. 276\/2003 art\. 29\)/)
    expect(warningWords({ code: 'OVER_CAPACITY', words: 'Laboratorio Beta would be at 112.0% of its capacity while the work is there.' }, BETA!, words('it'))).toBe('Laboratorio Beta sarebbe al 112% della sua capacità mentre il lavoro è lì.')
    expect(warningWords({ code: 'CONDITIONAL', words: 'Approved for finishing (Op 40 Finitura) with conditions: second check on seams' }, BETA!, words())).toBe('Approved with conditions for finishing (Op 40 Finitura): second check on seams.')
    expect(standingWords('suspended: seams opened on the last lot.', words())).toBe('suspended: seams opened on the last lot')
    expect(standingWords('not qualified for this work: no qualification covers it.', words())).toBe('no qualification covers this work')
    expect(standingWords('the qualification ended on 3 November 2026.', words('it'))).toBe("l'approvazione è scaduta")
    expect(standingWords('something new', words())).toBe('not approved')
  })

  it('the operations chip says which operation is outside', () => {
    const cards = decorateCards(drawAllocation(ALLOCATION, plain()).cards, ALLOCATION, ready, words())
    expect(cards.find((entry) => entry.id === card('WO-0102').id)!.marks!.at(-1)).toEqual({ label: 'Op 20 sewing outside', tone: 'info' })
    expect(cards.find((entry) => entry.id === card('WO-0101').id)!.marks!.some((mark) => /outside/.test(mark.label))).toBe(false)
    expect(decorateCards(drawAllocation(ALLOCATION, plain()).cards, ALLOCATION, { status: 'loading' }, words())).toHaveLength(ALLOCATION.cards.length)
  })
})

describe('allocation in depth: the kit timing, the switch and the orders', () => {
  const timing = {
    workOrder: { id: 'w', number: 'WO-1', status: 'RELEASED', garments: 10 },
    workshop: { id: 'p', code: 'B', name: 'Laboratorio Beta' },
    operations: [],
    pieces: 10,
    start: '2026-11-23',
    startSource: 'SCHEDULE' as const,
    transportDays: 2,
    transportSource: 'DEFAULT' as const,
    kitShipOn: '2026-11-19',
    kitDueAt: '2026-11-19T07:00:00.000Z',
    late: false,
    workDays: 1,
    workDaysSource: 'CAPACITY' as const,
    backOn: '2026-11-26',
    closedDaysSkipped: 2,
    kit: { note: null, lines: [] },
    laterOperations: [],
    finishesLate: false,
  }

  it('says when the kit leaves (start − transport days), how long the work takes and when it is back', () => {
    expect(kitSentence(timing, words())).toBe('Send the kit on Thu 19 Nov: 2 transport days before the work starts at Laboratorio Beta on Mon 23 Nov.')
    expect(kitSentence({ ...timing, late: true, transportDays: 1 }, words('it'))).toMatch(/^Il kit sarebbe dovuto partire il gio 19 nov .* 1 giorno di trasporto/)
    const facts = kitFacts(timing, 'Europe/Rome', words())
    expect(facts.map((fact) => fact.value)).toEqual(["Mon 23 Nov (the board's latest safe start)", '2 days (the default: the workshop has no delivery time)', 'Thu 19 Nov at 08:00', '1 working day (from its weekly capacity)', 'Thu 26 Nov (2 closed days of the workshop skipped)'])
  })

  it('a refused switch is read from its issue paths and its shape, never drawn in the API’s English', () => {
    const held = switchRefusalOf(apiErrorFrom(409, { error: { code: 'conflict', message: 'Beta is not offered for Op 20 Sew: …', issues: [{ path: 'refusal/NOT_QUALIFIED', message: 'Not approved for sewing (Op 20 Sew): being reviewed: not qualified yet.' }] } }))
    expect(held.code).toBe('HELD')
    expect(holdWords(held.holds[0]!, BETA!, 'x', words())).toBe('Not approved for sewing (Op 20 Sew): being reviewed, not approved yet.')
    expect(switchRefusalOf(apiErrorFrom(409, { error: { code: 'conflict', message: 'Changed.', issues: [{ path: 'body/version', message: 'x' }] } })).code).toBe('CHANGED')
    expect(switchRefusalOf(apiErrorFrom(409, { error: { code: 'conflict', message: 'The kit or pieces of SC-1 are at the workshop: take them back on the order first.' } })).code).toBe('KIT_OUT')
    expect(switchRefusalOf(apiErrorFrom(403, { error: { code: 'forbidden', message: 'Bringing it back changes SC-1: that needs purchasing.subcontract.manage.' } })).code).toBe('NEEDS_SUBCONTRACT')
    // W2a's createOrder: garments already on other subcontract orders (how many may still go out), and the workshop's location.
    const onOrders = switchRefusalOf(apiErrorFrom(400, { error: { code: 'validation_failed', message: '7 piece(s) of operation 20 SEW are on other subcontract orders already; at most 0 more of the work order\'s 7.', issues: [{ path: 'body/operations/0/pieces', message: '7 piece(s) of operation 20 SEW are on other subcontract orders already; at most 0 more of the work order\'s 7.' }] } }))
    expect(onOrders).toMatchObject({ code: 'ON_ORDERS', more: 0 })
    expect(switchRefusalWords(onOrders, words())).toMatch(/^Every garment of this operation is on another subcontract order already/)
    expect(switchRefusalWords({ code: 'ON_ORDERS', more: 3 }, words('it'))).toMatch(/^Possono uscire solo 3 altri capi/)
    expect(switchRefusalOf(apiErrorFrom(400, { error: { code: 'validation_failed', message: 'The workshop has 2 locations on the site: name the one to use.', issues: [{ path: 'body/locationId', message: 'The workshop has 2 locations on the site: name the one to use.' }] } })).code).toBe('LOCATION')
    expect(switchRefusalWords({ code: 'PIECES' }, words())).toBe("Give whole garments, at most the work order's.")
    expect(switchHeld({ mayOutsource: true, offline: false, busy: false, mode: 'outside', partyId: null, offered: false, reason: '' }, words())).toBe('Pick an approved workshop.')
    expect(switchHeld({ mayOutsource: true, offline: false, busy: false, mode: 'in-house', partyId: null, offered: false, reason: 'ok' }, words())).toMatch(/at least 3/)
    expect(switchHeld({ mayOutsource: true, offline: false, busy: false, mode: 'in-house', partyId: null, offered: false, reason: 'Linea 2 libera' }, words())).toBeNull()
  })

  it('what became of the order when an operation went outside', () => {
    const answer = { operation: { id: 'o', seq: 20, name: 'Cucitura', version: 3, outsourced: true, subcontractOrderId: null }, workshop: { id: 'p', code: 'B', name: 'Laboratorio Beta' }, order: null, orderWords: 'No subcontract order yet: drafting it needs purchasing.subcontract.manage (the buyer makes it from Purchasing › Subcontracting).', timing: { start: '2026-11-23', kitShipOn: '2026-11-19', kitDueAt: 'x', late: false, backOn: '2026-11-26' }, warnings: [] }
    expect(outsideDoneWords(answer, words())).toBe('Op 20 Cucitura sent outside to Laboratorio Beta. No subcontract order yet: the buyer drafts it from Purchasing › Subcontracting.')
    expect(outsideDoneWords({ ...answer, order: { id: 's', number: 'SC-2026-0001', status: 'DRAFT', kitDueAt: 'x' }, orderWords: null }, words())).toMatch(/Draft subcontract order SC-2026-0001: the kit leaves Thu 19 Nov, back Thu 26 Nov\.$/)
    // A kit already late: the order's kit time is today 08:00 at the site; a name ending in a full stop closes with one.
    const late = { ...answer, workshop: { id: 'p', code: 'S1', name: 'Laboratorio Esempio S.p.A.' }, order: { id: 's', number: 'SC-2026-0002', status: 'DRAFT', kitDueAt: '2026-11-12T07:00:00.000Z' }, orderWords: null, timing: { ...answer.timing, kitShipOn: '2026-11-05', late: true } }
    expect(outsideDoneWords(late, words(), 'Europe/Rome')).toBe('Op 20 Cucitura sent outside to Laboratorio Esempio S.p.A. Draft subcontract order SC-2026-0002: the kit leaves Thu 12 Nov, back Thu 26 Nov.')
  })

  it('a made order says its own kit day; a late kit in the review leaves today', () => {
    const result = { slotId: 's', ok: true, workOrder: { id: 'w', number: 'WO-0102' }, workshop: { id: 'p', code: 'B', name: 'Laboratorio Beta' }, operations: [{ id: 'o', seq: 20, name: 'Cucitura' }], pieces: 1, order: { id: 'o1', number: 'SC-2026-0009', status: 'DRAFT', kitDueAt: '2026-11-16T07:00:00.000Z' }, kitShipOn: '2026-11-05', backOn: '2026-11-27', problems: [], warnings: [] }
    expect(madeWords(result, WORKSHOPS, 'x', words(), 'Europe/Rome')).toBe('SC-2026-0009 drafted · the kit leaves Mon 16 Nov')
    expect(partChange({ ...result, order: null }, undefined, WORKSHOPS, words(), '2026-11-16').next).toBe('Draft order · the kit is late (due Thu 5 Nov): it leaves today · back Fri 27 Nov')
    expect(partChange({ ...result, order: null, kitShipOn: '2026-11-18' }, undefined, WORKSHOPS, words(), '2026-11-16').next).toBe('Draft order · the kit leaves Wed 18 Nov · back Fri 27 Nov')
  })

  it('Create subcontract orders (n): the workshop parts without their order; held with why', () => {
    const parts = orderableParts(ALLOCATION, WORKSHOPS)
    expect(parts.map((entry) => entry.workOrder.number)).toEqual(['WO-0102'])
    expect(slotsOf(parts)).toEqual([card('WO-0102', true).slot!.id])
    const input = { data: ALLOCATION, workshops: ready, mayOutsource: true, mayOrder: true, offline: false }
    expect(createOrdersHeld(input, words())).toBeNull()
    expect(createOrdersHeld({ ...input, mayOrder: false }, words())).toBe('Drafting subcontract orders needs the subcontracting permission: the buyer makes them.')
    expect(createOrdersHeld({ ...input, data: { ...ALLOCATION, cards: ALLOCATION.cards.filter((entry) => entry.slot === null) } }, words())).toBe('No order allocated to a subcontractor yet.')
    expect(createOrdersHeld({ ...input, workshops: { status: 'ready', value: { ...WORKSHOPS, workOrders: WORKSHOPS.workOrders.map((entry) => ({ ...entry, operations: entry.operations.map((operation) => ({ ...operation, outsourced: true, subcontractOrderId: 'so' })) })) } } }, words())).toMatch(/^Every part/)
    const part = { workOrder: { id: 'w', number: 'WO-0105' }, workshop: { id: BETA!.id, code: 'LAB-B', name: 'Laboratorio Beta' } }
    expect(partProblemWords("WO-0105's garments at this workshop are on a subcontract order already.", part, WORKSHOPS, 'x', words('it'))).toBe('I capi di WO-0105 presso questo laboratorio sono già su un ordine di lavorazione esterna.')
    expect(partProblemWords('No subcontract order yet: drafting it needs purchasing.subcontract.manage (the buyer makes it).', part, WORKSHOPS, 'x', words())).toMatch(/^Drafting it needs the subcontracting permission/)
    expect(partProblemWords('No valid DURC: it expired on 2026-11-05.', { ...part, workshop: { id: GAMMA!.id, code: 'LAB-G', name: 'Laboratorio Gamma' } }, WORKSHOPS, 'x', words())).toMatch(/^No valid DURC: it expired on/)
    expect(partProblemWords('Something we never said.', part, WORKSHOPS, 'x', words())).toBe('The server did not make this order.')
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

describe('allocation in depth: the calls as the API takes them', () => {
  it('reads the workshops, one work order’s, the kit timing; switches one operation with its version; previews the orders', async () => {
    const operation = { id: 'op1', seq: 20, name: 'Cucitura', version: 4, outsourced: true, subcontractOrderId: null }
    const { api, calls } = mockApi([
      { status: 200, body: WORKSHOPS },
      { status: 200, body: { workOrder: { id: 'w', number: 'WO-1', status: 'RELEASED', version: 3, garments: 10, style: 'MOD-1' }, asOf: 'x', operations: [], mayOutsource: true, workshops: [] } },
      { status: 400, body: { error: { code: 'invalid', message: 'x' } } },
      { status: 200, body: { operation, workshop: { id: 'p', code: 'B', name: 'Beta' }, order: null, orderWords: null, timing: { start: '2026-11-23', kitShipOn: '2026-11-19', kitDueAt: 'x', late: false, backOn: '2026-11-26' }, warnings: [] } },
      { status: 200, body: { operation: { ...operation, outsourced: false }, order: null } },
      { status: 200, body: { preview: true, made: 0, held: 0, asOf: 'x', results: [] } },
    ])
    await getAllocationWorkshops(api, 's1')
    expect(calls[0]!.url).toBe('/api/planning/allocation/workshops?siteId=s1')
    await getWorkOrderWorkshops(api, 'w', ['op1', 'op2'])
    expect(calls[1]!.url).toBe('/api/planning/work-orders/w/workshops?operationIds=op1%2Cop2')
    await expect(getKitTiming(api, 'w', { partyId: 'p', pieces: 10 })).rejects.toThrow()
    expect(calls[2]!.url).toBe('/api/planning/work-orders/w/kit-timing?partyId=p&pieces=10')
    await sendOutside(api, 'w', 'op1', { version: 4, partyId: 'p' })
    expect(calls[3]).toMatchObject({ method: 'POST', url: '/api/planning/work-orders/w/operations/op1/outside', body: { version: 4, partyId: 'p' } })
    expect(calls[3]!.headers.get('idempotency-key')).toBeTruthy()
    await bringInHouse(api, 'w', 'op1', { version: 5, reason: 'Linea 2 libera' })
    expect(calls[4]).toMatchObject({ method: 'POST', url: '/api/planning/work-orders/w/operations/op1/in-house', body: { version: 5, reason: 'Linea 2 libera' } })
    await createSubcontractOrders(api, { siteId: 's1', slotIds: ['a', 'b'], preview: true })
    expect(calls[5]).toMatchObject({ method: 'POST', url: '/api/planning/allocation/subcontract-orders', body: { siteId: 's1', parts: [{ slotId: 'a' }, { slotId: 'b' }], preview: true } })
    expect(calls[5]!.headers.get('idempotency-key')).toBeNull()
  })
})

const LEFT_KEY = /\b(?:al|cp)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:example\.com|D\.Lgs\.)\b/g

describe('every allocation design case draws in both languages with no depth key left on screen', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const View = screen.view as ComponentType<{ model: unknown }>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model: item.model }))).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
