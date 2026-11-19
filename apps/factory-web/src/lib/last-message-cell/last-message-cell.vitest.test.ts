import { readFileSync } from 'node:fs' // F-OP-213 follow-up
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../api/client'
import { render, textOf } from '../record-thread/parts/testing'
import { scanText } from '../testing/brand-scan'
import { BRAND_ALPHA } from '../testing/two-brands'
import { readUnreadWith } from './api'
import { cellOf, UNREAD_PAGE, unreadAsk, unreadMapOf, unreadValue } from './model'
import { LastMessageCell } from './view/LastMessageCell'

/**
 * B-TH-230 — LastMessageCell (threads plan TH-2, on B-TH-027): ONE read of a page of rows (at most 200, each record once), the cell
 * of each row (the count, "99+", empty), the door to the record's thread, it + en; the read names records only (W08, W27, W37: the
 * API counts only what the reader may open; a portal person only their party's shared messages).
 */

describe('one read per page', () => {
  it('asks each record once, in the list’s order, at most 200', () => {
    const rows = Array.from({ length: 260 }, (_, index) => ({ recordType: 'SalesOrder', id: `o${index}` }))
    const asked = unreadAsk([...rows.slice(0, 3), rows[1]!, ...rows.slice(3)])
    expect(asked).toHaveLength(UNREAD_PAGE)
    expect(asked.slice(0, 3)).toEqual([{ recordType: 'SalesOrder', recordId: 'o0' }, { recordType: 'SalesOrder', recordId: 'o1' }, { recordType: 'SalesOrder', recordId: 'o2' }])
    expect(new Set(asked.map((one) => one.recordId)).size).toBe(UNREAD_PAGE)
    // Two record types with the same id are two records (a portal list holds requests and orders).
    expect(unreadAsk([{ recordType: 'Inquiry', id: 'x' }, { recordType: 'SalesOrder', id: 'x' }])).toHaveLength(2)
  })

  it('the read is ONE POST /threads/unread naming records only — never a person, a party or a company', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = { post: async (path: string, options: { body: unknown }) => (calls.push({ path, body: options.body }), { counts: [{ recordType: 'SalesOrder', recordId: 'o1', newCount: 2, lastAt: '2026-11-17T09:12:00.000Z' }] }) } as unknown as ApiClient
    const counts = await readUnreadWith(api)([{ recordType: 'SalesOrder', recordId: 'o1' }], new AbortController().signal)
    expect(calls).toEqual([{ path: '/threads/unread', body: { records: [{ recordType: 'SalesOrder', recordId: 'o1' }] } }])
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/party|company|user|person/i)
    expect(unreadMapOf(counts)).toEqual({ o1: { newCount: 2, lastAt: '2026-11-17T09:12:00.000Z' } })
  })
})

describe('the cell', () => {
  it('empty with nothing new or not counted; the count; 99+ above 99; sorts by the count', () => {
    expect(cellOf(undefined)).toEqual({ kind: 'empty' })
    expect(cellOf({ newCount: 0, lastAt: null })).toEqual({ kind: 'empty' })
    expect(cellOf({ newCount: 3, lastAt: 'x' })).toEqual({ kind: 'new', count: 3, key: 'cell.count', lastAt: 'x' })
    expect(cellOf({ newCount: 140, lastAt: null })).toMatchObject({ count: 99, key: 'cell.many' })
    expect(unreadValue(undefined)).toBe(0)
    expect(unreadValue({ newCount: 7, lastAt: null })).toBe(7)
  })

  it('a door to the record’s thread at the first new message, in words (it + en); a plain mark without a door; nothing when empty', () => {
    const at = new Date().toISOString()
    for (const locale of ['en', 'it'] as const) {
      const html = render(createElement(LastMessageCell, { unread: { newCount: 2, lastAt: at }, href: '/w/SCA/sales/orders/o1?thread=new', record: 'SO-2026-0142' }), locale)
      expect(html).toContain('href="/w/SCA/sales/orders/o1?thread=new"')
      expect(textOf(html)).toContain(locale === 'en' ? '2 new' : '2 nuovi')
      expect(html).toContain(locale === 'en' ? 'aria-label="2 new messages on SO-2026-0142: open the thread at the first new one"' : 'aria-label="2 messaggi nuovi su SO-2026-0142: apri la conversazione al primo nuovo"')
    }
    expect(render(createElement(LastMessageCell, { unread: { newCount: 120, lastAt: null }, href: null, record: 'X' }))).not.toContain('href=')
    expect(textOf(render(createElement(LastMessageCell, { unread: { newCount: 120, lastAt: null }, href: null, record: 'X' })))).toBe('99+ new')
    expect(textOf(render(createElement(LastMessageCell, { unread: { newCount: 0, lastAt: null }, href: '/x', record: 'X' })))).toBe('')
    expect(render(createElement(LastMessageCell, { unread: undefined, href: '/x', record: 'X' }))).not.toContain('href=')
  })

  it('a cell names only its own record (the brand wall: no other customer’s words)', () => {
    const html = render(createElement(LastMessageCell, { unread: { newCount: 1, lastAt: null }, href: '/p/BETA/requests/r1', record: 'Your request 3' }))
    expect(scanText(html, BRAND_ALPHA)).toEqual([])
  })
})

