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
import { gistOf, GIST_CHARS, LINE_FILES, lineAudienceOf, lineFilesOf, lineTimeOf } from './model' // F-OP-205
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
  it('read only: the filters, the chips, "1 new · Show", the New dot, the door, Show older, what is left out — no ⋯ on a card', () => {
    const html = render(createElement(AllOfCustomerDock, { label: 'All of Brand Alpha · Read only', model: model(state), actions: { onAnswer: () => undefined } }))
    const text = textOf(html)
    // F-OP-206: the foot's ONE info icon says the keys and that seeing a line marks nothing read.
    expect(html).toContain('aria-label="J / K walk · Enter answers · Space shows the whole message. Seeing a line here marks nothing read: open its thread."')
    expect(text).toContain('View: All')
    expect(text).toContain('Kind: Every kind')
    expect(text).toContain('SO-0142 · Your order 12')
    expect(text).toContain('Brand Alpha (general)')
    expect(text).toContain('1 new · Show')
    expect(text).toContain('New')
    expect(text).toContain('Answer') // F-OP-216: the door's short word; its name keeps the record
    expect(html).toContain('aria-label="Answer in the thread of SO-0142 · Your order 12"')
    expect(text).not.toContain('Answer in its conversation')
    expect(text).toContain('Show older')
    expect(text).toContain('1 thread of Brand Alpha you cannot open is left out.')
    expect(html).not.toContain('fw-rt-msg-more')
    // The chip is a real link to the record (⌘-click opens a new tab).
    expect(html).toContain('href="/w/x/sales/orders/so-1"')
    expect(leftKeys(html, ['allOfCustomer', 'view', 'kind', 'chip'])).toEqual([])
    const italian = render(createElement(AllOfCustomerDock, { label: 'Tutto di Brand Alpha · Sola lettura', model: model(state), actions: { onAnswer: () => undefined } }), 'it')
    expect(textOf(italian)).toContain('Rispondi')
    expect(italian).toContain('aria-label="Rispondi nella conversazione di SO-0142 · Ordine 12 del cliente"')
    expect(textOf(italian)).toContain('Brand Alpha (generale)')
    expect(textOf(italian)).toContain('Vista: Tutto')
    expect(textOf(italian)).toContain('Tipo: Ogni tipo')
    expect(textOf(italian)).toContain('SO-0142 · Ordine 12 del cliente')
    expect(leftKeys(italian, ['allOfCustomer', 'view', 'kind', 'chip'])).toEqual([])
  })

  it('without a dock to switch, the door is a link to the message on its record’s page', () => {
    const html = render(createElement(AllOfCustomerFeed, { model: model(state) }))
    expect(html).toContain('href="/w/x/sales/orders/so-1?message=m3"')
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
    const body = html.indexOf('class="fw-rt-body"')
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
  const file = (id: string, status: 'AVAILABLE' | 'QUARANTINED' = 'AVAILABLE') => ({ id, name: `${id}.pdf`, sizeBytes: 10, contentType: 'application/pdf', status })

  it('the gist: the message\'s own words in one run (the quoted reply left out), at most two lines\' worth; an erased one says why', () => {
    const card = cardOfEntry(entry('m1', 10))
    expect(gistOf({ ...card, body: 'Can we move the delivery?\n\nOn 12 Nov, Alex wrote:\n> the old text' })).toEqual({ text: 'Can we move the delivery?' })
    expect(gistOf({ ...card, body: 'one\n  two\tthree' })).toEqual({ text: 'one two three' })
    const long = gistOf({ ...card, body: 'x'.repeat(600) })
    expect('text' in long && long.text.length).toBe(GIST_CHARS)
    expect(gistOf({ ...card, erased: true })).toEqual({ key: 'erased.line', ns: 'record-thread-card' })
    expect(gistOf({ ...card, body: '', files: [file('f1')] })).toEqual({ key: 'allOfCustomer.filesOnly', ns: 'record-thread' })
  })

  it('at most three file chips and "+N" for the rest; a file in quarantine or without files.read is only counted', () => {
    expect(LINE_FILES).toBe(3)
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => file(id))
    expect(lineFilesOf(five, true)).toEqual({ shown: five.slice(0, 3), more: 2 })
    expect(lineFilesOf(five.slice(0, 2), true)).toEqual({ shown: five.slice(0, 2), more: 0 })
    expect(lineFilesOf([file('q', 'QUARANTINED'), file('a')], true)).toEqual({ shown: [file('a')], more: 1 })
    expect(lineFilesOf(five, false)).toEqual({ shown: [], more: 5 })
  })

  it('who reads it: the customer\'s messages and ours reach them; a note stays in the office; the time of day today, else the date', () => {
    expect(lineAudienceOf({ kind: 'theirs' })).toBe('shared')
    expect(lineAudienceOf({ kind: 'ours' })).toBe('shared')
    expect(lineAudienceOf({ kind: 'note' })).toBe('office')
    expect(lineAudienceOf({ kind: 'floor' })).toBe('office')
    expect(lineTimeOf('2026-11-18T09:12:00.000Z', 'en', '2026-11-18')).toBe('10:12')
    expect(lineTimeOf('2026-11-16T09:12:00.000Z', 'en', '2026-11-18')).toMatch(/^16 Nov 10:12$/)
  })

  it('a line: chip · New · who reads it · time, then "author: words"; the edge in the audience\'s colour; the card only after More', () => {
    const state = afterFirst(EMPTY_FEED, answer([entry('m2', 20, ORDER, { new: true }), entry('m1', 10, ORDER, { direction: 'INTERNAL_NOTE', audience: 'OFFICE' })]))
    const html = render(createElement(AllOfCustomerFeed, { model: model(state), actions: { onAnswer: () => undefined } }))
    expect(html.match(/class="fw-aoc-line is-shared is-new"/g)?.length).toBe(1)
    expect(html.match(/class="fw-aoc-line is-office"/g)?.length).toBe(1)
    const text = textOf(html)
    expect(text).toContain('Brand Alpha reads it')
    expect(text).toContain('Office only')
    expect(text).toContain('Madeup Buyer: Message m2')
    // Collapsed: no card drawn; More says it opens (aria-expanded), the region it controls is there and hidden.
    expect(html).not.toContain('class="fw-rt-msg ')
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(2)
    expect(html).toContain('aria-controls="fw-aoc-whole-m2"')
    expect(html).toContain('id="fw-aoc-whole-m2" class="fw-aoc-whole" hidden=""')
    const italian = textOf(render(createElement(AllOfCustomerFeed, { model: model(state) }), 'it'))
    expect(italian).toContain('Brand Alpha lo legge')
    expect(italian).toContain('Solo ufficio')
    expect(italian).toContain('Altro')
    expect(leftKeys(render(createElement(AllOfCustomerFeed, { model: model(state) }), 'it'), ['allOfCustomer', 'erased'])).toEqual([])
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
    // RC3: the 2–5 px gaps and the 2 px / 3 px chip padding are gone; the line is 8 / 10 px, 8 px apart, its chips 20 px high.
    expect(css).not.toMatch(/var\(--nds-space-[235]\)/)
    expect(css).toMatch(/\.fw-aoc-line \{[^}]*padding: var\(--nds-space-8\) var\(--nds-space-10\);/)
    expect(css).toMatch(/\.fw-aoc-list \{[^}]*gap: var\(--nds-space-8\);/)
    expect(css).toMatch(/\.fw-aoc-chip \{[^}]*height: 20px;[^}]*padding: 0 var\(--nds-space-8\);/)
    expect(css).toMatch(/\.fw-aoc-line\.is-office \{[^}]*background: var\(--nds-warning-soft\);/)
    // RC2: the body scrolls in the card (.fw-rt-body), never the feed itself.
    expect(css).not.toMatch(/overflow-y:\s*auto/)
  })
})
// ---- end F-OP-205

