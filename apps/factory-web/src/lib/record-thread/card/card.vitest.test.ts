import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../i18n/messages'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { Avatar, initialsOf } from '../parts/Avatar'
import { everyCase, leftKeys, render, textOf } from '../parts/testing'
import { demoCards } from '../demo-data'
import { designScreen } from './fixtures'
import {
  audienceKey,
  cardActions,
  cardFiles,
  cardMarks,
  DELIVERY_STATES,
  DELIVERY_TONE,
  longFold,
  messageLink,
  splitQuoted,
  type CardContext,
  type CardMessage,
} from './model'
import { MessageCard } from './view/MessageCard'

/** B-TH-298 — the message card (T3): each kind, its audience in words and colour, the folds, the files, Retry keeps the text. */

const CONTEXT: CardContext = { partyName: BRAND_ALPHA.tradeName, canReadFiles: true, canReply: true, canTask: true }
const [MAIL, NOTE, BOUNCED, OURS, FLOOR_NOTE, STATION] = demoCards(BRAND_ALPHA)
const card = (message: CardMessage, context: CardContext = CONTEXT, locale: 'en' | 'it' = 'en') => render(createElement(MessageCard, { message, context }), locale)

describe('each kind of card says its side and audience in words and colour', () => {
  it('the customer’s mail: the info card, the organisation tile and name, the channel', () => {
    const html = card(MAIL)
    expect(html).toContain('fw-rt-msg is-theirs')
    expect(html).toContain('fw-rt-av is-org')
    expect(textOf(html)).toContain(`${BRAND_ALPHA.contact.name} ${BRAND_ALPHA.tradeName} Email`)
    expect(html).toContain(`aria-label="${BRAND_ALPHA.contact.name}, message from ${BRAND_ALPHA.tradeName}, 16:05"`)
  })

  it('our mail: “Us”, “Email to <customer>”, the delivery word and the details line', () => {
    const text = textOf(card(OURS))
    expect(text).toContain('Alex Demo Us Email to Brand Alpha Delivered')
    expect(text).toContain(`To ${BRAND_ALPHA.contact.email} · Subject:`)
  })

  it('an Office note: yellow with the lock and “Office only”, never the customer’s edge', () => {
    const html = card(NOTE)
    expect(html).toContain('fw-rt-msg is-note')
    expect(html).not.toContain('is-theirs')
    expect(html).not.toContain('is-ours')
    expect(textOf(html)).toContain('Office note · Office only')
    expect(textOf(html)).toContain('Mentioned: Alex Demo')
    expect(html).toContain('aria-label="Bea Esempio, Office note, office only, 17:30"')
    expect(textOf(card(NOTE, CONTEXT, 'it'))).toContain("Nota d'ufficio · Solo ufficio")
  })

  it('the floor: a ticked note says “Also on the floor”; a station’s comment “From the floor”, with no worker name', () => {
    expect(textOf(card(FLOOR_NOTE))).toContain('Office note · Office only Also on the floor')
    const station = textOf(card(STATION))
    expect(station).toContain('A person on the floor From the floor')
    expect(cardMarks(STATION)).toEqual([{ key: 'mark.fromFloor', icon: 'tablet' }])
    expect(audienceKey(STATION)).toBe('audience.floor')
  })

  it('at most two marks in a head', () => {
    for (const message of demoCards(BRAND_ALPHA)) expect(cardMarks(message).length).toBeLessThanOrEqual(2)
  })

  it('a bounce says why and opens the task it made', () => {
    const html = card(BOUNCED)
    expect(textOf(html)).toContain('could not get this mail: the mail service said so.')
    expect(html).toContain('href="/w/demo/home/tasks?open=task-1"')
    expect(textOf(html)).toContain('Task made for you · Open')
  })

  it('every delivery state has its word in both languages; Delivered is the only success tone', () => {
    for (const locale of ['en', 'it'] as const) for (const state of DELIVERY_STATES) expect(CATALOGUE[locale]['record-thread-card'][`delivery.${state}`]).toBeTruthy()
    expect(DELIVERY_STATES.filter((state) => DELIVERY_TONE[state] === 'success')).toEqual(['DELIVERED'])
    expect(CATALOGUE.en['record-thread-card']['delivery.QUEUED']).toBe('Waiting to send')
    expect(CATALOGUE.en['record-thread-card']['delivery.COMPLAINED']).toBe('Marked as spam')
  })
})

