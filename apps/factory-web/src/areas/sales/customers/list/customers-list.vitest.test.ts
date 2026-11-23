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
import { CARD_ROLES, CUSTOMER_HIDDEN_COLUMNS, customerRightsOf, officeDataOf } from './model'

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
