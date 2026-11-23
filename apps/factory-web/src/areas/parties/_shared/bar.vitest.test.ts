import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { customerRightsOf } from '../../sales/customers/list/model'
import { barOf, SHARED_ORDER, sharedActsOf, whyNotOf } from './bar'
import { CUSTOMERS, rowOf } from './fixtures'
import { listCanOf } from './model'

/**
 * F-CL-103 (customers list plan §1, 13-backend §8.2, settles T8 / T9 / T16): the bar of a selection READS like the Work tab's — at
 * most 3 buttons with words (two acts, Export N always third), the rest in More ▾; an act without its right is not drawn; a held
 * act stays where its order puts it. Rights per role from the role templates (C3 §1a).
 */

const ROLES: Readonly<Record<string, readonly string[]>> = {
  owner: ['parties.view', 'parties.manage', 'parties.block', 'parties.vies', 'tasks.manage', 'threads.post', 'production.brand.manage', 'partners.view', 'views.export'],
  sales: ['parties.view', 'parties.manage', 'parties.vies', 'tasks.manage', 'threads.post', 'partners.view', 'views.export'],
  finance: ['parties.view', 'parties.manage', 'parties.block', 'parties.vies', 'tasks.manage', 'threads.post', 'views.export'],
  productionManager: ['parties.view', 'tasks.manage', 'threads.post', 'production.brand.manage', 'partners.view', 'views.export'],
  planner: ['parties.view', 'tasks.manage', 'threads.post', 'production.brand.manage', 'views.export'],
  warehouse: ['parties.view', 'tasks.manage', 'threads.post', 'views.export'],
  readOnly: ['parties.view', 'partners.view'],
}
const row = (code: string) => rowOf(CUSTOMERS.find((item) => item.code === code)!)
const TICKED = [row('DE-BEISPIEL'), row('MODA-DEMO'), row('NUOVO-PROVA')]

/** The customers' own acts as the host gives them (each by its own right): Add task 10, Set supervisor 20. */
function customersBar(role: string, rows = TICKED) {
  const permissions = ROLES[role]!
  const can = listCanOf(permissions)
  const rights = customerRightsOf(permissions)
  const own = [...(rights.tasks ? [{ id: 'task', order: 10 }] : []), ...(rights.supervisor ? [{ id: 'supervisor', order: 20 }] : [])]
  const bar = barOf([...own, ...sharedActsOf('customers', can, rows)], can.export === true)
  return { promoted: bar.promoted.map((act) => act.id), more: bar.more.map((act) => act.id), exportShown: can.export === true }
}

describe('F-CL-103: the bar per role — two acts, Export N third, the rest in More ▾', () => {
  it('Owner: Add task · Set supervisor · Export · More ▾ (VIES · Block · Archive)', () => {
    expect(customersBar('owner')).toEqual({ promoted: ['task', 'supervisor'], more: ['vies', 'block', 'archive'], exportShown: true })
  })
  it('Sales: Add task · Check VIES · Export · More ▾ (Archive) — no Block (no parties.block), no supervisor (no production right)', () => {
    expect(customersBar('sales')).toEqual({ promoted: ['task', 'vies'], more: ['archive'], exportShown: true })
  })
  it('Finance: Add task · Check VIES · Export · More ▾ (Block · Archive)', () => {
    expect(customersBar('finance')).toEqual({ promoted: ['task', 'vies'], more: ['block', 'archive'], exportShown: true })
  })
  it('Production manager: Add task · Set supervisor · Export; Planner and Warehouse: Add task · Export', () => {
    expect(customersBar('productionManager')).toEqual({ promoted: ['task', 'supervisor'], more: [], exportShown: true })
    expect(customersBar('planner')).toEqual({ promoted: ['task'], more: [], exportShown: true })
    expect(customersBar('warehouse')).toEqual({ promoted: ['task'], more: [], exportShown: true })
  })
  it('Read-only: no act at all (the bar says so in words), no Export', () => {
    expect(customersBar('readOnly')).toEqual({ promoted: [], more: [], exportShown: false })
  })
  it('Suppliers keep their order: Check VIES · Request documents · Export · More ▾ (Block · Archive)', () => {
    const can = listCanOf(ROLES.owner!)
    const bar = barOf([{ id: 'request', order: 20 }, ...sharedActsOf('suppliers', can, TICKED)], true)
    expect(bar.promoted.map((act) => act.id)).toEqual(['vies', 'request'])
    expect(bar.more.map((act) => act.id)).toEqual(['block', 'archive'])
    expect(SHARED_ORDER.suppliers.vies).toBeLessThan(20)
  })
})

