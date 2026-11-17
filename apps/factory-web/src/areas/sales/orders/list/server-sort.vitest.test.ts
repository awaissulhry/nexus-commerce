import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { getBoard, listOrders } from '../api'
import { cfFromAddress, columnSort, laneQuery, listAddress, rowsQuery, SORT_CHOICES, SORT_COLUMNS, sortFromAddress, sortOfColumn } from '../model'
import { NAMESPACE } from './sheet/model'

/**
 * B-TH-057 (threads plan TH-4; SHEET-G05, SHEET-G15, ORD-G07; features SHEET.overall-F05, SHEET.brand-fields-F04,
 * O-SAL-ORD-LIST.grid-F13; wall W19): Sales › Orders sorts and filters on the server — the sort (`?sort=`) and the custom field
 * filter (`?cf=`) are terms of the page's address (a saved view and the file keep them), every read sends them, only the
 * columns the server sorts by keep a header sort, and the words exist in it and en. The API's own test is
 * apps/factory-api modules/sales/orders/server-sort.pg (T19: the sorted and filtered file equals the screen).
 */

const recorder = () => {
  const calls: Array<{ path: string; query: Record<string, unknown> }> = []
  const api = { get: async (path: string, options?: { query?: Record<string, unknown> }) => (calls.push({ path, query: options?.query ?? {} }), {}) } as unknown as Parameters<typeof listOrders>[0]
  return { api, calls }
}
const params = (query: string) => new URLSearchParams(query)

describe('the sort and the custom field filter are address terms', () => {
  it('a known sort is read from the address; anything else is newest first', () => {
    expect(sortFromAddress(params('sort=promise'))).toBe('promise')
    expect(sortFromAddress(params('sort=-daysLate'))).toBe('-daysLate')
    expect(sortFromAddress(params('sort=number'))).toBeNull()
    expect(sortFromAddress(params(''))).toBeNull()
    expect(sortFromAddress(null)).toBeNull()
  })

  it('the custom field filter is kept as written (the API checks its clauses and refuses a bad one)', () => {
    expect(cfFromAddress(params('cf=rush_note:rush'))).toBe('rush_note:rush')
    expect(cfFromAddress(params('cf=%20'))).toBeNull()
    expect(cfFromAddress(params(`cf=${'a'.repeat(3000)}`))?.length).toBe(2000)
  })

  it('the page’s address keeps both with every other term (so a saved view and its file keep them)', () => {
    const address = listAddress('/w/D/sales/orders', { rows: 'late', q: 'jkt', layout: 'list', party: null, brand: 'own', company: null, sort: '-daysLate', cf: 'rush_note:rush' })
    const query = new URL(address, 'http://x').searchParams
    expect(query.get('sort')).toBe('-daysLate')
    expect(query.get('cf')).toBe('rush_note:rush')
    expect(query.get('late')).toBe('true')
    expect(listAddress('/w/D/sales/orders', { rows: 'open', q: '', layout: 'list' })).toBe('/w/D/sales/orders')
  })
})

describe('every read sends them: the rows, each lane and the counts', () => {
  it('the rows and the lanes read in the sort with the filter; the counts take the filter (a sort counts nothing)', async () => {
    const { api, calls } = recorder()
    const narrow = { cf: 'rush_note:rush', sort: 'customer' as const }
    await listOrders(api, rowsQuery('all', '', null, null, narrow))
    await listOrders(api, laneQuery('READY', 'all', '', null, narrow))
    await getBoard(api, '', undefined, null, narrow)
    expect(calls.map((call) => [call.path, call.query.sort, call.query.cf])).toEqual([
      ['/sales/orders', 'customer', 'rush_note:rush'],
      ['/sales/orders', 'customer', 'rush_note:rush'],
      ['/sales/orders/board', undefined, 'rush_note:rush'],
    ])
  })

  it('no sort, no filter: neither term reaches the API', async () => {
    const { api, calls } = recorder()
    await listOrders(api, rowsQuery('open', '', null, null, {}))
    expect(calls[0]!.query.sort).toBeUndefined()
    expect(calls[0]!.query.cf).toBeUndefined()
  })
})

describe('only the columns the server sorts by keep a header sort (no header sorts the loaded rows only)', () => {
  it('Customer, Brand, Promised and Ordered sort every page; the arrow follows the address', () => {
    expect(Object.keys(SORT_COLUMNS).sort()).toEqual(['brand', 'customer', 'orderDate', 'promised'])
    expect(columnSort('promise', 'promised')).toBe('asc')
    expect(columnSort('-promise', 'promised')).toBe('desc')
    expect(columnSort('-daysLate', 'promised')).toBeNull()
    expect(columnSort(null, 'customer')).toBeNull()
    expect(columnSort('customer', 'number')).toBeNull()
  })

  it('a header click becomes the server sort; the third click (no sort) is newest first again; other columns never sort', () => {
    expect(sortOfColumn('customer', 'asc')).toBe('customer')
    expect(sortOfColumn('orderDate', 'desc')).toBe('-ordered')
    expect(sortOfColumn('brand', null)).toBeNull()
    expect(sortOfColumn('net', 'asc')).toBeNull()
    expect(sortOfColumn('status', 'desc')).toBeNull()
  })

  it('the Sort menu offers newest first and every server sort, each with its words in it and en', () => {
    const values = SORT_CHOICES.map((choice) => choice.value)
    expect(values[0]).toBe('')
    for (const key of ['customer', 'brand', 'promise', 'daysLate', 'ordered']) expect(values.some((value) => value === key || value === `-${key}`), key).toBe(true)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
      for (const choice of SORT_CHOICES) expect(t(`sort.${choice.word}`), `${locale} ${choice.word}`).not.toMatch(/^sort\./)
      expect(t('sort.label')).not.toMatch(/^sort\./)
      expect(t('chips.cf', { terms: 'rush_note:rush' })).toContain('rush_note:rush')
    }
  })
})
