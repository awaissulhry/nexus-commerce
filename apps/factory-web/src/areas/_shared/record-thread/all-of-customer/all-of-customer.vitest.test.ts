import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CUSTOMER_FEED_KINDS } from '@nexus/factory-domain/sales/customer-feed/kinds'
import type { ApiClient } from '../../../../lib/api/client'
import { leftKeys, render, textOf } from '../../../../lib/record-thread/parts/testing'
import { MessageCard } from '../../../../lib/record-thread/card/view/MessageCard'
import { feedAnswerSchema, feedEntrySchema, readCustomerFeed, type FeedAnswer, type FeedEntry } from './api'
import {
  afterFirst,
  afterFresh,
  afterOlder,
  audienceOfView,
  cardOfEntry,
  chipOf,
  EMPTY_FEED,
  FEED_KIND_CHOICES,
  feedModel,
  kindsOfChoice,
  liveTouches,
  messageHrefOf,
  opensItself,
  pendingOf,
  recordHrefOf,
  showFresh,
  type FeedState,
} from './model'
import { AllOfCustomerFeed } from './view/AllOfCustomerFeed'
import { AllOfCustomerDock } from './view/AllOfCustomerFeed' // F-OP-204
import { FeedHead } from './view/FeedHead' // F-OP-204
import { feedRowsOf } from './model' // tw- W2.5
import { feedKeyOf, linePlaceOf, rovingIndexOf } from './keys' // F-OP-206
import { answerOf } from './model' // F-OP-207
import { freshFolder, heldRecordsOf, listKeyOf, onShowOf } from './model' // F-OP-208
import { FRESH_WAIT_MS } from './use-all-of-customer' // F-OP-208
import { LOCALES } from '../../../../lib/i18n/locales' // F-OP-206
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages' // F-OP-206

/**
 * F-SA-261 (sales page plan R4, P9, N4, N5) — "All of <Customer>", the read-only merged view: its one call, paging (Show older, no
 * repeat), "N new · Show" (the list never moves by itself), View ▾ and Kind ▾, the record chips ("SO-0142 · Your order 12",
 * "<Customer> (general)"), the doors (the chip and "Answer in its conversation"; ⌘-click is the browser's), the card READ ONLY, and
 * the words in both languages.
 */

const ORDER = { type: 'SalesOrder', id: 'so-1', label: 'SO-0142', ownNumber: 12, companyId: 'c-1', kind: 'ORDERS' } as const
const GENERAL = { type: 'Party', id: 'p-a', label: 'SEED-C1 Brand Alpha S.r.l.', ownNumber: null, companyId: null, kind: 'GENERAL' } as const
const PROJECT = { type: 'Project', id: 'prj-1', label: 'PRJ-0004 Capsule', ownNumber: null, companyId: 'c-1', kind: 'PROJECTS' } as const
const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 9, minute)).toISOString()
const entry = (id: string, minute: number, record: FeedEntry['record'] = ORDER, over: Partial<{ new: boolean; direction: string; audience: string }> = {}): FeedEntry =>
  feedEntrySchema.parse({
    record,
    new: over.new ?? false,
    message: {
      id,
      direction: over.direction ?? 'INBOUND',
      audience: over.audience ?? 'PARTNER',
      channel: 'PORTAL',
      author: { kind: 'PARTY', name: 'Madeup Buyer' },
      body: `Message ${id}`,
      bodyHtml: null,
      attachments: [],
      at: at(minute),
    },
  })
const answer = (entries: FeedEntry[], nextCursor: string | null = null, extra: Partial<FeedAnswer> = {}): FeedAnswer =>
  feedAnswerSchema.parse({ customer: { id: 'p-a', code: 'SEED-C1', name: 'Brand Alpha' }, entries, nextCursor, threadsNotShown: 0, olderThreads: 0, ...extra })
const ids = (state: FeedState) => state.entries.map((item) => item.message.id)
const ready = (entries: FeedEntry[], nextCursor: string | null = null) => afterFirst(EMPTY_FEED, answer(entries, nextCursor))

describe('F-SA-261 the one call', () => {
  it('GET /sales/customers/:partyId/feed with a page of 30, the view’s audience, the kinds and the cursor', async () => {
    const asked: { path: string; query: unknown }[] = []
    const api = { get: async (path: string, options: { query?: unknown; schema?: { parse: (value: unknown) => unknown } }) => (asked.push({ path, query: options.query }), options.schema!.parse(answer([]))) } as unknown as ApiClient
    await readCustomerFeed(api, 'p-a', { audience: 'ALL', kinds: [] })
    await readCustomerFeed(api, 'p a', { audience: 'OFFICE', kinds: ['ORDERS', 'QUOTES'], cursor: 'c-9' })
    expect(asked).toEqual([
      { path: '/sales/customers/p-a/feed', query: { limit: 30, audience: 'ALL', kinds: undefined, cursor: undefined } },
      { path: '/sales/customers/p%20a/feed', query: { limit: 30, audience: 'OFFICE', kinds: 'ORDERS,QUOTES', cursor: 'c-9' } },
    ])
  })

  it('the container writes nothing and marks nothing read; the view fetches nothing', () => {
    const hook = readFileSync(new URL('./use-all-of-customer.ts', import.meta.url), 'utf8')
    expect(hook).not.toMatch(/markThreadRead|postNote|sendReply|\.post\(|\.request\(/)
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).not.toMatch(/lib\/api|lib\/session\/(server|context)|fetch\(/)
  })
})

describe('F-SA-261 paging: Show older adds the next page, never a repeat', () => {
  it('the first page, then the next at the foot; a message already shown is not shown twice; the cursor follows', () => {
    const first = ready([entry('m5', 50), entry('m4', 40)], 'c-1')
    expect(first).toMatchObject({ status: 'ready', cursor: 'c-1' })
    const next = afterOlder({ ...first, older: 'loading' }, answer([entry('m4', 40), entry('m3', 30)], null))
    expect(ids(next)).toEqual(['m5', 'm4', 'm3'])
    expect(next).toMatchObject({ cursor: null, older: 'idle' })
    const model = feedModel(first, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true })
    expect(model.more).toBe(true)
    expect(feedModel(next, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true }).more).toBe(false)
  })
})

