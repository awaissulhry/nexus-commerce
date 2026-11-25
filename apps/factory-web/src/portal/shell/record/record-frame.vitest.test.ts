import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { RecordView, type RecordSummaryModel } from '../view/RecordView'
import { ThreadView, type ThreadViewModel } from '../view/ThreadView'
import {
  accountConversationHref,
  askHref,
  bandThreadOf,
  conversationHref,
  messagesButtonWords,
  opensOwnPage,
  parentHref,
  PORTAL_DOCK_COLUMNS,
  PORTAL_DOCK_FROM,
  portalArrivalCleaned,
  portalArrivalOf,
  portalFrameMode,
  portalMainPixels,
  summaryTone,
  tabOrFirst,
} from './model'
import { PORTAL_ASK_EVENT, PortalRecordFrame } from './PortalRecordFrame'
import { PHONE_BELOW, threadPixels } from '../../../lib/record-frame/model' // pp-k1 k1.3: the portal's copies of these went; the core's

/**
 * B-TH-273 — the portal record frame (PL3): the conversation docked ~40 % from 1280 px, "Messages (2 new)" below, no Messages tab
 * and no Ask modal, old addresses kept (R-8); B-TH-274 — the portal's generic page (P-ANY, PL5): the summary beside the
 * conversation, a record's conversation as its own page, the account conversation. The brand wall: a Brand Beta page holds
 * nothing of Brand Alpha (scanText, B-TH-203).
 */

const PREFIX = `/p/${BRAND_BETA.code}`

const betaThread = (over: Partial<ThreadViewModel> = {}): ThreadViewModel => ({
  state: 'ready',
  title: 'Messages',
  record: null,
  companyName: 'Pelletteria Esempio',
  messages: [
    { id: 'm1', side: 'partner', channel: 'portal', author: { name: BRAND_BETA.portalPerson.name, mine: true }, body: BRAND_BETA.message, attachments: [{ id: BRAND_BETA.ids.file, name: BRAND_BETA.fileName, size: '84 KB', href: '#f' }], at: '2026-11-16T09:00:00Z', atText: '16/11/2026 10:00' },
    { id: 'm2', side: 'company', channel: 'email', author: { name: 'Marco Prova', mine: false }, body: 'We confirm the new chart for #7.', attachments: [], at: '2026-11-16T10:00:00Z', atText: '16/11/2026 11:00' },
  ],
  composer: { value: '', busy: false, heldReason: null, hint: null, limit: 20_000 },
  loadMore: null,
  accessLine: null,
  failed: null,
  ...over,
})

const frame = (mode: 'docked' | 'stacked', over: { viewOpen?: boolean; newCount?: number; thread?: boolean } = {}, locale: 'it' | 'en' = 'en') =>
  render(
    createElement(PortalRecordFrame, {
      thread: over.thread === false ? null : createElement(ThreadView, { model: betaThread() }),
      threadLabel: 'Messages about order #7',
      design: { mode, viewOpen: over.viewOpen, newCount: over.newCount },
      // `children` is a required prop of the frame: given in the props, not as createElement's third argument.
      children: createElement('p', null, `Status of ${BRAND_BETA.customerRef}`),
    }),
    locale,
  )

describe('B-TH-273 — where the conversation sits, and how wide', () => {
  it('docked from 1280 px; below, behind the "Messages" button (full width); the phone from 720 px down', () => {
    expect(PORTAL_DOCK_FROM).toBe(1280)
    expect(PHONE_BELOW).toBe(720) // pp-k1 k1.3: the core's (the portal kept no copy)
    expect(portalFrameMode(1920)).toBe('docked')
    expect(portalFrameMode(1280)).toBe('docked')
    expect(portalFrameMode(1279)).toBe('stacked')
    expect(portalFrameMode(375)).toBe('stacked')
  })

  it('a 3 : 2 grid of the portal main: ~450 px of 1140 at 1440, ~642 px of 1620 at 1920 (PL3)', () => {
    expect(PORTAL_DOCK_COLUMNS).toBe('minmax(0, 3fr) minmax(0, 2fr)')
    expect(portalMainPixels(1440)).toBe(1140)
    expect(portalMainPixels(1920)).toBe(1620)
    // pp-k1 k1.3: the core's threadPixels at 40 % (the portal's own copy went).
    expect(threadPixels(portalMainPixels(1440), 'forty')).toBe(450)
    expect(threadPixels(portalMainPixels(1920), 'forty')).toBe(642)
  })

  it('"Messages", "Messages (2 new)", "Messages (99+ new)"; the screen reader hears the count; words in both languages', () => {
    expect(messagesButtonWords(0)).toEqual({ key: 'record.frame.messages', label: null })
    expect(messagesButtonWords(2)).toEqual({ key: 'record.frame.messagesNew', count: 2, label: { key: 'record.frame.messagesNewLabel', count: 2 } })
    expect(messagesButtonWords(140)).toMatchObject({ key: 'record.frame.messagesMany', count: 99 })
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale].portal ?? {}
      for (const key of ['record.frame.messages', 'record.frame.messagesNew_one', 'record.frame.messagesNew_other', 'record.frame.messagesMany', 'record.frame.messagesNewLabel_other', 'record.frame.back', 'email.defaultInstant']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
    expect(CATALOGUE.en.portal!['record.frame.messagesNew_other']).toBe('Messages ({count} new)')
  })
})

