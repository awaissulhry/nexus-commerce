import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../../lib/i18n/messages'
import type { OrderSummary, SummaryFigures } from '../api'
import { doorAddress, extraFromAddress, groupFromAddress, listAddress, noExtra, rowsFromAddress, rowsQuery, withoutExtra } from '../model'
import { figureDoors, fromDdtsHref, groupedItems, groupHref, groupsToRead, heldKey, invoiceShippedHeld, timingKey, totalNameKey } from './sheet/overall'
import { NAMESPACE } from './sheet/model'
import { extraChips, progressWords } from './view/OrdersListView'
import { LIST_ROWS } from '../_demo/fixtures'

/**
 * B-TH-244 (threads plan TH-4, picture 26; features SHEET.overall-F02 … F11, ORD-G06; wall W19, W27, W30): the overall view —
 * the figures are the summary read's only (per customer and the grand total, per currency, money only with the grain), each figure a
 * door to exactly the rows it counts (the API's filter → the page's address → the same API terms), the grouping, the built-in
 * "Shipped, not invoiced", the later columns' words and "Invoice shipped goods for N" (Finance's dialog with the DDTs chosen).
 */

const P = '/w/DEMO/sales/orders'
const A = '0190f0e2-aaaa-7000-8000-000000000001'
const B = '0190f0e2-bbbb-7000-8000-000000000002'
const s = createTranslator('en', messagesFor('en', [NAMESPACE])[NAMESPACE]!)
const t = createTranslator('en', messagesFor('en', ['orders']).orders!)
const door = (count: number, filter: Record<string, string> | null) => ({ count, filter })

/** Made-up figures of a view ("open orders"), the doors as the API makes them: the view's terms + the figure's own. */
function figures(party: string | null, counts: { orders: number; late: number; part: number }, net?: Array<{ currency: string; amount: number }>): SummaryFigures {
  const view = { open: 'true', ...(party ? { partyId: party } : {}) }
  return {
    orders: door(counts.orders, view),
    pieces: { ordered: door(120, view), shipped: door(0, view), open: door(120, { ...view }) },
    late: door(counts.late, { ...view, late: 'true' }),
    atRisk: door(0, { ...view, atRisk: 'true' }),
    invoiced: { NONE: door(counts.orders - counts.part, { ...view, invoiced: 'NONE' }), PART: door(counts.part, { ...view, invoiced: 'PART' }), ALL: door(0, null) },
    ...(net ? { net: net.map((entry) => ({ ...entry, filter: { ...view, currency: entry.currency } })) } : {}),
  }
}

const SUMMARY: OrderSummary = {
  all: figures(null, { orders: 42, late: 3, part: 4 }, [
    { currency: 'EUR', amount: 1_234_500 },
    { currency: 'USD', amount: 99_000 },
  ]),
  groups: [
    { partyId: A, code: 'ALPHA', name: 'Brand Alpha', invoiceTiming: 'PER_SHIPMENT', figures: figures(A, { orders: 30, late: 3, part: 4 }, [{ currency: 'EUR', amount: 1_000_000 }]) },
    { partyId: B, code: 'BETA', name: 'Brand Beta', invoiceTiming: 'MONTHLY', figures: figures(B, { orders: 12, late: 0, part: 0 }, [{ currency: 'USD', amount: 99_000 }]) },
  ],
  limited: false,
  asOf: '2026-11-17T09:00:00Z',
}