describe('F-SA-261 "N new · Show": the list never moves by itself', () => {
  it('a newer page read on a live hint waits; only what is newer than the top and not shown counts', () => {
    const shown = ready([entry('m5', 50), entry('m4', 40)], 'c-1')
    const fresh = afterFresh(shown, answer([entry('m7', 70), entry('m6', 60), entry('m5', 50), entry('m4', 40)], 'c-2', { threadsNotShown: 2 }))
    expect(ids(fresh)).toEqual(['m5', 'm4'])
    expect(pendingOf(fresh).map((item) => item.message.id)).toEqual(['m7', 'm6'])
    expect(fresh.threadsNotShown).toBe(2)
    expect(feedModel(fresh, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true }).pending).toBe(2)
    const after = showFresh(fresh)
    expect(ids(after)).toEqual(['m7', 'm6', 'm5', 'm4'])
    expect(after.fresh).toBeNull()
    expect(after.cursor).toBe('c-1')
  })

  it('more than a page came: Show starts the list again from the newest page, so nothing is skipped between', () => {
    const shown = ready([entry('m2', 20), entry('m1', 10)])
    const fresh = afterFresh(shown, answer([entry('m9', 90), entry('m8', 80)], 'c-9'))
    expect(pendingOf(fresh)).toHaveLength(2)
    const after = showFresh(fresh)
    expect(ids(after)).toEqual(['m9', 'm8'])
    expect(after.cursor).toBe('c-9')
  })

  it('nothing shown yet: the new page is the list at once (nothing can jump); no news: nothing waits', () => {
    const empty = ready([])
    expect(ids(afterFresh(empty, answer([entry('m1', 10)])))).toEqual(['m1'])
    const shown = ready([entry('m1', 10)])
    expect(pendingOf(afterFresh(shown, answer([entry('m1', 10)])))).toEqual([])
    expect(showFresh(shown)).toBe(shown)
  })

  it('a live hint about a customer-side conversation reads again; a work order’s, a hold’s or another event never', () => {
    expect(liveTouches({ type: 'thread.message_posted', fields: { recordType: 'SalesOrder', recordId: 'x' } })).toBe(true)
    expect(liveTouches({ type: 'thread.message_posted', fields: { recordType: 'Party', recordId: 'x' } })).toBe(true)
    for (const recordType of ['WorkOrder', 'QualityHold', 'Nonconformance', 'OrderChangeRequest', 'PurchaseOrder']) {
      expect(liveTouches({ type: 'thread.message_posted', fields: { recordType, recordId: 'x' } }), recordType).toBe(false)
    }
    expect(liveTouches({ type: 'sales_order.changed', fields: { recordType: 'SalesOrder' } })).toBe(false)
  })
})

describe('F-SA-261 the filters', () => {
  it('View ▾ All · With the customer · Office notes are the API’s audiences; Kind ▾ is every kind or one', () => {
    expect(['all', 'shared', 'notes'].map((view) => audienceOfView(view as 'all'))).toEqual(['ALL', 'PARTNER', 'OFFICE'])
    expect(FEED_KIND_CHOICES).toEqual(['every', ...CUSTOMER_FEED_KINDS])
    expect(kindsOfChoice('every')).toEqual([])
    expect(kindsOfChoice('QUOTES')).toEqual(['QUOTES'])
  })
})

describe('F-SA-261 the chips and the doors', () => {
  it('"SO-0142 · Your order 12", "<Customer> (general)", a project by its number; a record gone is said so', () => {
    expect(chipOf(ORDER, 'Brand Alpha')).toEqual({ key: 'allOfCustomer.chip.own.ORDER', params: { number: 'SO-0142', seq: 12 } })
    expect(chipOf({ ...ORDER, ownNumber: null }, 'Brand Alpha')).toEqual({ key: 'allOfCustomer.chip.number', params: { number: 'SO-0142' } })
    expect(chipOf(GENERAL, 'Brand Alpha')).toEqual({ key: 'allOfCustomer.chip.general', params: { customer: 'Brand Alpha' } })
    expect(chipOf(PROJECT, 'Brand Alpha')).toEqual({ key: 'allOfCustomer.chip.number', params: { number: 'PRJ-0004 Capsule' } })
    expect(chipOf({ ...ORDER, label: null }, 'Brand Alpha')).toEqual({ key: 'allOfCustomer.chip.unnamed' })
  })

  it('the chip opens the record’s page (a real link), the door the message on it; a modified click is the browser’s', () => {
    expect(recordHrefOf(ORDER, '/w/x')).toBe('/w/x/sales/orders/so-1')
    expect(messageHrefOf(entry('m1', 10), '/w/x')).toBe('/w/x/sales/orders/so-1?message=m1')
    const click = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 }
    expect(opensItself(click)).toBe(false)
    expect(opensItself({ ...click, metaKey: true })).toBe(true)
    expect(opensItself({ ...click, ctrlKey: true })).toBe(true)
    expect(opensItself({ ...click, button: 1 })).toBe(true)
  })

  it('the card is the thread’s own card of the message (its audience), without mentions', () => {
    expect(cardOfEntry(entry('m1', 10))).toMatchObject({ id: 'm1', kind: 'theirs', channel: 'PORTAL', author: 'Madeup Buyer', mentions: [] })
    expect(cardOfEntry(entry('m2', 20, ORDER, { direction: 'INTERNAL_NOTE', audience: 'OFFICE' })).kind).toBe('note')
  })
})