// ---- F-OP-206 (order page plan N4; 11-dock §3.3; D7): the keys and the a11y of the list — a feed of articles, ONE tab stop --------------
describe('F-OP-206 — J / K walk the lines, Enter answers, Space shows the whole message; one tab stop', () => {
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
    expect(html).toMatch(/<div class="fw-aoc-list" role="feed" aria-busy="false" aria-label="Messages with Brand Alpha, newest first">/)
    expect(html).toContain('<article class="fw-aoc-line is-shared" tabindex="0" aria-posinset="1" aria-setsize="-1" aria-labelledby="fw-aoc-m2-chip fw-aoc-m2-author fw-aoc-m2-time">')
    expect(html).toContain('<article class="fw-aoc-line is-shared" tabindex="-1" aria-posinset="2" aria-setsize="-1" aria-labelledby="fw-aoc-m1-chip fw-aoc-m1-author fw-aoc-m1-time">')
    for (const id of ['fw-aoc-m2-chip', 'fw-aoc-m2-author', 'fw-aoc-m2-time']) expect(html).toContain(`id="${id}"`)
    const second = html.slice(html.indexOf('aria-posinset="2"'))
    expect(second.match(/<(a|button)[^>]*tabindex="-1"/g)?.length).toBeGreaterThanOrEqual(3)
    const first = html.slice(html.indexOf('aria-posinset="1"'), html.indexOf('aria-posinset="2"'))
    expect(first).not.toMatch(/<(a|button)[^>]*tabindex="-1"/)
    const older = render(createElement(AllOfCustomerFeed, { model: model({ ...state, older: 'loading' }) }))
    expect(older).toContain('role="feed" aria-busy="true"')
  })

  it('the sources: keys on the line itself only (a control keeps its own Enter); Enter presses the line\'s door; no list role lost', () => {
    const view = readFileSync(new URL('./view/AllOfCustomerFeed.tsx', import.meta.url), 'utf8')
    expect(view).toContain('if (event.target !== event.currentTarget) return')
    expect(view).toContain("else if (act.kind === 'answer') (doorButton.current ?? doorLink.current)?.click()")
    expect(view).toContain("if (act.kind === 'expand') onToggle()")
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

  it('the doors drawn: "Answer" (its name the thread it answers in) asks the frame; another record "Open …" is a real link', () => {
    const asked: unknown[] = []
    const html = render(createElement(AllOfCustomerFeed, { model: model(state), actions: { canAnswer: onlyThisOrder, onCompose: (ask) => asked.push(ask), onAnswer: () => undefined } }))
    expect(html.match(/aria-label="Answer in the thread of SO-0142 · Your order 12"/g)?.length).toBe(2)
    expect(html).toContain('href="/w/x/sales/orders/so-9?message=m1"')
    expect(textOf(html)).toContain('Open SO-0150')
    // Without the host's threads the door is what it was (Answer through onAnswer, or the message's link).
    expect(render(createElement(AllOfCustomerFeed, { model: model(state) }))).toContain('href="/w/x/sales/orders/so-1?message=m3"')
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
    expect(view).toContain("const scroller = root.current?.closest<HTMLElement>('.fw-rt-body')")
    expect(view).toContain('if (scrolledTo > 0) scroller.scrollTop = scrolledTo')
    // The hosts call the container on every render (it reads only while All shows), so leaving All never drops it.
    const order = readFileSync(new URL('../../../sales/orders/record/dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(order).toMatch(/const feed = useAllOfCustomer\(api, \{ partyId: order\.partyId, customerName: customer, enabled: scope\.kind === 'all'/)
    expect(feedModel(EMPTY_FEED, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true }).scrollTop).toBe(0)
    expect(feedModel(EMPTY_FEED, { customerName: 'Brand Alpha', prefix: '/w/x', view: 'all', kind: 'every', canReadFiles: true, scrollTop: 420 }).scrollTop).toBe(420)
  })
})
// ---- end F-OP-208