describe('the figures are the server\'s, each a door to exactly what it counts (overall-F03, F11)', () => {
  const doors = figureDoors(SUMMARY.all, { path: P, t: s, locale: 'en' })
  const byKey = (key: string) => doors.find((entry) => entry.key === key)!

  it('the grand total says the summary\'s numbers (42 orders while the screen may hold 7 rows): no row is read', () => {
    expect(byKey('orders').words).toBe('42 orders')
    expect(byKey('late').words).toBe('Late 3')
    expect(byKey('PART').words).toBe('Invoiced in part 4')
    // figureDoors takes no rows at all: a total can never be summed from the loaded ones.
    expect(figureDoors.length).toBe(2)
  })

  it('a figure opens its own rows: the view\'s terms + its own; a 0 is plain words; a figure without a filter opens nothing', () => {
    expect(byKey('orders').href).toBe(`${P}`)
    expect(byKey('late').href).toBe(`${P}?late=true`)
    expect(byKey('PART').href).toBe(`${P}?invoiced=PART`)
    expect(byKey('shipped').href).toBeNull()
    expect(byKey('atRisk').href).toBeNull()
    expect(byKey('ALL').href).toBeNull()
    expect(byKey('late').tone).toBe('danger')
    expect(byKey('atRisk').tone).toBeUndefined()
  })

  it('money per currency, never added across currencies; absent without the price grain', () => {
    const money = doors.filter((entry) => entry.key.startsWith('net-'))
    expect(money.map((entry) => entry.key)).toEqual(['net-EUR', 'net-USD'])
    expect(money.find((entry) => entry.key === 'net-USD')!.href).toBe(`${P}?currency=USD`)
    const withoutPrice: SummaryFigures = { ...SUMMARY.all, net: undefined }
    expect(figureDoors(withoutPrice, { path: P, t: s, locale: 'en' }).some((entry) => entry.key.startsWith('net-'))).toBe(false)
  })

  it('a customer\'s header name opens its own sheet with the same view; its rhythm in words; "All my customers" for a limited reader', () => {
    expect(groupHref(P, SUMMARY.groups![0]!)).toBe(`${P}?party=${A}`)
    expect(figureDoors(SUMMARY.groups![0]!.figures, { path: P, t: s, locale: 'en' }).find((entry) => entry.key === 'late')!.href).toBe(`${P}?late=true&party=${A}`)
    expect(s(timingKey(SUMMARY.groups![1]!))).toBe('Invoiced monthly')
    expect(s(totalNameKey(SUMMARY))).toBe('All customers')
    expect(s(totalNameKey({ limited: true }))).toBe('All my customers')
  })
})

describe('a door\'s address reads exactly the rows it counted (the API\'s filter → the page → the same terms)', () => {
  const land = (filter: Record<string, string>) => {
    const params = new URL(doorAddress(P, filter), 'http://x').searchParams
    const rows = rowsFromAddress(params)
    return rowsQuery(rows, params.get('q') ?? '', null, params.get('party'), { extra: extraFromAddress(params, rows), ...(params.get('company') ? { companyId: params.get('company') } : {}), ...(params.get('brand') ? { brand: params.get('brand') } : {}) })
  }
  it('open orders, late, Invoiced Part, a currency, a customer and a company keep their terms', () => {
    expect(land({ open: 'true', invoiced: 'PART', partyId: A, companyId: B })).toMatchObject({ open: true, invoiced: 'PART', partyId: A, companyId: B })
    expect(land({ open: 'true', late: 'true' })).toMatchObject({ late: true })
    expect(land({ currency: 'USD' })).toMatchObject({ currency: 'USD' })
    expect(land({ currency: 'USD' })).not.toHaveProperty('open')
    expect(land({ status: 'READY', late: 'true' })).toMatchObject({ status: 'READY', late: true })
    expect(land({ open: 'true', atRisk: 'true', brand: 'own' })).toMatchObject({ open: true, atRisk: true, brand: 'own' })
    expect(land({ shippedNotInvoiced: 'true', partyId: A })).toMatchObject({ shippedNotInvoiced: true, partyId: A })
  })
  it('the extra terms are chips (each with ✕) and leave the address with their ✕', () => {
    const params = new URLSearchParams('invoiced=PART&atRisk=true&currency=USD&late=true&status=READY')
    const extra = extraFromAddress(params, rowsFromAddress(params))
    expect(rowsFromAddress(params)).toBe('late')
    expect(extra).toEqual({ status: 'READY', invoiced: 'PART', atRisk: true, currency: 'USD' })
    expect(extraChips(extra, t, s).map((chip) => chip.label)).toEqual(['Status: Ready', 'Invoiced: Part', 'At risk', 'Currency: USD'])
    expect(withoutExtra(extra, 'atRisk')).toEqual({ status: 'READY', invoiced: 'PART', currency: 'USD' })
    expect(noExtra({})).toBe(true)
    expect(noExtra(extra)).toBe(false)
    expect(listAddress(P, { rows: 'late', q: '', layout: 'list', extra })).toBe(`${P}?late=true&status=READY&invoiced=PART&atRisk=true&currency=USD`)
  })
})