describe('F-CL-103: Export always third; a held act keeps its place; never "… for 0"', () => {
  const acts = [{ id: 'c', order: 30 }, { id: 'a', order: 10 }, { id: 'd', order: 40 }, { id: 'b', order: 20 }]
  it('two promoted beside Export N; without Export a third act moves up; More ▾ in order', () => {
    expect(barOf(acts, true)).toEqual({ promoted: [{ id: 'a', order: 10 }, { id: 'b', order: 20 }], more: [{ id: 'c', order: 30 }, { id: 'd', order: 40 }] })
    expect(barOf(acts, false).promoted.map((act) => act.id)).toEqual(['a', 'b', 'c'])
    expect(barOf([], true)).toEqual({ promoted: [], more: [] })
  })
  it('a reach of 0 stays, held with words, where its order puts it (settle T8)', () => {
    const can = listCanOf(ROLES.owner!)
    const shared = sharedActsOf('customers', can, [row('MODA-DEMO')])
    const vies = shared.find((act) => act.id === 'vies')!
    expect(vies.reach).toEqual([])
    expect(vies.held).toEqual({ key: 'held.noEuNumber' })
    expect(shared.map((act) => act.id)).toEqual(['vies', 'block', 'archive'])
    // More than the cap: held with the cap's words.
    const many = Array.from({ length: 51 }, (_, index) => ({ ...row('MODA-DEMO'), id: `p${index}` }))
    expect(sharedActsOf('customers', can, many).find((act) => act.id === 'block')!.held).toEqual({ key: 'held.bulkMax', params: { max: 50 } })
  })
  it('each act reads its own right: VIES parties.vies, Block parties.block, Archive parties.manage', () => {
    expect(sharedActsOf('customers', { view: true, manage: false, block: false, vies: true }, TICKED).map((act) => act.id)).toEqual(['vies'])
    expect(sharedActsOf('customers', { view: true, manage: true, block: false, vies: false }, TICKED).map((act) => act.id)).toEqual(['archive'])
    expect(sharedActsOf('customers', { view: true, manage: false, block: false, vies: false }, TICKED)).toEqual([])
  })
})

describe('F-CL-103: "Not on N" — each left-out row says why (C3-B3)', () => {
  it('in the parties’ own words where they exist, else the list’s', () => {
    expect(whyNotOf('vies', 'customers', { status: 'ACTIVE' })).toEqual({ ns: 'customers-list', key: 'p2.why.noNumber' })
    expect(whyNotOf('vies', 'customers', { status: 'ARCHIVED' })).toEqual({ ns: 'parties', key: 'held.archived' })
    expect(whyNotOf('block', 'customers', { status: 'PROSPECT' })).toEqual({ ns: 'customers-list', key: 'p2.why.prospect.customers' })
    expect(whyNotOf('block', 'suppliers', { status: 'PROSPECT' })).toEqual({ ns: 'customers-list', key: 'p2.why.prospect.suppliers' })
    expect(whyNotOf('block', 'customers', { status: 'BLOCKED' })).toEqual({ ns: 'customers-list', key: 'p2.why.blocked' })
    expect(whyNotOf('archive', 'customers', { status: 'BLOCKED' })).toEqual({ ns: 'parties', key: 'held.archiveBlocked' })
    expect(whyNotOf('archive', 'customers', { status: 'ARCHIVED' })).toEqual({ ns: 'customers-list', key: 'p2.why.archived' })
  })

  it('every word of the bar and the P2 window exists in it and en (the Orders sheet’s P2 words read as they are)', () => {
    const sheet = ['commands.runs_one', 'commands.runs_other', 'commands.notOn_one', 'commands.notOn_other', 'commands.many.runRest_one', 'commands.many.runRest_other']
    const list = ['bar.more', 'bar.none.customers', 'bar.none.suppliers', 'p2.why.noNumber', 'p2.why.blocked', 'p2.why.archived', 'p2.why.prospect.customers', 'p2.why.prospect.suppliers', 'p2.each.customers', 'p2.each.suppliers', 'p2.door.customers', 'p2.door.suppliers']
    const parties = ['held.archived', 'held.archiveBlocked', 'held.noEuNumber', 'held.nothingToBlock', 'held.nothingToArchive', 'held.bulkMax', 'row.checkVies', 'row.block', 'row.archive']
    for (const locale of LOCALES) {
      for (const key of sheet) expect(CATALOGUE[locale]['orders-sheet']?.[key], `${locale} orders-sheet ${key}`).toBeTruthy()
      for (const key of list) expect(CATALOGUE[locale]['customers-list']?.[key], `${locale} customers-list ${key}`).toBeTruthy()
      for (const key of parties) expect(CATALOGUE[locale].parties?.[key], `${locale} parties ${key}`).toBeTruthy()
    }
  })
})
