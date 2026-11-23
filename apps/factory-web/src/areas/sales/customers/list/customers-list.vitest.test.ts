import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cardFieldsOf } from '@nexus/ui/grid/card-list/index'
import type { ColDef } from '@nexus/ui/grid'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import type { PartyRow } from '../../../parties/_shared/api'
import { CUSTOMERS, rowOf } from '../../../parties/_shared/fixtures'
import { customerColumnsOf, threadHref } from './columns'
import { MessagesHeader } from './view/cells' // F-CL-301
import { CARD_ROLES, customerActsOf, CUSTOMER_HIDDEN_COLUMNS, customerRightsOf, namesOtherCustomer, officeDataOf } from './model'
import { supervisorBodyOf, supervisorPlanOf, supervisorRestOf, supervisorSummaryOf, type SupervisorTarget } from './supervisor/model'

/**
 * Sales › Customers, the list's own parts (customers list W1, F-CL-102…104): the Customer cell's office chip, the columns and what
 * starts hidden, the phone card, the rights each act reads, and every word the folder names in both languages.
 */

const words = (key: string, params?: Readonly<Record<string, string | number>>) => (params ? `${key} ${JSON.stringify(params)}` : key)
const row = (code: string): PartyRow => rowOf(CUSTOMERS.find((item) => item.code === code)!)

describe('F-CL-102: the Customer cell says what the office still owes, in one chip', () => {
  const base = row('MODA-DEMO')
  it('one code per warning: VIES not valid, SDI code or PEC missing, tax data missing (or anything that stops an invoice)', () => {
    expect(officeDataOf({ ...base, attention: [], invoiceBlocked: false })).toEqual([])
    expect(officeDataOf({ ...base, attention: ['VIES_NOT_PROVEN'], invoiceBlocked: false })).toEqual(['VIES'])
    expect(officeDataOf({ ...base, attention: ['FISCAL_DRAWER'], invoiceBlocked: false })).toEqual(['SDI'])
    expect(officeDataOf({ ...base, attention: ['NO_TAX_IDENTITY'], invoiceBlocked: true })).toEqual(['TAX'])
    expect(officeDataOf({ ...base, attention: [], invoiceBlocked: true })).toEqual(['TAX'])
    expect(officeDataOf({ ...base, attention: ['VIES_NOT_PROVEN', 'FISCAL_DRAWER', 'NO_TAX_IDENTITY'], invoiceBlocked: true })).toEqual(['VIES', 'SDI', 'TAX'])
    // Address and contact warnings are the record's own steps, not office data on the list.
    expect(officeDataOf({ ...base, attention: ['NO_DEFAULT_SHIP_TO', 'NO_ORDERS_CONTACT'], invoiceBlocked: false })).toEqual([])
  })
})

describe('F-CL-102: the columns, what starts hidden, the phone card', () => {
  const overdue: ColDef<PartyRow>[] = [{ colId: 'overdue', headerName: 'Overdue' }]
  const actions: ColDef<PartyRow> = { colId: 'actions', headerName: '', pinned: 'right' }
  const unread = { [row('MODA-DEMO').id]: { newCount: 2, lastAt: null } }

  it('the Customer cell takes the name’s place (same id); New messages only for a reader of threads, after Overdue', () => {
    const withThreads = customerColumnsOf({ prefix: '/w/DEMO', unread, overdue }, words, words)
    expect(withThreads.nameColumn.colId).toBe('name')
    expect(withThreads.nameColumn.headerName).toBe('col.customer')
    expect(withThreads.leadingColumns.map((column) => column.colId)).toEqual(['overdue', 'messages'])
    const messages = withThreads.leadingColumns.find((column) => column.colId === 'messages')!
    expect(messages.headerName).toBe('column')
    expect(messages.headerTooltip).toBe('col.messagesHint')
    // A reader without threads.read gets no column (never an empty one); without prices no Overdue either.
    expect(customerColumnsOf({ prefix: '/w/DEMO', unread: null, overdue: undefined }, words, words).leadingColumns).toEqual([])
    expect(threadHref('/w/DEMO', 'p 1')).toBe('/w/DEMO/sales/customers/p%201?thread=new')
  })

  it('the identity columns start hidden (still in Customise and the full file); the shown set is Customer · Overdue · New messages · ⋯', () => {
    expect([...CUSTOMER_HIDDEN_COLUMNS]).toEqual(['roles', 'status', 'country', 'taxMode', 'vies', 'sdi', 'language'])
    // F-CL-202 (T15): Overdue shows at first only in the wide room (1920); at 1440 it waits in Customise.
    const built = customerColumnsOf({ prefix: '/w/DEMO', unread, overdue, wide: true }, words, words)
    const all = [built.nameColumn.colId, ...built.leadingColumns.map((column) => column.colId), ...CUSTOMER_HIDDEN_COLUMNS, 'actions']
    expect(all.filter((id) => !built.hiddenColumns.includes(id!))).toEqual(['name', 'overdue', 'messages', 'actions'])
    const narrow = customerColumnsOf({ prefix: '/w/DEMO', unread, overdue }, words, words)
    expect(all.filter((id) => !narrow.hiddenColumns.includes(id!))).toEqual(['name', 'messages', 'actions'])
  })

  it('the card: the Customer cell is the title, the thread door beside it, the row’s ⋯ its actions, Overdue a line', () => {
    const built = customerColumnsOf({ prefix: '/w/DEMO', unread, overdue }, words, words)
    const fields = cardFieldsOf([built.nameColumn, ...built.leadingColumns, actions], built.card)
    expect(Object.fromEntries(fields.map((field) => [field.id, field.role]))).toEqual({ name: 'title', overdue: 'field', messages: 'aside', actions: 'actions' })
    // F-CL-203: the work columns' places on the card (without orders.view they are not built).
    expect(CARD_ROLES).toEqual({ picture: 'hidden', name: 'title', needs: 'subtitle', work: 'subtitle', nextPromise: 'subtitle', lastOrder: 'hidden', messages: 'aside', overdue: 'field' })
    // Never a labelled "Actions" line on the card (C1-B9).
    expect(fields.filter((field) => field.role === 'field').map((field) => field.label)).toEqual(['Overdue'])
  })
})