describe('B-TH-273 — every old address keeps working (R-8): no Messages tab any more', () => {
  it('?tab=messages shows the conversation and focuses its box; ?thread=new and #messages show it; anything else nothing', () => {
    expect(portalArrivalOf('?tab=messages')).toEqual({ openThread: true, focus: true })
    expect(portalArrivalOf('?thread=new')).toEqual({ openThread: true, focus: false })
    expect(portalArrivalOf('', '#messages')).toEqual({ openThread: true, focus: false })
    expect(portalArrivalOf(new URLSearchParams('tab=lines'))).toEqual({ openThread: false, focus: false })
    expect(portalArrivalOf('?thread=open')).toEqual({ openThread: false, focus: false })
    expect(portalArrivalOf(null)).toEqual({ openThread: false, focus: false })
  })

  it('the arrival terms leave the address; narrower than 1280 px the full-width view stays open (thread=open)', () => {
    expect(portalArrivalCleaned('?tab=messages&line=3', false)).toBe('?line=3')
    expect(portalArrivalCleaned('?tab=messages&line=3', true)).toBe('?line=3&thread=open')
    expect(portalArrivalCleaned('?thread=new', false)).toBe('')
    expect(portalArrivalCleaned('?tab=lines', false)).toBe('?tab=lines')
  })

  it('a page’s tab: one of its tabs, a merged tab where it went, else its first — never a key of Object.prototype', () => {
    const tabs = ['status', 'lines', 'shipments', 'documents'] as const
    expect(tabOrFirst(tabs, 'lines')).toBe('lines')
    expect(tabOrFirst(tabs, 'messages')).toBe('status')
    expect(tabOrFirst(tabs, null)).toBe('status')
    expect(tabOrFirst(['lines', 'confirm', 'asn'] as const, 'documents', { documents: 'confirm' })).toBe('confirm')
    expect(tabOrFirst(tabs, 'constructor')).toBe('status')
    expect(tabOrFirst(tabs, '__proto__', {})).toBe('status')
  })
})

describe('B-TH-273 — the frame on the page', () => {
  it('docked: ONE conversation in a named region beside the body, `#messages` for "Ask a question", no button', () => {
    const html = frame('docked')
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(html).toContain('id="messages"')
    expect(html).toContain('aria-label="Messages about order #7"')
    expect(html).toContain('data-mode="docked"')
    expect(html).toContain('class="fw-prf has-thread"')
    expect(textOf(html)).not.toContain('Messages (')
  })

  // pp-w1 (w1.1; 10-design § 4, P0-B4): the "Messages (2 new)" button left the body for the band (the frame sets it there).
  it('under 1280 px: the body leads with no row of its own — the band holds "Messages (2 new)" (bandThreadOf); the conversation waits', () => {
    const html = frame('stacked', { newCount: 2 })
    expect(html).toContain('data-view="body"')
    expect(textOf(html)).not.toContain('Messages (')
    expect(html).not.toContain('fw-prf-bar')
    expect(bandThreadOf({ hasThread: true, mode: 'stacked', hidden: false, viewOpen: false, count: 2 })).toEqual({ count: 2 })
    const source = readFileSync(new URL('./PortalRecordFrame.tsx', import.meta.url), 'utf8')
    expect(source).toContain('usePortalBandThread(bandThread ? { count: bandThread.count, onClick: () => showThread(false) } : null)')
  })

  it('under 1280 px with the view open: the conversation alone, with Back; no button', () => {
    const html = frame('stacked', { viewOpen: true })
    expect(html).toContain('data-view="thread"')
    expect(textOf(html)).toContain('Back')
    expect(textOf(html)).not.toContain('Messages (')
  })

  it('no conversation for this person (a missing record): no dock, no button', () => {
    const html = frame('stacked', { thread: false, newCount: 3 })
    expect(html).not.toContain('<aside')
    expect(html).not.toContain('id="messages"')
    expect(textOf(html)).not.toContain('Messages (')
  })

  it('the brand wall: a Brand Beta record page holds nothing of Brand Alpha (docked and narrow, both languages)', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const html of [frame('docked', {}, locale), frame('stacked', { newCount: 2 }, locale), frame('stacked', { viewOpen: true }, locale)]) {
        expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
        expect(scanText(html, BRAND_ALPHA)).toEqual([])
      }
    }
  })
})

