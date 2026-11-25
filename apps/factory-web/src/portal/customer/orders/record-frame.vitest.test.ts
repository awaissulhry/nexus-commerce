import { readFileSync } from 'node:fs'
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
// F-SA-264
import { bandThreadOf, DEFAULT_PORTAL_DOCK_WIDTH, isPortalThreadKey, PORTAL_DOCK_COLUMNS, PORTAL_DOCK_COLUMNS_OF, PORTAL_DOCK_WIDTHS, portalFirstWidth, portalHiddenKey, portalWidthKey, readPortalDock, writePortalDock } from '../../shell/record/model'
import { PortalRecordFrame } from '../../shell/record/PortalRecordFrame'
import type { OrderRecord } from './api'
import { orderBandOf, orderTabsOf, type OrderBandFacts } from './band'
import { documentsRead, orderRecord, orderWords, progressRead, requestsOf, shellOf, shipmentsRead, threadOf, words } from './design-data'
import { withThreadButton } from '../../shell/fixtures'
import { madeFromOf, orderNameOf, orderRefOf, orderThreadHref, RECORD_TABS, recordHref, stateLineKey, tabOf, threadHref, type RecordTab } from './model'
import { CustomerCase, type CustomerCaseBuilder } from './view/CustomerCase'
import type { OrderRecordViewModel } from './view/OrderRecordView'
import { ReaderProvider, useT } from '../../../lib/i18n/provider' // pp-w1 (w1.4)
import { WithMessages } from '../../../record-panels/i18n' // pp-w1 (w1.4)

/**
 * B-TH-275 (threads plan TH-6; P-CUS-ORD.band, .body, .thread; picture 22; wall W02, W08, W09, W10, W13, W14, W36): the customer's
 * order on the portal record frame — 5 → 4 tabs (pp-w1: Overview, Lines, Shipments, Files, under the band), the conversation docked
 * (no Messages tab, no Ask modal), an old `?tab=messages` lands on Overview with the conversation shown, "Your order is confirmed" only
 * for a CONFIRMED order, the customer's own number and never the office's SO- series, and Brand Beta's page holds nothing of Brand
 * Alpha.
 */

const PREFIX_BETA = `/p/${BRAND_BETA.code}`
const t = (locale: Locale) => words(locale)
const FACTS: OrderBandFacts = { ask: { held: null }, cancelHeld: null, reconfirm: null, confirmation: true, pay: null }

