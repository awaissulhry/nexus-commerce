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
// B-TH-236
import { amountWords, correctionWay, excerptOf, showsUndo, undoLeft } from './model'
import { MessageCard } from './view/MessageCard'
// B-TH-255
import { SKIP_REASONS } from '@nexus/factory-domain/email-in/rules'
import { bodyKind, cardDepth, SKIP_REASON_CODES, skippedLine, skipReasonKey } from './model'

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
    expect(cardFiles(OURS.files, false)).toEqual({ photos: [], others: [], held: [], more: 0, hidden: 3, sheets: 0 }) // B-TH-231: sheets
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

// ---- B-TH-231 (B-TH-029, B-TH-083): files the reader may not see are counted, a locked sheet is named, "Use on another record…"
describe('B-TH-231: hidden files counted, a sheet named as locked, “Use on another record…”', () => {
  it('the message’s files the API left out and its locked sheets show as lines, never by name, in it and en', () => {
    const counted = { ...OURS, hiddenFiles: 1, lockedSheets: 1 }
    expect(cardFiles(counted.files, true, false, { hidden: 1, sheets: 1 })).toMatchObject({ hidden: 1, sheets: 1 })
    const text = textOf(card(counted))
    expect(text).toContain('1 file you cannot open')
    expect(text).toContain('Measurement sheet — you cannot open it')
    expect(textOf(card(counted, CONTEXT, 'it'))).toContain('Scheda misure — non puoi aprirla')
    expect(leftKeys(card(counted), ['files', 'menu'])).toEqual([])
    expect(scanText(card(counted), BRAND_BETA)).toEqual([])
  })

  it('“Use on another record…” only for a reader who may add files and a message with a file they open', () => {
    expect(cardActions(OURS, { ...CONTEXT, canUseOn: true })).toEqual(['task', 'useOn', 'link'])
    expect(cardActions(OURS, { ...CONTEXT, canUseOn: false })).toEqual(['task', 'link'])
    expect(cardActions({ ...OURS, files: [] }, { ...CONTEXT, canUseOn: true })).toEqual(['task', 'link'])
    expect(cardActions(OURS, { ...CONTEXT, canUseOn: true, canReadFiles: false })).toEqual(['task', 'link'])
  })
})
// ---- end B-TH-231