describe('F-SA-261 the view, in both languages', () => {
  const model = (state: FeedState, over: Partial<Parameters<typeof feedModel>[1]> = {}) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true, ...over })
  const state = afterFresh(
    afterFirst(EMPTY_FEED, answer([entry('m3', 30, ORDER, { new: true }), entry('m2', 20, GENERAL), entry('m1', 10, ORDER, { direction: 'INTERNAL_NOTE', audience: 'OFFICE' })], 'c-1', { threadsNotShown: 1 })),
    answer([entry('m4', 40), entry('m3', 30)], 'c-0', { threadsNotShown: 1 }),
  )

  // F-OP-204: the card — its Head (the filters, "1 new · Show"), the feed, the foot's info icon; the one line is the pick band's now.
  // tw- W2.5 (10-design §9; S1): the thread's own bubbles, read only; each bubble's menu Answer in its thread · Copy text · Copy link.
  it('read only: the filters, the chips, "1 new · Show", the New dot, the bubble’s menu, Show older, what is left out', () => {
    const html = render(createElement(AllOfCustomerDock, { label: 'All of Brand Alpha · Read only', model: model(state), actions: { onAnswer: () => undefined } }))
    const text = textOf(html)
    // F-OP-206: the foot's ONE info icon says the keys and that seeing a message marks nothing read.
    expect(html).toContain('aria-label="J / K walk · Enter answers in its thread. Seeing a message here marks nothing read: open its thread."')
    expect(text).toContain('View: All')
    expect(text).toContain('Kind: Every kind')
    expect(text).toContain('SO-0142 · Your order 12')
    expect(text).toContain('Brand Alpha (general)')
    expect(text).toContain('1 new · Show')
    expect(text).toContain('New')
    expect(text).toContain('Read only · 2 threads')
    // Each bubble is the thread's own, read only, with its small menu (Answer in its thread · Copy text · Copy link).
    expect(html.match(/class="fw-rt-msg /g)?.length).toBe(3)
    expect(html).toContain('fw-rt-msg-more')
    expect(html).not.toContain('fw-aoc-line')
    expect(text).toContain('Show older')
    expect(text).toContain('1 thread of Brand Alpha you cannot open is left out.')
    // The chip is a real link to the record (⌘-click opens a new tab).
    expect(html).toContain('href="/w/x/sales/orders/so-1"')
    expect(leftKeys(html, ['allOfCustomer', 'view', 'kind', 'chip', 'menu'])).toEqual([])
    const italian = render(createElement(AllOfCustomerDock, { label: 'Tutto di Brand Alpha · Sola lettura', model: model(state), actions: { onAnswer: () => undefined } }), 'it')
    expect(textOf(italian)).toContain('Sola lettura · 2 thread')
    expect(textOf(italian)).toContain('Brand Alpha (generale)')
    expect(textOf(italian)).toContain('Vista: Tutto')
    expect(textOf(italian)).toContain('Tipo: Ogni tipo')
    expect(textOf(italian)).toContain('SO-0142 · Ordine 12 del cliente')
    expect(leftKeys(italian, ['allOfCustomer', 'view', 'kind', 'chip'])).toEqual([])
  })

  // tw- W2.5: oldest at the top, the newest at the bottom; Show older on top; a record's chip on top of its run (the run ends there).
  it('oldest at the top, the newest at the bottom; Show older on top; the record’s chip on its run’s first bubble only', () => {
    const html = render(createElement(AllOfCustomerFeed, { model: model(state) }))
    expect(html.indexOf('Message m1')).toBeLessThan(html.indexOf('Message m2'))
    expect(html.indexOf('Message m2')).toBeLessThan(html.indexOf('Message m3'))
    expect(html.indexOf('Show older')).toBeLessThan(html.indexOf('Message m1'))
    // m1 (the order) · m2 (general) · m3 (the order again): three runs, three chips.
    expect(html.match(/<a class="fw-aoc-chip"/g)?.length).toBe(3)
    const one = render(createElement(AllOfCustomerFeed, { model: model(afterFirst(EMPTY_FEED, answer([entry('m3', 30), entry('m2', 20), entry('m1', 10)]))) }))
    expect(one.match(/<a class="fw-aoc-chip"/g)?.length).toBe(1)
    expect(one.match(/fw-aoc-item is-recstart/g)?.length).toBe(1)
    const source = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(source).toContain('scroller.scrollTop = scrolledTo > 0 ? scrolledTo : scroller.scrollHeight')
  })

  it('the states: reading, nothing yet (and with a filter), failed with Try again, out of reach; older conversations said', () => {
    expect(render(createElement(AllOfCustomerFeed, { model: model({ ...EMPTY_FEED, status: 'loading' }) }))).toContain('aria-busy="true"')
    expect(textOf(render(createElement(AllOfCustomerFeed, { model: model(ready([])) })))).toContain('No message with Brand Alpha yet')
    expect(textOf(render(createElement(AllOfCustomerFeed, { model: model(ready([]), { view: 'notes' }) })))).toContain('choose All and Every kind')
    const failed = textOf(render(createElement(AllOfCustomerFeed, { model: model({ ...EMPTY_FEED, status: 'failed' }) })))
    expect(failed).toContain("Couldn't read the messages.")
    expect(failed).toContain('Try again')
    expect(textOf(render(createElement(AllOfCustomerFeed, { model: model({ ...EMPTY_FEED, status: 'gone' }) })))).toContain('out of your reach')
    const older = afterFirst(EMPTY_FEED, answer([entry('m1', 10)], null, { olderThreads: 4 }))
    expect(textOf(render(createElement(AllOfCustomerFeed, { model: model(older) })))).toContain('Older threads: open their record')
  })
})

describe('F-SA-261 MessageCard read only', () => {
  it('the same card without its ⋯ menu; the thread keeps its menu', () => {
    const card = cardOfEntry(entry('m1', 10))
    const context = { partyName: 'Brand Alpha', canReadFiles: true, canReply: true }
    expect(render(createElement(MessageCard, { message: card, context }))).toContain('fw-rt-msg-more')
    const readOnly = render(createElement(MessageCard, { message: card, context, readOnly: true }))
    expect(readOnly).not.toContain('fw-rt-msg-more')
    expect(textOf(readOnly)).toContain('Message m1')
  })
})