describe('tabs 5 → 4: the conversation docks, never a Messages tab', () => {
  it('four tabs in order; Messages is gone', () => {
    expect([...RECORD_TABS]).toEqual(['overview', 'lines', 'shipments', 'files'])
    expect((RECORD_TABS as readonly string[]).includes('messages')).toBe(false)
  })

  it('an old ?tab=messages (a list, a mail, a notification) opens Overview, with the conversation shown and focused', () => {
    expect(tabOf('messages')).toBe('overview')
    // pp-w1 (w1.3): the old ids keep their links working.
    expect(tabOf('status')).toBe('overview')
    expect(tabOf('documents')).toBe('files')
    expect(tabOf('constructor')).toBe('overview')
    const href = orderThreadHref('/p/X', 'o1')
    expect(href).toBe('/p/X/orders/o1?tab=messages')
    expect(portalArrivalOf(href.slice(href.indexOf('?')))).toEqual({ openThread: true, focus: true })
    // The list's New messages cell opens the same door; a request keeps its own page.
    const order = { kind: 'order', order: { id: 'o1', kind: 'ORDER' } } as unknown as Parameters<typeof threadHref>[1]
    expect(threadHref('/p/X', order)).toBe('/p/X/orders/o1?tab=messages')
    expect(recordHref('/p/X', 'o1', 'shipments' as RecordTab)).toBe('/p/X/orders/o1?tab=shipments')
  })

  it('the band: "Your order 11", their PO and "Ask a question" about the order by its own name; the four link tabs under it', () => {
    const record = orderRecord()
    const band = orderBandOf({ words: orderWords('en'), record, prefix: '/p/X', facts: FACTS })
    expect(band.title).toBe('Your order 11')
    expect(band.refs).toEqual({ theirs: record.order.customerRef, ours: null })
    // pp-w1 (w1.3, D6 a): the tabs left the band for the body (orderTabsOf).
    expect(band.tabs ?? null).toBeNull()
    expect(orderTabsOf({ words: orderWords('en'), record, prefix: '/p/X', toConfirm: false, files: null }).map((item) => item.id)).toEqual([...RECORD_TABS])
    expect(band.ask).toEqual({ type: 'SalesOrder', id: record.order.id, label: 'Your order 11' })
    expect(JSON.stringify(band, (_key, value) => (typeof value === 'function' ? undefined : value))).not.toMatch(/\bSO-\d{4}-\d+/)
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
    // pp-w1 (C-1): the office's number is no longer in the web's read; it must never be drawn either (asserted below).
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
    tab: 'overview',
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
    dialog: null,
    frame: { mode: 'docked' },
    madeFrom: { kind: 'request', href: `${PREFIX_BETA}/orders/requests/${BRAND_BETA.ids.thread}`, label: '#2' },
    ...over,
  }
}

function betaCase(record: OrderRecord, tab: RecordTab, over: Partial<OrderRecordViewModel> = {}): CustomerCaseBuilder {
  return (locale) => ({
    // pp-w1 (w1.1): the frame's "Messages (2 new)" rides in the band (the design's band carries it: withThreadButton).
    // pp-w2: "Made from your request #2" is the band's (the Overview draws it no more), from the page's summary read.
    shell: shellOf(locale, withThreadButton(orderBandOf({ words: orderWords(locale), record, prefix: PREFIX_BETA, facts: { ...FACTS, madeFrom: betaModel(record, { tab, ...over }).madeFrom ?? null } }), betaModel(record, { tab, ...over }).frame), {
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
    const html = draw(betaCase(betaRecord(), 'overview'), 'en')
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
    const confirmed = textOf(draw(betaCase(betaRecord({ status: 'CONFIRMED', words: CUSTOMER_STATUS_WORDS.CONFIRMED }), 'overview'), 'en'))
    expect(confirmed).toContain('Your order is confirmed.')
    expect(confirmed).toContain('Made from your request #2')
    const waiting = textOf(draw(betaCase(betaRecord({ status: 'REQUESTED', words: CUSTOMER_STATUS_WORDS.REQUESTED }), 'overview'), 'en'))
    expect(waiting).toContain('We received your order: it waits for our approval.')
    expect(waiting).not.toContain('Your order is confirmed.')
    const shipped = textOf(draw(betaCase(betaRecord({ status: 'PARTLY_SHIPPED', words: CUSTOMER_STATUS_WORDS.PARTLY_SHIPPED }), 'overview', { madeFrom: null }), 'en'))
    expect(shipped).not.toContain('Your order is confirmed.')
    expect(shipped).not.toContain('Made from your')
  })

  it('a missing order draws no conversation (the same words for another customer’s order)', () => {
    const html = draw(betaCase(betaRecord(), 'overview', { state: 'missing', record: null }), 'en')
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

// ---- F-SA-264 (sales page plan N6, R6, P11, P20) + pp-w1 (w1.1; L3, L8): the dock's widths (a third · 40 % · half) and Hide / Show
// (⌘J), kept on this device per person like the office's — drawn as rows of the thread head's ⋯ (the frame hands the thread its
// `width` + `choose`); the first width is the office's rule; the band holds "Messages (2 new)" when the conversation is off screen ---
describe('F-SA-264 / pp-w1 — the customer’s conversation: ONE head row, the office’s first width, Hide / Show, remembered per person', () => {
  const memory = () => {
    const store = new Map<string, string>()
    return { store, storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } }
  }

  it('three widths as the office’s dock (a third · 40 % · half); the first width is the office’s: a third below 1600 px, 40 % from 1600 (L8)', () => {
    expect([...PORTAL_DOCK_WIDTHS]).toEqual(['third', 'forty', 'half'])
    expect(PORTAL_DOCK_COLUMNS_OF.forty).toBe(PORTAL_DOCK_COLUMNS)
    expect(PORTAL_DOCK_COLUMNS_OF.third).toBe('minmax(0, 2fr) minmax(0, 1fr)')
    expect(PORTAL_DOCK_COLUMNS_OF.half).toBe('minmax(0, 1fr) minmax(0, 1fr)')
    expect([1280, 1440, 1599, 1600, 1920].map(portalFirstWidth)).toEqual(['third', 'third', 'third', 'forty', 'forty'])
    // Before the window is known (a server render, a design case naming none): today's 40 %.
    expect(DEFAULT_PORTAL_DOCK_WIDTH).toBe('forty')
  })

  it('kept per person on this device: a chosen width (40 % too) and "hidden"; nothing chosen is null (the first width); reset forgets', () => {
    const { store, storage } = memory()
    const beta = BRAND_BETA.portalPerson.email
    expect(readPortalDock(storage, 'u-beta')).toEqual({ width: null, hidden: false })
    writePortalDock(storage, 'u-beta', { width: 'half' })
    writePortalDock(storage, 'u-beta', { hidden: true })
    expect(readPortalDock(storage, 'u-beta')).toEqual({ width: 'half', hidden: true })
    expect(readPortalDock(storage, 'u-other')).toEqual({ width: null, hidden: false })
    // Keyed by the person's id, never by a name or an e-mail.
    expect([...store.keys()].sort()).toEqual([portalHiddenKey('u-beta'), portalWidthKey('u-beta')].sort())
    expect([...store.keys()].join(' ')).not.toContain(beta)
    // 40 % chosen at 1440 (where the first width is a third) is a choice: kept.
    writePortalDock(storage, 'u-beta', { width: 'forty', hidden: false })
    expect(readPortalDock(storage, 'u-beta')).toEqual({ width: 'forty', hidden: false })
    writePortalDock(storage, 'u-beta', { width: null })
    expect(store.size).toBe(0)
    const closed = { getItem: () => { throw new Error('closed') }, setItem: () => { throw new Error('closed') }, removeItem: () => { throw new Error('closed') } }
    expect(readPortalDock(closed, 'u-beta')).toEqual({ width: null, hidden: false })
    expect(() => writePortalDock(closed, 'u-beta', { width: 'third', hidden: true })).not.toThrow()
  })

  it('⌘J / Ctrl J hides and shows it, never with Alt or Shift (the page’s own J / K walk is without ⌘); the keys window names it', () => {
    const key = (more: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more })
    expect(isPortalThreadKey(key({ metaKey: true }))).toBe(true)
    expect(isPortalThreadKey(key({ ctrlKey: true, key: 'J' }))).toBe(true)
    expect(isPortalThreadKey(key({ metaKey: true, altKey: true }))).toBe(false)
    expect(isPortalThreadKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isPortalThreadKey(key({}))).toBe(false)
    const page = readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("if ((event.key !== 'j' && event.key !== 'k') || event.metaKey || event.ctrlKey || event.altKey) return")
    expect(orderBandOf({ words: orderWords('en'), record: betaRecord(), prefix: PREFIX_BETA, facts: FACTS }).keys?.some((entry) => entry.keys.join('') === '⌘J')).toBe(true)
  })

  it('docked: ONE head row — the frame draws no tools row and no door; it hands the thread its widths, the current one and the chooser', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = draw(betaCase(betaRecord(), 'overview', { frame: { mode: 'docked', width: 'half' } }), locale)
      expect(html).not.toContain('fw-prf-tools')
      expect(html).not.toContain('fw-prf-door')
      expect(html).toContain('data-width="half"')
      expect(html).toContain('--fw-prf-cols:minmax(0, 1fr) minmax(0, 1fr)')
      expect(html).not.toContain('is-hidden')
      expect(scanText(html, BRAND_ALPHA)).toEqual([])
    }
    // The thread (PortalThread live) receives `width` + `choose`: its head's ⋯ draws a third · 40 % · half, Hide, Default (pt-'s rows).
    const handed: Array<{ width?: unknown; choose?: unknown }> = []
    function Probe(props: { width?: unknown; choose?: unknown }) {
      handed.push(props)
      return null
    }
    const frameOf = (design: { mode: 'docked' | 'stacked'; width?: 'third' | 'forty' | 'half'; hidden?: boolean }) =>
      render(createElement(PortalRecordFrame, { thread: createElement(Probe), threadLabel: 'Messages: Your order 4', design, children: createElement('p', null, 'body') }))
    frameOf({ mode: 'docked', width: 'third' })
    expect(handed.at(-1)?.width).toEqual({ widths: ['third', 'forty', 'half'], current: 'third' })
    expect(typeof handed.at(-1)?.choose).toBe('function')
    // Off screen (hidden, or narrower), nothing to choose: no rows.
    frameOf({ mode: 'docked', width: 'third', hidden: true })
    expect(handed.at(-1)?.width).toBeUndefined()
    frameOf({ mode: 'stacked' })
    expect(handed.at(-1)?.choose).toBeUndefined()
  })

  it('hidden: the body takes the whole width, the band’s "Messages (2 new)" brings it back (no lone row); the conversation stays mounted', () => {
    const html = draw(betaCase(betaRecord(), 'lines', { frame: { mode: 'docked', hidden: true, newCount: 2 } }), 'en')
    expect(html).toContain('class="fw-prf has-thread is-hidden"')
    expect(html).toContain('fw-pband-thread')
    expect(textOf(html)).toContain('Messages (2 new)')
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(html.indexOf('fw-pband-thread')).toBeLessThan(html.indexOf('id="main-content"'))
    const it = textOf(draw(betaCase(betaRecord(), 'lines', { frame: { mode: 'docked', hidden: true } }), 'it'))
    expect(it).toContain('Messaggi')
    expect(bandThreadOf({ hasThread: true, mode: 'docked', hidden: true, viewOpen: false, count: 3 })).toEqual({ count: 3 })
    expect(bandThreadOf({ hasThread: true, mode: 'docked', hidden: false, viewOpen: false, count: 3 })).toBeNull()
    expect(bandThreadOf({ hasThread: true, mode: 'stacked', hidden: false, viewOpen: false, count: 0 })).toEqual({ count: 0 })
    expect(bandThreadOf({ hasThread: true, mode: 'stacked', hidden: false, viewOpen: true, count: 2 })).toBeNull()
    expect(bandThreadOf({ hasThread: false, mode: 'stacked', hidden: false, viewOpen: false, count: 2 })).toBeNull()
    // A hidden docked conversation marks nothing read (it is not on screen).
    const frame = readFileSync(new URL('../../shell/record/PortalRecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain("const onScreen = (mode === 'docked' && !dockHidden) || viewOpen")
  })

  it('narrower than 1280 px: no head rows; the band’s "Messages (2 new)" opens the full-width view (one button, no body row)', () => {
    const html = draw(betaCase(betaRecord(), 'overview', { frame: { mode: 'stacked', newCount: 2 } }), 'en')
    expect(html).not.toContain('fw-prf-bar')
    expect(textOf(html).match(/Messages \(2 new\)/g)?.length).toBe(1)
    expect(html).toContain('aria-label="Messages, 2 new"')
  })

  // pt-w2 / pp-w1: the thread's face is the shared one (lib/record-thread/partner) — the frame only hands it the dock's choices.
  it('the frame keeps the person’s choices (the design review none); "Ask a question" and an old address show a hidden conversation again', () => {
    const frame = readFileSync(new URL('../../shell/record/PortalRecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('const keepFor = design ? null : person')
    expect(frame).toContain('if (keepFor) writePortalDock(storageOf(), keepFor, { hidden: next })')
    expect(frame).toContain('if (keepFor) writePortalDock(storageOf(), keepFor, { width: next, hidden: false })')
    expect(frame).toContain('if (keepFor) writePortalDock(storageOf(), keepFor, { width: null, hidden: false })')
    expect(frame).toContain("if (mode === 'docked' && hidden) setHidden(false)")
    expect(frame).toContain('if (!narrow) setHidden(false)')
    expect(frame).toContain('portalFirstWidth(roomy ? THIRD_BELOW : DOCK_FROM)')
  })

  it('the words in both languages ("voi" pages): the band’s button reads the frame’s Messages words; the old row’s words are gone', () => {
    const en = CATALOGUE.en.portal!
    const it = CATALOGUE.it.portal!
    for (const words of [en, it]) {
      for (const key of ['record.frame.messagesNew_one', 'record.frame.messagesNew_other', 'record.frame.messagesMany']) expect(words[key], key).toContain('{count}')
      for (const gone of ['record.frame.width', 'record.frame.third', 'record.frame.forty', 'record.frame.half', 'record.frame.hide', 'record.frame.show', 'record.frame.showNew_one', 'record.frame.showMany']) expect(words[gone], gone).toBeUndefined()
    }
  })
})
// ---- end F-SA-264

// ---- pp-w1 (w1.4): the order's notices in the office's ONE notice slot (lib/record-frame RecordNotices), in the portal's words -----
describe('w1.4 — the notices: one slot, the most serious first, the rest behind "N more notices"; the portal says "voi"', () => {
  it('a failure first, then the lost connection, then what was just sent — all inside RecordNotices', () => {
    const html = draw(betaCase(betaRecord(), 'overview', { offlineSince: '2026-11-25T08:00:00Z', notice: { tone: 'danger', key: 'docs.downloadFailed' } }), 'en')
    expect(html.match(/class="fw-rcf-notices[" ]/g)?.length).toBe(1)
    const slot = html.slice(html.indexOf('fw-rcf-notices-list'))
    const failed = slot.indexOf('The document could not be downloaded.')
    const offline = slot.indexOf('No connection — showing what was loaded at')
    expect(failed).toBeGreaterThan(0)
    expect(offline).toBeGreaterThan(failed)
    const sent = draw(betaCase(betaRecord(), 'overview', { offlineSince: '2026-11-25T08:00:00Z', notice: { tone: 'success', key: 'notice.changeSent' } }), 'en')
    const after = sent.slice(sent.indexOf('fw-rcf-notices-list'))
    expect(after.indexOf('No connection')).toBeLessThan(after.indexOf('Your change request was sent.'))
    const view = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("import { RecordNotices } from '../../../../lib/record-frame/RecordNotices'")
  })

  it('"Hide 2 notices" in the portal reads the voi form (outside words); the office keeps its own', () => {
    const fewer = (reader: 'office' | 'outside') => {
      let said = ''
      function Probe() {
        said = useT('record-frame')('notices.fewer', { count: 2 })
        return null
      }
      render(createElement(ReaderProvider, { reader }, createElement(WithMessages, { namespaces: ['record-frame'] }, createElement(Probe))), 'it')
      return said
    }
    expect(fewer('outside')).toBe('Nascondete 2 avvisi')
    expect(fewer('office')).toBe('Nascondi 2 avvisi')
  })
})
// ---- end pp-w1 (w1.4)
