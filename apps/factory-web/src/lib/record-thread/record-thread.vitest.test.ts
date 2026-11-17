import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../testing/two-brands'
import { scanText } from '../testing/brand-scan'
import { everyCase, leftKeys, textOf } from './parts/testing'
import { THREAD_NAMESPACES } from './parts/ThreadMessages'
import { CATALOGUE } from '../i18n/messages'
import { designScreen } from './fixtures'
import { anchorOf, cardOf, closedBy, eventOf, feedForView, feedKinds, feedShowsChange, settleOutbox, walkScope, withOutbox, type OutboxItem, type ThreadApiChange, type ThreadApiMessage } from './model'

/** B-TH-212 — RecordThread v1: an API message becomes a card by its audience, the anchor, the J / K focus rule, the outbox and the draft. */

const message = (more: Partial<ThreadApiMessage>): ThreadApiMessage => ({ id: 'm1', direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', name: BRAND_ALPHA.contact.name }, authorHidden: false, forFloor: false, body: 'Hello', attachments: [], at: '2026-11-17T09:00:00.000Z', ...more })
const sources = { emails: new Map(), names: new Map([['u1', 'Alex Demo']]) }

describe('an API message becomes a card by its audience', () => {
  it('inbound → the customer’s, outbound → ours, an internal note → an Office note, a floor worker’s note → from the floor', () => {
    expect(cardOf(message({}), sources).kind).toBe('theirs')
    expect(cardOf(message({ direction: 'OUTBOUND', author: { kind: 'USER', name: 'Alex Demo' } }), sources).kind).toBe('ours')
    expect(cardOf(message({ direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', name: 'Bea' } }), sources).kind).toBe('note')
    expect(cardOf(message({ direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'WORKER', name: 'Ugo' }, authorHidden: true, forFloor: true }), sources)).toMatchObject({ kind: 'floor', author: null, authorHidden: true })
  })

  it('carries the mail’s state, the bounce task while it is open, the mentioned names and the files', () => {
    const emails = new Map([['m1', { messageId: 'm1', to: ['a@x.example'], subject: 'Re: SO', status: 'BOUNCED' as const }]])
    const deliveries = new Map([['m1', { messageId: 'm1', task: { id: 't1', status: 'OPEN' as const } }]])
    const card = cardOf(
      message({ direction: 'OUTBOUND', mentions: ['u1', 'gone'], attachments: [{ id: 'f1', originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, status: 'AVAILABLE' }] }),
      { emails, deliveries, names: sources.names, taskHref: (id) => `/w/demo/home/tasks?open=${id}` },
    )
    expect(card.email).toEqual({ to: ['a@x.example'], subject: 'Re: SO', status: 'BOUNCED' })
    expect(card.bounceTask).toEqual({ href: '/w/demo/home/tasks?open=t1' })
    expect(card.mentions).toEqual(['Alex Demo', null])
    expect(card.files).toEqual([{ id: 'f1', name: 'a.pdf', sizeBytes: 10, contentType: 'application/pdf', status: 'AVAILABLE' }])
    expect(cardOf(message({ direction: 'OUTBOUND' }), { emails, deliveries: new Map([['m1', { messageId: 'm1', task: { id: 't1', status: 'DONE' as const } }]]), names: sources.names, taskHref: () => 'x' }).bounceTask).toBeNull()
  })
})

describe('the history’s steps', () => {
  const change = (more: Partial<ThreadApiChange>): ThreadApiChange => ({ kind: 'change', id: 'c1', at: '2026-11-12T15:00:00Z', action: 'sales.orders.update', actor: { audience: 'OFFICE', id: 'u1' }, actorHidden: false, status: null, fields: ['requestedDate'], before: { requestedDate: '2026-11-28' }, after: { requestedDate: '2026-12-01' }, ...more })
  it('a change becomes a quiet line with who and the values the API gave', () => {
    expect(eventOf(change({}), sources.names)).toEqual({ id: 'c1', at: '2026-11-12T15:00:00Z', who: 'Alex Demo', whoHidden: false, actorAudience: 'OFFICE', verb: 'update', status: null, values: [{ field: 'requestedDate', before: '2026-11-28', after: '2026-12-01' }], fields: ['requestedDate'] })
    expect(eventOf(change({ before: undefined, after: undefined }), sources.names).values).toEqual([])
  })

  it('the thread’s own steps (a note, a mail, a file) are not repeated as lines', () => {
    expect(feedShowsChange({ action: 'threads.postNote' })).toBe(false)
    expect(feedShowsChange({ action: 'email.send' })).toBe(false)
    expect(feedShowsChange({ action: 'files.completeUpload' })).toBe(false)
    expect(feedShowsChange({ action: 'sales.orders.setStatus' })).toBe(true)
  })

  it('who closed the thread and when, from the newest close', () => {
    const entries = [change({ id: 'a', at: '2026-11-10T10:00:00Z', status: { from: 'OPEN', to: 'CLOSED' }, actor: { audience: 'OFFICE', id: 'x' } }), change({ id: 'b', at: '2026-11-12T10:00:00Z', status: { from: 'OPEN', to: 'CLOSED' } })]
    expect(closedBy(entries, sources.names)).toEqual({ by: 'Alex Demo', at: '2026-11-12T10:00:00Z' })
    expect(closedBy([], sources.names)).toEqual({ by: null, at: null })
  })
})

describe('the anchor and the keys', () => {
  it('?message=<id> names the message a link opens (thread-G03)', () => {
    expect(anchorOf('?tab=request&message=0190f0e2-4370-7000-8000-000000000001')).toBe('0190f0e2-4370-7000-8000-000000000001')
    expect(anchorOf(new URLSearchParams('message=m1'))).toBe('m1')
    expect(anchorOf('?message=<script>')).toBeNull()
    expect(anchorOf('')).toBeNull()
  })

  it('J / K walk messages only while the feed has the focus; records otherwise; nothing while typing', () => {
    expect(walkScope({ inFeed: true, inField: false })).toBe('messages')
    expect(walkScope({ inFeed: false, inField: false })).toBe('records')
    expect(walkScope({ inFeed: true, inField: true })).toBeNull()
  })
})

describe('the outbox: a live read never drops what the person sent', () => {
  const card = cardOf(message({ direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', name: 'Alex Demo' } }), sources)
  const sendingItem: OutboxItem = { key: 'local-1', card: { ...card, body: 'On its way' }, state: 'sending' }
  const failedItem: OutboxItem = { key: 'local-2', card: { ...card, body: 'Did not go' }, state: 'failed', reason: 'reason.network' }

  it('what is on its way or did not go shows after the server’s messages, with its state and its text', () => {
    const cards = withOutbox([card], [sendingItem, failedItem])
    expect(cards.map((item) => item.id)).toEqual(['m1', 'local-1', 'local-2'])
    expect(cards[1].outbox).toEqual({ state: 'sending' })
    expect(cards[2]).toMatchObject({ body: 'Did not go', outbox: { state: 'failed', reason: 'reason.network' } })
  })

  it('an item leaves once the server lists its message; the others stay', () => {
    const confirmed = { ...sendingItem, messageId: 'm9' }
    expect(withOutbox([card, { ...card, id: 'm9' }], [confirmed, failedItem]).map((item) => item.id)).toEqual(['m1', 'm9', 'local-2'])
    expect(settleOutbox([confirmed, failedItem], new Set(['m9']))).toEqual([failedItem])
  })
})

describe('SCR-006-thread, both languages', () => {
  const cases = everyCase(designScreen)
  it('every case draws, with no message key left on screen', () => {
    for (const [locale, id, html] of cases) expect(leftKeys(html, ['state', 'mode', 'mark', 'held', 'box', 'notice', 'pane', 'delivery', 'chip', 'tray', 'clip']), `${locale} ${id}`).toEqual([])
  })

  it('one column named by its record; no permission draws neither the feed nor the box', () => {
    const page = cases.find(([locale, id]) => locale === 'en' && id === 'full-page')?.[2] ?? ''
    expect(page).toContain(`aria-label="Thread of ${BRAND_ALPHA.numbers.request} · ${BRAND_ALPHA.tradeName}"`)
    expect(page).toContain('role="feed"')
    expect(page).toContain('data-mode="note"')
    const forbidden = cases.find(([locale, id]) => locale === 'en' && id === 'forbidden')?.[2] ?? ''
    expect(textOf(forbidden)).toContain('You cannot read this thread')
    expect(forbidden).not.toContain('fw-rt-composer')
  })

  it('the reading pane is the SplitPane with the thread in a named pane', () => {
    const pane = cases.find(([locale, id]) => locale === 'en' && id === 'reading-pane')?.[2] ?? ''
    expect(pane).toContain('class="fw-split is-open"')
    expect(pane).toContain('aria-label="Reading pane"')
  })

  it('the brand wall: Brand Beta’s copy shows nothing of Brand Alpha (B-TH-203)', () => {
    for (const [, id, html] of cases) {
      if (id !== 'brand-beta') continue
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(BRAND_BETA.tradeName)
    }
  })

  it('every record-thread catalogue exists in both languages', () => {
    for (const namespace of THREAD_NAMESPACES) for (const locale of ['it', 'en'] as const) expect(Object.keys(CATALOGUE[locale][namespace] ?? {}).length, `${locale} ${namespace}`).toBeGreaterThan(0)
  })

  it('the views fetch nothing and import no office or portal code (lib/record-thread stays a view, PR-15)', () => {
    const files = ['RecordThread.tsx', 'ThreadCase.tsx', 'parts/DockedStage.tsx', 'model.ts', 'card/view/MessageCard.tsx', 'feed/view/Feed.tsx', 'composer/view/Composer.tsx', 'attachments/view/AttachmentTray.tsx', 'send-check/view/Recipients.tsx', 'send-check/view/SendCheckDialog.tsx']
    for (const file of files) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/from '[^']*(areas|portal|shell|record-panels|lib\/api|lib\/session)\//)
      expect(source, file).not.toMatch(/\bfetch\(/)
    }
  })
})

describe('B-TH-300 — the docked thread', () => {
  const card = (id: string, kind: 'theirs' | 'ours' | 'note' | 'floor') => ({ ...cardOf(message({ id }), sources), kind })
  const feed = { messages: [card('a', 'theirs'), card('b', 'note'), card('c', 'ours'), card('d', 'floor')], events: [eventOf({ kind: 'change', id: 'e', at: '2026-11-12T15:00:00Z', action: 'sales.orders.update', actor: { audience: 'OFFICE', id: null }, actorHidden: false, status: null, fields: [] }, sources.names)] }

  it('the Head’s View: with the customer, office notes, changes; All shows everything', () => {
    expect(feedForView(feed, 'all')).toBe(feed)
    expect(feedForView(feed, 'shared').messages.map((item) => item.id)).toEqual(['a', 'c'])
    expect(feedForView(feed, 'shared').events).toEqual([])
    expect(feedForView(feed, 'notes').messages.map((item) => item.id)).toEqual(['b', 'd'])
    expect(feedForView(feed, 'changes').messages).toEqual([])
    expect(feedForView(feed, 'changes').events).toHaveLength(1)
    expect(feedKinds(feed.messages)).toEqual({ hasShared: true, hasNotes: true })
    expect(feedKinds([card('x', 'note')])).toEqual({ hasShared: false, hasNotes: true })
  })

  const cases = everyCase(designScreen)
  const docked = (id: string) => cases.find(([locale, caseId]) => locale === 'en' && caseId === id)?.[2] ?? ''

  it('three bands above the first message: the Head, the files line, then the feed (pictures 6–11)', () => {
    const html = docked('docked')
    const head = html.indexOf('class="fw-rth')
    const files = html.indexOf('fw-rtf-line')
    const feedAt = html.indexOf('role="feed"')
    expect(head).toBeGreaterThan(-1)
    expect(files).toBeGreaterThan(head)
    expect(feedAt).toBeGreaterThan(files)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).toContain('fw-rtm-replies')
  })

  it('R-ACT: the Head’s "⋯" is there at count 0 too (Activity’s tools never hide), and no "?" key overlay in the thread (PR-14)', () => {
    const html = docked('docked-no-files')
    expect(html).toContain('aria-label="Thread tools"')
    expect(textOf(html)).not.toMatch(/Keyboard shortcuts|Press \?/)
    expect(html).not.toContain('fw-rtf-line')
  })

  it('the brand wall: Brand Beta’s docked order shows nothing of Brand Alpha (B-TH-203)', () => {
    for (const [, id, html] of cases) {
      if (id !== 'docked-brand-beta') continue
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(BRAND_BETA.tradeName)
    }
  })
})