describe('F-CL-102 / F-CL-104: each act reads its own right', () => {
  it('threads, orders, tasks (tasks.manage + threads.post) and the supervisor (production.brand.manage + partners.view)', () => {
    expect(customerRightsOf([])).toEqual({ threads: false, orders: false, tasks: false, supervisor: false })
    expect(customerRightsOf(['tasks.manage'])).toMatchObject({ tasks: false })
    expect(customerRightsOf(['tasks.manage', 'threads.post'])).toMatchObject({ tasks: true })
    // A planner holds production.brand.manage without partners.view: no supervisor act (as the customer card).
    expect(customerRightsOf(['production.brand.manage'])).toMatchObject({ supervisor: false })
    expect(customerRightsOf(['production.brand.manage', 'partners.view', 'threads.read', 'orders.view'])).toEqual({ threads: true, orders: true, tasks: false, supervisor: true })
  })
})

// ---- F-CL-104: the customers' own acts ------------------------------------------------------------------------------------------
describe('F-CL-104: Add task to N customers… — the R-47 check of the text', () => {
  const ticked = [
    { code: 'SEED-C1', tradeName: 'Seed Racing', legalName: 'Seed Racing S.r.l.' },
    { code: 'SEED-C3', tradeName: 'Seed Moto Club', legalName: 'Seed Moto Club ASD' },
    { code: 'AB', tradeName: null, legalName: 'Xy' },
  ]
  it('names one customer, two customers, none', () => {
    expect(namesOtherCustomer('Send the new size chart to Seed Racing', ticked)).toEqual(['Seed Racing'])
    expect(namesOtherCustomer('seed racing and SEED MOTO CLUB: check the logos', ticked)).toEqual(['Seed Racing', 'Seed Moto Club'])
    expect(namesOtherCustomer('Check the logos on the new jackets', ticked)).toEqual([])
    // Its code counts as its name.
    expect(namesOtherCustomer('About SEED-C3 only', ticked)).toEqual(['Seed Moto Club'])
  })
  it('a code inside a longer word is no match; fewer than 3 letters are no name', () => {
    expect(namesOtherCustomer('Order SEED-C10 is late', ticked)).toEqual([])
    expect(namesOtherCustomer('XSEED-C1', ticked)).toEqual([])
    expect(namesOtherCustomer('AB xy ab', ticked)).toEqual([])
  })
})