// ---- F-OP-213 (B-OP-061): the read also says whether the reader may read each record's thread; an older answer says nothing ----------
describe('F-OP-213 — readable per record', () => {
  it('kept when the API says it (true or false alike for an unknown record and one out of reach); absent when it does not', () => {
    expect(unreadMapOf([{ recordId: 'p1', newCount: 0, lastAt: null, readable: false }, { recordId: 'o1', newCount: 1, lastAt: null, readable: true }])).toEqual({
      p1: { newCount: 0, lastAt: null, readable: false },
      o1: { newCount: 1, lastAt: null, readable: true },
    })
    expect(unreadMapOf([{ recordId: 'o1', newCount: 1, lastAt: null }]).o1).not.toHaveProperty('readable')
  })
})
// ---- end F-OP-213

// ---- F-OP-213 follow-up (B-OP-061 #1711: `readable` is opt-in): only the dock asks it, for the records its pick offers ------------------
describe('F-OP-213 — `readable` asked by the dock only', () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const api = { post: async (path: string, options: { body: unknown }) => (calls.push({ path, body: options.body }), { counts: [{ recordType: 'Party', recordId: 'p1', newCount: 0, lastAt: null, readable: false }] }) } as unknown as ApiClient
  it('asked: the body says `readable: true` and the rows keep it; not asked (a list\'s cells): the body is the records only', async () => {
    calls.length = 0
    const counts = await readUnreadWith(api, { readable: true })([{ recordType: 'Party', recordId: 'p1' }], new AbortController().signal)
    expect(calls[0]).toEqual({ path: '/threads/unread', body: { records: [{ recordType: 'Party', recordId: 'p1' }], readable: true } })
    expect(unreadMapOf(counts)).toEqual({ p1: { newCount: 0, lastAt: null, readable: false } })
    await readUnreadWith(api)([{ recordType: 'SalesOrder', recordId: 'o1' }], new AbortController().signal)
    expect(calls[1]).toEqual({ path: '/threads/unread', body: { records: [{ recordType: 'SalesOrder', recordId: 'o1' }] } })
  })
  it('the sources: the order dock and the customer page\'s own party ask it; every list page reads its cells without it', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    expect(read('../../areas/sales/orders/record/dock/OrderDock.tsx')).toContain('readUnreadWith(api, { readable: true })')
    expect(read('../../areas/sales/customers/record/CustomerRecord.tsx')).toContain('readUnreadWith(api, { readable: true })')
    for (const list of ['../../areas/sales/orders/list/use-orders-sheet.ts', '../../areas/sales/quotes/list/use-quotes-list.ts', '../../areas/sales/inquiries/use-inquiries-list.ts', '../../areas/purchasing/orders/list/OrdersPage.tsx', '../../portal/customer/orders/OrdersPage.tsx', '../../areas/home/today/following/Following.tsx']) {
      expect(read(list), list).not.toContain('readable: true')
    }
  })
})
// ---- end F-OP-213 follow-up
