import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CUSTOMER_ORDER_STATUSES, CUSTOMER_STATUS_WORDS } from '@nexus/factory-domain/sales/portal-orders/status'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { portalArrivalOf } from '../../shell/record/model'
import type { OrderRecord } from './api'
import { orderBandOf, type OrderBandFacts } from './band'
import { documentsRead, orderRecord, orderWords, progressRead, requestsOf, shellOf, shipmentsRead, threadOf, words } from './design-data'
import { madeFromOf, orderNameOf, orderRefOf, orderThreadHref, RECORD_TABS, recordHref, stateLineKey, tabOf, threadHref, type RecordTab } from './model'
import { CustomerCase, type CustomerCaseBuilder } from './view/CustomerCase'
import type { OrderRecordViewModel } from './view/OrderRecordView'

/**
 * B-TH-275 (threads plan TH-6; P-CUS-ORD.band, .body, .thread; picture 22; wall W02, W08, W09, W10, W13, W14, W36): the customer's
 * order on the portal record frame — 5 → 4 tabs (Status & progress, Lines, Shipments & tracking, Documents), the conversation docked
 * (no Messages tab, no Ask modal), an old `?tab=messages` lands on Status with the conversation shown, "Your order is confirmed" only
 * for a CONFIRMED order, the customer's own number and never the office's SO- series, and Brand Beta's page holds nothing of Brand
 * Alpha.
 */

const PREFIX_BETA = `/p/${BRAND_BETA.code}`
const t = (locale: Locale) => words(locale)
const FACTS: OrderBandFacts = { changeHeld: null, cancelHeld: null, reconfirm: null, shipments: 1, moves: 0, confirmation: true, pay: null }

describe('tabs 5 → 4: the conversation docks, never a Messages tab', () => {
  it('four tabs in order; Messages is gone', () => {
    expect([...RECORD_TABS]).toEqual(['status', 'lines', 'shipments', 'documents'])
    expect((RECORD_TABS as readonly string[]).includes('messages')).toBe(false)
  })

  it('an old ?tab=messages (a list, a mail, a notification) opens Status & progress, with the conversation shown and focused', () => {
    expect(tabOf('messages')).toBe('status')
    expect(tabOf('documents')).toBe('documents')
    expect(tabOf('constructor')).toBe('status')
    const href = orderThreadHref('/p/X', 'o1')
    expect(href).toBe('/p/X/orders/o1?tab=messages')
    expect(portalArrivalOf(href.slice(href.indexOf('?')))).toEqual({ openThread: true, focus: true })
    // The list's New messages cell opens the same door; a request keeps its own page.
    const order = { kind: 'order', order: { id: 'o1', kind: 'ORDER' } } as unknown as Parameters<typeof threadHref>[1]
    expect(threadHref('/p/X', order)).toBe('/p/X/orders/o1?tab=messages')
    expect(recordHref('/p/X', 'o1', 'shipments' as RecordTab)).toBe('/p/X/orders/o1?tab=shipments')
  })

  it('the band: "Your order 11", their PO, four link tabs and "Ask a question" about the order by its own name', () => {
    const record = orderRecord()
    const band = orderBandOf({ words: orderWords('en'), record, tab: 'status', prefix: '/p/X', facts: FACTS })
    expect(band.title).toBe('Your order 11')
    expect(band.refs).toEqual({ theirs: record.order.customerRef, ours: null })
    expect(band.tabs?.items.map((item) => item.id)).toEqual(['status', 'lines', 'shipments', 'documents'])
    expect(band.ask).toEqual({ type: 'SalesOrder', id: record.order.id, label: 'Your order 11' })
    expect(JSON.stringify(band, (key, value) => (typeof value === 'function' ? undefined : value))).not.toMatch(/\bSO-\d{4}-\d+/)
  })
})

describe('the customer’s own number (plan §0.5, B-TH-303) — never the office’s series', () => {
  it('"Your order 12" / "Il vostro ordine 12"; "#12" where one short reference is needed; else their PO, else words', () => {
    const order = { yourNumber: customerNumberOf('ORDER', 12), customerRef: 'BETA-PO-0077' }
    expect(orderNameOf(order, 'en', t('en'))).toBe('Your order 12')
    expect(orderNameOf(order, 'it', t('it'))).toBe('Il vostro ordine 12')
    expect(orderRefOf(order, t('en'))).toBe('#12')
    expect(orderNameOf({ yourNumber: null, customerRef: 'BETA-PO-0077' }, 'en', t('en'))).toBe('Your order BETA-PO-0077')
    expect(orderNameOf({ yourNumber: null, customerRef: null }, 'en', t('en'))).toBe('Your order')
    expect(orderRefOf({ yourNumber: null, customerRef: null }, t('en'))).toBe('this order')
  })
})

