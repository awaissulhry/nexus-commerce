import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ReaderProvider } from '../../../lib/i18n/provider'
import { partnerMenuOf } from '../../../lib/record-thread/partner/model'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { partnerThreadSchema } from '../api'
import { portalMessageOf, replyRefusalKey } from '../thread-model'
import { ThreadView, type ThreadViewModel } from '../view/ThreadView'

/**
 * pt-w2 (lane pt-, ONE SHARED THREAD): the portal's thread — its reads (W2.1), its host (W2.3). The thread tests of the portal frame
 * live here now (they left portal/shell/record/record-frame.vitest.test.ts with the face).
 */

const api = readFileSync(new URL('../api.ts', import.meta.url), 'utf8')
const threadBlock = api.slice(api.indexOf("// ── a record's conversation"), api.indexOf('// ── the portal terms'))

// ---- W2.1: the reads -------------------------------------------------------------------------------------------------------------------
describe('pt-w2 W2.1 — the portal thread’s reads', () => {
  it('WALL: the portal’s thread schema reads no field the partner contract never sends (authorId, audience, mail, amount)', () => {
    expect(threadBlock.length).toBeGreaterThan(1000)
    expect(threadBlock).not.toMatch(/\b(authorId|audience|amount|mail|email|forFloor|pinnedBy|readBy|seenBy)\s*:/)
    // Even when an answer carried office fields, the schema drops them (it reads only what it names).
    const read = partnerThreadSchema.parse({
      record: { type: 'SalesOrder', id: 'o1', theirRef: 'PO-1', ourRef: 'SO-1', subtitle: null, status: null },
      thread: { id: 't1', status: 'OPEN' },
      messages: [
        {
          id: 'm2',
          side: 'PARTNER',
          channel: 'PORTAL',
          author: { name: 'Lia Modello', mine: true, id: 'u-9' },
          body: 'The sizes are fine.',
          attachments: [{ id: 'f1', originalName: 'Price list.pdf', sizeBytes: 900, kind: 'DOCUMENT', contentType: 'application/pdf', status: 'AVAILABLE', locked: 'PRICED' }],
          replyTo: { id: 'm1', authorName: 'Bea Esempio', excerpt: 'Are the sizes fine?', at: '2026-11-17T09:00:00.000Z', authorKind: 'USER', authorId: 'u-1', audience: 'OFFICE' },
          audience: 'PARTNER',
          amount: { value: 12, currency: 'EUR' },
          at: '2026-11-17T09:05:00.000Z',
        },
      ],
      nextCursor: null,
      composer: { canPost: true, reason: null, words: null, replyByEmail: true, hint: null },
    })
    const message = read.messages[0]!
    expect(message).not.toHaveProperty('audience')
    expect(message).not.toHaveProperty('amount')
    expect(message.author).toEqual({ name: 'Lia Modello', mine: true })
    expect(message.replyTo).toEqual({ id: 'm1', authorName: 'Bea Esempio', excerpt: 'Are the sizes fine?', at: '2026-11-17T09:00:00.000Z', authorKind: 'USER' })
    expect(message.attachments[0]).toMatchObject({ locked: 'PRICED', contentType: 'application/pdf' })
    // pt-fx1 R-4: a link the web cannot read (an office-shaped one, a broken one) is dropped; the thread still reads.
    const odd = partnerThreadSchema.parse({ ...read, messages: [{ ...read.messages[0]!, replyTo: { id: 'x', audience: 'OFFICE' }, corrects: { id: 'y' } }] })
    expect(odd.messages[0]!.replyTo).toBeUndefined()
    expect(odd.messages[0]!.corrects).toBeUndefined()
    expect(odd.messages[0]!.body).toBe('The sizes are fine.')
    // An older answer (no link, no file type) still reads.
    expect(partnerThreadSchema.parse({ ...read, messages: [{ id: 'm3', side: 'COMPANY', channel: 'EMAIL', author: { name: null, mine: false }, body: 'x', attachments: [{ id: 'f2', originalName: 'a.pdf', sizeBytes: 1 }], at: '2026-11-17T09:06:00.000Z' }] }).messages[0]!.replyTo).toBeUndefined()
  })

  it('a jump reads the same page read (no new route), in pages of up to 200; Reply posts the message it answers, never a correction', () => {
    expect(threadBlock).toContain('export const fetchThread = (api: ApiClient, type: string, id: string, cursor?: string | null, signal?: AbortSignal, limit: number = THREAD_PAGE) =>')
    expect(threadBlock).toContain('export const THREAD_PAGE = 50')
    expect(threadBlock).toContain("...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {})")
    expect(threadBlock).not.toContain('correctsMessageId')
  })
})
// ---- end W2.1