describe('F-CL-104: the bar’s own acts — each by its own right, held only by the cap', () => {
  it('Add task (10) with tasks.manage + threads.post, Set supervisor (20) with production.brand.manage + partners.view', () => {
    expect(customerActsOf({ tasks: true, supervisor: true }, 3)).toEqual([
      { id: 'task', order: 10, held: null },
      { id: 'supervisor', order: 20, held: null },
    ])
    expect(customerActsOf({ tasks: false, supervisor: true }, 3).map((act) => act.id)).toEqual(['supervisor'])
    expect(customerActsOf({ tasks: false, supervisor: false }, 3)).toEqual([])
  })
  it('more than the cap: held with its numbers (tasks 100 per batch, the supervisor 50 at a time)', () => {
    expect(customerActsOf({ tasks: true, supervisor: true }, 101)).toEqual([
      { id: 'task', order: 10, held: { max: 100 } },
      { id: 'supervisor', order: 20, held: { max: 50 } },
    ])
    expect(customerActsOf({ tasks: true, supervisor: true }, 51)[0]!.held).toBeNull()
  })
})

describe('F-CL-104: Set production supervisor for N… — runs on, not on with why, the receipt, run the rest again', () => {
  const mario = { id: 'u-mario', name: 'Mario Production', active: true }
  const anna = { id: 'u-anna', name: 'Anna Office', active: true }
  const targets: SupervisorTarget[] = [
    { id: 'p1', name: 'Seed Racing', state: 'read', version: 3, supervisor: null, backup: null },
    { id: 'p2', name: 'Seed Moto Club', state: 'read', version: 5, supervisor: mario, backup: anna },
    { id: 'p3', name: 'Seed Track Days', state: 'read', version: 1, supervisor: anna, backup: mario },
    { id: 'p4', name: 'Seed Customer Four', state: 'unread', why: { ns: 'customers-list', key: 'supervisor.notReached' } },
  ]
  it('before the pick every read customer runs; after it, "already this person" leaves one out (with the name)', () => {
    expect(supervisorPlanOf(targets, null).runs.map((target) => target.id)).toEqual(['p1', 'p2', 'p3'])
    const plan = supervisorPlanOf(targets, mario.id)
    expect(plan.runs.map((target) => target.id)).toEqual(['p1', 'p3'])
    expect(plan.notOn).toEqual([
      { id: 'p2', name: 'Seed Moto Club', why: { ns: 'customers-list', key: 'supervisor.already', params: { name: 'Mario Production' } }, already: true },
      { id: 'p4', name: 'Seed Customer Four', why: { ns: 'customers-list', key: 'supervisor.notReached' }, already: false },
    ])
  })
  it('each write sends the version read and keeps the backup — never the pick as its own backup', () => {
    const plan = supervisorPlanOf(targets, mario.id)
    expect(supervisorBodyOf(plan.runs[0]!, mario.id)).toEqual({ supervisorId: 'u-mario', backupId: null, version: 3 })
    expect(supervisorBodyOf(plan.runs[1]!, mario.id)).toEqual({ supervisorId: 'u-mario', backupId: null, version: 1 })
    expect(supervisorBodyOf({ id: 'p9', name: 'X', state: 'read', version: 7, supervisor: null, backup: anna }, mario.id)).toEqual({ supervisorId: 'u-mario', backupId: 'u-anna', version: 7 })
  })
  it('the receipt: done, already so, not run, left out; the rest again = stopped + refused', () => {
    const plan = supervisorPlanOf(targets, mario.id)
    const outcomes = { p1: { kind: 'done' as const }, p3: { kind: 'notRun' as const } }
    expect(supervisorSummaryOf(plan, outcomes)).toEqual({ done: 1, same: 1, notRun: 1, left: 1 })
    expect(supervisorRestOf(plan, outcomes)).toEqual(['p3'])
    const refused = { p1: { kind: 'failed' as const, why: { ns: 'production-supervisor' as const, key: 'skip.NO_REACH' } }, p3: { kind: 'done' as const } }
    expect(supervisorSummaryOf(plan, refused)).toEqual({ done: 1, same: 1, notRun: 0, left: 2 })
    expect(supervisorRestOf(plan, refused)).toEqual(['p1'])
  })
})

// ---- F-CL-201: the reads — the band asks what the list asks, minus its own door, order and page (K2) -----------------------------
import { partyQueryParams } from '../../../parties/_shared/api'
import { bandTermsOf, listQueryOf, SIDES, sortOf, viewQuery, workOf } from '../../../parties/_shared/model'
import { customerSortOf } from './model'

