import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { MessageRow } from '../card/view/MessageRow'
import { render, textOf } from '../parts/testing'
import { partnerFeedOf, partnerFilesOf, partnerMenuOf, partnerPinsOf, partnerQuoteOf, partnerRowOf, partnerWho, bytesOf, type PortalQuote, type PortalThreadFile, type PortalThreadMessage } from './model'

/** pt-w2 (lane pt-, ONE SHARED THREAD): the partner face — what a customer, a supplier, a workshop, an accountant or a link's guest reads. */

const NAMES = { you: 'You', yourTeam: 'Your team', company: 'Example Works' }
const at = (minute: number) => `2026-11-17T09:${String(minute).padStart(2, '0')}:00.000Z`
const msg = (id: string, over: Partial<PortalThreadMessage> = {}): PortalThreadMessage => ({ id, side: 'company', channel: 'portal', author: { name: 'Bea Esempio', mine: false }, body: `Words of ${id}`, attachments: [], at: at(1), ...over })

// ---- W2.1: the model -----------------------------------------------------------------------------------------------------------------
describe('pt-w2 W2.1 — the partner model', () => {
  const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
  const shapeOf = (name: string) => {
    const start = source.indexOf(`export interface ${name} {`)
    expect(start, name).toBeGreaterThan(-1)
    return source.slice(start, source.indexOf('\n}\n', start)).replace(/\/\*\*[\s\S]*?\*\//g, '')
  }

  it('WALL: the portal thread’s message map has no audience, note, author id or office field', () => {
    expectTypeOf<keyof PortalThreadMessage>().toEqualTypeOf<'id' | 'side' | 'channel' | 'author' | 'body' | 'attachments' | 'at' | 'atText' | 'replyTo' | 'correctedBy' | 'erased'>()
    expectTypeOf<keyof PortalQuote>().toEqualTypeOf<'id' | 'authorName' | 'authorKind' | 'excerpt' | 'at' | 'erased' | 'mine' | 'fileCount' | 'firstFile'>()
    expectTypeOf<keyof PortalThreadFile>().toEqualTypeOf<'id' | 'name' | 'size' | 'sizeBytes' | 'href' | 'contentType' | 'locked'>()
    for (const name of ['PortalThreadMessage', 'PortalQuote', 'PortalThreadFile', 'PortalPin', 'PartnerFeedMessage']) {
      expect(shapeOf(name), name).not.toMatch(/\b(audience|note|office|authorId|amount|email|mail|forFloor|pinnedBy|seenBy|readBy)\??:/)
    }
    // Pure, and no office, portal or session code.
    expect(source).not.toMatch(/from '[^']*(areas|portal|shell|record-panels|lib\/api|lib\/session)\//)
    expect(source).not.toMatch(/\bfetch\(|useState|useEffect/)
  })

  it('WALL: the portal names the writer — You, the person, our company, Your team — and a quote and a pin the same way; never "Someone in the office" or "A person on the floor"', () => {
    expect(partnerWho(msg('a', { author: { name: 'Lia Modello', mine: true }, side: 'partner' }), NAMES)).toBe('You')
    expect(partnerWho(msg('a'), NAMES)).toBe('Bea Esempio')
    expect(partnerWho(msg('a', { author: { name: null, mine: false } }), NAMES)).toBe('Example Works')
    expect(partnerWho(msg('a', { side: 'partner', author: { name: '  ', mine: false } }), NAMES)).toBe('Your team')
    // A quote by its kind: PARTY their side, anything else ours; erased: no name; the reader's own: "You" (the shared quote's word).
    const quote = (over: Partial<PortalQuote>): PortalQuote => ({ id: 'q', authorName: null, excerpt: 'x', at: at(0), ...over })
    expect(partnerQuoteOf(quote({ authorKind: 'USER' }), NAMES).author).toBe('Example Works')
    expect(partnerQuoteOf(quote({ authorKind: 'SYSTEM' }), NAMES).author).toBe('Example Works')
    expect(partnerQuoteOf(quote({ authorKind: 'WORKER' }), NAMES).author).toBe('Example Works')
    expect(partnerQuoteOf(quote({}), NAMES).author).toBe('Example Works')
    expect(partnerQuoteOf(quote({ authorKind: 'PARTY' }), NAMES).author).toBe('Your team')
    expect(partnerQuoteOf(quote({ authorKind: 'PARTY', authorName: 'Ugo Test' }), NAMES).author).toBe('Ugo Test')
    expect(partnerQuoteOf(quote({ authorKind: 'PARTY', authorName: 'Lia Modello', mine: true }), NAMES)).toMatchObject({ author: 'You', mine: true })
    expect(partnerQuoteOf(quote({ erased: true, authorName: 'Bea Esempio' }), NAMES)).toMatchObject({ author: null, erased: true })
    expect(partnerQuoteOf(quote({ authorKind: 'USER', authorName: 'Bea Esempio' }), NAMES)).not.toHaveProperty('audience')
    // A pin: never who pinned; the writer by the same rule.
    const pins = partnerPinsOf(
      [
        { messageId: 'm1', pinnedAt: at(1), authorName: null, excerpt: 'Ours', files: 0, removed: false },
        { messageId: 'm2', pinnedAt: at(2), authorName: 'Lia Modello', excerpt: 'Mine', files: 0, removed: false },
        { messageId: 'm3', pinnedAt: at(3), authorName: 'Bea Esempio', excerpt: '', files: 0, removed: true },
      ],
      NAMES,
      new Set(['m2']),
    )
    expect(pins.map((pin) => [pin.messageId, pin.author, pin.office, pin.hidden])).toEqual([['m3', null, false, false], ['m2', 'You', false, false], ['m1', 'Example Works', false, false]])
    // The shared rules' office fallbacks are never reached: every quote and pin carries a name (or is removed).
    expect(source).not.toMatch(/author\.(USER|WORKER|floorPerson)|Someone in the office|A person on the floor/)
  })

  it('WALL: a locked file on a portal message shows locked, with no name and no link', () => {
    const files: PortalThreadFile[] = [
      { id: 'f1', name: 'Price list Example Works.pdf', sizeBytes: 86_016, contentType: 'application/pdf', href: '/api/files/f1/download', locked: true },
      { id: 'f2', name: 'Sizes.pdf', size: '84 KB', contentType: 'application/pdf', href: '/api/files/f2/download' },
    ]
    expect(partnerFilesOf(files)).toEqual({ files: [{ id: 'f2', name: 'Sizes.pdf', sizeBytes: 86_016, contentType: 'application/pdf', status: 'AVAILABLE' }], locked: 1 })
    const [feed] = partnerFeedOf([msg('m1', { attachments: files })], NAMES, { quotes: true })
    const html = render(createElement(MessageRow, { message: partnerRowOf(feed!, { names: NAMES, label: 'Bea Esempio, 09:01' }), context: {}, run: { side: 'others', first: true, last: true, showName: true } }))
    expect(textOf(html)).toContain('Priced document — you cannot open it')
    expect(html).not.toContain('Price list')
    expect(html).not.toContain('f1')
    expect(textOf(html)).toContain('Sizes.pdf')
    expect(bytesOf('84 KB')).toBe(86_016)
    expect(bytesOf('1,5 MB')).toBe(1_572_864)
    expect(bytesOf('1.5 MB')).toBe(1_572_864)
    expect(bytesOf(undefined)).toBe(0)
  })

  it('sides by the reader; the name line with our company beside our people; the row draws no office mark; Reply only where the kind answers', () => {
    const feed = partnerFeedOf(
      [
        msg('m1', { replyTo: { id: 'm0', authorName: 'Lia Modello', authorKind: 'PARTY', mine: true, excerpt: 'Are the sizes fine?', at: at(0) } }),
        msg('m2', { side: 'partner', author: { name: 'Lia Modello', mine: true }, at: at(2) }),
        msg('m3', { side: 'partner', author: { name: 'Ugo Test', mine: false }, at: at(3) }),
      ],
      NAMES,
      { quotes: true },
    )
    expect(feed.map((item) => [item.kind, item.mine, item.senderKey])).toEqual([['ours', false, 'company~Bea Esempio'], ['theirs', true, 'mine~You'], ['theirs', false, 'partner~Ugo Test']])
    const rows = feed.map((item) => partnerRowOf(item, { names: NAMES, label: 'x' }))
    expect(rows.map((row) => [row.who, row.org])).toEqual([['Bea Esempio', 'Example Works'], ['You', null], ['Ugo Test', null]])
    const html = render(createElement(MessageRow, { message: rows[0]!, context: {}, run: { side: 'others', first: true, last: true, showName: true } }))
    expect(textOf(html)).toContain('Bea Esempio Example Works')
    expect(html).toContain('class="fw-rt-quote fw-rt-tone-')
    expect(textOf(html)).toContain('You') // the reader's own message, quoted
    for (const office of ['is-note', 'fw-rt-lock', 'lucide-globe', 'lucide-check', 'fw-rt-audwords']) expect(html, office).not.toContain(office)
    // A link's guest reads no quote (its read carries none: A10).
    expect(partnerFeedOf([msg('m1', { replyTo: { id: 'm0', authorName: null, excerpt: 'x', at: at(0) } })], NAMES, { quotes: false })[0]!.replyTo).toBeNull()
    expect(partnerMenuOf(msg('m1'), { reply: true })).toEqual(['reply', 'copyText'])
    expect(partnerMenuOf(msg('m1'), { reply: false })).toEqual(['copyText'])
    expect(partnerMenuOf(msg('m1', { erased: true }), { reply: true })).toEqual(['reply'])
    expect(partnerMenuOf(msg('m1', { body: '' }), { reply: false })).toEqual([])
  })
})
// ---- end W2.1

// ---- W2.2: the face ------------------------------------------------------------------------------------------------------------------
import { CATALOGUE } from '../../i18n/messages'
import { ReaderProvider } from '../../i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { PartnerColumn, type PartnerColumnModel } from './view/PartnerColumn'

describe('pt-w2 W2.2 — the partner face', () => {
  const beta = (over: Partial<PartnerColumnModel> = {}): PartnerColumnModel => ({
    kind: 'record',
    state: 'ready',
    title: 'Messages',
    recordName: BRAND_BETA.customerRef,
    companyName: 'Example Works',
    messages: [
      msg('m1', { author: { name: 'Bea Esempio', mine: false }, body: 'We confirm the new chart.', channel: 'email', at: at(1) }),
      msg('m2', { side: 'partner', author: { name: BRAND_BETA.portalPerson.name, mine: true }, body: BRAND_BETA.message, at: at(2), replyTo: { id: 'm1', authorName: 'Bea Esempio', authorKind: 'USER', excerpt: 'We confirm the new chart.', at: at(1) }, attachments: [{ id: 'f1', name: BRAND_BETA.fileName, size: '84 KB', href: '/api/files/f1/download', contentType: 'application/pdf' }] }),
      msg('m3', { side: 'partner', author: { name: 'Ugo Test', mine: false }, body: 'Thanks from the team.', at: at(3) }),
    ],
    more: true,
    reading: { firstNewId: 'm3', newCount: 1 },
    pins: [{ messageId: 'm1', pinnedAt: at(4), authorName: 'Bea Esempio', excerpt: 'We confirm the new chart.', files: 0, removed: false }],
    composer: { value: '', busy: false, held: null, designer: { ask: 'Ask Dora Campione, factory designer', on: false, hint: 'Dora Campione gets your message at once.', held: null, completes: false } },
    help: ['You can also answer our emails: the reply lands here.'],
    ...over,
  })
  const draw = (model: PartnerColumnModel, locale: 'en' | 'it' = 'en', outside = true) => render(outside ? createElement(ReaderProvider, { reader: 'outside' }, createElement(PartnerColumn, { model })) : createElement(PartnerColumn, { model }), locale)
  const views = ['./view/PartnerColumn.tsx', './view/PartnerHead.tsx', './view/PartnerComposer.tsx', './model.ts'].map((file) => [file, readFileSync(new URL(file, import.meta.url), 'utf8')] as const)

  it('the face draws the office’s row, list, composer and pinned bar (the same classes) and no office-only class', () => {
    const html = draw(beta())
    for (const shared of ['<section class="fw-rt-column is-docked fw-rtp"', 'class="fw-rth"', 'class="fw-rt-pinbar"', 'class="fw-rt-feedwrap"', 'class="fw-rt-feed" role="feed"', 'class="fw-rt-sentinel"', 'fw-rt-msg is-ours is-others is-start', 'fw-rt-msg is-theirs is-mine is-start', 'class="fw-rt-quote fw-rt-tone-', 'class="fw-rt-composer"', 'class="fw-rt-cx-row"', 'class="fw-rt-cx-box"', 'fw-rt-cx-send', 'data-feed-new=""']) {
      expect(html, shared).toContain(shared)
    }
    for (const office of ['is-note', 'fw-rt-cx-aud', 'fw-rt-cx-chipbtn', 'fw-rt-event', 'fw-rth-line', 'fw-rth-files', 'fw-rt-lock', 'lucide-globe', 'lucide-check-check', 'data-mode', 'nds-pthread', 'fw-pthread']) {
      expect(html, office).not.toContain(office)
    }
    // The box is a textbox named "Your message"; Send is named "Send"; the designer ask is a checkbox; one row at rest, no counter.
    expect(html).toMatch(/<textarea[^>]*class="nds-textarea fw-rt-cx-text"[^>]*aria-label="Your message"/)
    expect(html).not.toMatch(/<textarea[^>]*role="combobox"/)
    expect(html).toContain('aria-label="Send"')
    expect(html).toMatch(/<button type="button" role="checkbox" aria-checked="false"[^>]*>.*Ask Dora Campione, factory designer<\/button>/)
    expect(html).not.toContain('fw-rt-cx-count')
    // A mail on an email only; the quote of the reader's colleague's message; no Reply when the box is held.
    expect(html.match(/lucide-mail/g)?.length).toBe(1)
    expect(draw(beta({ composer: { value: '', busy: false, held: 'You can read these messages; to write here, ask your admin (Ugo Test).' } }))).toContain('class="fw-rt-cx-held"')
    // The ⋮ only with the frame's width chooser (A11); its rows are the office's Width rows.
    expect(html).not.toContain('fw-rth-menu')
    expect(draw(beta({ width: { widths: ['third', 'forty', 'half'], current: 'forty', choose: () => undefined } }))).toContain('fw-rth-menu')
    // The face imports no office, portal or session code, and draws the shared parts.
    for (const [file, source] of views) expect(source, file).not.toMatch(/from '[^']*(areas|portal|shell|record-panels|lib\/api|lib\/session)\//)
    const face = views[0]![1]
    for (const part of ['MessageRow', 'useFeedShell', 'FeedShell', 'PinnedBar', 'feedRows']) expect(face, part).toContain(part)
    expect(views[2]![1]).toContain('ComposerRow')
    // The face never reports what was seen: the host marks read only while on screen (A14).
    expect(face).not.toContain('onSeen')
  })

  it('every word EN + IT, IT voi for the outside reader, no key left on screen', () => {
    for (const locale of ['en', 'it'] as const) {
      expect(Object.keys(CATALOGUE[locale]['record-thread-partner'] ?? {}).sort(), locale).toEqual(Object.keys(CATALOGUE.en['record-thread-partner'] ?? {}).sort())
      const text = textOf(draw(beta(), locale))
      expect(text, locale).not.toMatch(/\b(kind|row|attach|keys|width|pinbar|feed|state|quote|menu|files|unread|day)\.[a-zA-Z]/)
      expect(text, locale).not.toMatch(/\b(thread|conversation|conversazione)\b/i)
    }
    const it = draw(beta(), 'it')
    expect(it).toContain('aria-label="Il vostro messaggio"')
    expect(it).toContain('aria-label="Inviate"')
    expect(it).toContain('placeholder="Scrivete un messaggio"')
    expect(it).toContain('aria-label="Come funziona"')
    expect(textOf(it)).not.toMatch(/\b(Scrivi|Rispondi|Copia il testo|Riprova|Nascondi|Tasti)\b/)
    // The office reads its own words from the same keys.
    expect(draw(beta(), 'it', false)).toContain('placeholder="Scrivi un messaggio"')
  })

  it('WALL: no "seen by", "read by" or "typing" field or word in the portal thread', () => {
    for (const [file, source] of views) expect(source, file).not.toMatch(/\b(seenBy|readBy|isTyping|typingNow|readers)\b/)
    for (const locale of ['en', 'it'] as const) {
      expect(textOf(draw(beta(), locale)), locale).not.toMatch(/\b(seen by|read by|is typing|visto da|letto da|sta scrivendo)\b/i)
      for (const [key, text] of Object.entries(CATALOGUE[locale]['record-thread-partner'] ?? {})) expect(text, `${locale} ${key}`).not.toMatch(/\b(seen by|read by|is typing|visto da|letto da|sta scrivendo)\b/i)
    }
  })

  it('WALL: Brand Beta’s portal thread shows nothing of Brand Alpha', () => {
    for (const locale of ['en', 'it'] as const) {
      const text = textOf(draw(beta(), locale))
      expect(scanText(text, BRAND_ALPHA), locale).toEqual([])
      expect(text, locale).toContain(BRAND_BETA.message)
    }
  })

  it('a link’s guest: no Reply, no quote, the "+" of the shared files; the states (loading, error with Try again, empty)', () => {
    const link = draw(beta({ kind: 'link', composer: { value: '', busy: false, held: null, attach: { files: [{ id: 'f1', name: BRAND_BETA.fileName }], attached: ['f1'] } } }))
    expect(link).not.toContain('fw-rt-quote')
    expect(link).toContain('aria-label="Attach files of this record"')
    expect(textOf(link)).toContain('1 file attached')
    expect(textOf(draw(beta({ state: 'loading' })))).toContain('Reading the messages…')
    expect(textOf(draw(beta({ state: 'error' })))).toContain('The messages could not be read')
    expect(textOf(draw(beta({ messages: [], pins: [], reading: null })))).toContain('No messages yet')
  })
})
// ---- end W2.2

// ---- pt-fx1 F-2 (walk W-01): the reader's own messages are never unread --------------------------------------------------------------
import { partnerUnreadOf } from './model'

describe('pt-fx1 F-2 — the reader’s own messages are never unread', () => {
  const own = (id: string, minute: number) => msg(id, { side: 'partner', author: { name: 'Lia Modello', mine: true }, at: at(minute) })
  const ours = (id: string, minute: number) => msg(id, { at: at(minute) })
  const list = [ours('m1', 1), own('m2', 2), own('m3', 3), ours('m4', 4), own('m5', 5)]

  it('a portal reader’s own message is never under the unread band nor counted', () => {
    // m2…m5 are new to the server's reading (4); three are her own: the band goes above m4 and says 1.
    expect(partnerUnreadOf(list, { firstNewId: 'm2', newCount: 4 })).toEqual({ firstNewId: 'm4', newCount: 1 })
    // Only her own are new: no band at all.
    expect(partnerUnreadOf(list, { firstNewId: 'm5', newCount: 1 })).toEqual({ firstNewId: null, newCount: 0 })
    // The first new one is older than the loaded page: every loaded one is new; her own three leave the count.
    expect(partnerUnreadOf(list, { firstNewId: 'm0', newCount: 7 })).toEqual({ firstNewId: 'm1', newCount: 4 })
    expect(partnerUnreadOf(list, null)).toEqual({ firstNewId: null, newCount: 0 })
    expect(partnerUnreadOf(list, { firstNewId: 'm2', newCount: 0 })).toEqual({ firstNewId: null, newCount: 0 })
    // Drawn: the band sits above our m4 with her own count left out; with only her own new, no band.
    const face = (reading: { firstNewId: string | null; newCount: number }) =>
      render(createElement(PartnerColumn, { model: { kind: 'record', state: 'ready', title: 'Messages', recordName: 'Your order 142', companyName: 'Example Works', messages: list, reading, composer: null } }))
    const html = face({ firstNewId: 'm2', newCount: 4 })
    expect(html.match(/data-feed-new=""/g)?.length).toBe(1)
    expect(html.indexOf('data-feed-new=""')).toBeGreaterThan(html.indexOf('data-message-id="m3"'))
    expect(html.indexOf('data-feed-new=""')).toBeLessThan(html.indexOf('data-message-id="m4"'))
    expect(textOf(html)).toContain('1 unread message')
    expect(face({ firstNewId: 'm5', newCount: 1 })).not.toContain('data-feed-new')
    // Her own new message arriving live always shows (the list follows it): it never adds to the down button's count.
    const column = readFileSync(new URL('./view/PartnerColumn.tsx', import.meta.url), 'utf8')
    expect(column).toContain('const unread = useMemo(() => partnerUnreadOf(model.messages, model.reading), [model.messages, model.reading])')
    expect(column).toContain('feed.map((message) => (message.mine ? { ...message, outbox: true } : message))')
    expect(column).toContain('messages: shellMessages,')
  })
})
// ---- end pt-fx1 F-2