// ---- B-TH-236 (B-TH-048, B-TH-049, B-TH-050): Correct on one's own message, the links, the office amount, Undo for 10 seconds.
describe('B-TH-236: Correct, “In reply to”, “Corrected below”, the amount, Undo', () => {
  const CAN = { note: true, email: true, portal: true }
  const MINE_MAIL: CardMessage = { ...OURS, mine: true }
  const MINE_NOTE: CardMessage = { ...NOTE, mine: true }

  it('Correct only on one’s own message, the way it went, with the right that way needs; never the customer’s or the floor’s', () => {
    expect(correctionWay(MINE_MAIL, { canCorrect: CAN })).toBe('reply')
    expect(correctionWay(MINE_NOTE, { canCorrect: CAN })).toBe('note')
    expect(correctionWay({ ...MINE_MAIL, channel: 'PORTAL', email: null }, { canCorrect: CAN })).toBe('portal')
    expect(correctionWay(OURS, { canCorrect: CAN })).toBeNull() // a colleague's mail
    expect(correctionWay({ ...MAIL, mine: true }, { canCorrect: CAN })).toBeNull() // the customer corrects their own
    expect(correctionWay({ ...STATION, mine: true }, { canCorrect: CAN })).toBeNull()
    expect(correctionWay(MINE_MAIL, { canCorrect: { ...CAN, email: false } })).toBeNull()
    expect(correctionWay(MINE_NOTE, {})).toBeNull()
    // A mail still in its 10 seconds is taken back, not corrected; one taken back or not sent never reached them.
    expect(correctionWay({ ...MINE_MAIL, email: { ...MINE_MAIL.email!, status: 'QUEUED', undoUntil: '2026-11-17T10:00:07Z' } }, { canCorrect: CAN })).toBeNull()
    expect(correctionWay({ ...MINE_MAIL, email: { ...MINE_MAIL.email!, status: 'WITHDRAWN' } }, { canCorrect: CAN })).toBeNull()
    expect(correctionWay({ ...MINE_MAIL, email: { ...MINE_MAIL.email!, status: 'FAILED' } }, { canCorrect: CAN })).toBeNull()
    expect(cardActions(MINE_MAIL, { ...CONTEXT, canCorrect: CAN })).toEqual(['correct', 'task', 'link'])
    expect(cardActions(MAIL, { ...CONTEXT, canCorrect: CAN })).toEqual(['reply', 'task', 'link'])
    expect(textOf(card(MINE_MAIL, { ...CONTEXT, canCorrect: CAN }))).not.toContain('Correction of')
  })

  it('the correction says “Correction of 09:12” in its head (two marks at most); the old one “Corrected below”', () => {
    const correction: CardMessage = { ...MINE_MAIL, id: 'c-1', at: '2026-11-17T08:20:00.000Z', body: 'Sorry, one change: Thursday.', files: [], corrects: { id: OURS.id, author: 'Alex Demo', excerpt: 'Good morning', at: OURS.at } }
    const text = textOf(card(correction))
    expect(text).toContain('Correction of 09:12')
    expect(card(correction)).toContain(`href="#message-${OURS.id}"`)
    expect(textOf(card({ ...MINE_MAIL, correctedBy: { id: 'c-1', at: '2026-11-17T08:20:00.000Z' } }))).toContain('Corrected below · 09:20')
    expect(textOf(card({ ...MINE_MAIL, correctedBy: { id: 'c-1', at: '2026-11-17T08:20:00.000Z' } }, CONTEXT, 'it'))).toContain('Corretto più sotto · 09:20')
    // A corrected floor note: the audience mark stays in the head, "Also on the floor" moves to the details line.
    const floorFix = textOf(card({ ...FLOOR_NOTE, corrects: { id: 'n-1', author: 'Carlo Prova', excerpt: 'grey mesh', at: FLOOR_NOTE.at } }))
    expect(floorFix).toContain('Office note · Office only Correction of')
    expect(floorFix).toContain('Also on the floor')
  })

  it('a reply names the message it answers above its words (W08: only this thread’s message, its excerpt)', () => {
    const reply: CardMessage = { ...MINE_MAIL, id: 'r-1', channel: 'PORTAL', email: null, body: 'Yes, both sizes.', files: [], replyTo: { id: MAIL.id, author: BRAND_ALPHA.portalPerson.name, excerpt: 'Is the label 3 cm from the hem on both sizes?', at: '2026-11-17T09:41:00.000Z' } }
    const text = textOf(card(reply))
    expect(text).toContain(`In reply to ${BRAND_ALPHA.portalPerson.name}, 17 Nov`)
    expect(text).toContain('“Is the label 3 cm from the hem on both sizes?”')
    expect(text).toContain(`In the portal · ${BRAND_ALPHA.tradeName}`)
    expect(excerptOf('x'.repeat(200)).length).toBe(90)
    expect(scanText(text, BRAND_BETA)).toEqual([])
  })

  it('an office note’s amount in the reader’s numbers, said office only (the API sends it to price readers only)', () => {
    expect(amountWords({ value: 1_845_000, currency: 'EUR' }, 'en-GB')).toBe('€18,450.00')
    expect(amountWords({ value: 1_845_000, currency: 'EUR' }, 'it-IT')).toMatch(/18\.450,00\s?€/)
    const text = textOf(card({ ...NOTE, amount: { value: 125_000, currency: 'EUR' } }))
    expect(text).toContain('Amount: €1,250.00 · office only, for those who see prices')
    expect(textOf(card(NOTE))).not.toContain('Amount:')
  })

  it('Undo for 10 seconds: “Sending to <customer>… · Undo (7)” for the sender only, gone when the window passed', () => {
    const now = Date.parse('2026-11-17T10:00:00.000Z')
    const waiting: CardMessage = { ...MINE_MAIL, files: [], email: { to: [BRAND_ALPHA.contact.email], subject: 'Re: sizes', status: 'QUEUED', id: 'mail-1', undoUntil: '2026-11-17T10:00:07.000Z' } }
    expect(undoLeft(waiting.email!.undoUntil, now)).toBe(7)
    expect(undoLeft('2026-11-17T09:59:59.000Z', now)).toBe(0)
    expect(undoLeft(null, now)).toBe(0)
    expect(showsUndo(waiting, now)).toBe(true)
    expect(showsUndo({ ...waiting, email: { ...waiting.email!, status: 'SENT' } }, now)).toBe(false)
    expect(showsUndo({ ...waiting, email: { ...waiting.email!, undoUntil: undefined } }, now)).toBe(false)
    const html = render(createElement(MessageCard, { message: waiting, context: { ...CONTEXT, now }, actions: { onUndo: () => undefined } }))
    expect(textOf(html)).toContain(`Sending to ${BRAND_ALPHA.tradeName}… Undo (7)`)
    expect(textOf(render(createElement(MessageCard, { message: waiting, context: { ...CONTEXT, now }, actions: { onUndo: () => undefined } }), 'it'))).toContain(`Invio a ${BRAND_ALPHA.tradeName} in corso… Annulla (7)`)
    expect(textOf(render(createElement(MessageCard, { message: waiting, context: { ...CONTEXT, now: now + 8_000 }, actions: { onUndo: () => undefined } })))).not.toContain('Undo (')
  })

  it('the new cases draw with no key left on screen; Brand Beta’s copy stays clean', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['link', 'amount', 'undo', 'menu']), `${locale} ${id}`).toEqual([])
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['corrected', 'reply-link', 'amount', 'undo']))
  })
})
// ---- end B-TH-236

