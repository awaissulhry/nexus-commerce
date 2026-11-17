import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { listHref } from '../../reports/model'
import { getBoard, listOrderCustomers, listOrders, type OrderCustomer } from '../api'
import { listPromiseLines } from '../depth/api'
import { laneQuery, listAddress, partyFromAddress, rowsQuery } from '../model'
import { NAMESPACE, switcherFace, switcherLines, type SwitcherState } from './sheet/model'

/**
 * B-TH-226 (threads plan TH-1a, picture 24; SHEET.switcher-F01…F04, X-SAL-REPORTS.drill-F01; wall W18, W19, W27, W30): the
 * Customer switcher — `?party=` drives every read (the rows, each board lane, the tiles, By promise week) and the export (its
 * query is the page's address); "All customers", "All my customers (n)" for a reader limited to some, a fixed label for one, a
 * customer that is not available named by no one; the lines recent first; Sales › Reports' drill lands on it.
 */

const A = '0190a1b2-0000-7000-8000-00000000000a'
const B = '0190a1b2-0000-7000-8000-00000000000b'
const customer = (id: string, name: string, open = 2, late = 0): OrderCustomer => ({ id, code: name.toUpperCase(), name, archived: false, orders: open + 1, open, late, lastOrderDate: '2026-11-10' })
const state = (customers: OrderCustomer[] | null, over: Partial<SwitcherState> = {}): SwitcherState => ({ customers, total: customers?.length ?? 0, limited: false, problem: null, ...over })

describe('?party= drives every read and the export', () => {
  const recorder = () => {
    const calls: Array<{ path: string; query: Record<string, unknown> }> = []
    const api = { get: async (path: string, options?: { query?: Record<string, unknown> }) => (calls.push({ path, query: options?.query ?? {} }), {}) } as unknown as Parameters<typeof listOrders>[0]
    return { api, calls }
  }

  it('the rows, each lane, the tiles and By promise week read that customer; the address keeps it with every view', async () => {
    const { api, calls } = recorder()
    const narrow = { brand: 'own' }
    await listOrders(api, rowsQuery('late', '', null, A, narrow))
    await listOrders(api, laneQuery('READY', 'all', '', A, narrow))
    await getBoard(api, '', undefined, A, narrow)
    await listPromiseLines(api, 'site-1', { q: '', partyId: A })
    expect(calls.map((call) => [call.path, call.query.partyId])).toEqual([
      ['/sales/orders', A],
      ['/sales/orders', A],
      ['/sales/orders/board', A],
      ['/planning/promises', A],
    ])
    expect(calls.slice(0, 3).every((call) => call.query.brand === 'own')).toBe(true)
    // The export's query is the page's address (the frame sends it): the same customer, the same label.
    const address = listAddress('/w/DEMO/sales/orders', { rows: 'late', q: '', layout: 'list', party: A, brand: 'own' })
    expect(new URL(address, 'http://x').searchParams.get('party')).toBe(A)
    expect(partyFromAddress(new URL(address, 'http://x').searchParams)).toBe(A)
  })

  it('the switcher reads the customers (search, company) from GET /sales/orders/customers', async () => {
    const { api, calls } = recorder()
    await listOrderCustomers(api, { q: ' alp ', companyId: B, limit: 50 }).catch(() => undefined)
    expect(calls[0]).toEqual({ path: '/sales/orders/customers', query: { q: 'alp', companyId: B, limit: 50 } })
  })
})

describe('the switcher’s face and lines', () => {
  const t = createTranslator('en', messagesFor('en', [NAMESPACE])[NAMESPACE]!)

  it('All customers; one chosen by name; "All my customers (n)" for a reader limited to some; a fixed label for one', () => {
    const two = [customer(A, 'Brand Alpha'), customer(B, 'Brand Beta')]
    expect(switcherFace(state(two), null, undefined)).toEqual({ kind: 'button', label: { key: 'switcher.all' } })
    expect(switcherFace(state(two), A, undefined)).toEqual({ kind: 'button', label: { key: 'switcher.chosen', params: { name: 'Brand Alpha' } } })
    expect(switcherFace(state(two, { limited: true }), null, undefined)).toEqual({ kind: 'button', label: { key: 'switcher.allMine', params: { count: 2 } } })
    expect(switcherFace(state([two[1]!], { limited: true }), null, undefined)).toEqual({ kind: 'fixed', name: 'Brand Beta' })
    // A reader with every customer who has only one so far keeps the menu (others may come).
    expect(switcherFace(state([two[1]!]), null, undefined).kind).toBe('button')
  })

  it('a customer the reader may not open is named by no one (W27); counts reading say so, never 0; none yet: absent', () => {
    expect(switcherFace(state([customer(B, 'Brand Beta')], { limited: true }), A, null)).toEqual({ kind: 'button', label: { key: 'switcher.unknown' } })
    expect(t('switcher.unknown')).not.toMatch(/Brand/)
    expect(switcherFace(state(null), A, undefined)).toEqual({ kind: 'button', label: { key: 'switcher.reading' } })
    expect(switcherFace(state([], { total: 0 }), null, undefined)).toEqual({ kind: 'hidden' })
  })

  it('"All customers" on top, the two most recent, then the others by name, each once; searched: the matches recent first', () => {
    const recentFirst = [customer(B, 'Zeta Moto'), customer(A, 'Brand Alpha'), customer('c', 'Delta Workwear'), customer('d', 'Beta Riders')]
    const lines = switcherLines(recentFirst, false, { all: 'All', recent: 'Recent', others: 'All (4)' })
    expect(lines.map((line) => [line.value, line.group ?? null])).toEqual([
      ['', null],
      [B, 'Recent'],
      [A, 'Recent'],
      ['d', 'All (4)'],
      ['c', 'All (4)'],
    ])
    expect(switcherLines(recentFirst, true, { all: 'All', recent: 'Recent', others: 'All' }).map((line) => line.value)).toEqual([B, A, 'c', 'd'])
  })

  it('every switcher word in it and en', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
      for (const key of ['switcher.all', 'switcher.allMine', 'switcher.chosen', 'switcher.fixed', 'switcher.unknown', 'switcher.unavailable', 'switcher.showAll', 'switcher.recent', 'switcher.open', 'switcher.late', 'switcher.typeToFind']) expect(words(key, { count: 3, name: 'X', q: 'x' }), `${locale} ${key}`).not.toMatch(/^switcher\.|\{/)
    }
  })
})

describe('Sales › Reports’ drill lands on the switcher (X-SAL-REPORTS.drill-F01)', () => {
  it('Open the list sends the customer’s id: the sheet opens with that customer chosen', () => {
    const href = listHref('/w/DEMO', { section: 'backlog' } as Parameters<typeof listHref>[1], A)
    const address = new URL(href, 'http://x').searchParams
    expect(partyFromAddress(address)).toBe(A)
    expect(address.get('q')).toBeNull()
    expect(switcherFace(state([customer(A, 'Brand Alpha')]), partyFromAddress(address), undefined)).toEqual({ kind: 'button', label: { key: 'switcher.chosen', params: { name: 'Brand Alpha' } } })
  })
})
