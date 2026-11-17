import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { canOf } from '../../../_shared/buying/fixtures'
import { listOrders, listSupplierReplies, type WaitingReply } from '../api'
import { ORDER_ROWS, ORDER_SUMMARY } from '../demo/fixtures'
import { ORDER_TILES, ORDER_VIEWS, orderQuery, orderViewOf } from '../model'
import { designScreen } from './fixtures'
import { replyCell, replyWait, repliesByOrder, repliesEmpty, repliesLine, repliesValue, showsReplies, threadHref, tilesFor, viewsFor } from './supplier-replies'

/**
 * B-TH-240 — Purchasing › Orders "Supplier replies" (X-PUR-ORD-LIST.grid-F01, back end B-TH-047; wall W19, W27, W36): the saved view
 * of the purchase orders whose supplier wrote last, its tile and line, the Supplier wrote / Waiting cells from the conversation alone,
 * the New messages column, and every design case in both languages with no key left on screen.
 */

vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

const buyer = canOf('buyer')
const blind = { ...buyer, threads: false }
const params = (query: string) => new URLSearchParams(query)
const PREFIX = '/w/demo'
const ORDER_A = ORDER_ROWS.find((row) => row.number === 'PO-2026-0006')!
const ORDER_B = ORDER_ROWS.find((row) => row.number === 'PO-2026-0005')!
/** A customer of a sales order the supplier's goods serve: it must never appear on a supplier's row (W36). */
const CUSTOMER = 'Brand Alpha Moto'

function reply(orderId: string, over: Partial<WaitingReply> = {}): WaitingReply {
  return {
    recordType: 'PurchaseOrder',
    recordId: orderId,
    label: 'PO-2026-0006',
    companyId: ORDER_A.companyId,
    party: { id: ORDER_A.partyId, code: 'CONCERIA-DEMO', name: 'Conceria Demo S.r.l.' },
    lastMessage: { id: 'm-1', at: '2026-10-24T08:15:00.000Z', channel: 'EMAIL', authorName: 'Marta Demo', excerpt: 'Possiamo consegnare il 10 dicembre?' },
    waiting: { since: '2026-10-24T08:15:00.000Z', workingMinutes: 4 * 480 + 120, calendar: true, amber: true, thresholdDays: 3 },
    ...over,
  }
}

describe('Supplier replies: the saved view and its address', () => {
  it('?view=supplierReplies and ?supplierReplies=true open the view; the API is asked supplierReplies=true', () => {
    expect(orderViewOf(params('view=supplierReplies'))).toBe('supplierReplies')
    expect(orderViewOf(params('supplierReplies=true'))).toBe('supplierReplies')
    expect(orderQuery('supplierReplies', '')).toEqual({ status: null, waitingOver48h: false, q: '', cursor: null, supplierReplies: true })
    // Every other view asks nothing new.
    expect(orderQuery('all', '')).toEqual({ status: null, waitingOver48h: false, q: '', cursor: null })
  })

  it('only a reader of conversations has the view, its tile and the New messages column', () => {
    expect(showsReplies(buyer)).toBe(true)
    expect(showsReplies(blind)).toBe(false)
    expect(viewsFor(ORDER_VIEWS, buyer)).toContain('supplierReplies')
    expect(viewsFor(ORDER_VIEWS, blind)).not.toContain('supplierReplies')
    expect(tilesFor(ORDER_TILES, buyer).some((tile) => tile.view === 'supplierReplies')).toBe(true)
    expect(tilesFor(ORDER_TILES, blind).some((tile) => tile.view === 'supplierReplies')).toBe(false)
  })

  it('the tile says the API’s number, "—" while unknown — never 0 for a reader the API cannot count for', () => {
    expect(repliesValue({ ...ORDER_SUMMARY, supplierReplies: 3 }, buyer)).toBe('3')
    expect(repliesValue({ ...ORDER_SUMMARY, supplierReplies: 0 }, buyer)).toBe('0')
    expect(repliesValue(ORDER_SUMMARY, buyer)).toBe('—')
    expect(repliesValue(null, buyer)).toBe('—')
    expect(repliesValue({ ...ORDER_SUMMARY, supplierReplies: 0 }, blind)).toBe('—')
  })

  it('the view’s line: how many wait, partial past 1000, the messages unreadable, or why a reader cannot have it', () => {
    const ready = { status: 'ready' as const, byOrder: {}, complete: true }
    expect(repliesLine({ supplierReplies: 3 }, ready, buyer)).toEqual({ key: 'replies.count', params: { count: 3 } })
    expect(repliesLine({ supplierReplies: 1240 }, { ...ready, complete: false }, buyer)).toEqual({ key: 'replies.countPartial', params: { count: 1240 } })
    expect(repliesLine({ supplierReplies: 3 }, { status: 'error', problem: 'problem.offline' }, buyer)).toEqual({ key: 'replies.readFailed' })
    expect(repliesLine({}, ready, buyer)).toEqual({ key: 'replies.countUnknown' })
    expect(repliesLine({ supplierReplies: 0 }, ready, blind)).toEqual({ key: 'replies.noThreads' })
  })

  it('empty: its own words (nothing waits is not an error); a search that matches nothing keeps Clear filters', () => {
    expect(repliesEmpty(buyer, false)).toEqual({ title: { key: 'replies.empty.title' }, body: { key: 'replies.empty.body' } })
    expect(repliesEmpty(blind, false)?.title.key).toBe('replies.empty.noThreadsTitle')
    expect(repliesEmpty(buyer, true)).toBeNull()
  })
})