// ---- B-TH-255 (B-TH-079; T3-F14, T3-F15): the erased card, told apart from a message of files only; an e-mail’s files not kept ------
describe('B-TH-255 — erased after a privacy request vs files only; the files an e-mail did not keep', () => {
  const card = (message: CardMessage, locale: 'en' | 'it' = 'en') => render(createElement(MessageCard, { message, context: CONTEXT }), locale)
  const PHOTO = { id: 'p-1', name: 'collar.jpg', sizeBytes: 820_000, contentType: 'image/jpeg', status: 'AVAILABLE' as const }

  it('bodyKind: erased says so; empty words with files is files (NEVER erased); words are words; nothing is nothing', () => {
    expect(bodyKind({ erased: true, body: '', files: [] })).toBe('erased')
    expect(bodyKind({ erased: false, body: '', files: [PHOTO] })).toBe('files')
    expect(bodyKind({ body: '', files: [] })).toBe('empty')
    expect(bodyKind({ body: '', files: [], hiddenFiles: 1 })).toBe('files')
    expect(bodyKind({ body: '  ', files: [], lockedSheets: 1 })).toBe('files')
    expect(bodyKind({ body: 'Hello', files: [PHOTO] })).toBe('text')
  })

  it('the erased card: "Message removed after a privacy request", no empty body, in it and en', () => {
    const erased: CardMessage = { ...MAIL, id: 'e-1', author: null, body: '', files: [], erased: true }
    const html = card(erased)
    expect(textOf(html)).toContain('Message removed after a privacy request')
    expect(html).toContain('fw-rt-msg is-theirs is-erased')
    expect(html).not.toContain('class="fw-rt-body')
    expect(textOf(card(erased, 'it'))).toContain('Messaggio rimosso dopo una richiesta di privacy')
  })

  it('a message of files only is NOT the erased card: its files, no removal words, no empty body', () => {
    const filesOnly: CardMessage = { ...MAIL, id: 'fo-1', body: '', files: [PHOTO] }
    const html = card(filesOnly)
    expect(textOf(html)).not.toContain('removed')
    expect(html).not.toContain('is-erased')
    expect(html).not.toContain('class="fw-rt-body')
    expect(textOf(html)).toContain('collar.jpg')
  })

  it('the files an e-mail did not keep, by name and why; a signature logo is never listed (the codes are factory-domain’s)', () => {
    expect([...SKIP_REASON_CODES].sort()).toEqual(SKIP_REASONS.filter((reason) => reason !== 'inline').sort())
    expect(skipReasonKey('too_large')).toBe('skipped.reason.too_large')
    expect(skipReasonKey('something_new')).toBe('skipped.reason.other')
    expect(skippedLine(undefined)).toBeNull()
    expect(skippedLine([{ name: 'sig.png', contentType: 'image/png', sizeBytes: 900, reason: 'inline' }])).toBeNull()
    const mail: CardMessage = {
      ...MAIL,
      id: 's-1',
      skipped: [
        { name: 'logo.ai', contentType: 'application/postscript', sizeBytes: 2_400_000, reason: 'type_not_allowed' },
        { name: 'clip.mov', contentType: 'video/quicktime', sizeBytes: 61_000_000, reason: 'too_large' },
        { name: 'sig.png', contentType: 'image/png', sizeBytes: 900, reason: 'inline' },
      ],
    }
    const text = textOf(card(mail))
    expect(text).toContain('2 files in this e-mail were not kept: logo.ai (type not accepted), clip.mov (too large)')
    expect(text).not.toContain('sig.png')
    expect(textOf(card({ ...mail, skipped: [mail.skipped![1]!] }, 'it'))).toContain('1 file di questa e-mail non è stato tenuto: clip.mov (troppo grande)')
    expect(textOf(card(MAIL))).not.toContain('were not kept')
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale]['record-thread-card'] ?? {}
      for (const code of [...SKIP_REASON_CODES, 'other']) expect(words[`skipped.reason.${code}`], `${locale} ${code}`).toBeTruthy()
    }
  })

  it('cardDepth carries the API’s flags onto the card; none when the API said nothing', () => {
    expect(cardDepth({})).toEqual({})
    expect(cardDepth({ erased: false, skippedAttachments: [] })).toEqual({})
    expect(cardDepth({ erased: true, skippedAttachments: [{ name: 'a.zip', contentType: 'application/zip', sizeBytes: 1, reason: 'type_not_allowed' }] })).toEqual({ erased: true, skipped: [{ name: 'a.zip', contentType: 'application/zip', sizeBytes: 1, reason: 'type_not_allowed' }] })
  })

  it('the B-TH-255 cases draw with no key left; Brand Beta never shows on Brand Alpha’s cards', () => {
    for (const [locale, id, html] of everyCase(designScreen)) {
      expect(leftKeys(html, ['erased', 'skipped', 'filesOnly']), `${locale} ${id}`).toEqual([])
      if (id === 'erased' || id === 'skipped') expect(scanText(textOf(html), BRAND_BETA), `${locale} ${id}`).toEqual([])
    }
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['erased', 'skipped']))
  })
})
// ---- end B-TH-255