describe('grouping, the built-in "Shipped, not invoiced", the groups\' own reads (overall-F02, F06)', () => {
  it('?group=party groups All customers; a customer\'s sheet is never grouped', () => {
    expect(groupFromAddress(new URLSearchParams('group=party'))).toBe('party')
    expect(groupFromAddress(new URLSearchParams(`group=party&party=${A}`))).toBeNull()
    expect(listAddress(P, { rows: 'open', q: '', layout: 'list', group: 'party' })).toBe(`${P}?group=party`)
    expect(listAddress(P, { rows: 'open', q: '', layout: 'list', group: 'party', party: A })).toBe(`${P}?party=${A}`)
  })
  it('"Shipped, not invoiced" is the list\'s own term (screen = file = count)', () => {
    const address = listAddress(P, { rows: 'uninvoiced', q: '', layout: 'list', group: 'party' })
    expect(address).toBe(`${P}?shippedNotInvoiced=true&group=party`)
    expect(rowsFromAddress(new URL(address, 'http://x').searchParams)).toBe('uninvoiced')
    expect(rowsQuery('uninvoiced', '')).toMatchObject({ shippedNotInvoiced: true })
    expect(rowsQuery('uninvoiced', '')).not.toHaveProperty('open')
    expect(t('rows.uninvoiced')).toBe('Shipped, not invoiced')
  })
  it('an open group not read yet is read once; a folded one waits; the rows on screen follow the groups\' order', () => {
    const groups = SUMMARY.groups!
    expect(groupsToRead(groups, [], {})).toEqual([A, B])
    expect(groupsToRead(groups, [B], {})).toEqual([A])
    expect(groupsToRead(groups, [], { [A]: { items: null, cursor: null, more: false, problem: null, loading: true } })).toEqual([B])
    const rowA = { ...LIST_ROWS[0]!, partyId: A }
    const rowB = { ...LIST_ROWS[1]!, partyId: B }
    expect(groupedItems(groups, { [B]: { items: [rowB], cursor: null, more: false, problem: null, loading: false }, [A]: { items: [rowA], cursor: 'c', more: true, problem: null, loading: false } }).map((row) => row.partyId)).toEqual([A, B])
  })
})

describe('the later columns and Invoice shipped goods for N (overall-F07, N23)', () => {
  it('Progress in words: cut, sewn, finished of the pieces in work; not in work yet; not read', () => {
    expect(progressWords({ progress: { inWork: 40, cut: 40, sewn: 12, finished: null } }, s)).toBe('Cut 40 · Sewn 12 · Finished — of 40')
    expect(progressWords({ progress: null }, s)).toBe('Not in work yet')
    expect(progressWords({}, s)).toBe('—')
  })
  it('the drafts open Finance\'s From-DDTs dialog with their DDTs chosen; held orders in our words; at most 100', () => {
    expect(fromDdtsHref('/w/DEMO', { partyId: A, body: { ddtIds: ['d1', 'd2'] } })).toBe(`/w/DEMO/finance/invoices?new=1&ddts=d1%2Cd2&party=${A}`)
    expect(heldKey('IN_DRAFT')).toBe('invoiceShipped.held.IN_DRAFT')
    expect(heldKey('SOMETHING_NEW')).toBe('invoiceShipped.held.OTHER')
    expect(invoiceShippedHeld(0)).toBe('invoiceShipped.pick')
    expect(invoiceShippedHeld(101)).toBe('invoiceShipped.tooMany')
    expect(invoiceShippedHeld(3)).toBeNull()
  })
})

describe('the overall view\'s words in it and en', () => {
  it('the same keys and placeholders', () => {
    const en = CATALOGUE.en[NAMESPACE] ?? {}
    const it_ = CATALOGUE.it[NAMESPACE] ?? {}
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) expect(placeholdersOf(it_[key] ?? ''), key).toEqual(placeholdersOf(en[key] ?? ''))
    for (const locale of LOCALES) for (const key of ['totals.all', 'totals.invoiced.PART', 'invoiceShipped.held.OTHER', 'group.party', 'col.progress', 'uninvoiced.none']) expect(CATALOGUE[locale][NAMESPACE]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
