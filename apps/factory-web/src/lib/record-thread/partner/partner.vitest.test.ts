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