// ---- B-TH-286 (B-TH-091; T3-F12 "Pin for everyone"; wall W08) ----------------------------------------------------------------------
import { pinnable } from './model'

describe('B-TH-286 — pin a message for everyone, by right', () => {
  it('offers Pin for everyone to whoever may write (canPin), Unpin on a pinned card, nothing without the right', () => {
    expect(cardActions(MAIL, { ...CONTEXT, canPin: true })).toContain('pin')
    expect(cardActions({ ...MAIL, pinned: true }, { ...CONTEXT, canPin: true })).toContain('unpin')
    expect(cardActions({ ...MAIL, pinned: true }, { ...CONTEXT, canPin: true })).not.toContain('pin')
    expect(cardActions(MAIL, CONTEXT)).not.toContain('pin')
    expect(cardActions(MAIL, { ...CONTEXT, canPin: false })).not.toContain('pin')
    // Copy link stays last.
    expect(cardActions(NOTE, { ...CONTEXT, canPin: true }).at(-1)).toBe('link')
  })

  it('never pins a message on its way, a mail in its 10 seconds or a mail taken back (the API’s HELD)', () => {
    expect(pinnable({ outbox: { state: 'sending' } })).toBe(false)
    expect(cardActions({ ...OURS, outbox: { state: 'sending' } }, { ...CONTEXT, canPin: true })).toEqual([])
    const waiting = { ...OURS, email: { to: ['buyer@example.com'], subject: 'S', status: 'QUEUED' as const, undoUntil: '2026-11-17T10:42:10.000Z' } }
    expect(pinnable(waiting)).toBe(false)
    expect(cardActions(waiting, { ...CONTEXT, canPin: true })).not.toContain('pin')
    expect(pinnable({ ...OURS, email: { to: ['buyer@example.com'], subject: 'S', status: 'WITHDRAWN' as const } })).toBe(false)
    expect(pinnable({ ...OURS, email: { to: ['buyer@example.com'], subject: 'S', status: 'DELIVERED' as const } })).toBe(true)
  })

  it('a pinned card says so in words (not colour alone), in it and en; the menu words are there', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = card({ ...MAIL, pinned: true }, { ...CONTEXT, canPin: true }, locale)
      expect(html).toContain('fw-rt-pinned')
      expect(textOf(html)).toContain(locale === 'en' ? 'Pinned for everyone on this record' : 'Fissato per tutti su questo record')
      expect(leftKeys(html, ['pin', 'menu'])).toEqual([])
      for (const key of ['menu.pin', 'menu.pinHint', 'menu.unpin', 'menu.unpinHint', 'pin.pinned']) expect(CATALOGUE[locale]['record-thread-card']?.[key]).toBeTruthy()
    }
    expect(card(MAIL, { ...CONTEXT, canPin: true })).not.toContain('fw-rt-pinned')
  })
})
// ---- end B-TH-286