describe('F-CL-201: the band query, the order and the door in the address', () => {
  it('the band query is the list query minus work, sort, cursor and limit (so a band number is the rows its press shows)', () => {
    const terms = viewQuery(SIDES.customers, 'active', { kind: 'ORGANISATION' }, 'seed')
    const list = { ...listQueryOf(terms, 'needs', 'NOT_SENT'), cursor: 'abc', limit: 50 }
    expect(list).toMatchObject({ sort: 'needs', work: 'NOT_SENT', statuses: ['ACTIVE'], kind: 'ORGANISATION', q: 'seed' })
    expect(bandTermsOf(list)).toEqual(terms)
    expect(partyQueryParams({ ...bandTermsOf(list), limit: 1, band: true })).toMatchObject({ band: 'true', limit: 1, work: undefined, sort: undefined, status: 'ACTIVE' })
    // Code is the API's own order: never sent (a reader without orders.view may ask for it).
    expect(listQueryOf(terms, 'code', null)).toEqual(terms)
    expect(listQueryOf(terms, 'name', null)).toMatchObject({ sort: 'name' })
  })

  it('the order from the address: a known choice, else the fallback (never written when it is the fallback)', () => {
    const withOrders = customerSortOf({ orders: true })
    const without = customerSortOf({ orders: false })
    expect(withOrders).toEqual({ choices: ['needs', 'code', 'name'], fallback: 'needs' })
    expect(without).toEqual({ choices: ['code', 'name'], fallback: 'code' })
    expect(sortOf(null, withOrders)).toBe('needs')
    expect(sortOf('name', withOrders)).toBe('name')
    expect(sortOf('nope', withOrders)).toBe('needs')
    // Without orders.view "needs" is no choice: the address cannot ask for it.
    expect(sortOf('needs', without)).toBe('code')
    const page = readFileSync(new URL('../../../parties/_shared/PartiesList.tsx', import.meta.url), 'utf8')
    expect(page).toContain("if (sort && nextSort && nextSort !== sort.fallback) search.set('sort', nextSort)")
  })

  it('the door in the address: a known group or none; pressing and clearing it is one write of the address', () => {
    expect(workOf('NOT_SENT')).toBe('NOT_SENT')
    expect(workOf('NEEDS_US')).toBe('NEEDS_US')
    expect(workOf('CANCELLED')).toBeNull()
    expect(workOf(null)).toBeNull()
    const page = readFileSync(new URL('../../../parties/_shared/PartiesList.tsx', import.meta.url), 'utf8')
    expect(page).toContain('writeAddress({ work: next })')
    expect(page).toContain("if (workTerm && nextWork) search.set('work', nextWork)")
  })
})

// ---- F-CL-202: the band, the work cells, the doors, Overdue read whole ------------------------------------------------------------
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { vi } from 'vitest'
import { createApiClient } from '../../../../lib/api/client'
import { DOCK_PARAM, dockOnTab, dockTermOf, phaseDoor } from '../record/use-customer-work' // F-CL-301: + the dock's term
import { showsOnArrival } from '../../../_shared/record-frame/model' // F-CL-301
import { phasePhrase } from '../../orders/list/sheet/model'
import { getOverdueCustomers } from '../money/api'
import type { CustomerWork } from './api'
import { workDoor } from './doors'
import { bandGroupsOf, foldOf, groupWordOf, needsChipsOf, nextPromiseOf, workChipsOf } from './model'
import { factsState } from './view/cells'

const WORK: CustomerWork = {
  partyId: 'p1',
  orders: 12,
  phases: [
    { phase: 'NOT_SENT', count: 2 },
    { phase: 'NOT_STARTED', count: 1 },
    { phase: 'IN_PRODUCTION', count: 4 },
    { phase: 'READY', count: 0 },
    { phase: 'SHIPPED', count: 1 },
    { phase: 'DONE', count: 3 },
    { phase: 'CANCELLED', count: 1 },
  ],
  late: 1,
  waitsForYes: 1,
  depositOpen: 2,
  requests: { open: 2, firstId: 'r-1' },
  replies: 1,
  customerUrgent: { count: 1, byCompany: [{ companyId: 'c1', count: 1 }] },
  priority: { top: 1, high: 0 },
  nextPromise: '2026-11-27',
  lastOrderDate: '2026-11-20',
  newestOrder: { id: 'o-9', number: 'SEED-SO-0012' },
  beforeOrder: { toAnswer: 1, openQuotes: 2 },
}
const ZERO: CustomerWork = { ...WORK, orders: 0, phases: WORK.phases.map((entry) => ({ ...entry, count: 0 })), late: 0, waitsForYes: 0, depositOpen: 0, requests: { open: 0, firstId: null }, replies: 0, customerUrgent: { count: 0, byCompany: [] }, priority: { top: 0, high: 0 }, nextPromise: null, newestOrder: null, beforeOrder: {} }