describe('"Your order is confirmed" only for a CONFIRMED order (L2-G06, B-TH-006)', () => {
  it('confirmed → the sentence; waiting for our approval → received, waiting; any later state → nothing here', () => {
    for (const status of CUSTOMER_ORDER_STATUSES) {
      const key = stateLineKey(status)
      if (status === 'CONFIRMED') expect(key).toBe('status.confirmed')
      else if (status === 'REQUESTED') expect(key).toBe('status.waitsApproval')
      else expect(key, status).toBeNull()
    }
    expect(CATALOGUE.en['portal-orders']!['status.confirmed']).toBe('Your order is confirmed.')
    expect(CATALOGUE.en['portal-orders']!['status.waitsApproval']).not.toMatch(/confirmed/i)
  })
})

describe('"Made from your request" (the order’s summary read, B-TH-076)', () => {
  const request = { recordType: 'Inquiry', recordId: 'q1', label: '#7' }
  const quote = { recordType: 'Quote', recordId: 'k1', label: '#3' }

  it('a request behind the order (directly, or behind its quote) opens the request page; a quote alone opens its conversation page', () => {
    expect(madeFromOf('/p/X', request, null)).toEqual({ kind: 'request', href: '/p/X/orders/requests/q1', label: '#7' })
    expect(madeFromOf('/p/X', quote, request)).toEqual({ kind: 'request', href: '/p/X/orders/requests/q1', label: '#7' })
    expect(madeFromOf('/p/X', quote, null)).toEqual({ kind: 'quote', href: '/p/X/open/Quote/k1?view=conversation', label: '#3' })
    expect(madeFromOf('/p/X', null, null)).toBeNull()
    expect(madeFromOf('/p/X', { recordType: 'Party', recordId: 'p1', label: null }, null)).toBeNull()
  })
})

// ---- the page as Brand Beta reads it ------------------------------------------------------------------------------------------
function betaRecord(over: Partial<OrderRecord['order']> = {}): OrderRecord {
  return orderRecord({
    // The office's number is in the read and must never be drawn.
    number: BRAND_BETA.numbers.order,
    yourNumber: customerNumberOf('ORDER', 4),
    customerRef: BRAND_BETA.customerRef,
    shipTo: { name: `${BRAND_BETA.legalName} — Lager`, line1: BRAND_BETA.address.line1, postalCode: BRAND_BETA.address.postalCode, city: BRAND_BETA.address.city, country: BRAND_BETA.address.country },
    ...over,
  })
}

function betaModel(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    tab: 'status',
    prefix: PREFIX_BETA,
    offlineSince: null,
    notice: null,
    revision: { state: 'ready', page: null },
    reconfirmHeld: null,
    progress: { state: 'ready', read: progressRead() },
    requests: { state: 'ready', items: requestsOf().map((item) => ({ ...item, orderNumber: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef })) },
    withdrawHeld: null,
    changeHeld: null,
    pay: {},
    shipments: { state: 'ready', read: shipmentsRead() },
    documents: { state: 'ready', read: documentsRead() },
    fileHeld: null,
    openLine: null,
    copied: null,
    historyOpen: false,
    dialog: null,
    frame: { mode: 'docked' },
    madeFrom: { kind: 'request', href: `${PREFIX_BETA}/orders/requests/${BRAND_BETA.ids.thread}`, label: '#2' },
    ...over,
  }
}

function betaCase(record: OrderRecord, tab: RecordTab, over: Partial<OrderRecordViewModel> = {}): CustomerCaseBuilder {
  return (locale) => ({
    shell: shellOf(locale, orderBandOf({ words: orderWords(locale), record, tab, prefix: PREFIX_BETA, facts: FACTS }), {
      partyName: BRAND_BETA.legalName,
      person: { displayName: BRAND_BETA.portalPerson.name, email: BRAND_BETA.portalPerson.email },
      prefix: PREFIX_BETA,
      path: `/orders/${record.order.id}`,
    }),
    body: { kind: 'record', model: betaModel(record, { tab, ...over }), thread: threadOf(locale) },
  })
}

