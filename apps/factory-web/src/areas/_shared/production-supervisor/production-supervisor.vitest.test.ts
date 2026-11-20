import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { render, renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen as listScreen } from '../../production/work-orders/fixtures'
import { designScreen as recordScreen } from '../../production/work-orders/record/fixtures'
import { boardMarksOf, cleared, listAddress, listQueryOf, listTiles, narrowed, termsOf } from '../../production/work-orders/list/model'
import { ApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { API_SKIP_SENTENCES, ASSIGN_MAX, SUPERVISOR_NS, assignHeld, assignProblemOf, commonPeople, markKeyOf, resultOf, scopesOf, skipKeyOf, supervisorFactOf, targetsOfRecord, targetsOfRows, type AssignSupervisorModel, type SupervisorTarget } from './model'
import { NOT_YET_SENTENCE, SUPERVISOR_HELDS, supervisorHeldOf } from './model' // F-OO-132
import { SUPERVISED_ORDER_STATES } from '@nexus/factory-domain/production-brand/supervisor' // F-OO-132
import { SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders' // F-OO-132
import { messagesFor } from '../../../lib/i18n/messages' // F-OO-132
import { AssignSupervisorBody } from './view/AssignSupervisorDialog'
import { SupervisorFact } from './view/SupervisorFact'

/**
 * F-PR-21 — the production supervisor in the office: the band fact (by name inside one record), Work orders' Supervisor column (Me /
 * Someone else / Not set), Mine (`?supervisor=me`), "Assign supervisor…" on a selection (≤ 100 orders) and THE assign dialog (people
 * allowed on every customer of the selection; Customer default; one result per order). Wall tests (web side): PW-14 (no name on a list;
 * the pick list asked per customer of the selection only), PW-12 (an order the API does not name is counted, never named), PW-02 (the
 * Mine term never widens the customer filter).
 */

const ALPHA = { id: 'party-alpha', code: 'ALPHA', name: 'Brand Alpha' }
const BETA = { id: 'party-beta', code: 'BETA', name: 'Brand Beta' }
const row = (id: string, customer: typeof ALPHA | null, orders: { id: string; number: string; customerRef?: string | null }[], companyId = 'company-1') => ({ id, companyId, customer, orders })
const target = (orderId: string, partyId = ALPHA.id, companyId = 'company-1'): SupervisorTarget => ({ orderId, number: orderId.toUpperCase(), customerRef: null, partyId, partyName: partyId === ALPHA.id ? ALPHA.name : BETA.name, companyId })
const model = (over: Partial<AssignSupervisorModel> = {}): AssignSupervisorModel => ({
  targets: [target('so-1'), target('so-2', BETA.id)],
  leftOut: 0,
  current: null,
  people: { status: 'ready', people: [{ id: 'u-me', name: 'Alex Demo', me: true }, { id: 'u-bea', name: 'Bea Esempio', me: false }], complete: true },
  busy: false,
  problem: null,
  result: null,
  ...over,
})
/** One word of this catalogue as a screen says it (the list's cell draws exactly this). */
function MarkWords({ id }: { id: string }) {
  return createElement(WithMessages, { namespaces: [SUPERVISOR_NS] }, createElement(Say, { id }))
}
function Say({ id }: { id: string }) {
  return useT(SUPERVISOR_NS)(id)
}
const body = (value: AssignSupervisorModel, locale: 'it' | 'en' = 'en') => textOf(render(createElement(AssignSupervisorBody, { model: value }), locale))
const listCase = (id: string) => textOf(renderView(listScreen.view as ComponentType<{ model: unknown }>, listScreen.cases.find((item) => item.id === id)!.model))
const recordCase = (id: string, locale: 'it' | 'en' = 'en') => textOf(renderView(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === id)!.model, locale))

describe('F-PR-21 — what a selection sets', () => {
  it('each order once, its customer and company; a work order of no one customer left out, counted', () => {
    const rows = [row('wo-1', ALPHA, [{ id: 'so-1', number: 'SO-1', customerRef: 'PO-7' }]), row('wo-2', ALPHA, [{ id: 'so-1', number: 'SO-1' }, { id: 'so-3', number: 'SO-3' }]), row('wo-3', null, [{ id: 'so-9', number: 'SO-9' }]), row('wo-4', BETA, [], 'company-2')]
    const { targets, leftOut } = targetsOfRows(rows, true)
    expect(targets.map((one) => [one.orderId, one.partyName, one.customerRef])).toEqual([
      ['so-1', 'Brand Alpha', 'PO-7'],
      ['so-3', 'Brand Alpha', null],
    ])
    expect(leftOut).toBe(2)
    // Without parties.view the customer is named by its code.
    expect(targetsOfRows(rows, false).targets[0]!.partyName).toBe('ALPHA')
    expect(targetsOfRecord({ companyId: 'company-1', orders: [{ id: 'so-1', number: 'SO-1', customerRef: null, partyId: ALPHA.id, partyName: ALPHA.name }, { id: 'so-1', number: 'SO-1', customerRef: null, partyId: ALPHA.id, partyName: ALPHA.name }] })).toHaveLength(1)
  })

  it('PW-14 (web side): the pick list is asked only for the customers and companies of the selection, each once', () => {
    expect(scopesOf([target('so-1'), target('so-2'), target('so-3', BETA.id), target('so-4', ALPHA.id, 'company-2')])).toEqual([
      { partyId: ALPHA.id, companyId: 'company-1' },
      { partyId: BETA.id, companyId: 'company-1' },
      { partyId: ALPHA.id, companyId: 'company-2' },
    ])
  })

  it('the people who may take it on EVERY customer: the lists crossed, me first; one partial list makes it partial', () => {
    const a = { people: [{ id: 'u-bea', name: 'Bea Esempio', me: false }, { id: 'u-me', name: 'Alex Demo', me: true }, { id: 'u-dora', name: 'Dora Campione', me: false }], complete: true, ordersOnDefault: 3 }
    const b = { people: [{ id: 'u-dora', name: 'Dora Campione', me: false }, { id: 'u-me', name: 'Alex Demo', me: true }], complete: false, ordersOnDefault: 0 }
    expect(commonPeople([a, b])).toEqual({ people: [{ id: 'u-me', name: 'Alex Demo', me: true }, { id: 'u-dora', name: 'Dora Campione', me: false }], complete: false })
    expect(commonPeople([a]).people.map((person) => person.id)).toEqual(['u-me', 'u-bea', 'u-dora'])
    expect(commonPeople([])).toEqual({ people: [], complete: true })
  })

  it('held in words: no right, nothing to set, more than 100 orders (the API’s ORDER_SUPERVISOR_MAX)', () => {
    const contract = readFileSync(new URL('../../../../../factory-api/src/modules/production/supervisor/contract.ts', import.meta.url), 'utf8')
    expect(contract).toContain(`export const ORDER_SUPERVISOR_MAX = ${ASSIGN_MAX}`)
    expect(assignHeld({ manage: false }, { targets: [target('so-1')], leftOut: 0 })).toEqual({ key: 'held.noRight' })
    expect(assignHeld({ manage: true }, { targets: [], leftOut: 2 })).toEqual({ key: 'held.noCustomerOrder' })
    expect(assignHeld({ manage: true }, { targets: [], leftOut: 0 })).toEqual({ key: 'held.nothing' })
    const many = Array.from({ length: ASSIGN_MAX + 1 }, (_, index) => target(`so-${index}`))
    expect(assignHeld({ manage: true }, { targets: many, leftOut: 0 })).toEqual({ key: 'held.tooMany', params: { count: 101, max: 100 } })
    expect(assignHeld({ manage: true }, { targets: many.slice(0, 100), leftOut: 0 })).toBeNull()
  })
})

describe('F-PR-21 — after Send: one result per order', () => {
  it('Done / Already so / Not done: why (from its code), in the dialog’s order; what the API did not name only counted (PW-12)', () => {
    const targets = [target('so-1'), target('so-2'), target('so-3', BETA.id), target('so-4', BETA.id)]
    const result = resultOf({ supervisor: { id: 'u-bea', name: 'Bea Esempio', active: true }, changed: [{ orderId: 'so-2', number: 'SO-2' }], unchanged: [{ orderId: 'so-1', number: 'SO-1' }], skipped: [{ orderId: 'so-3', number: 'SO-3', why: "This person may not work on this customer's production." }], unknown: 0 }, targets)
    expect(result.lines).toEqual([
      { orderId: 'so-1', number: 'SO-1', state: 'unchanged' },
      { orderId: 'so-2', number: 'SO-2', state: 'changed' },
      { orderId: 'so-3', number: 'SO-3', state: 'skipped', key: 'skip.NO_REACH' },
    ])
    expect(result.unknown).toBe(1)
    const text = body(model({ result }))
    expect(text).toContain('Bea Esempio supervises them now.')
    expect(text).toContain('SO-3 · Not done: this person may not work on this customer')
    expect(text).toContain('1 more order was not changed.')
    expect(text).not.toContain('SO-4')
  })

  it('the API’s English "why" is said from its code; every sentence the screen knows is the API’s own', () => {
    const sources = ['../../../../../factory-api/src/modules/production/supervisor/assign.ts', '../../../../../factory-api/src/modules/production/supervisor/eligible.ts'].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
    for (const sentence of Object.values(API_SKIP_SENTENCES)) expect(sources).toContain(sentence)
    expect(skipKeyOf('This person is no longer active.')).toBe('skip.NOT_ACTIVE')
    expect(skipKeyOf('This person cannot open measurement sheets: a supervisor must (the measurements right is given per person).')).toBe('skip.NO_MEASUREMENTS')
    expect(skipKeyOf('This order is no longer in production.')).toBe('skip.notInProduction')
    expect(skipKeyOf('Something new.')).toBe('skip.other')
  })

  it('a refused Send in words: the person refused (400) from its code, none seen (404), no connection', () => {
    expect(assignProblemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/supervisorId', message: 'This person is no longer active.' }]))).toBe('skip.NOT_ACTIVE')
    expect(assignProblemOf(new ApiError('invalid', 400, 'invalid', 'x', null, []))).toBe('problem.invalid')
    expect(assignProblemOf(new ApiError('not_found', 404, 'not_found', 'Sales order not found.', null, []))).toBe('problem.notFound')
    expect(assignProblemOf(new ApiError('unavailable', 503, 'http_503', 'x', null, []))).toBe('problem.offline')
    expect(assignProblemOf(new Error('boom'))).toBe('problem.failed')
  })
})

describe('F-PR-21 — THE assign dialog', () => {
  it('names the orders it sets (first three, Show all), the customers, the people (Me first) and Customer default (en + it)', () => {
    const many = model({ targets: [target('so-1'), target('so-2'), target('so-3'), target('so-4', BETA.id)] })
    const text = body(many)
    expect(text).toContain('SO-1, SO-2, SO-3')
    expect(text).toContain('Show all (4)')
    expect(text).toContain('2 customers')
    expect(text).toContain('Me (Alex Demo)')
    expect(text).toContain('Bea Esempio')
    expect(text).toContain("Customer default — takes the order's own away")
    expect(body(many, 'it')).toContain('Predefinito del cliente')
    expect(body(model({ targets: [target('so-1')] }))).toContain('Brand Alpha')
  })

  it('nobody may take it: what a supervisor needs, in words; reading and could not read (Try again)', () => {
    expect(body(model({ people: { status: 'ready', people: [], complete: true } }))).toContain('A supervisor must be active, allowed on every customer of the selection and hold the measurements right.')
    expect(body(model({ targets: [target('so-1')], people: { status: 'ready', people: [], complete: true } }))).toContain('A supervisor must be active, allowed on the customer and hold the measurements right.')
    const failed = body(model({ people: { status: 'error', problem: 'problem.people' } }))
    expect(failed).toContain('Who may supervise could not be read.')
    expect(failed).toContain('Try again')
    expect(body(model({ people: { status: 'ready', people: [], complete: false } }))).toContain('the list holds the first 500')
  })
})

describe('F-PR-21 — the band fact (by name inside one record only)', () => {
  const orders = [{ id: 'so-1' }]
  it('none without a customer order (or an older answer); Not set; the person with this order / customer default; muted only for himself', () => {
    expect(supervisorFactOf({ orders: [], partyId: ALPHA.id, supervisor: null })).toEqual({ kind: 'none' })
    expect(supervisorFactOf({ orders, partyId: null, supervisor: null })).toEqual({ kind: 'none' })
    expect(supervisorFactOf({ orders, partyId: ALPHA.id })).toEqual({ kind: 'none' })
    expect(supervisorFactOf({ orders, partyId: ALPHA.id, supervisor: null })).toEqual({ kind: 'notSet' })
    const bea = { name: 'Bea Esempio', active: true, from: 'ORDER' as const, me: false }
    expect(supervisorFactOf({ orders, partyId: ALPHA.id, supervisor: bea, youMuted: true })).toEqual({ kind: 'person', ...bea, muted: false })
    expect(supervisorFactOf({ orders, partyId: ALPHA.id, supervisor: { ...bea, me: true }, youMuted: true })).toMatchObject({ kind: 'person', muted: true })
  })

  it('draws "Supervisor Bea Esempio · this order" with Change…, "You muted this order" for himself, "no longer active"', () => {
    expect(recordCase('supervisor-order')).toContain('Supervisor Bea Esempio · this order')
    expect(recordCase('supervisor-order')).toContain('Change…')
    expect(recordCase('supervisor-default')).toContain('· customer default')
    expect(recordCase('supervisor-muted')).toContain('You muted this order')
    expect(recordCase('supervisor-order')).not.toContain('You muted this order')
    expect(recordCase('supervisor-inactive')).toContain('no longer active')
    expect(recordCase('supervisor-not-set')).toContain('Supervisor: not set')
    expect(recordCase('supervisor-order', 'it')).toContain('Supervisore Bea Esempio · questo ordine')
    // A work order of no customer order draws no supervisor at all.
    expect(textOf(render(createElement(SupervisorFact, { fact: { kind: 'none' }, face: 'line', held: null }), 'en'))).not.toContain('Supervisor')
    expect(textOf(render(createElement(SupervisorFact, { fact: { kind: 'notSet' }, face: 'line', held: 'noRight' }), 'en'))).toContain('Supervisor: not set')
  })
})

describe('F-PR-21 — Work orders: the Supervisor column, Mine, Assign supervisor…', () => {
  const params = (query: string) => new URLSearchParams(query)
  it('Mine is `?supervisor=me` (no filter by another person), kept in the address, sent to the API beside the customer filter (PW-02)', () => {
    const terms = termsOf(params('supervisor=me&party=0190f0e2-6666-7000-8000-000000000001'), ['table'])
    expect(terms.supervisor).toBe('me')
    expect(termsOf(params('supervisor=u-bea'), ['table']).supervisor).toBeNull()
    expect(listAddress('/w/A/production/work-orders', terms)).toContain('supervisor=me')
    expect(listQueryOf(terms)).toMatchObject({ supervisor: 'me', partyId: '0190f0e2-6666-7000-8000-000000000001' })
    expect(narrowed(terms)).toBe(true)
    expect(cleared(terms).supervisor).toBeNull()
  })

  it('the Mine tile counts the open work orders I supervise; a press toggles the term', () => {
    const terms = termsOf(params(''), ['table'])
    const mine = listTiles(terms, { draft: 1, released: 0, inProgress: 2, completed: 0, open: 3, late: 0, mine: 2 })[0]!
    expect(mine).toEqual({ id: 'mine', count: 2, active: false, next: { supervisor: 'me' } })
    expect(listTiles({ ...terms, supervisor: 'me' }, null)[0]).toEqual({ id: 'mine', count: null, active: true, next: { supervisor: null } })
  })

  it('PW-14 (web side): the list says Me / Someone else / Not set, never a name; a card says only "Supervisor: me"', () => {
    expect([markKeyOf('ME'), markKeyOf('SOMEONE_ELSE'), markKeyOf('NOT_SET'), markKeyOf(null)]).toEqual(['mark.ME', 'mark.SOMEONE_ELSE', 'mark.NOT_SET', null])
    // The list's words for each mark (the cell draws only these), and the Mine tile; no case of the list names a person.
    expect(['mark.ME', 'mark.SOMEONE_ELSE', 'mark.NOT_SET'].map((key) => textOf(render(createElement(MarkWords, { id: key }), 'en')))).toEqual(['Me', 'Someone else', 'Not set'])
    expect(listCase('supervisor-column')).toContain('Mine')
    for (const id of ['supervisor-column', 'supervisor-mine', 'supervisor-selected']) expect(listCase(id)).not.toContain('Bea Esempio')
    const source = readFileSync(new URL('../../production/_shared/api.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/supervisor: z\.enum\(SUPERVISOR_MARKS\)\.nullable\(\)\.optional\(\)/)
    const card = { risk: null, waitingOn: null, status: 'IN_PROGRESS' } as const
    expect(boardMarksOf({ ...card, supervisor: 'ME' } as never, 0).flatMap((mark) => mark.words.map((words) => words.key))).toContain('production-work-orders:supervisor.cardMe')
    expect(boardMarksOf({ ...card, supervisor: 'SOMEONE_ELSE' } as never, 0)).toEqual([])
  })

  it('Assign supervisor… in the selection bar; held in words without production.brand.manage', () => {
    const view = readFileSync(new URL('../../production/work-orders/view/WorkOrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('assignHeld(model.supervisorCan ?? { manage: false }, targetsOfRows(picked, false))')
    const page = readFileSync(new URL('../../production/work-orders/WorkOrdersPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("supervisorCan = { manage: session.permissions.includes('production.brand.manage') }")
  })
})

// ---- F-OO-132 (order overview lane; 10-design §3.2; 13-backend B-OO-008; review F10): the fact's two faces, Change… held in words ----
describe('F-OO-132 — SupervisorFact: the line face (the work order pages, as before) and the row face (the order Overview)', () => {
  const bea = { kind: 'person' as const, name: 'Bea Esempio', active: true, from: 'ORDER' as const, me: false, muted: false }
  const draw = (props: Record<string, unknown>, locale: 'it' | 'en' = 'en') => render(createElement(SupervisorFact, { fact: bea, face: 'row', held: null, ...props } as never), locale)
  /** A word of this catalogue as written (the catalogue is flat: `held.notYet`). */
  const say = (locale: 'it' | 'en', key: string): string | undefined => messagesFor(locale, [SUPERVISOR_NS])[SUPERVISOR_NS]?.[key]
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const IT_NOT_YET = 'Questo ordine aspetta un sì: il supervisore si sceglie quando è confermato.'

  it('held by the order’s status, in the API’s order: no right first; a waiting order "not yet"; out of the supervised states "no longer"', () => {
    const want: Record<string, string | null> = { PENDING_APPROVAL: 'notYet', CONFIRMED: null, IN_PRODUCTION: null, READY: null, PARTLY_SHIPPED: null, SHIPPED: 'noLonger', DELIVERED: 'noLonger', CLOSED: 'noLonger', CANCELLED: 'noLonger' }
    // Every status of an order is said (none falls through unseen); the supervised states are the keeper's.
    expect(Object.keys(want).sort()).toEqual([...SALES_ORDER_STATUSES].sort())
    for (const status of SALES_ORDER_STATUSES) {
      expect(supervisorHeldOf(true, status), status).toBe(want[status])
      expect(supervisorHeldOf(false, status), status).toBe('noRight')
    }
    expect([...SUPERVISED_ORDER_STATES].sort()).toEqual(['CONFIRMED', 'IN_PRODUCTION', 'PARTLY_SHIPPED', 'READY'])
  })

  it('each held reason in its own words (en + it); "not yet" is B-OO-008’s sentence — ONE wording with the API (assign.ts)', () => {
    for (const locale of ['en', 'it'] as const) for (const held of SUPERVISOR_HELDS) expect(say(locale, `held.${held}`), `${locale} ${held}`).toBeTruthy()
    expect(say('en', 'held.notYet')).toBe(NOT_YET_SENTENCE)
    expect(say('it', 'held.notYet')).toBe(IT_NOT_YET)
    expect(say('en', 'held.noLonger')).toBe('This order is no longer in production: its supervisor stays.')
    // The API skips a waiting order with the same sentence (assign.ts, or the domain words it imports; never urgency.ts / health.ts).
    const api = ['../../../../../factory-api/src/modules/production/supervisor/assign.ts', '../../../../../../packages/factory-domain/src/production-brand/words.ts'].map(source).join('\n')
    expect(api).toContain(NOT_YET_SENTENCE)
    expect(api).toContain(IT_NOT_YET)
    // …and the assign dialog says that skip from its code.
    expect(skipKeyOf(NOT_YET_SENTENCE)).toBe('skip.notYet')
    expect(say('en', 'skip.notYet')).toBe('this order waits for a yes: its supervisor is set once it is confirmed.')
    // Drawn: held, focusable, the reason said (never disabled, never hidden).
    expect(draw({ held: 'notYet', onChange: () => {} })).toContain(`aria-description="${NOT_YET_SENTENCE}"`)
    expect(draw({ held: 'notYet', onChange: () => {} }, 'it')).toContain(`aria-description="${IT_NOT_YET}"`)
    expect(draw({ held: 'noLonger', onChange: () => {} })).toContain('aria-description="This order is no longer in production: its supervisor stays."')
    expect(draw({ held: null, onChange: () => {} })).not.toContain('aria-disabled')
  })

  it('the line face is the work order band’s fact as before: the icon, "Supervisor {name} · this order", Change… — its two callers pass it', () => {
    const line = render(createElement(SupervisorFact, { fact: bea, face: 'line', held: null }), 'en')
    expect(line.startsWith('<span class="fw-psv-fact"><svg')).toBe(true)
    expect(textOf(line)).toBe('Supervisor Bea Esempio · this order Change…')
    expect(line).not.toContain('aria-disabled')
    expect(render(createElement(SupervisorFact, { fact: bea, face: 'line', held: 'noRight' }), 'en')).toContain('aria-description="Setting a production supervisor needs the right to manage customers')
    // The work order pages hold it for the right only, as before (their fact spans orders: no order status there).
    for (const path of ['../../production/work-orders/record/view/BandFacts.tsx', '../../production/work-orders/record/customer/view/CustomerCard.tsx']) {
      const caller = source(path)
      expect(caller, path).toContain('<SupervisorFact face="line"')
      expect(caller, path).toContain("held={model.supervisor.can ? null : 'noRight'}")
    }
    const view = source('./view/SupervisorFact.tsx')
    expect(view).toContain('<UserCog size={13} aria-hidden />')
    expect(view).toContain("{t('fact.label', { name: fact.name })} <span className=\"fw-psv-hint\">· {t(`fact.from.${fact.from}`)}</span>")
    // The order Overview passes the row face with the order's own hold.
    const people = source('../../sales/orders/record/view/overview/PeopleCard.tsx')
    expect(people).toContain('face="row"')
    expect(people).toContain('held={supervisorHeldOf(!!model.people?.mayAssign, order.status)}')
  })

  it('the row face: the value and the doors cells — no icon, no word "Supervisor"; "Not set"; Change… and Ask only where the caller gives them', () => {
    const row = draw({ onChange: () => {} })
    expect(row).not.toContain('<svg')
    expect(row).not.toContain('fw-psv-fact')
    expect(row.startsWith('<span class="fw-psv-value">')).toBe(true)
    expect(row).toContain('<span class="fw-psv-doors">')
    expect(textOf(row)).toBe('Bea Esempio · this order Change…')
    expect(textOf(draw({ onChange: () => {} }, 'it'))).toBe('Bea Esempio · questo ordine Cambia…')
    // No door given (Read-only): the value alone.
    const bare = draw({})
    expect(bare).not.toContain('<button')
    expect(bare).not.toContain('fw-psv-doors')
    expect(textOf(draw({ fact: { kind: 'notSet' } }))).toBe('Not set')
    expect(textOf(draw({ fact: { kind: 'notSet' } }, 'it'))).toBe('Non impostato')
    expect(textOf(draw({ fact: { ...bea, active: false } }))).toContain('no longer active')
    expect(textOf(draw({ ask: { label: 'Ask', held: null, onAsk: () => {} } }))).toBe('Bea Esempio · this order Ask')
    expect(textOf(render(createElement(SupervisorFact, { fact: { kind: 'none' }, face: 'row', held: null }), 'en'))).toBe('')
  })
})
// ---- end F-OO-132