describe('Supplier replies: the brand wall (W19, W27, W36)', () => {
  it('a waiting row is drawn only for an order on the page the reader was given (never another record, never an order not listed)', () => {
    const notListed = reply('0190f0e2-9999-7000-8000-000000000999')
    const salesOrder = reply(ORDER_B.id, { recordType: 'SalesOrder' })
    const mine = reply(ORDER_A.id)
    const byOrder = repliesByOrder([notListed, salesOrder, mine], [ORDER_A, ORDER_B])
    expect(Object.keys(byOrder)).toEqual([ORDER_A.id])
    expect(byOrder[ORDER_A.id]).toBe(mine)
    // The first (oldest) waiting row of an order wins; a second never replaces it.
    expect(repliesByOrder([mine, reply(ORDER_A.id, { lastMessage: { ...mine.lastMessage, id: 'm-2' } })], [ORDER_A])[ORDER_A.id]!.lastMessage.id).toBe('m-1')
  })

  it('a reply cell is built from the conversation alone: the supplier’s person (else the supplier), its words, its time — no customer or brand', () => {
    const cell = replyCell(reply(ORDER_A.id), PREFIX, Date.parse('2026-10-29T11:00:00.000Z'))
    expect(cell.who).toBe('Marta Demo')
    expect(cell.excerpt).toBe('Possiamo consegnare il 10 dicembre?')
    expect(cell.amber).toBe(true)
    expect(cell.wait).toEqual({ key: 'replies.wait.days', params: { n: 4 } })
    expect(cell.tip).toEqual({ key: 'replies.tipWorking', params: { days: 3 } })
    expect(cell.href).toBe(`${PREFIX}/purchasing/orders/${ORDER_A.id}?tab=activity&message=m-1`)
    expect(JSON.stringify(cell)).not.toContain(CUSTOMER)
    // No author name: the supplier itself.
    expect(replyCell(reply(ORDER_A.id, { lastMessage: { ...reply(ORDER_A.id).lastMessage, authorName: null } }), PREFIX).who).toBe('Conceria Demo S.r.l.')
  })

  it('every design case of the view names no customer of the factory on a supplier row', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    for (const item of screen.cases.filter((one) => one.id.startsWith('th3-240-'))) {
      for (const locale of LOCALES) expect(render(screen, item.model, locale), `${item.id} (${locale})`).not.toMatch(/Brand Alpha|Brand Beta/)
    }
  })
})

