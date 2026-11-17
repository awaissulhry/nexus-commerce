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
    expect(textOf(render(createElement(SupervisorFact, { fact: { kind: 'none' }, can: true }), 'en'))).not.toContain('Supervisor')
    expect(textOf(render(createElement(SupervisorFact, { fact: { kind: 'notSet' }, can: false }), 'en'))).toContain('Supervisor: not set')
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