// ---- F-OP-204 (order page plan N4; 11-dock §0.2, §1, §3.1; RC1, D6): All of <Customer> in the dock's ONE card, with its Head row ---------
describe('F-OP-204 — All of <Customer> inside the card: FeedHead, the width menu, the foot', () => {
  const model = (state: FeedState, over: Partial<Parameters<typeof feedModel>[1]> = {}) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true, ...over })
  const shown = afterFirst(EMPTY_FEED, answer([entry('m2', 20), entry('m1', 10)]))
  const waiting = afterFresh(shown, answer([entry('m4', 40), entry('m3', 30), entry('m2', 20)]))

  it('the card: the same column as a thread — the Head row, the body that scrolls, the fixed foot with ONE info icon', () => {
    const html = render(createElement(AllOfCustomerDock, { label: 'All of Brand Alpha · Read only', model: model(shown), foot: createElement('span', null, 'WRITE IN') }))
    expect(html).toContain('class="fw-rt-column is-docked" aria-label="All of Brand Alpha · Read only"')
    const head = html.indexOf('class="fw-rth fw-aoc-head"')
    const body = html.indexOf('class="fw-rt-scroll"')
    const foot = html.indexOf('class="fw-rt-foot"')
    expect(head).toBeGreaterThan(-1)
    expect(head).toBeLessThan(body)
    expect(body).toBeLessThan(foot)
    expect(html.slice(foot)).toContain('WRITE IN')
    expect(html.slice(foot).match(/class="info"/g)?.length).toBe(1)
    // The feed's old header (its line, filters, marks) is gone from the body.
    expect(html.slice(body, foot)).not.toContain('fw-aoc-head')
    expect(html.slice(body, foot)).not.toContain('View: All')
  })

  it('the Head: the title, View ▾ and Kind ▾ with their words in their names, "N new · Show" only while messages wait, a polite status', () => {
    const calm = render(createElement(FeedHead, { title: 'All of Brand Alpha · Read only', model: model(shown) }))
    expect(calm).toContain('role="group" aria-label="All of Brand Alpha · Read only"')
    expect(textOf(calm)).toContain('All of Brand Alpha · Read only')
    expect(calm).toContain('aria-label="View: All · Choose which messages the feed shows"')
    expect(calm).toContain('aria-label="Kind: Every kind · Choose which records the feed shows"')
    expect(textOf(calm)).not.toContain('new · Show')
    expect(calm).toMatch(/<span class="nds-vh" role="status" aria-live="polite"><\/span>/)
    const news = render(createElement(FeedHead, { title: 'All of Brand Alpha · Read only', model: model(waiting) }))
    expect(textOf(news)).toContain('2 new · Show')
    expect(news).toContain('2 new messages')
    const italian = render(createElement(FeedHead, { title: 'Tutto di Brand Alpha · Sola lettura', model: model(waiting) }), 'it')
    expect(textOf(italian)).toContain('2 nuovi · Mostra')
    expect(italian).toContain('2 nuovi messaggi')
    expect(leftKeys(italian, ['allOfCustomer', 'width', 'more'])).toEqual([])
  })

  it('outside a docked frame no width menu; the ⋯ only with something in it (Open <customer> on the order page)', () => {
    const bare = render(createElement(FeedHead, { title: 'All of Brand Alpha · Read only', model: model(shown) }))
    expect(bare).not.toContain('aria-label="Thread width"')
    expect(bare).not.toContain('aria-label="Thread tools"')
    const withPage = render(createElement(FeedHead, { title: 'All of Brand Alpha · Read only', model: model(shown), customerHref: '/w/x/sales/customers/p-a' }))
    expect(withPage).toContain('aria-label="Thread tools"')
  })

  it('the sources: the SAME width menu as the thread Head; the ⋯ hides, resets and opens the customer; icon-only filters below 481 px', () => {
    const head = readFileSync(new URL('./view/FeedHead.tsx', import.meta.url), 'utf8')
    expect(head).toContain("import { WIDTH_NS, WidthMenu } from '../../../../../lib/record-thread/head/view/WidthMenu'")
    expect(head).toContain('<WidthMenu width={width} onWidth={frame ? (choice) => frame.choose(choice) : undefined} />')
    expect(head).toContain("onSelect: () => frame.choose('hide')")
    expect(head).toContain("onSelect: () => frame.choose('reset')")
    expect(head).toContain("t('allOfCustomer.openRecord', { record: model.customerName }), href: customerHref")
    const css = readFileSync(new URL('./all-of-customer.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@container fw-rtcol \(max-width: 480px\) \{\s*\.fw-aoc-menu-words \{\s*display: none;/)
    expect(css).not.toMatch(/\.fw-aoc-head \{/)
  })

  it('the hosts: the order page and the customer page draw the card; the pick band\'s line says it is read only and how to write', () => {
    const order = readFileSync(new URL('../../../sales/orders/record/dock/OrderDock.tsx', import.meta.url), 'utf8')
    const customer = readFileSync(new URL('../../../sales/customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(order).toContain('<AllOfCustomerDock')
    expect(order).toContain('customerHref={`${prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}')
    expect(order).toContain("line: rt('allOfCustomer.line', { customer })")
    expect(customer).toContain('<AllOfCustomerDock label=')
    expect(customer).toContain("line: rt('allOfCustomer.line', { customer: customer.name })")
    for (const host of [order, customer]) expect(host).not.toContain('<PickedDockColumn')
  })
})
// ---- end F-OP-204

// ---- F-OP-205 (order page plan N4; 11-dock §3.2, §3.5; RC2, RC3): ONE compact line per message, the whole card in place, every state
// inside the card ---------------------------------------------------------------------------------------------------------------------
describe('F-OP-205 — compact lines, expand in place, the states inside the card', () => {
  const model = (state: FeedState, over: Partial<Parameters<typeof feedModel>[1]> = {}) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true, ...over })

  // tw- W2.5 (replaces the compact lines): the thread's own bubbles — runs by the thread's rule, a run ends where the record changes.
  it('the rows: oldest first; a run ends where the record changes, then by the thread’s rule (sender, who reads it, day)', () => {
    const items = model(afterFirst(EMPTY_FEED, answer([entry('m4', 40, GENERAL), entry('m3', 30), entry('m2', 20), entry('m1', 10, ORDER, { direction: 'INTERNAL_NOTE', audience: 'OFFICE' })]))).items
    const rows = feedRowsOf(items)
    expect(rows.map((row) => row.item.key)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(rows.map((row) => row.recordStart)).toEqual([true, false, false, true])
    // m2 and m3: one sender in one record, one run (the first has the tile and the name, the second neither); m4 is a new record.
    expect(rows[1]!.place).toMatchObject({ first: true, last: false })
    expect(rows[2]!.place).toMatchObject({ first: false, last: true })
    expect(rows[3]!.place).toMatchObject({ first: true, last: true })
    expect(feedRowsOf([])).toEqual([])
  })

  it('a bubble is the thread’s own card, read only: its words, its audience in words and icons, the New mark; no Reply, no Pin', () => {
    const state = afterFirst(EMPTY_FEED, answer([entry('m2', 20, ORDER, { new: true }), entry('m1', 10, ORDER, { direction: 'INTERNAL_NOTE', audience: 'OFFICE' })]))
    const html = render(createElement(AllOfCustomerFeed, { model: model(state), actions: { onAnswer: () => undefined } }))
    expect(html.match(/class="fw-rt-msg /g)?.length).toBe(2)
    expect(html).toContain('fw-rt-msg is-note')
    expect(html).toContain('class="fw-aoc-item is-new"')
    const text = textOf(html)
    expect(text).toContain('Message m2')
    expect(text).toContain('New')
    expect(html).not.toContain('fw-aoc-line')
    expect(html).not.toContain('aria-expanded="true"')
    expect(leftKeys(render(createElement(AllOfCustomerFeed, { model: model(state) }), 'it'), ['allOfCustomer', 'erased', 'menu', 'foot'])).toEqual([])
  })

  it('mine on the right: the container says who reads (the session), the card puts the reader’s own message there', () => {
    const mine = feedEntrySchema.parse({ ...entry('m9', 10, ORDER, { direction: 'OUTBOUND' }), message: { ...entry('m9', 10, ORDER, { direction: 'OUTBOUND' }).message, author: { kind: 'USER', id: 'u-me', name: 'Bea Esempio' } } })
    expect(cardOfEntry(mine, 'u-me').mine).toBe(true)
    expect(cardOfEntry(mine).mine).toBeFalsy()
    expect(readFileSync(new URL('./use-all-of-customer.ts', import.meta.url), 'utf8')).toContain('const me = useOfficeSession().user.id')
  })

  it('the states inside the card: three 64 px lines while reading, a danger banner, a lock when out of reach, the empty doors', () => {
    const reading = render(createElement(AllOfCustomerFeed, { model: model({ ...EMPTY_FEED, status: 'loading' }) }))
    expect(reading.match(/height:64px/g)?.length).toBe(3)
    expect(render(createElement(AllOfCustomerFeed, { model: model({ ...EMPTY_FEED, status: 'failed' }) }))).toContain('nds-banner danger')
    const gone = render(createElement(AllOfCustomerFeed, { model: model({ ...EMPTY_FEED, status: 'gone' }) }))
    expect(gone).toContain('class="nds-empty fw-aoc-empty"')
    expect(gone).toContain('lucide-lock')
    // Empty: the host's own thread to write the first one in; filtered empty: Show everything (View All, Kind Every).
    const written: string[] = []
    const empty = textOf(render(createElement(AllOfCustomerFeed, { model: model(ready([])), actions: { writeFirst: { thread: 'This order', onWrite: () => written.push('x') } } })))
    expect(empty).toContain('Write the first one in This order')
    expect(textOf(render(createElement(AllOfCustomerFeed, { model: model(ready([])) })))).not.toContain('Write the first one')
    const filtered = textOf(render(createElement(AllOfCustomerFeed, { model: model(ready([]), { kind: 'QUOTES' }), actions: { writeFirst: { thread: 'This order', onWrite: () => undefined } } })))
    expect(filtered).toContain('Show everything')
    expect(filtered).not.toContain('Write the first one')
    expect(textOf(render(createElement(AllOfCustomerFeed, { model: model(ready([]), { kind: 'QUOTES' }) }), 'it'))).toContain('Mostra tutto')
  })

  it('the hosts give the empty feed its door (the frame\'s compose ask, the box on Office note); the spaces mean their px', () => {
    const order = readFileSync(new URL('../../../sales/orders/record/dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(order).toContain("frame.compose({ record: { type: 'SalesOrder', id: order.id }, messageId: null, mode: 'note' })")
    const customer = readFileSync(new URL('../../../sales/customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(customer).toContain("frame.compose({ record: { type: 'Party', id: customer.id }, messageId: null, mode: 'note' })")
    const css = readFileSync(new URL('./all-of-customer.css', import.meta.url), 'utf8')
    // tw- W2.5: a run's bubbles 2 px apart, a new record's run 10 px from the one before; the chip 20 px high; the compact line gone.
    expect(css).toMatch(/\.fw-aoc-list \{[^}]*gap: var\(--nds-space-2\);/)
    expect(css).toMatch(/\.fw-aoc-item\.is-recstart:not\(:first-child\) \{[^}]*margin-top: var\(--nds-space-10\);/)
    expect(css).toMatch(/\.fw-aoc-chip \{[^}]*height: 20px;[^}]*padding: 0 var\(--nds-space-8\);/)
    expect(css).not.toContain('.fw-aoc-line')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix/i)
    // RC2: the body scrolls in the card (.fw-rt-scroll), never the feed itself.
    expect(css).not.toMatch(/overflow-y:\s*auto/)
  })
})
// ---- end F-OP-205

// ---- F-OP-206 (order page plan N4; 11-dock §3.3; D7): the keys and the a11y of the list — a feed of articles, ONE tab stop --------------
describe('F-OP-206 / tw- W2.5 — J / K walk the messages, Enter answers in its thread; one tab stop', () => {
  const model = (state: FeedState) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true })
  const plain = { metaKey: false, ctrlKey: false, altKey: false }

  it('the walk targets: J / ↓ the next line, K / ↑ the one before, never past either end; Enter the door, Space the whole message', () => {
    expect(feedKeyOf({ ...plain, key: 'j' }, 0, 3)).toEqual({ kind: 'move', to: 1 })
    expect(feedKeyOf({ ...plain, key: 'ArrowDown' }, 1, 3)).toEqual({ kind: 'move', to: 2 })
    expect(feedKeyOf({ ...plain, key: 'j' }, 2, 3)).toEqual({ kind: 'move', to: 2 })
    expect(feedKeyOf({ ...plain, key: 'k' }, 2, 3)).toEqual({ kind: 'move', to: 1 })
    expect(feedKeyOf({ ...plain, key: 'ArrowUp' }, 0, 3)).toEqual({ kind: 'move', to: 0 })
    expect(feedKeyOf({ ...plain, key: 'K' }, 9, 3)).toEqual({ kind: 'move', to: 1 })
    expect(feedKeyOf({ ...plain, key: 'Enter' }, 0, 3)).toEqual({ kind: 'answer' })
    expect(feedKeyOf({ ...plain, key: ' ' }, 0, 3)).toEqual({ kind: 'expand' })
    // ⌘ / Ctrl / Alt and any other key are the browser's (⌘J is the frame's); an empty list takes nothing.
    for (const held of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) expect(feedKeyOf({ ...plain, ...held, key: 'j' }, 0, 3)).toBeNull()
    for (const key of ['x', 'Tab', 'Escape', '/']) expect(feedKeyOf({ ...plain, key }, 0, 3), key).toBeNull()
    expect(feedKeyOf({ ...plain, key: 'j' }, 0, 0)).toBeNull()
  })

  it('the one tab stop stays inside the list as it grows or shrinks; each line\'s place (-1 while older lines may come)', () => {
    expect(rovingIndexOf(0, 3)).toBe(0)
    expect(rovingIndexOf(5, 3)).toBe(2)
    expect(rovingIndexOf(-1, 3)).toBe(0)
    expect(rovingIndexOf(2, 0)).toBe(-1)
    expect(linePlaceOf(0, 30, true)).toEqual({ posinset: 1, setsize: -1 })
    expect(linePlaceOf(2, 3, false)).toEqual({ posinset: 3, setsize: 3 })
  })

  it('a feed of articles named by chip, writer and time; only the first line is a tab stop, its controls too; busy while older ones come', () => {
    const state = afterFirst(EMPTY_FEED, answer([entry('m2', 20), entry('m1', 10)], 'c-1'))
    const html = render(createElement(AllOfCustomerFeed, { model: model(state), actions: { onAnswer: () => undefined } }))
    // tw- W2.5: oldest first — the newest (the last) holds the one tab stop; each article named by its chip and its bubble.
    expect(html).toMatch(/<div class="fw-aoc-list" role="feed" aria-busy="false" aria-label="Messages with Brand Alpha, oldest first">/)
    expect(html).toContain('<article class="fw-aoc-item is-recstart" tabindex="-1" aria-posinset="1" aria-setsize="-1" aria-labelledby="fw-aoc-m1-chip message-m1">')
    expect(html).toContain('<article class="fw-aoc-item" tabindex="0" aria-posinset="2" aria-setsize="-1" aria-labelledby="fw-aoc-m2-chip message-m2">')
    for (const id of ['fw-aoc-m1-chip', 'fw-aoc-m2-chip', 'message-m1', 'message-m2']) expect(html).toContain(`id="${id}"`)
    // Only the line holding the tab stop lets Tab into its chip.
    const first = html.slice(html.indexOf('aria-posinset="1"'), html.indexOf('aria-posinset="2"'))
    expect(first).toMatch(/<a class="fw-aoc-chip" tabindex="-1"/)
    const older = render(createElement(AllOfCustomerFeed, { model: model({ ...state, older: 'loading' }) }))
    expect(older).toContain('role="feed" aria-busy="true"')
  })

  it('the sources: keys on the line itself only (a control keeps its own Enter); Enter presses the line\'s door; no list role lost', () => {
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).toContain('if (event.target !== event.currentTarget) return')
    expect(view).toContain("if (act.kind === 'answer') answerThere?.()")
    expect(view).not.toContain('onToggle') // tw- W2.5: a bubble shows its whole message (a long one folds inside the card itself)
    expect(view).toContain('lineRefs.current[index]?.focus()')
    expect(view).not.toContain('<ol')
  })

  it('the tip in both languages, keys and read marks in ONE place (the foot\'s info icon); the old read-marks line is gone', () => {
    for (const locale of LOCALES) {
      const rt = createTranslator(locale, messagesFor(locale, ['record-thread'])['record-thread']!)
      expect(rt('allOfCustomer.keysTip'), locale).not.toBe('allOfCustomer.keysTip')
      expect(rt('allOfCustomer.readMarks'), locale).toBe('allOfCustomer.readMarks')
    }
  })
})
// ---- end F-OP-206

// ---- F-OP-207 (order page plan N4; 11-dock §3.2, §3.4; pick P7): Answer opens that thread at the message, the box focused; the foot --------
describe('F-OP-207 — Answer per line and the read-only foot', () => {
  const model = (state: FeedState) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true })
  const OTHER = { ...ORDER, id: 'so-9', label: 'SO-0150', ownNumber: null }
  const state = afterFirst(EMPTY_FEED, answer([entry('m3', 30), entry('m2', 20, ORDER, { direction: 'INTERNAL_NOTE', audience: 'OFFICE' }), entry('m1', 10, OTHER)]))
  const onlyThisOrder = (record: { type: string; id: string }) => record.type === 'SalesOrder' && record.id === 'so-1'

  it('answerOf: the customer\'s line → Reply at its message; a note (or ours) → Office note; another record → its page at the message', () => {
    const [customers, note, other] = model(state).items
    expect(answerOf(customers!, onlyThisOrder)).toEqual({ kind: 'answer', ask: { record: { type: 'SalesOrder', id: 'so-1' }, messageId: 'm3', mode: 'reply' } })
    expect(answerOf(note!, onlyThisOrder)).toEqual({ kind: 'answer', ask: { record: { type: 'SalesOrder', id: 'so-1' }, messageId: 'm2', mode: 'note' } })
    const ours = model(afterFirst(EMPTY_FEED, answer([entry('m4', 40, ORDER, { direction: 'OUTBOUND' })]))).items[0]!
    expect(answerOf(ours, onlyThisOrder)).toMatchObject({ kind: 'answer', ask: { mode: 'note' } })
    expect(answerOf(other!, onlyThisOrder)).toEqual({ kind: 'open', href: '/w/x/sales/orders/so-9?message=m1' })
  })

  // tw- W2.5 (10-design §9): the door is the bubble's menu row "Answer in its thread" — the frame's compose ask, else the dock's switch,
  // else the message on its record's page; another record's line opens that page at the message.
  it('the door: each bubble’s menu (Answer in its thread · Copy text · Copy link); the answer goes by the frame, the switch or the page', () => {
    const html = render(createElement(AllOfCustomerFeed, { model: model(state), actions: { canAnswer: onlyThisOrder, onCompose: () => undefined, onAnswer: () => undefined } }))
    expect(html.match(/class="fw-rt-msg-more"/g)?.length).toBe(3)
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).toContain("if (door?.kind === 'answer') actions?.onCompose?.(door.ask)")
    expect(view).toContain("else if (door?.kind === 'open') window.location.assign(door.href)")
    expect(view).toContain('else if (answer) answer(item.record, item.key)')
    expect(view).toContain('else window.location.assign(item.messageHref)')
    const card = readFileSync(new URL('../../../../lib/record-thread/card/view/MessageCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain("const READ_ONLY_DOOR: Partial<Record<CardAction, keyof CardActions>> = { answerThere: 'onAnswerThere', copyText: 'onCopyText', link: 'onCopyLink' }")
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['record-thread-card'])['record-thread-card']!)('menu.answerThere')).toBe(locale === 'en' ? 'Answer in its thread' : 'Rispondi nel suo thread')
  })

  it('the hosts: only this customer\'s threads the dock can show (order: this order, General, a linked project; customer page: General, the record picked)', () => {
    const order = readFileSync(new URL('../../../sales/orders/record/dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(order).toContain('const canAnswer = (record: { readonly type: string; readonly id: string }) => scopeOfRecord(record, page, offer) !== null')
    expect(order).toContain('...(frame?.compose ? { onCompose: frame.compose } : {})')
    // The foot: "Read only. Write in:" — This order, and General only when it is offered; each opens its thread on Office note.
    expect(order).toContain("{t('record.dock.readOnly')}. {t('record.dock.writeIn')}")
    expect(order).toContain("writeIn({ type: 'SalesOrder', id: order.id }, ORDER_SCOPE)")
    expect(order).toMatch(/\{offer\.general && \(\s*<Button size="sm" variant="secondary" onClick=\{\(\) => writeIn\(\{ type: 'Party', id: order\.partyId \}/)
    expect(order).toContain("frame.compose({ record, messageId: null, mode: 'note' })")
    const customer = readFileSync(new URL('../../../sales/customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(customer).toContain("const canAnswer = (record: { readonly type: string; readonly id: string }) => (record.type === 'Party' ? record.id === customer.id : !!pick && sameRecord(record, pick))")
    expect(customer).toContain("{t('customers.work.dock.readOnly')}. {o('record.dock.writeIn')}")
    expect(customer).toMatch(/\{pick && \(\s*<Button size="sm" variant="secondary" onClick=\{\(\) => writeIn\(\{ type: pick\.type, id: pick\.id \}, 'record'\)\}>/)
    expect(customer).toContain('foot={allFoot}')
  })
})
// ---- end F-OP-207

// ---- F-OP-208 (order page plan N4; 11-dock §3.6, D8; R-1): a revisit keeps the list; live hints by the records the list holds --------------
describe('F-OP-208 — revisit keeps the list and reads fresh; a hint on a held record reads again', () => {
  const held = heldRecordsOf(afterFirst(EMPTY_FEED, answer([entry('m2', 20), entry('m1', 10, GENERAL)])))

  it('the records the list holds; a hint on one of them reads again; any other keeps today\'s rule (customer-side types only)', () => {
    expect([...held].sort()).toEqual(['Party:p-a', 'SalesOrder:so-1'])
    expect(liveTouches({ type: 'thread.message_posted', fields: { recordType: 'SalesOrder', recordId: 'so-1' } }, held)).toBe(true)
    // Not held, a customer-side type: a new thread of this customer may begin (the server sends it only to who reaches the customer).
    expect(liveTouches({ type: 'thread.message_posted', fields: { recordType: 'Quote', recordId: 'q-new' } }, held)).toBe(true)
    // Not held and not customer-side: never; another event: never.
    for (const recordType of ['WorkOrder', 'QualityHold', 'PurchaseOrder']) expect(liveTouches({ type: 'thread.message_posted', fields: { recordType, recordId: 'x' } }, held), recordType).toBe(false)
    expect(liveTouches({ type: 'sales_order.changed', fields: { recordType: 'SalesOrder', recordId: 'so-1' } }, held)).toBe(false)
    // The hint names no party: the rule never reads a party id (R-1).
    const model = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    const rule = model.slice(model.indexOf('export function liveTouches'), model.indexOf('// ---- F-OP-208'))
    expect(rule).not.toContain('partyId')
  })

  it('showing the list again: the same customer, View and Kind read fresh behind "N new"; the first visit or another list starts again', () => {
    const shown = afterFirst(EMPTY_FEED, answer([entry('m1', 10)]))
    const key = listKeyOf('p-a', 'all', 'every')
    expect(onShowOf(shown, key, key)).toBe('fresh')
    expect(onShowOf(shown, null, key)).toBe('first')
    expect(onShowOf(shown, key, listKeyOf('p-a', 'notes', 'every'))).toBe('first')
    expect(onShowOf(shown, key, listKeyOf('p-b', 'all', 'every'))).toBe('first')
    expect(onShowOf({ status: 'failed' }, key, key)).toBe('first')
    expect(onShowOf({ status: 'loading' }, key, key)).toBe('first')
    expect(new Set([listKeyOf('p-a', 'all', 'every'), listKeyOf('p-a', 'all', 'QUOTES'), listKeyOf('p-a', 'shared', 'every'), listKeyOf(null, 'all', 'every')]).size).toBe(4)
  })

  it('live hints fold into one read per burst (800 ms); a cancelled wait reads nothing', () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      const folder = freshFolder(() => (reads += 1), FRESH_WAIT_MS)
      folder.hint()
      folder.hint()
      vi.advanceTimersByTime(FRESH_WAIT_MS - 1)
      folder.hint()
      expect(reads).toBe(0)
      vi.advanceTimersByTime(1)
      expect(reads).toBe(1)
      folder.hint()
      folder.cancel()
      vi.advanceTimersByTime(FRESH_WAIT_MS * 2)
      expect(reads).toBe(1)
      expect(FRESH_WAIT_MS).toBe(800)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the container stays mounted and keeps lines, View, Kind and scroll; the view draws the list where it was', () => {
    const hook = readFileSync(new URL('./use-all-of-customer.ts', import.meta.url), 'utf8')
    expect(hook).toContain("if (onShowOf(stateRef.current, heldKey.current, listKey) === 'fresh') loadFresh()")
    expect(hook).toContain('}, [enabled, listKey])')
    expect(hook).toContain('liveTouches(change, heldRecordsOf(stateRef.current)) && folder.hint()')
    expect(hook).toContain('scrollTop: scrollTop.current')
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).toContain("const scroller = root.current?.closest<HTMLElement>('.fw-rt-scroll')")
    expect(view).toContain('scroller.scrollTop = scrolledTo > 0 ? scrolledTo : scroller.scrollHeight') // tw- W2.5: the first visit at the newest
    // The hosts call the container on every render (it reads only while All shows), so leaving All never drops it.
    const order = readFileSync(new URL('../../../sales/orders/record/dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(order).toMatch(/const feed = useAllOfCustomer\(api, \{ partyId: order\.partyId, customerName: customer, enabled: scope\.kind === 'all'/)
    expect(feedModel(EMPTY_FEED, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true }).scrollTop).toBe(0)
    expect(feedModel(EMPTY_FEED, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true, scrollTop: 420 }).scrollTop).toBe(420)
  })
})
// ---- end F-OP-208

// ---- F-OP-305 (order page walk #13): a record no longer there keeps its true words and offers no door ---------------------------
describe('F-OP-305 — "A record no longer there": the true words, no door', () => {
  const GONE = { ...ORDER, id: 'so-gone', label: null, ownNumber: null }
  const model = (state: FeedState) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true })
  const state = afterFirst(EMPTY_FEED, answer([entry('m2', 20, GONE), entry('m1', 10)]))
  const anyRecord = () => true

  it('the model marks it gone; answerOf offers no door for it (and still does for a record that is there)', () => {
    const [gone, there] = model(state).items
    expect(gone!.gone).toBe(true)
    expect(there!.gone).toBe(false)
    expect(answerOf(gone!, anyRecord)).toBeNull()
    expect(answerOf(gone!, () => false)).toBeNull()
    expect(answerOf(there!, anyRecord)).toMatchObject({ kind: 'answer' })
  })

  it('drawn: its chip is words, never a link; no "Open A record no longer there", no Answer in its thread — with every host and none', () => {
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const answerThere = item.gone')
    for (const actions of [undefined, { onAnswer: () => undefined }, { canAnswer: anyRecord, onCompose: () => undefined, onAnswer: () => undefined }, { canAnswer: () => false, onCompose: () => undefined }]) {
      const html = render(createElement(AllOfCustomerFeed, { model: model(afterFirst(EMPTY_FEED, answer([entry('m2', 20, GONE)]))), actions }))
      const text = textOf(html)
      expect(text).toContain('A record no longer there')
      expect(html).toContain('class="fw-aoc-chip is-gone"')
      expect(html).not.toContain('/so-gone')
      expect(text).not.toContain('Open A record no longer there')
      expect(text).not.toContain('Answer')
      expect(text).toContain('Message m2') // tw- W2.5: the message itself is shown whole
    }
  })
})
// ---- end F-OP-305

// ---- tw- W2.5 (THE THREAD REBUILD; 10-design §9, §10; S1): the same face — one line read-only foot, the menu of a read-only bubble ----
describe('tw- W2.5 — All of <Customer> in the thread’s own face', () => {
  const model = (state: FeedState) => feedModel(state, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true })
  const state = afterFirst(EMPTY_FEED, answer([entry('m2', 20), entry('m1', 10, GENERAL)]))

  it('with no door of the host’s, the foot is ONE line: "Read only: to write, pick one thread." — in both languages', () => {
    for (const [locale, words] of [['en', 'Read only: to write, pick one thread.'], ['it', 'Sola lettura: per scrivere, scegli un thread.']] as const) {
      const html = render(createElement(AllOfCustomerDock, { label: 'x', model: model(state) }), locale)
      expect(textOf(html.slice(html.indexOf('class="fw-rt-foot"'))), locale).toContain(words)
    }
    const withDoors = render(createElement(AllOfCustomerDock, { label: 'x', model: model(state), foot: createElement('span', null, 'WRITE IN') }))
    expect(withDoors).not.toContain('fw-aoc-readonly')
  })

  it('a read-only bubble’s menu is Answer in its thread · Copy text · Copy link, each by its door; none without doors (no Reply, no Pin)', () => {
    const card = cardOfEntry(entry('m1', 10))
    const context = { partyName: 'Brand Alpha', canReadFiles: true, canReply: true, canPin: true }
    expect(render(createElement(MessageCard, { message: card, context, readOnly: true }))).not.toContain('fw-rt-msg-more')
    expect(render(createElement(MessageCard, { message: card, context, readOnly: true, actions: { onAnswerThere: () => undefined } }))).toContain('fw-rt-msg-more')
    const model_ = readFileSync(new URL('../../../../lib/record-thread/card/model.ts', import.meta.url), 'utf8')
    expect(model_).toContain("export const READ_ONLY_MENU: readonly CardAction[] = ['answerThere', 'copyText', 'link']")
  })

  it('the brand wall holds: the feed draws only the messages its one customer read gave (nothing looked up elsewhere)', () => {
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).not.toMatch(/\bfetch\(|useOfficeApi|readCustomerFeed/)
    const html = textOf(render(createElement(AllOfCustomerFeed, { model: model(state) })))
    expect(html).toContain('Brand Alpha (general)')
    expect(html).not.toContain('Brand Beta')
  })
})
// ---- end tw- W2.5