describe('F-CL-202: every count is a door to exactly what it counts', () => {
  const door = (term: Parameters<typeof workDoor>[2]) => workDoor('/w/DEMO', 'p1', term)
  it('the Work tab on that group, late, waiting for a yes, deposit open, the customer’s urgency, our priority', () => {
    for (const phase of ['NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE'] as const) {
      expect(door({ kind: 'phase', phase })).toBe(`/w/DEMO/sales/customers/p1?tab=work&phase=${phase}`)
      // The same address as the Work tab's own phase door (cw W1).
      expect(door({ kind: 'phase', phase })).toBe(phaseDoor('/w/DEMO/sales/customers/p1', phase))
    }
    expect(door({ kind: 'late' })).toBe('/w/DEMO/sales/customers/p1?tab=work&late=true')
    expect(door({ kind: 'waitsForYes' })).toBe('/w/DEMO/sales/customers/p1?tab=work&status=PENDING_APPROVAL')
    expect(door({ kind: 'deposit' })).toBe('/w/DEMO/sales/customers/p1?tab=work&deposit=OPEN')
    expect(door({ kind: 'customerUrgent' })).toBe('/w/DEMO/sales/customers/p1?tab=work&customerUrgency=URGENT')
    expect(door({ kind: 'priority', level: 'URGENT' })).toBe('/w/DEMO/sales/customers/p1?tab=work&rows=open&priority=URGENT')
    expect(door({ kind: 'priority', level: 'HIGH' })).toBe('/w/DEMO/sales/customers/p1?tab=work&rows=open&priority=HIGH')
  })
  it('requests open the review window on the first one; replies the thread’s All; to answer / open quotes their own group', () => {
    expect(door({ kind: 'requests', firstId: 'r-1' })).toBe('/w/DEMO/sales/customers/p1?tab=work&open=r-1')
    expect(door({ kind: 'requests', firstId: null })).toBe('/w/DEMO/sales/customers/p1?tab=work')
    // F-CL-301 (walk W-3): All of <customer> in the dock (the customer page's own term), the thread shown on arrival, the Work tab.
    expect(door({ kind: 'replies' })).toBe('/w/DEMO/sales/customers/p1?tab=work&dock=all&thread=open')
    const replies = new URL(door({ kind: 'replies' }), 'https://factory.example.com')
    expect(dockTermOf(replies.searchParams.get(DOCK_PARAM))).toEqual({ kind: 'all' })
    expect(dockOnTab('work', dockTermOf(replies.searchParams.get(DOCK_PARAM)))).toEqual({ kind: 'all' })
    expect(showsOnArrival(replies.search)).toBe(true)
    expect(door({ kind: 'quotes', group: 'TO_ANSWER' })).toBe('/w/DEMO/sales/customers/p1?tab=quotes&group=TO_ANSWER')
    expect(door({ kind: 'quotes', group: 'OPEN_QUOTES' })).toBe('/w/DEMO/sales/customers/p1?tab=quotes&group=OPEN_QUOTES')
    expect(door({ kind: 'work' })).toBe('/w/DEMO/sales/customers/p1?tab=work')
  })
})