describe('the body folds, nothing is deleted', () => {
  it('the quoted reply and the signature go behind “…”; a note never folds', () => {
    const split = splitQuoted(MAIL.body, 'theirs')
    expect(split.text).toBe(MAIL.body.slice(0, MAIL.body.indexOf('\n\nOn 12 Nov')))
    expect(split.quoted).toContain('Alex Demo wrote:')
    expect(split.quoted).toContain(`${BRAND_ALPHA.contact.name} · Buyer`)
    expect(splitQuoted('Hello\n-- \nAlma', 'ours').quoted).toBe('-- \nAlma')
    expect(splitQuoted('Hello\n> quoted', 'note').quoted).toBeNull()
    expect(splitQuoted('> only quoted\n> text', 'theirs').quoted).toBeNull()
    expect(splitQuoted('Just words', 'theirs')).toEqual({ text: 'Just words', quoted: null })
    expect(card(MAIL)).toContain('aria-expanded="false"')
  })

  it('a long mail folds after 12 lines with “Show all (N lines)”', () => {
    expect(longFold('a\n'.repeat(12).trim())).toEqual({ lines: 12, folds: false })
    expect(longFold('a\n'.repeat(33).trim())).toEqual({ lines: 33, folds: true })
    const html = card({ ...MAIL, body: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') })
    expect(html).toContain('fw-rt-body is-folded')
    expect(textOf(html)).toContain('Show all (20 lines)')
  })
})

describe('files on a card', () => {
  it('pictures for JPEG/PNG/WebP, a row for the rest, the first six and “+N”', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `p${i}.jpg`, sizeBytes: 10, contentType: 'image/jpeg', status: 'AVAILABLE' as const }))
    expect(cardFiles(many, true)).toMatchObject({ more: 14, hidden: 0 })
    expect(cardFiles(many, true).photos).toHaveLength(6)
    expect(textOf(card({ ...OURS, files: many }))).toContain('+14 14 more')
    const split = cardFiles(OURS.files, true)
    expect(split.photos.map((file) => file.name)).toEqual(['sample-front.jpg', 'label-detail.jpg'])
    expect(split.others.map((file) => file.name)).toEqual(['Label placement v2.pdf'])
  })

  it('a reader without the files right sees them counted, never dropped', () => {
    expect(cardFiles(OURS.files, false)).toEqual({ photos: [], others: [], held: [], more: 0, hidden: 3 })
    expect(textOf(card(OURS, { ...CONTEXT, canReadFiles: false }))).toContain('3 files you cannot open')
    expect(textOf(card(OURS, { ...CONTEXT, canReadFiles: false }, 'it'))).toContain('3 file che non puoi aprire')
  })
})

describe('the ⋯ menu and the message on its way', () => {
  it('Reply only on the customer’s message for a reader who may answer; a task where the host has tasks; the link always', () => {
    expect(cardActions(MAIL, CONTEXT)).toEqual(['reply', 'task', 'link'])
    expect(cardActions(MAIL, { canReply: false, canTask: false })).toEqual(['link'])
    expect(cardActions(NOTE, CONTEXT)).toEqual(['task', 'link'])
    expect(cardActions({ ...OURS, outbox: { state: 'sending' } }, CONTEXT)).toEqual([])
  })

  it('the link to a message is the record’s address with ?message=<id> (thread-G03)', () => {
    expect(messageLink('/w/demo/sales/orders/o1', 'm1')).toBe('/w/demo/sales/orders/o1?message=m1')
    expect(messageLink('/w/demo/sales/orders/o1?tab=lines#x', 'm1')).toBe('/w/demo/sales/orders/o1?tab=lines&message=m1#x')
  })

  it('“Sending…” until the server says so; “Not sent · Retry” keeps the text', () => {
    expect(textOf(card({ ...OURS, email: null, outbox: { state: 'sending' } }))).toContain('Sending…')
    const failed = card({ ...OURS, body: 'And the hang tags arrived, thank you.', email: null, outbox: { state: 'failed', reason: 'reason.network' } })
    expect(failed).toContain('is-failed')
    expect(textOf(failed)).toContain('And the hang tags arrived, thank you.')
    expect(textOf(failed)).toContain('Not sent · the connection dropped. Your text is kept. Retry')
  })
})

describe('the Avatar (built here first, B-TH-294 moves it on the Owner’s word)', () => {
  it('two initials, an organisation as a square tile, hidden from screen readers', () => {
    expect(initialsOf('Dora Campione')).toBe('DC')
    expect(initialsOf('Brand Alpha S.r.l.')).toBe('BA')
    expect(initialsOf('Brand Beta GmbH')).toBe('BB')
    expect(initialsOf('alex')).toBe('A')
    expect(initialsOf(null)).toBe('?')
    expect(render(createElement(Avatar, { name: 'Brand Beta', kind: 'organisation' }))).toBe('<span class="fw-rt-av is-org" aria-hidden="true">BB</span>')
  })
})

describe('SCR-006-card in both languages', () => {
  it('every case draws, with no message key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['mark', 'side', 'audience', 'delivery', 'menu', 'files', 'file', 'bounce', 'outbox', 'reason', 'author', 'body', 'mentioned', 'details']), `${locale} ${id}`).toEqual([])
  })

  it('the brand wall: Brand Beta’s copy shows nothing of Brand Alpha (B-TH-203)', () => {
    const beta = everyCase(designScreen).filter(([, id]) => id === 'brand-beta')
    expect(beta).toHaveLength(2)
    for (const [, , html] of beta) {
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(BRAND_BETA.tradeName)
    }
  })
})