const draw = (build: CustomerCaseBuilder, locale: Locale) => render(createElement(CustomerCase, { model: build }), locale)

describe('Brand Beta’s order page (W02, W10, W13, W14): its own records, numbers and files only', () => {
  it('every tab, docked and narrow, in both languages: no Brand Alpha marker, no office SO- series', () => {
    const record = betaRecord()
    for (const locale of ['it', 'en'] as const) {
      for (const tab of RECORD_TABS) {
        for (const frame of [{ mode: 'docked' as const }, { mode: 'stacked' as const, newCount: 2 }, { mode: 'stacked' as const, viewOpen: true }]) {
          const html = draw(betaCase(record, tab, { frame }), locale)
          expect(scanText(html, BRAND_ALPHA), `${tab} ${frame.mode} (${locale})`).toEqual([])
          expect(html.match(/\bSO-\d{4}-\d+/)?.[0] ?? null, `${tab} ${frame.mode} (${locale})`).toBeNull()
          expect(html).not.toContain(BRAND_BETA.numbers.order)
        }
      }
    }
  })

  it('docked: ONE conversation beside the body, named, `#messages` for "Ask a question"; no Messages tab in the band', () => {
    const html = draw(betaCase(betaRecord(), 'status'), 'en')
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(html).toContain('id="messages"')
    expect(html).toContain('aria-label="Messages: Your order 4"')
    expect(html).toContain('data-mode="docked"')
    expect(textOf(html)).toContain('Your order 4')
    expect(html).not.toContain('tab=messages')
  })

  it('under 1280 px: "Messages (2 new)" opens the conversation full width', () => {
    const html = draw(betaCase(betaRecord(), 'lines', { frame: { mode: 'stacked', newCount: 2 } }), 'en')
    expect(html).toContain('data-mode="stacked"')
    expect(html).toContain('data-view="body"')
    expect(textOf(html)).toContain('Messages (2 new)')
    const open = draw(betaCase(betaRecord(), 'lines', { frame: { mode: 'stacked', viewOpen: true } }), 'en')
    expect(open).toContain('data-view="thread"')
  })

  it('the confirmed sentence shows on a CONFIRMED order only; "Made from your request #2" links its page', () => {
    const confirmed = textOf(draw(betaCase(betaRecord({ status: 'CONFIRMED', words: CUSTOMER_STATUS_WORDS.CONFIRMED }), 'status'), 'en'))
    expect(confirmed).toContain('Your order is confirmed.')
    expect(confirmed).toContain('Made from your request #2')
    const waiting = textOf(draw(betaCase(betaRecord({ status: 'REQUESTED', words: CUSTOMER_STATUS_WORDS.REQUESTED }), 'status'), 'en'))
    expect(waiting).toContain('We received your order: it waits for our approval.')
    expect(waiting).not.toContain('Your order is confirmed.')
    const shipped = textOf(draw(betaCase(betaRecord({ status: 'PARTLY_SHIPPED', words: CUSTOMER_STATUS_WORDS.PARTLY_SHIPPED }), 'status', { madeFrom: null }), 'en'))
    expect(shipped).not.toContain('Your order is confirmed.')
    expect(shipped).not.toContain('Made from your')
  })

  it('a missing order draws no conversation (the same words for another customer’s order)', () => {
    const html = draw(betaCase(betaRecord(), 'status', { state: 'missing', record: null }), 'en')
    expect(html).not.toContain('<aside')
    expect(textOf(html)).toContain('It is not one of your orders, or it no longer exists.')
  })
})

describe('the words exist in both languages with the same placeholders', () => {
  it('B-TH-275 keys', () => {
    for (const locale of ['it', 'en'] as const) {
      const catalogue = CATALOGUE[locale]['portal-orders']!
      for (const key of ['messages.label', 'status.confirmed', 'status.waitsApproval', 'status.madeFromRequest', 'status.madeFromRequestNone', 'status.madeFromQuote', 'status.madeFromQuoteNone', 'record.titleRef', 'record.titleNone', 'record.refNone']) {
        expect(catalogue[key], `${locale} ${key}`).toBeTruthy()
      }
      expect(catalogue['tabs.messages']).toBeUndefined()
    }
  })
})
