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
    const built = customerColumnsOf({ prefix: '/w/DEMO', unread, overdue }, words, words)
    const all = [built.nameColumn.colId, ...built.leadingColumns.map((column) => column.colId), ...CUSTOMER_HIDDEN_COLUMNS, 'actions']
    expect(all.filter((id) => !built.hiddenColumns.includes(id!))).toEqual(['name', 'overdue', 'messages', 'actions'])
  })

  it('the card: the Customer cell is the title, the thread door beside it, the row’s ⋯ its actions, Overdue a line', () => {
    const built = customerColumnsOf({ prefix: '/w/DEMO', unread, overdue }, words, words)
    const fields = cardFieldsOf([built.nameColumn, ...built.leadingColumns, actions], built.card)
    expect(Object.fromEntries(fields.map((field) => [field.id, field.role]))).toEqual({ name: 'title', overdue: 'field', messages: 'aside', actions: 'actions' })
    expect(CARD_ROLES).toEqual({ name: 'title', messages: 'aside', overdue: 'field' })
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
    const keys = new Set<string>(['office.VIES', 'office.SDI', 'office.TAX'])
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