describe('B-TH-273 — no Ask modal: "Ask a question" focuses the docked box, else opens the conversation as a page', () => {
  const shell = readFileSync(new URL('../PortalShell.tsx', import.meta.url), 'utf8')

  it('from another page: a record whose own page docks it opens there with its box focused; any other its conversation page', () => {
    expect(askHref(PREFIX, { type: 'SalesOrder', id: 's-7' }, '/orders/s-7')).toBe(`${PREFIX}/orders/s-7?tab=messages`)
    expect(askHref(PREFIX, { type: 'Invoice', id: 'i-1' }, '/documents?invoice=i-1')).toBe(`${PREFIX}/open/Invoice/i-1?view=conversation`)
    expect(askHref(PREFIX, { type: 'Ddt', id: 'd-1' }, null)).toBe(`${PREFIX}/open/Ddt/d-1?view=conversation`)
    expect(askHref(PREFIX, { type: 'ShipNotice', id: 'n-1' }, '/deliveries/n-1')).toBe(`${PREFIX}/open/ShipNotice/n-1?view=conversation`)
  })

  it('PortalShell asks the dock first (PORTAL_ASK_EVENT), then the page’s own box, else the conversation page; no pop-up copy', () => {
    expect(PORTAL_ASK_EVENT).toBe('fw-portal-ask')
    expect(shell).toContain('here.dispatchEvent(new CustomEvent(PORTAL_ASK_EVENT, { cancelable: true }))')
    expect(shell).toContain('leaveTo(record ? askHref(prefix, record, recordPageOf(kinds, record.type, record.id)) : accountConversationHref(prefix, me.party.id))')
    expect(shell).not.toMatch(/<Modal\b/)
    expect(shell).not.toContain('<PortalThread')
  })

  // pp-fx4 (walk W-03): `?tab=messages` arrives before the conversation has loaded — the box is not drawn yet. The asked focus waits for
  // it (the frame watches the dock until a box that is not disabled appears), unless the person moved the focus meanwhile; then gives up.
  it('an asked focus waits for the box the thread draws later (arrival, a loading conversation); never steals a focus moved meanwhile', () => {
    const frame = readFileSync(new URL('./PortalRecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain("dock?.querySelector<HTMLTextAreaElement>('textarea:not([disabled])')")
    expect(frame).toContain("observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })")
    expect(frame).toContain('if (active !== waitingFrom && active && active !== document.body && !element.contains(active)) return done()')
    expect(frame).toContain('const giveUp = setTimeout(done, BOX_WAIT_MS)')
    expect(frame).toContain('if (asked.focus) setFocusAsked(true)')
  })
  // pt-w2 W2.3: the docked conversation's own tests (its count, read only while on screen, a removed message) live with the thread now:
  // portal/shell/thread/thread.vitest.test.ts.
})

describe('B-TH-274 — the portal’s generic page: a record’s conversation as its own page, the account conversation', () => {
  it('the conversation page of a record (?view=conversation never sends on), the account’s, the parent’s /open/ link', () => {
    expect(conversationHref(PREFIX, { type: 'Invoice', id: 'i-1' })).toBe(`${PREFIX}/open/Invoice/i-1?view=conversation`)
    expect(accountConversationHref(PREFIX, 'p-1')).toBe(`${PREFIX}/open/Party/p-1`)
    expect(parentHref(PREFIX, { recordType: 'SalesOrder', recordId: 's-1' })).toBe(`${PREFIX}/open/SalesOrder/s-1`)
    expect(opensOwnPage('/documents?invoice=i-1', 'conversation')).toBe(false)
    expect(opensOwnPage('/documents?invoice=i-1', undefined)).toBe(true)
    expect(opensOwnPage(null, undefined)).toBe(false)
    const route = readFileSync(new URL('../../../app/(portal)/p/[party]/open/[type]/[id]/page.tsx', import.meta.url), 'utf8')
    expect(route).toContain('if (page && opensOwnPage(page, view)) redirect(')
  })

  it('only words of real states: the tone is a reading aid from the code', () => {
    expect(summaryTone('DELIVERED')).toBe('success')
    expect(summaryTone('PENDING_APPROVAL')).toBe('warning')
    expect(summaryTone('CANCELLED')).toBe('neutral')
    expect(summaryTone('IN_PRODUCTION')).toBe('info')
    expect(summaryTone(null)).toBe('neutral')
  })

  const summary = (over: Partial<RecordSummaryModel> = {}): RecordSummaryModel => ({
    state: 'ready',
    type: 'Delivery note',
    label: 'DDT-2026-0702',
    theirRef: BRAND_BETA.customerRef,
    stateWords: 'Issued',
    stateTone: 'info',
    parent: { words: 'Order #7', href: `${PREFIX}/open/SalesOrder/s-7` },
    ownPage: null,
    ...over,
  })
  const page = (model: Parameters<typeof RecordView>[0]['model'], locale: 'it' | 'en' = 'en') => render(createElement(RecordView, { model }, createElement(ThreadView, { model: betaThread() })), locale)

  it('no tabs: the conversation (`#messages`) and beside it the summary — type, number, their reference, state, the parent as a link', () => {
    const html = page({ missing: false, subtitle: null, homeHref: PREFIX, summary: summary() })
    const text = textOf(html)
    expect(html).toContain('id="messages"')
    expect(html).toContain('class="fw-precord has-summary"')
    expect(text).toContain('About this record')
    expect(text).toContain('Delivery note')
    expect(text).toContain('DDT-2026-0702')
    expect(text).toContain(BRAND_BETA.customerRef)
    expect(text).toContain('Belongs to')
    expect(html).toContain(`href="${PREFIX}/open/SalesOrder/s-7"`)
    expect(html).not.toContain('role="tablist"')
  })

  it('no parent known or not theirs: no link (X-G01); the record’s own page when built (an invoice’s PDF in Documents)', () => {
    const html = page({ missing: false, subtitle: null, homeHref: PREFIX, summary: summary({ parent: null, ownPage: { href: `${PREFIX}/documents?invoice=i-1`, words: 'Open the Invoice page' } }) })
    expect(textOf(html)).not.toContain('Belongs to')
    expect(html).toContain(`href="${PREFIX}/documents?invoice=i-1"`)
  })

  it('the summary failed: said with Try again, the conversation still there; the account conversation has no summary', () => {
    const failed = textOf(page({ missing: false, subtitle: null, homeHref: PREFIX, summary: summary({ state: 'error' }) }))
    expect(failed).toContain('The details of this record could not be read.')
    expect(failed).toContain(BRAND_BETA.message)
    const account = page({ missing: false, subtitle: null, homeHref: PREFIX, account: true, summary: summary() })
    expect(account).not.toContain('has-summary')
    expect(textOf(account)).not.toContain('About this record')
  })

  it('a record that is not theirs reads like one that does not exist, with the way Home', () => {
    const text = textOf(page({ missing: true, subtitle: null, homeHref: PREFIX }))
    expect(text).toContain('Record not found')
    expect(text).toContain('This record is not one of yours, or it no longer exists.')
    expect(text).not.toContain(BRAND_BETA.message)
  })

  it('the brand wall: the Brand Beta generic page holds nothing of Brand Alpha (both languages)', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = page({ missing: false, subtitle: null, homeHref: PREFIX, summary: summary() }, locale)
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(scanText(html, BRAND_ALPHA)).toEqual([])
    }
  })

  it('every summary word exists in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale].portal ?? {}
      for (const key of ['record.summary.title', 'record.summary.details', 'record.summary.type', 'record.summary.number', 'record.summary.theirRef', 'record.summary.state', 'record.summary.partOf', 'record.summary.open', 'record.summary.failed']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})

// ---- B-TH-286: the portal conversation's pins moved with the thread's tests (portal/shell/thread/thread.vitest.test.ts, pt-w2 W2.3).