// ---- W2.3: the host ------------------------------------------------------------------------------------------------------------------
describe('pt-w2 W2.3 — the portal thread’s host on the partner face', () => {
  const thread = readFileSync(new URL('./PortalThread.tsx', import.meta.url), 'utf8')
  const view = readFileSync(new URL('../view/ThreadView.tsx', import.meta.url), 'utf8')
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
  const draw = (model: ThreadViewModel, locale: 'en' | 'it' = 'en') => render(createElement(ReaderProvider, { reader: 'outside' }, createElement(ThreadView, { model })), locale)

  // Moved from portal/shell/record/record-frame.vitest.test.ts (B-TH-273), same strictness.
  it('the docked conversation tells the button its count and marks messages read only while on screen (the face reports nothing it saw)', () => {
    expect(thread).toContain('const dockFrame = usePortalRecordFrame()')
    expect(thread).toContain("if (state !== 'ready' || !newest || (read?.reading?.newCount ?? 0) <= 0 || !onScreen) return")
    expect(thread).toContain('.then((answer) => reportNew?.(answer.reading.newCount))')
    expect(thread).toContain("if (state === 'ready') reportNew?.(read?.reading?.newCount ?? 0)")
    expect(`${thread}${view}`).not.toContain('onSeen')
  })

  // Moved from record-frame.vitest (B-TH-079): the face says it in the office's words (A12: one word per place).
  it('a message removed after a privacy request says so in the portal too; a files-only message keeps its empty text', () => {
    const read = partnerThreadSchema.parse({ record: { type: 'SalesOrder', id: 'o1', theirRef: null, ourRef: null, subtitle: null, status: null }, thread: null, messages: [{ id: 'm9', side: 'COMPANY', channel: 'APP', author: { name: null, mine: false }, body: '', attachments: [], erased: true, at: '2026-11-16T08:00:00Z' }], nextCursor: null, composer: { canPost: true, reason: null, words: null, replyByEmail: false, hint: null } })
    const erased = portalMessageOf(read.messages[0]!, 'en')
    expect(erased).toMatchObject({ erased: true, body: '' })
    for (const [locale, words] of [['en', 'Message removed after a privacy request'], ['it', 'Messaggio rimosso dopo una richiesta di privacy']] as const) {
      expect(textOf(draw(betaThread({ messages: [erased] }), locale)), locale).toContain(words)
    }
    expect(portalMessageOf({ ...read.messages[0]!, erased: false }, 'en')).toMatchObject({ erased: false, body: '' })
  })

  // Moved from record-frame.vitest (B-TH-286), re-pointed to the pinned bar.
  it('WALL: the portal reads pins through the partner answer only — never who pinned', () => {
    const api = readFileSync(new URL('../api.ts', import.meta.url), 'utf8')
    const block = api.slice(api.indexOf('---- B-TH-286'), api.indexOf('---- end B-TH-286'))
    expect(block).toContain('/pins')
    expect(block).not.toMatch(/pinnedBy|audience/)
    expect(thread).toContain('fetchPins(frame.api, type, id, signal)')
    expect(thread).not.toMatch(/pinnedBy|pin\.by\b/)
    const pins = [
      { id: 'm2', author: 'Marco Prova', words: 'We confirm the new chart for #7.', date: '2026-11-16T10:05:00Z', pinnedAt: '2026-11-16T10:05:00Z' },
      { id: 'm9', author: null, words: '', date: '2026-11-10T08:00:00Z', pinnedAt: '2026-11-10T08:00:00Z', removed: true },
      { id: 'm8', author: null, words: 'Ours, unnamed.', date: '2026-11-09T08:00:00Z', pinnedAt: '2026-11-09T08:00:00Z' },
    ]
    for (const locale of ['en', 'it'] as const) {
      const html = draw(betaThread({ pins }), locale)
      expect(html, locale).toContain('class="fw-rt-pinbar"')
      // The newest pin first, its writer by the author rule; a pin's marks when there are 2+; never who pinned.
      expect(textOf(html), locale).toContain('Marco Prova: We confirm the new chart for #7.')
      expect(html, locale).toContain('class="fw-rt-pinmarks"')
      expect(textOf(html), locale).not.toMatch(/pinned (it|a message)|ha fissato/i)
      expect(scanText(textOf(html), BRAND_ALPHA), locale).toEqual([])
    }
    expect(draw(betaThread())).not.toContain('fw-rt-pinbar')
    expect(draw(betaThread({ pins: [] }))).not.toContain('fw-rt-pinbar')
  })

  it('WALL: a jump reads the same portal page read (no new route), pages of 200, at most 1,000', () => {
    expect(thread).toContain('readPage: (from: string, size: number) => fetchThread(frame.api, type, id, from, undefined, size),')
    expect(thread).toContain('page: JUMP_PAGE,')
    expect(thread).toContain('limit: JUMP_LIMIT,')
    expect(thread).toContain('requestAnimationFrame(() => lightRow(messageId))')
    expect(thread).not.toMatch(/scrollIntoView\(|\bfetch\(|api\.get\(/)
    // The only routes the portal thread reads are its page, its post, its mark and its pins.
    const api = readFileSync(new URL('../api.ts', import.meta.url), 'utf8')
    expect([...threadBlock.matchAll(/`([^`]*\/portal\/threads[^`]*)`/g)].map((found) => found[1])).toEqual(['/portal/threads/${encodeURIComponent(type)}/${encodeURIComponent(id)}'])
    expect(api).toContain('`${recordPath(type, id)}/messages`')
  })

  it('Reply sends replyToMessageId only; Correct is never offered; a refused reply keeps the text and the bar, the words say why', () => {
    expect(thread).toContain('{ askFactoryDesigner: asking, replyToMessageId: replyTo }')
    expect(thread).not.toMatch(/corrects?MessageId|onCorrect/)
    expect(view).not.toContain('onCorrect')
    expect(partnerMenuOf({ body: 'x' }, { reply: true })).not.toContain('correct')
    expect(replyRefusalKey(['refusal/REPLY_REFUSED'])).toBe('thread.reply.refused')
    expect(replyRefusalKey(['refusal.REPLY_REFUSED'])).toBe('thread.reply.refused')
    expect(replyRefusalKey(['body'])).toBeNull()
    // Refused: nothing written — the key goes (a new try is a new post), the draft and the reply bar stay.
    const refused = thread.slice(thread.indexOf('const refused = replyTo'), thread.indexOf('// ---- F-CP-156: the ask refused'))
    expect(refused).toContain("setFailed(t(refused))")
    expect(refused).not.toMatch(/setDraft|setReplyTo/)
    for (const locale of ['en', 'it'] as const) {
      const html = draw(betaThread({ replyTo: 'm2', failed: locale === 'en' ? 'That message cannot be answered here.' : 'A quel messaggio non si può rispondere qui.' }), locale)
      expect(html, locale).toContain('class="fw-rt-cx-bar is-link fw-rt-tone-')
      expect(html, locale).toContain('class="fw-rt-notice" role="alert"')
    }
  })

  it('a live hint or a Send keeps the older pages loaded (A7): the newest page merges, the cursor stays at the oldest page read', () => {
    const load = thread.slice(thread.indexOf('const load = useCallback('), thread.indexOf('usePortalLive('))
    expect(load).toContain('setOlder((now) => now.filter((message) => !newest.has(message.id)))')
    expect(load).toContain('if (!olderRead.current) setCursor(answer.nextCursor)')
    expect(load.slice(0, load.indexOf('useEffect('))).not.toContain('setOlder([])')
    expect(thread).toContain('await load()')
  })

  it('A6: off a record frame the column is bounded (its list scrolls itself); the frame’s dock it fills', () => {
    expect(thread).toContain("<div ref={box} className={dockFrame ? 'fw-pthr' : 'fw-pthr is-bounded'}>")
    const css = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-pthr\.is-bounded \{\s*height: clamp\(440px, calc\(100vh - 200px\), 1000px\);/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix/i)
    const frameCss = readFileSync(new URL('../record/record-frame.css', import.meta.url), 'utf8')
    expect(frameCss).toContain('.fw-prf .fw-prf-thread > .fw-rtp {')
    expect(frameCss).not.toMatch(/nds-pthread|fw-pthread/)
  })

  it('every mount draws the ONE face: no showRecord, no DS PartnerThread draw in the portal or the links page', () => {
    const mounts = ['../record/RecordPage.tsx', '../../supplier/orders/OrderPage.tsx', '../../supplier/jobs/JobPage.tsx', '../../supplier/deliveries/NoticePage.tsx', '../../guest/accountant/AccountantPage.tsx', '../../customer/projects/ProjectPage.tsx', '../../customer/requests/RequestPage.tsx', '../../customer/returns/CasePage.tsx', '../../customer/returns/repair/RepairPage.tsx', '../../customer/orders/OrderPage.tsx', '../../customer/neworder/NewOrderPage.tsx']
    for (const file of mounts) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).toContain('<PortalThread ')
      expect(source, file).not.toContain('showRecord')
    }
    expect(thread).not.toContain('showRecord')
    for (const file of ['../view/ThreadView.tsx', './PortalThread.tsx', '../../../links/invite/view/InviteView.tsx']) expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toMatch(/patterns\/PartnerThread/)
    // A19: the supplier's price talk is said inside the column, in its ⓘ — never a box above it.
    const supplier = readFileSync(new URL('../../supplier/orders/OrderPage.tsx', import.meta.url), 'utf8')
    expect(supplier).toContain("help={[t('messages.priceTalk')]}")
    expect(supplier).not.toContain('<PriceTalkHint')
    // pt-fx1 F-1: its design case draws it the same way (the old box is gone with its part and its class).
    const supplierCase = readFileSync(new URL('../../supplier/orders/view/SupplierCase.tsx', import.meta.url), 'utf8')
    expect(supplierCase).toContain("<ThreadView model={{ ...body.thread, help: [t('messages.priceTalk')] }} />")
    expect(supplierCase).not.toContain('PriceTalkHint')
    expect(readFileSync(new URL('../../supplier/orders/view/OrderRecordView.tsx', import.meta.url), 'utf8')).not.toContain('PriceTalkHint')
  })
})
// ---- end W2.3


// ---- pt-t T.1: the gallery (SCR-027-thread) ------------------------------------------------------------------------------------------
import { designScreen as gallery } from './fixtures'

describe('pt-t T.1 — the gallery of the portal’s messages (SCR-027-thread)', () => {
  const drawCase = (id: string, locale: 'en' | 'it') => render(createElement(ReaderProvider, { reader: 'outside' }, createElement(gallery.view, { model: gallery.cases.find((item) => item.id === id)!.model })), locale)
  const KEY = /\b(thread|record|state|feed|quote|menu|files|kind|row|attach|keys|width|pinbar|unread|day|designer|held|failed|link|counter|box|send)\.[a-zA-Z]/
  const TU = /\b(tu|tuo|tua|tuoi|tue|ti|te|hai|puoi|sei|vuoi|devi)\b/i

  for (const locale of ['en', 'it'] as const) {
    it(`every case draws in ${locale}: no key on screen, made-up data only, no office part, no menu or modal open`, () => {
      for (const item of gallery.cases) {
        const html = drawCase(item.id, locale)
        const text = textOf(html)
        expect(html, `${item.id} ${locale}`).toContain('class="fw-rt-column is-docked fw-rtp"')
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY)
        expect(scanText(text, BRAND_ALPHA), item.id).toEqual([])
        expect(scanText(text, BRAND_BETA), item.id).toEqual([])
        expect(html, item.id).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        for (const office of ['is-note', 'fw-rt-cx-aud', 'fw-rth-line', 'fw-rth-files', 'lucide-check-check', 'lucide-globe', 'nds-pthread', 'role="menu"', 'role="dialog"']) expect(html, `${item.id} ${office}`).not.toContain(office)
        expect(text, `${item.id} ${locale}`).not.toMatch(/\b(seen by|read by|is typing|visto da|letto da|sta scrivendo|conversation|conversazione)\b/i)
        if (locale === 'it') expect(text, item.id).not.toMatch(TU)
      }
    })
  }

  it('the busy thread holds every part: sides, quotes, the pinned bar, tiles, a locked file, a removed message, the band, the chip, the ⓘ', () => {
    const html = drawCase('busy-forty', 'en')
    const text = textOf(html)
    for (const part of ['fw-rt-msg is-ours is-others is-start', 'fw-rt-msg is-theirs is-mine', 'class="fw-rt-quote fw-rt-tone-', 'class="fw-rt-pinbar"', 'class="fw-rt-album"', 'class="fw-rt-file"', 'data-feed-new=""', 'role="checkbox"', 'fw-rth-keys', 'class="fw-rt-sentinel"']) expect(html, part).toContain(part)
    expect(text).toContain('Priced document — you cannot open it')
    expect(text).toContain('Message removed after a privacy request')
    expect(text).toContain('Bea Esempio Example Works')
    expect(text).toContain('Ugo Test')
    // pt-fx1 F-2: m11 · m12 · m13 are new to the reading (3); m13 is the reader's own, never unread: 2.
    expect(text).toContain('2 unread messages')
    // A reply, the jump's flash, a refused reply, the held lines, the link and the account.
    expect(drawCase('replying', 'en')).toContain('class="fw-rt-cx-bar is-link fw-rt-tone-')
    expect(drawCase('jump-flash', 'en')).toMatch(/<article class="fw-rt-msg [^"]*" id="message-m01" data-message-id="m01"[^>]* data-flash=""/)
    expect(textOf(drawCase('failed-reply', 'en'))).toContain('That message cannot be answered here.')
    expect(drawCase('held-no-comment', 'en')).toContain('class="fw-rt-cx-held"')
    expect(textOf(drawCase('held-no-comment', 'it'))).toContain('Potete leggere questi messaggi; per scrivere qui, chiedete al vostro amministratore (Ugo Test).')
    expect(drawCase('link', 'en')).not.toContain('fw-rt-quote')
    expect(drawCase('link', 'en')).toContain('data-kind="link"')
    expect(textOf(drawCase('account', 'en'))).toContain('Ask us a question')
    expect(drawCase('width-menu', 'en')).toContain('fw-rth-menu')
    expect(drawCase('busy-forty', 'en')).not.toContain('fw-rth-menu')
    // The gallery lives under portal/, so the design index reads it from outside the office (app/design/_registry.ts readerOf): voi.
    expect(new URL('./fixtures.ts', import.meta.url).pathname).toMatch(/\/src\/portal\/shell\/thread\/fixtures\.ts$/)
    expect(gallery.screen).toBe('SCR-027-thread')
  })
})
// ---- end pt-t T.1