describe('Supplier replies: the waiting time by the one rule', () => {
  it('working time on the calendar (a day = 8 working hours); clock time without a calendar', () => {
    const now = Date.parse('2026-10-29T11:00:00.000Z')
    expect(replyWait(reply(ORDER_A.id, { waiting: { ...reply(ORDER_A.id).waiting, workingMinutes: 55 } }), now)).toEqual({ key: 'replies.wait.minutes', params: { n: 55 } })
    expect(replyWait(reply(ORDER_A.id, { waiting: { ...reply(ORDER_A.id).waiting, workingMinutes: 180 } }), now)).toEqual({ key: 'replies.wait.hours', params: { n: 3 } })
    const clock = replyWait(reply(ORDER_A.id, { waiting: { since: '2026-10-29T08:00:00.000Z', workingMinutes: 0, calendar: false, amber: false, thresholdDays: 3 } }), now)
    expect(clock).toEqual({ key: 'replies.wait.hours', params: { n: 3 } })
    expect(threadHref(PREFIX, ORDER_A.id)).toBe(`${PREFIX}/purchasing/orders/${ORDER_A.id}?tab=activity`)
  })
})

describe('Supplier replies: the API calls', () => {
  it('the list asks supplierReplies=true; the waiting read asks the supplier side of purchase orders, 100 a page', async () => {
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url))
      const body = String(url).includes('/threads/waiting') ? { rows: [reply(ORDER_A.id)], count: 1, complete: true, next: null } : { summary: { ...ORDER_SUMMARY, supplierReplies: 1 }, orders: [ORDER_A], nextCursor: null }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: fetcher as unknown as typeof fetch, csrfToken: () => 'csrf' })
    const page = await listOrders(api, { ...orderQuery('supplierReplies', ''), limit: 50 })
    expect(page.summary.supplierReplies).toBe(1)
    const waiting = await listSupplierReplies(api, { cursor: null })
    expect(waiting.rows[0]!.lastMessage.excerpt).toBe('Possiamo consegnare il 10 dicembre?')
    expect(urls[0]).toContain('supplierReplies=true')
    expect(urls[1]).toContain('/threads/waiting?side=SUPPLIER&recordType=PurchaseOrder')
    expect(urls[1]).toContain('limit=100')
  })

  it('a summary from before B-TH-047 (no supplierReplies) still parses: the tile says "—"', async () => {
    const { supplierReplies: _gone, ...old } = { ...ORDER_SUMMARY, supplierReplies: 1 }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ summary: old, orders: [], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: fetcher as unknown as typeof fetch, csrfToken: () => 'csrf' })
    const page = await listOrders(api, {})
    expect(repliesValue(page.summary, buyer)).toBe('—')
  })
})

const LEFT_KEY = /\b(?:replies|tile|view|list|po|common|held|problem|cell)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:purchasing\.[a-z.]+|money\.cost|[a-z-]+\.example\.com|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'buying', 'lists', 'records', 'send', 'purchasing-orders', 'last-message']) }, createElement(View, { model })))
}

describe('the Supplier replies design cases draw in both languages with no key left on screen', () => {
  it('SCR-058 th3-240-* × it, en', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const cases = screen.cases.filter((item) => item.id.startsWith('th3-240-'))
    expect(cases.length).toBeGreaterThanOrEqual(10)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = render(screen, item.model, locale).replace(SAID, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('the view says what waits and who wrote, in both languages', () => {
    const screen = designScreen as unknown as DesignScreen<unknown>
    const html = (id: string, locale: 'it' | 'en') => render(screen, screen.cases.find((item) => item.id === id)!.model, locale)
    // AG Grid draws its column headers ("Supplier wrote") in a browser only: the server draws the view's own words, and the column
    // is held by its definition (its header is the catalogue's `replies.col`, checked in both languages below).
    expect(html('th3-240-replies', 'en')).toContain('3 conversations wait on us: the supplier wrote last')
    expect(html('th3-240-replies', 'it')).toContain('3 conversazioni attendono una nostra risposta: ha scritto per ultimo il fornitore')
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{ colId: 'reply', headerName: td('replies.col')")
    expect(html('th3-240-empty', 'en')).toContain('No supplier waits for an answer')
    expect(html('th3-240-no-threads', 'en')).not.toContain('Supplier replies')
  })

  it('has every word of the view in both languages', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['purchasing-orders'])['purchasing-orders'] ?? {})
      for (const key of ['tile.supplierReplies', 'view.supplierReplies', 'replies.col', 'replies.colWaiting', 'replies.wait.days', 'replies.empty.title', 'replies.noThreads', 'replies.readFailed']) expect(words(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