describe('F-CL-202: the chips — strongest first, zero no chip, the Work tab’s words; the fold at two lines', () => {
  it('Needs us: requests · to answer · replies · late · waiting for a yes · the customer’s urgent · Top · then deposit, quiet', () => {
    const chips = needsChipsOf(WORK)
    expect(chips.map((chip) => chip.id)).toEqual(['requests', 'toAnswer', 'replies', 'late', 'waitsForYes', 'customerUrgent', 'top', 'deposit'])
    expect(chips.find((chip) => chip.id === 'deposit')?.tone).toBe('quiet')
    expect(chips.find((chip) => chip.id === 'late')?.tone).toBe('red')
    // A part without its right is absent (replies withheld, no before-order counts): never a 0 chip.
    expect(needsChipsOf({ ...WORK, replies: null, beforeOrder: {} }).map((chip) => chip.id)).not.toContain('replies')
    expect(needsChipsOf(ZERO)).toEqual([])
  })
  it('Work: open quotes, then the groups in the Work tab’s order, non-zero only; Done quiet; Cancelled never', () => {
    const chips = workChipsOf(WORK)
    expect(chips.map((chip) => chip.id)).toEqual(['openQuotes', 'NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'SHIPPED', 'DONE'])
    expect(chips.at(-1)?.tone).toBe('done')
    expect(workChipsOf(ZERO)).toEqual([])
    // One word per phase: the Work tab's own (its phasePhrase).
    for (const phase of ['NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE'] as const) expect(groupWordOf(phase).key).toBe(phasePhrase(phase).key)
    expect(groupWordOf('NEEDS_US')).toEqual({ ns: 'customers-list', key: 'band.needsNow' })
  })
  it('the fold keeps what two lines hold and leaves room for "+n more"', () => {
    expect(foldOf([100, 100, 100], 250, 40)).toBe(3)
    expect(foldOf([100, 100, 100, 100, 100], 250, 40)).toBe(4)
    expect(foldOf([100, 100, 100, 100, 100], 250, 60)).toBe(3)
    expect(foldOf([120, 120, 120], 250, 40, 1)).toBe(1)
    expect(foldOf([], 250, 40)).toBe(0)
  })
})

describe('F-CL-202: Next promise and the cells without facts', () => {
  it('never a past date; "No promise ahead" with open orders; "No open order"; "—" without an order', () => {
    expect(nextPromiseOf(WORK, '2026-11-24')).toEqual({ kind: 'date', date: '2026-11-27', days: 3 })
    expect(nextPromiseOf(WORK, '2026-11-27')).toEqual({ kind: 'date', date: '2026-11-27', days: 0 })
    expect(nextPromiseOf({ ...WORK, nextPromise: '2026-11-20' }, '2026-11-24')).toEqual({ kind: 'noneAhead' })
    expect(nextPromiseOf({ ...WORK, nextPromise: null, phases: [{ phase: 'DONE', count: 3 }] }, '2026-11-24')).toEqual({ kind: 'noOpen' })
    expect(nextPromiseOf(ZERO, '2026-11-24')).toEqual({ kind: 'none' })
  })
  it('a customer the reader’s orders.view does not reach says "—", never "No order yet" (T13); a failed read says so in words', () => {
    const words = { c: (key: string) => key, p: (key: string) => key, ord: (key: string) => key, sheet: (key: string) => key, levels: (key: string) => key, more: (key: string) => key }
    const html = (node: ReturnType<typeof factsState>) => renderToString(createElement('div', null, node))
    expect(html(factsState({ work: undefined, reading: false, problem: null, words }))).toContain('—')
    expect(html(factsState({ work: undefined, reading: false, problem: 'problem.unavailable', words }))).toContain('cell.failed')
    expect(factsState({ work: ZERO, reading: false, problem: null, words })).toBeNull()
  })
  it('the band: seven groups in order, a group the answer lacks is a quiet 0, Cancelled never', () => {
    const groups = bandGroupsOf({ groups: [{ group: 'IN_PRODUCTION', customers: 8, orders: 14 }], needsUs: { requests: 0, replies: 0, late: 0, repliesComplete: true }, notSent: { waitsForYes: 0, waitsForDeposit: 0 }, limited: false })
    expect(groups.map((entry) => entry.group)).toEqual(['NEEDS_US', 'NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE'])
    expect(groups.find((entry) => entry.group === 'IN_PRODUCTION')).toEqual({ group: 'IN_PRODUCTION', customers: 8, orders: 14 })
    expect(groups.find((entry) => entry.group === 'NEEDS_US')).toEqual({ group: 'NEEDS_US', customers: 0, orders: null })
  })
})

describe('F-CL-202 (C1-B1): Overdue read whole — every company, every page (at most 5)', () => {
  const page = (next: number | null) => ({ asOf: '2026-11-23', readAt: '2026-11-23T08:00:00.000Z', tiles: [], customers: [], count: 0, next })
  it('follows `next` and sends no company', async () => {
    const answers = [page(1), page(null)]
    const fetch = vi.fn(async () => new Response(JSON.stringify(answers.shift()), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
    const read = await getOverdueCustomers(api)
    expect(read.complete).toBe(true)
    const urls = fetch.mock.calls.map((call) => String((call as unknown as [string])[0]))
    expect(urls).toHaveLength(2)
    expect(urls.every((url) => !url.includes('companyId'))).toBe(true)
    expect(urls[1]).toContain('cursor=1')
  })
  it('stops after 5 pages and says the read is not whole', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(page(1)), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
    expect((await getOverdueCustomers(api)).complete).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})

// ---- F-CL-203: Most urgent first, the capped notice, the final phone card ---------------------------------------------------------
import { sortCapped } from '../../../parties/_shared/model'

describe('F-CL-203: Sort ▾ and the phone card', () => {
  it('the server’s cap is said when it kept the code order; the asked order says nothing', () => {
    expect(sortCapped({ value: 'needs', sortedBy: 'code' })).toBe(true)
    expect(sortCapped({ value: 'needs', sortedBy: 'needs' })).toBe(false)
    expect(sortCapped({ value: 'name', sortedBy: null })).toBe(false)
  })

  it('the card: picture and Customer as the title, then ≤ 2 Needs us chips, ONE line of Work, the next promise; the thread door beside', () => {
    const facts = { byParty: new Map([[row('MODA-DEMO').id, WORK]]), problem: null, repliesComplete: true, limited: false }
    const built = customerColumnsOf({ prefix: '/w/DEMO', unread: {}, overdue: [{ colId: 'overdue', headerName: 'Overdue' }], work: facts, today: '2026-11-24', wide: true }, words, words)
    const columns = [...built.beforeName, built.nameColumn, ...built.leadingColumns, { colId: 'actions', headerName: '', pinned: 'right' } as ColDef<PartyRow>]
    expect(columns.map((column) => column.colId)).toEqual(['picture', 'name', 'needs', 'work', 'nextPromise', 'lastOrder', 'overdue', 'messages', 'actions'])
    const fields = cardFieldsOf(columns, built.card)
    expect(fields.map((field) => [field.id, field.role])).toEqual([
      ['name', 'title'],
      ['needs', 'subtitle'],
      ['work', 'subtitle'],
      ['nextPromise', 'subtitle'],
      ['overdue', 'field'],
      ['messages', 'aside'],
      ['actions', 'actions'],
    ])
    // At 1440 (not wide) Last order and Overdue wait in Customise; the work columns show at first.
    const narrow = customerColumnsOf({ prefix: '/w/DEMO', unread: {}, work: facts, today: '2026-11-24' }, words, words)
    expect(narrow.hiddenColumns).toEqual(expect.arrayContaining(['lastOrder', 'overdue']))
    expect(narrow.hiddenColumns).not.toContain('needs')
  })

  it('F-CL-301 (walk W-2): no cut header — Picture whole in a wider column with narrow sides; New messages the message mark, its name kept', () => {
    const facts = { byParty: new Map([[row('MODA-DEMO').id, WORK]]), problem: null, repliesComplete: true, limited: false }
    const built = customerColumnsOf({ prefix: '/w/DEMO', unread: {}, work: facts, today: '2026-11-24' }, words, words)
    const picture = built.beforeName.find((column) => column.colId === 'picture')!
    expect(picture.width).toBeGreaterThanOrEqual(80)
    expect(picture.minWidth).toBeGreaterThanOrEqual(80)
    expect([picture.headerClass, picture.cellClass]).toEqual(['fw-cl-tight', 'fw-cl-tight'])
    const messages = built.leadingColumns.find((column) => column.colId === 'messages')!
    expect(messages.headerName).toBe('column')
    expect(messages.headerComponentParams).toEqual({ innerHeaderComponent: MessagesHeader })
    expect(messages.suppressHeaderMenuButton).toBe(true)
  })
})

// ---- every word the folder names, in both languages (the shape of parties.vitest.test.ts :391) ---------------------------------
const HERE = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '_demo' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}
const SHARED = [fileURLToPath(new URL('../../../parties/_shared/view/PartiesListView.tsx', import.meta.url)), fileURLToPath(new URL('../../../parties/_shared/view/dialogs.tsx', import.meta.url))]

describe('every customers-list word the code names exists in it and en', () => {
  it('the `c(…)` keys of the folder and of the shared list, with the same placeholders', () => {
    const keys = new Set<string>(['office.VIES', 'office.SDI', 'office.TAX', 'needs.toAnswer', 'band.needsNow' /* F-CL-202: named through groupWordOf / needsChipsOf */, ...['records', 'one', 'neverWho', 'never', 'where'].map((key) => `task.${key}`) /* F-CL-301: the task window reads them under its prefix */, ...['needs', 'needsHint', 'code', 'codeHint', 'name'].map((key) => `sort.${key}`) /* F-CL-203: Sort ▾ by its choices */])
    for (const file of [...sources(HERE), ...SHARED]) for (const match of readFileSync(file, 'utf8').matchAll(/\bc\(['"`]([A-Za-z0-9_.]+)['"`]/g)) keys.add(match[1]!)
    expect(keys.size).toBeGreaterThan(8)
    for (const key of keys) {
      for (const locale of LOCALES) {
        const dictionary = CATALOGUE[locale]['customers-list'] ?? {}
        expect(key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary), `${locale} ${key}`).toBe(true)
      }
      const en = CATALOGUE.en['customers-list']?.[key] ?? CATALOGUE.en['customers-list']?.[`${key}_other`] ?? ''
      const it = CATALOGUE.it['customers-list']?.[key] ?? CATALOGUE.it['customers-list']?.[`${key}_other`] ?? ''
      expect((it.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((en.match(/\{\w+\}/g) ?? []).sort())
    }
  })
})

// F-CL-202: the words the band and the chips reuse from other catalogues (one word per thing) exist in both languages.
describe('F-CL-202: the reused words of the band and the chips exist in it and en', () => {
  it('parties, orders, the sheet, the levels, "+n more"', () => {
    const reused: Readonly<Record<string, readonly string[]>> = {
      parties: ['customers.work.tile.requests', 'customers.work.tile.replies', 'customers.work.tile.late', 'customers.work.tile.deposit', 'numbers.openQuotes', 'customers.work.band.why.yes_one', 'customers.work.band.why.yes_other', 'customers.work.band.why.deposit_one', 'customers.work.band.why.deposit_other', 'customers.tab.work', 'customers.intro'],
      orders: ['rows.PENDING_APPROVAL', 'rows.IN_PRODUCTION', 'rows.READY', 'rows.SHIPPED'],
      'orders-sheet': ['urgency.bare', 'urgency.priority', 'phase.NOT_SENT', 'phase.NOT_STARTED', 'phase.DONE', 'col.picture'],
      'sales-orders-depth': ['priority.level.URGENT', 'priority.level.HIGH'],
      'home-tasks': ['batch.more'],
    }
    for (const locale of LOCALES) for (const [ns, keys] of Object.entries(reused)) for (const key of keys) expect(CATALOGUE[locale][ns]?.[key], `${locale} ${ns} ${key}`).toBeTruthy()
  })
})


// ---- T.1 (customers list 13-backend §8.10): the gallery — the busy list, its band and work, each role's bar, each window step ------
import type { ComponentType } from 'react'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as customersScreen } from '../fixtures'

describe('T.1: the gallery draws the list’s states, both languages, the walls kept', () => {
  const screen = customersScreen as DesignScreen<unknown>
  const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
    const item = screen.cases.find((entry) => entry.id === id)
    expect(item, id).toBeDefined()
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: item!.model })))
  }

  it('keeps every pinned case and adds the busy list, the band doors, the roles’ bars and the windows', () => {
    const ids = screen.cases.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining(['list', 'loading', 'error', 'empty', 'filtered-empty', 'no-access', 'read-only', 'selection', 'new', 'block', 'archive']))
    expect(ids).toEqual(expect.arrayContaining(['busy', 'busy-wide', 'band-pressed', 'band-pressed-empty', 'view-zero', 'search-none', 'limited', 'band-failed', 'sort-code', 'sort-capped', 'customise']))
    expect(ids).toEqual(expect.arrayContaining(['bar-owner', 'bar-sales', 'bar-finance', 'bar-pm', 'bar-warehouse', 'bar-readonly', 'task', 'task-r47', 'task-one', 'sup-read', 'sup-pick', 'sup-running', 'sup-done', 'block-noton', 'archive-noton', 'bulk-receipt']))
    expect(ids).toEqual(expect.arrayContaining(['view-vies', 'view-invoice']))
    expect(ids).not.toContain('tile-vies')
    expect(ids).not.toContain('shortcuts')
  })

  it('the busy list: the band in the head row and Most urgent first, in both languages', () => {
    const en = draw('busy')
    expect(en).toContain('All customers')
    expect(en).toContain('Needs us now')
    expect(en).toContain('Most urgent first')
    const it = draw('busy', 'it')
    expect(it).toContain('Tutti i clienti')
    expect(it).toContain('Da seguire ora')
    expect(it).toContain('Prima i più urgenti')
  })

  it('the limited reader reads “Your customers”; a pressed door with nobody, a view with 0 rows and the cap say their own words', () => {
    expect(draw('limited')).toContain('Your customers')
    expect(draw('band-pressed-empty')).toContain('No customer needs us now.')
    expect(draw('view-zero')).toContain('No blocked customers.')
    expect(draw('sort-capped')).toContain('More than 2 000 customers')
  })

  it('each role’s bar holds only its own acts; Read-only says so in words; Sales sees no amount', () => {
    const owner = draw('bar-owner')
    expect(owner).toContain('Add task to 6 customers…')
    expect(owner).toContain('Set production supervisor for 6…')
    const sales = draw('bar-sales')
    expect(sales).toContain('Add task to 6 customers…')
    expect(sales).not.toContain('Set production supervisor for 6…')
    expect(sales).not.toMatch(/€/)
    expect(draw('bar-warehouse')).not.toContain('Check VIES')
    expect(draw('bar-readonly')).toContain('Your role reads customers and changes none')
  })
})
