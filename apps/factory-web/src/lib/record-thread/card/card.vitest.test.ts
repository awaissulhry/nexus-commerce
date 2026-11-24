import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'
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
  deliveryMark,
  DELIVERY_STATES,
  footMarks,
  longFold,
  messageLink,
  splitQuoted,
  type CardContext,
  type CardMessage,
} from './model'
// B-TH-236
import { amountWords, correctionWay, excerptOf, showsUndo, undoLeft } from './model'
import { MessageCard } from './view/MessageCard'
import type { CardActions } from './view/MessageCard' // F-SA-244
// B-TH-255
import { SKIP_REASONS } from '@nexus/factory-domain/email-in/rules'
import { bodyKind, cardDepth, SKIP_REASON_CODES, skippedLine, skipReasonKey } from './model'
import { ASK_STATES, askChip, changeChip, withChangeSide } from './model' // F-SA-244

/** B-TH-298 — the message card (T3): each kind, its audience in words and colour, the folds, the files, Retry keeps the text. */

const CONTEXT: CardContext = { partyName: BRAND_ALPHA.tradeName, canReadFiles: true, canReply: true, canTask: true }
const [MAIL, NOTE, BOUNCED, OURS, FLOOR_NOTE, STATION] = demoCards(BRAND_ALPHA)
const card = (message: CardMessage, context: CardContext = CONTEXT, locale: 'en' | 'it' = 'en') => render(createElement(MessageCard, { message, context }), locale)

// tw- W1.2 (10-design §2 – §4; R17): the bubble — mine right, everyone else left with the person's tile; who reads it in words and
// icons in the foot, never by side or colour alone; no side words, no head marks.
describe('each kind of bubble says who reads it in words and icons, never by side or colour alone (R17)', () => {
  it('the customer’s mail: left, the PERSON’s 28 px tile, the name with their company (P3), the mail icon with its word', () => {
    const html = card(MAIL)
    expect(html).toContain('fw-rt-msg is-theirs is-others is-start')
    expect(html).toContain('fw-rt-av is-run fw-rt-tone-')
    expect(html).not.toContain('fw-rt-av is-org')
    expect(textOf(html)).toContain(`${BRAND_ALPHA.contact.name} ${BRAND_ALPHA.tradeName}`)
    expect(html).toContain('title="Email"')
    expect(html).toContain(`aria-label="${BRAND_ALPHA.contact.name}, message from ${BRAND_ALPHA.tradeName}, 16:05"`)
    expect(textOf(html)).not.toMatch(/\bUs\b|Email to /)
  })

  // tw- W2.2 (B7): To · Cc · Subject moved into the menu's Email details — no line of them in the bubble.
  it('our mail: no "Us", no "Email to", the delivery as two grey ticks with its word; To and Subject only in Email details', () => {
    const html = card(OURS)
    const text = textOf(html)
    expect(text).not.toMatch(/\bUs\b|Email to /)
    expect(html).toContain('class="fw-rt-mi is-ok" title="Delivered"')
    expect(text).not.toContain(BRAND_ALPHA.contact.email)
    expect(text).not.toContain('Subject:')
    expect(emailDetailsOf(OURS)).toMatchObject({ to: [BRAND_ALPHA.contact.email], sent: true, status: 'DELIVERED' })
  })

  it('an Office note: the one yellow, the lock with "Office only", the @name coloured in its words (no "Mentioned:" line)', () => {
    const html = card(NOTE)
    expect(html).toContain('fw-rt-msg is-note')
    expect(html).not.toContain('is-theirs')
    expect(html).not.toContain('is-ours')
    expect(html).toContain('class="fw-rt-mi fw-rt-lock" title="Office only"')
    expect(html).toContain('<span class="fw-rt-mention">@Alex Demo</span>')
    expect(textOf(html)).not.toContain('Mentioned:')
    expect(html).toContain('aria-label="Bea Esempio, Office note, office only, 17:30"')
    expect(card(NOTE, CONTEXT, 'it')).toContain('title="Solo ufficio"')
  })

  it('the floor: a ticked note says "Also on the floor"; a station’s comment "From the floor" with the "?" tile and no worker name', () => {
    expect(card(FLOOR_NOTE)).toContain('title="Also on the floor"')
    const station = card(STATION)
    expect(textOf(station)).toContain('A person on the floor')
    expect(station).toContain('<span class="fw-rt-av is-run is-hidden" aria-hidden="true">?</span>')
    expect(station).toContain('title="From the floor"')
    expect(footMarks(STATION)).toEqual([{ key: 'foot.office', icon: 'lock' }, { key: 'foot.fromFloor', icon: 'tablet' }])
    expect(audienceKey(STATION)).toBe('audience.floor')
  })

  it('at most two audience icons in a foot, each with its word in both languages', () => {
    for (const message of demoCards(BRAND_ALPHA)) {
      const marks = footMarks(message)
      expect(marks.length).toBeLessThanOrEqual(2)
      for (const locale of ['en', 'it'] as const) for (const mark of marks) expect(CATALOGUE[locale]['record-thread-card'][mark.key], `${locale} ${mark.key}`).toBeTruthy()
    }
  })

  it('a bounce says why in one red line and opens the task it made', () => {
    const html = card(BOUNCED)
    expect(textOf(html)).toContain('could not get this email')
    expect(html).toContain('href="/w/demo/home/tasks?open=task-1"')
    expect(textOf(html)).toContain('Open task')
    expect(html).toContain('class="fw-rt-mi is-bad" title="Bounced"')
  })

  it('every delivery state has its word in both languages; delivered is two ticks in the time’s grey — never blue, never "read"', () => {
    for (const locale of ['en', 'it'] as const) for (const state of DELIVERY_STATES) expect(CATALOGUE[locale]['record-thread-card'][`delivery.${state}`]).toBeTruthy()
    expect(DELIVERY_STATES.filter((state) => deliveryMark(state).icon === 'checks')).toEqual(['DELIVERED'])
    expect(deliveryMark('DELIVERED').tone).toBe('plain')
    for (const state of ['BOUNCED', 'COMPLAINED', 'FAILED'] as const) expect(deliveryMark(state)).toEqual({ icon: 'alert', tone: 'bad' })
    expect(CATALOGUE.en['record-thread-card']['delivery.QUEUED']).toBe('Waiting to send')
    expect(CATALOGUE.en['record-thread-card']['delivery.COMPLAINED']).toBe('Marked as spam')
    const css = readFileSync(new URL('./card.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-rt-mi\.is-ok \{\s*color: inherit;\s*\}/)
    for (const words of Object.values(CATALOGUE.en['record-thread-card'] ?? {})) expect(words).not.toMatch(/\b(read by|seen by|typing)\b/i)
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
  // tw- W1.2 (Z1, W-041, P18): pictures are tiles in a 2 × 2 album; the 4th tile says "+N"; other files a row with type and size.
  it('pictures for JPEG/PNG/WebP as an album of tiles (3 and “+N” past 4), a row for the rest', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `p${i}.jpg`, sizeBytes: 10, contentType: 'image/jpeg', status: 'AVAILABLE' as const }))
    expect(cardFiles(many, true)).toMatchObject({ more: 14, hidden: 0 })
    expect(cardFiles(many, true).photos).toHaveLength(6)
    const album = card({ ...OURS, files: many })
    expect(album.match(/class="fw-rt-tile"/g)?.length).toBe(3)
    expect(textOf(album)).toContain('+17')
    expect(album).toContain('aria-label="Show 17 more files"')
    expect(card(OURS)).toContain('aria-label="Open Label placement v2.pdf"')
    expect(textOf(card(OURS))).toMatch(/PDF · \d+ KB/)
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
  // tw- W1.1: with the reader's ways (replyWays) Reply is on every message (the W1.1 tests); without them, as before.
  // tw- W2.2 (S8): ONE order — Reply · Reply privately · Copy text · Copy link · Pin · Remind me · Make a task · Answer… · Correct ·
  // Email details · Use on another record…
  it('a host that does not say its ways: Reply only on the customer’s message for a reader who may answer; a task where the host has tasks; the link always', () => {
    expect(cardActions(MAIL, CONTEXT)).toEqual(['reply', 'copyText', 'link', 'task', 'emailDetails'])
    expect(cardActions(MAIL, { canReply: false, canTask: false })).toEqual(['copyText', 'link', 'emailDetails'])
    expect(cardActions(NOTE, CONTEXT)).toEqual(['copyText', 'link', 'task'])
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

  // tw- W1.2 (W-016, R5, R6): the bubble's tile — 28 px, the PERSON's initials in their colour; "?" in the neutral grey; never a photo.
  it('the bubble’s tile: 28 px, the person’s initials in their tone; "?" neutral for a writer kept back', () => {
    expect(render(createElement(Avatar, { name: 'Lia Modello', size: 'run', tone: 'purple' }))).toBe('<span class="fw-rt-av is-run fw-rt-tone-purple" aria-hidden="true">LM</span>')
    expect(render(createElement(Avatar, { name: null, size: 'run', tone: 'slate' }))).toBe('<span class="fw-rt-av is-run is-hidden" aria-hidden="true">?</span>')
    // The customer's person shows their own initials, never the company's tile.
    expect(card(MAIL)).toContain(`>${initialsOf(BRAND_ALPHA.contact.name)}</span>`)
    const css = readFileSync(new URL('../parts/parts.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-rt-av\.is-run \{[^}]*width: 28px;[^}]*height: 28px;/)
    expect(readFileSync(new URL('../parts/Avatar.tsx', import.meta.url), 'utf8')).not.toMatch(/<img|photo|src=/i)
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
    expect(cardActions(OURS, { ...CONTEXT, canUseOn: true })).toEqual(['copyText', 'link', 'task', 'emailDetails', 'useOn'])
    expect(cardActions(OURS, { ...CONTEXT, canUseOn: false })).toEqual(['copyText', 'link', 'task', 'emailDetails'])
    expect(cardActions({ ...OURS, files: [] }, { ...CONTEXT, canUseOn: true })).toEqual(['copyText', 'link', 'task', 'emailDetails'])
    expect(cardActions(OURS, { ...CONTEXT, canUseOn: true, canReadFiles: false })).toEqual(['copyText', 'link', 'task', 'emailDetails'])
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
    expect(cardActions(MINE_MAIL, { ...CONTEXT, canCorrect: CAN })).toEqual(['copyText', 'link', 'task', 'correct', 'emailDetails'])
    expect(cardActions(MAIL, { ...CONTEXT, canCorrect: CAN })).toEqual(['reply', 'copyText', 'link', 'task', 'emailDetails'])
    expect(textOf(card(MINE_MAIL, { ...CONTEXT, canCorrect: CAN }))).not.toContain('Correction of')
  })

  // tw- W1.2 / W1.4 (B1, Z10): "Correction of 09:12" on top and "Corrected" in the foot are doors (the host's jump), never a dead hash link.
  it('the correction says “Correction of 09:12” on top; the old one “Corrected” in its foot; both go to the other message', () => {
    const correction: CardMessage = { ...MINE_MAIL, id: 'c-1', at: '2026-11-17T08:20:00.000Z', body: 'Sorry, one change: Thursday.', files: [], corrects: { id: OURS.id, author: 'Alex Demo', excerpt: 'Good morning', at: OURS.at } }
    const text = textOf(card(correction))
    expect(text).toContain('Correction of 09:12')
    expect(card(correction)).not.toContain('href="#message-')
    const jumping = (message: CardMessage) => render(createElement(MessageCard, { message, context: CONTEXT, actions: { onJump: () => undefined } }))
    expect(jumping(correction)).toContain('<button type="button" class="fw-rt-corr">')
    const corrected = { ...MINE_MAIL, correctedBy: { id: 'c-1', at: '2026-11-17T08:20:00.000Z' } }
    expect(textOf(card(corrected))).toContain('Corrected')
    expect(textOf(card(corrected, CONTEXT, 'it'))).toContain('Corretto')
    expect(jumping(corrected)).toContain('<button type="button" class="fw-rt-corrected">Corrected</button>')
    expect(card(corrected)).not.toContain('href="#message-')
    // A corrected floor note: "Correction of" on top, the lock and the tablet with their words in the foot.
    const floorFix = card({ ...FLOOR_NOTE, corrects: { id: 'n-1', author: 'Carlo Prova', excerpt: 'grey mesh', at: FLOOR_NOTE.at } })
    expect(textOf(floorFix)).toContain('Correction of')
    expect(floorFix).toContain('title="Office only"')
    expect(floorFix).toContain('title="Also on the floor"')
  })

  // tw- W1.2 (W-030, R1): the quote block — the quoted sender's colour bar and name, their words; a button that goes to the message.
  it('a reply carries the quote of the message it answers (W08: only this thread’s message, its excerpt), a door to it', () => {
    const reply: CardMessage = { ...MINE_MAIL, id: 'r-1', channel: 'PORTAL', email: null, body: 'Yes, both sizes.', files: [], replyTo: { id: MAIL.id, author: BRAND_ALPHA.portalPerson.name, excerpt: 'Is the label 3 cm from the hem on both sizes?', at: '2026-11-17T09:41:00.000Z' } }
    const html = card(reply)
    const text = textOf(html)
    expect(html).toContain('class="fw-rt-quote fw-rt-tone-slate"')
    expect(text).toContain(`${BRAND_ALPHA.portalPerson.name} Is the label 3 cm from the hem on both sizes?`)
    expect(text).not.toContain('In reply to')
    expect(html).toContain('title="In the portal"')
    const door = render(createElement(MessageCard, { message: reply, context: CONTEXT, actions: { onJump: () => undefined } }))
    expect(door).toContain(`aria-label="Go to the message of ${BRAND_ALPHA.portalPerson.name} at 10:41"`)
    expect(render(createElement(MessageCard, { message: reply, context: CONTEXT, actions: { onJump: () => undefined } }), 'it')).toContain(`aria-label="Vai al messaggio di ${BRAND_ALPHA.portalPerson.name} delle 10:41"`)
    expect(excerptOf('x'.repeat(200)).length).toBe(90)
    expect(scanText(text, BRAND_BETA)).toEqual([])
  })

  it('an office note’s amount in the reader’s numbers, on its own line with the lock (the API sends it to price readers only)', () => {
    expect(amountWords({ value: 1_845_000, currency: 'EUR' }, 'en-GB')).toBe('€18,450.00')
    expect(amountWords({ value: 1_845_000, currency: 'EUR' }, 'it-IT')).toMatch(/18\.450,00\s?€/)
    const html = card({ ...NOTE, amount: { value: 125_000, currency: 'EUR' } })
    expect(textOf(html)).toContain('Amount €1,250.00')
    expect(html).toContain('class="fw-rt-bline fw-rt-amount"')
    // Italian numbers group from five digits (CLDR minimumGroupingDigits 2): 1250,00 €, 18.450,00 €.
    expect(textOf(card({ ...NOTE, amount: { value: 125_000, currency: 'EUR' } }, CONTEXT, 'it'))).toMatch(/Importo 1\.?250,00\s?€/)
    expect(textOf(card(NOTE))).not.toContain('Amount')
  })

  it('Undo for 10 seconds: “Sending · Undo (7)” in the foot for the sender only, the time back when the window passed', () => {
    const now = Date.parse('2026-11-17T10:00:00.000Z')
    const waiting: CardMessage = { ...MINE_MAIL, files: [], email: { to: [BRAND_ALPHA.contact.email], subject: 'Re: sizes', status: 'QUEUED', id: 'mail-1', undoUntil: '2026-11-17T10:00:07.000Z' } }
    expect(undoLeft(waiting.email!.undoUntil, now)).toBe(7)
    expect(undoLeft('2026-11-17T09:59:59.000Z', now)).toBe(0)
    expect(undoLeft(null, now)).toBe(0)
    expect(showsUndo(waiting, now)).toBe(true)
    expect(showsUndo({ ...waiting, email: { ...waiting.email!, status: 'SENT' } }, now)).toBe(false)
    expect(showsUndo({ ...waiting, email: { ...waiting.email!, undoUntil: undefined } }, now)).toBe(false)
    const html = render(createElement(MessageCard, { message: waiting, context: { ...CONTEXT, now }, actions: { onUndo: () => undefined } }))
    expect(textOf(html)).toContain('Sending · Undo (7)')
    expect(html).toContain('aria-label="Take the mail back: 7 seconds left"')
    expect(textOf(render(createElement(MessageCard, { message: waiting, context: { ...CONTEXT, now }, actions: { onUndo: () => undefined } }), 'it'))).toContain('Invio · Annulla (7)')
    const passed = textOf(render(createElement(MessageCard, { message: waiting, context: { ...CONTEXT, now: now + 8_000 }, actions: { onUndo: () => undefined } })))
    expect(passed).not.toContain('Undo (')
    expect(passed).toMatch(/\d\d:\d\d/)
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
    // tw- W2.2 (S8): Pin right after Copy link, in the one order.
    expect(cardActions(NOTE, { ...CONTEXT, canPin: true })).toEqual(['copyText', 'link', 'pin', 'task'])
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

  // tw- W1.2: the pin is a small icon in the foot, its word "Pinned" as the tooltip and for screen readers.
  it('a pinned card says so in words (not colour alone), in it and en; the menu words are there', () => {
    for (const locale of ['en', 'it'] as const) {
      const html = card({ ...MAIL, pinned: true }, { ...CONTEXT, canPin: true }, locale)
      expect(html).toContain('fw-rt-pinned')
      expect(html).toContain(locale === 'en' ? 'title="Pinned"' : 'title="Fissato"')
      expect(leftKeys(html, ['pin', 'menu'])).toEqual([])
      for (const key of ['menu.pin', 'menu.unpin', 'foot.pinned']) expect(CATALOGUE[locale]['record-thread-card']?.[key]).toBeTruthy()
    }
    expect(card(MAIL, { ...CONTEXT, canPin: true })).not.toContain('fw-rt-pinned')
  })
})
// ---- end B-TH-286

// ---- F-SA-244 (sales page plan P5, P8', P21, R2, R7; 14-change-flow §3.1, §4.1; review WP-1, WP-2): the conversation side of a change
describe('F-SA-244: the customer\'s ask and a change\'s line on their cards (office only, filled by the record page)', () => {
  const ASK: CardMessage = { ...MAIL, id: 'ask-1', kind: 'theirs', channel: 'PORTAL' }
  const LINE: CardMessage = { ...NOTE, id: 'line-1', kind: 'note', author: null, authorKind: 'SYSTEM', body: 'Modifica accettata · Bea Esempio · 10:42' }
  const withActions = (message: CardMessage, actions: CardActions, locale: 'en' | 'it' = 'en', readOnly = false) => render(createElement(MessageCard, { message, context: CONTEXT, actions, readOnly }), locale)

  it('the ask\'s chip lives with the request: waiting on us → counter-offer → accepted · N still to do → accepted; refused, withdrawn', () => {
    expect([...ASK_STATES]).toEqual(['OPEN', 'COUNTERED', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'])
    expect(askChip({ state: 'OPEN', stillToDo: 0 })).toEqual({ key: 'ask.chip.OPEN', tone: 'warning' })
    expect(askChip({ state: 'COUNTERED', stillToDo: 0 })).toEqual({ key: 'ask.chip.COUNTERED', tone: 'info' })
    expect(askChip({ state: 'ACCEPTED', stillToDo: 2 })).toEqual({ key: 'ask.chip.acceptedStill', params: { count: 2 }, tone: 'info' })
    expect(askChip({ state: 'ACCEPTED', stillToDo: 0 })).toEqual({ key: 'ask.chip.ACCEPTED', tone: 'success' })
    expect(askChip({ state: 'REFUSED', stillToDo: 0 }).key).toBe('ask.chip.REFUSED')
    expect(askChip({ state: 'WITHDRAWN', stillToDo: 0 }).key).toBe('ask.chip.WITHDRAWN')
  })

  it('the line\'s chip: "Still to do: N" (a door) → "Done"; not counted for this reader → no chip at all (no claim)', () => {
    expect(changeChip({ stillToDo: 2 })).toEqual({ key: 'change.still', params: { count: 2 }, tone: 'warning', door: true })
    expect(changeChip({ stillToDo: 0 })).toEqual({ key: 'change.done', tone: 'success', door: false })
    expect(changeChip({ stillToDo: null })).toBeNull()
  })

  it('only their own message takes the ask, only the system\'s office note takes the line; no facts: the card as before', () => {
    const facts = { asks: new Map([['ask-1', { requestId: 'r1', state: 'OPEN' as const, stillToDo: 0, answer: true }], ['line-1', { requestId: 'r2', state: 'OPEN' as const, stillToDo: 0, answer: true }]]), changes: new Map([['line-1', { stillToDo: 1, floorAt: null, workshopAt: null }], ['ask-1', { stillToDo: 1, floorAt: null, workshopAt: null }]]) }
    expect(withChangeSide(ASK, facts)).toMatchObject({ ask: { requestId: 'r1' } })
    expect(withChangeSide(ASK, facts)).not.toHaveProperty('change')
    expect(withChangeSide(LINE, facts)).toMatchObject({ change: { stillToDo: 1 } })
    expect(withChangeSide(LINE, facts)).not.toHaveProperty('ask')
    // A colleague's office note is never a change's line, whatever the page says.
    expect(withChangeSide({ ...LINE, authorKind: 'USER', author: 'Bea Esempio' }, facts)).not.toHaveProperty('change')
    expect(withChangeSide(ASK, null)).toBe(ASK)
  })

  // tw- W2.2 (10-design §12 home 38): the chip in the bubble; Answer… is a row of the message's menu — a real link to the page's window
  // (MessageMenu: a plain click stays on the page, ⌘ / Ctrl / Shift open a new tab).
  it('their ask: "Request · waiting on us" in the bubble and Answer… in its menu — offered only when the reader may answer it now', () => {
    const html = withActions({ ...ASK, ask: { requestId: 'r1', state: 'OPEN', stillToDo: 0, answer: true } }, { onAnswer: () => undefined, answerHref: (id: string) => `/w/acme/sales/orders/o1?tab=overview&open=${id}` })
    expect(textOf(html)).toContain('Request · waiting on us')
    expect(textOf(html)).not.toContain('Answer…') // a row of the menu (closed on the server render), never a button in the bubble
    expect(cardActions({ ...ASK, ask: { requestId: 'r1', state: 'OPEN', stillToDo: 0, answer: true } }, CONTEXT)).toContain('answer')
    // The reader may not answer it now: no row.
    expect(cardActions({ ...ASK, ask: { requestId: 'r1', state: 'OPEN', stillToDo: 0, answer: false } }, CONTEXT)).not.toContain('answer')
    const menu = readFileSync(new URL('./view/MessageMenu.tsx', import.meta.url), 'utf8')
    expect(menu).toContain("action === 'answer' && answerHref ? { id: action, label: t(ROW_KEY[action]), href: answerHref }")
    expect(menu).toContain('if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return')
    // No door from the page (another host): the row is not drawn (MessageCard drops a row whose door is absent).
    expect(readFileSync(new URL('./view/MessageCard.tsx', import.meta.url), 'utf8')).toContain("const DOOR_OF: Partial<Record<CardAction, keyof CardActions>> = { answer: 'onAnswer', remind: 'onRemind', emailDetails: 'onEmailDetails', copyText: 'onCopyText' }")
    expect(textOf(withActions({ ...ASK, ask: { requestId: 'r1', state: 'ACCEPTED', stillToDo: 2, answer: false } }, {}, 'it'))).toContain('Richiesta · accettata · ancora 2 da fare')
    // The merged customer feed (read only) draws neither.
    expect(textOf(withActions({ ...ASK, ask: { requestId: 'r1', state: 'OPEN', stillToDo: 0, answer: true } }, { onAnswer: () => undefined }, 'en', true))).not.toContain('Request · waiting on us')
  })

  it('a change\'s line: Still to do, when the floor and the workshop were told, Who was told — never who read it', () => {
    const html = withActions({ ...LINE, change: { stillToDo: 2, floorAt: '2026-11-18T09:42:00.000Z', workshopAt: '2026-11-18T09:44:00.000Z' } }, { onWhoWasTold: () => undefined, onStillToDo: () => undefined })
    const text = textOf(html)
    expect(text).toContain('Still to do: 2')
    expect(text).toMatch(/Told the floor at \d\d:\d\d/)
    expect(text).toMatch(/Told the workshop at \d\d:\d\d/)
    expect(text).toContain('Who was told')
    expect(text).not.toMatch(/\b(seen|read by|not yet|shown)\b/i)
    const italian = textOf(withActions({ ...LINE, change: { stillToDo: 0, floorAt: '2026-11-18T09:42:00.000Z', workshopAt: null } }, { onWhoWasTold: () => undefined }, 'it'))
    expect(italian).toContain('Fatto')
    expect(italian).toMatch(/Reparto avvisato alle \d\d:\d\d/)
    expect(italian).toContain('Chi è stato avvisato')
    expect(italian).not.toMatch(/letto|visto|non ancora/i)
    // Not counted for this reader: no chip; the told times stay.
    expect(textOf(withActions({ ...LINE, change: { stillToDo: null, floorAt: null, workshopAt: null } }, {}))).not.toMatch(/Still to do|Done/)
  })

  it('every word in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale]['record-thread-card'] ?? {}
      for (const key of ['OPEN', 'COUNTERED', 'ACCEPTED', 'acceptedStill', 'REFUSED', 'WITHDRAWN']) expect(words[`ask.chip.${key}`]).toBeTruthy()
      for (const key of ['ask.answer', 'change.still', 'change.done', 'change.floor', 'change.workshop', 'change.whoWasTold', 'place.line', 'place.open']) expect(words[key]).toBeTruthy()
    }
    expect(CATALOGUE.it['record-thread-card']?.['ask.chip.OPEN']).toBe('Richiesta · tocca a noi')
  })
})
// ---- end F-SA-244

// ---- tw- W1.1 (10-design §5, §9; D4, Z12, P15; R1): the quote's words in every case, and how Reply answers each message ----------
import { createTranslator as translatorOf, messagesFor as catalogueFor } from '../../i18n/messages'
import { quoteMediaOf, quoteOf, type QuoteModel } from './quote'
import { repliesPrivately, replyWay } from './model'

describe('tw- W1.1 — the quote says who and what, in both languages, words only', () => {
  const words = (locale: 'en' | 'it') => translatorOf(locale, catalogueFor(locale, ['record-thread-card'])['record-thread-card']!)
  const said = (quote: QuoteModel, locale: 'en' | 'it' = 'en') => {
    const t = words(locale)
    const name = quote.name === null ? null : 'text' in quote.name ? quote.name.text : t(quote.name.key)
    const text = 'text' in quote.text ? quote.text.text : t(quote.text.key, quote.text.count === undefined ? undefined : { count: quote.text.count })
    return { name, text }
  }
  const link = { id: 'q1', author: 'Lia Modello', excerpt: 'Good morning! Attached is the final size split.', at: '2026-11-19T08:20:00.000Z' }

  it('the words: a person’s name in their tone, up to 3 lines; "You" for mine; the customer’s person without the company', () => {
    expect(said(quoteOf({ ...link, authorKind: 'PARTY', senderKey: 'PARTY:p1' }))).toEqual({ name: 'Lia Modello', text: 'Good morning! Attached is the final size split.' })
    expect(quoteOf({ ...link, authorKind: 'PARTY', senderKey: 'PARTY:p1' })).toMatchObject({ lines: 3, media: null, lock: false, removed: false })
    expect(quoteOf({ ...link, senderKey: 'PARTY:p1' }).tone).not.toBe('slate')
    const mine = quoteOf({ ...link, author: 'Bea Esempio', authorKind: 'USER', senderKey: 'USER:u2', mine: true })
    expect(said(mine)).toEqual({ name: 'You', text: link.excerpt })
    expect(said(mine, 'it').name).toBe('Tu')
    expect(said(quoteOf({ ...link, author: 'Carlo Prova', authorKind: 'USER', senderKey: 'USER:u3' })).name).toBe('Carlo Prova')
    expect(said(quoteOf(link)).name).not.toContain('Brand Alpha')
  })

  // The lead's final shape (tw-s): firstFile.kind is the API's FILE_KINDS — PHOTO, DOCUMENT, ATTACHMENT, CERTIFICATE, FISCAL_ARCHIVE, AUDIO.
  it('a message of files: "Photo", "PDF", "File", "2 files" — the caption instead when it has words', () => {
    const files = (count: number, kind: string, contentType: string) => ({ ...link, excerpt: '', fileCount: count, firstFile: { id: 'f1', kind, contentType } })
    expect(said(quoteOf(files(1, 'PHOTO', 'image/jpeg')))).toMatchObject({ text: 'Photo' })
    expect(said(quoteOf(files(1, 'PHOTO', 'image/jpeg')), 'it')).toMatchObject({ text: 'Foto' })
    expect(said(quoteOf(files(1, 'ATTACHMENT', 'image/png')))).toMatchObject({ text: 'Photo' })
    expect(said(quoteOf(files(1, 'DOCUMENT', 'application/pdf')))).toMatchObject({ text: 'PDF' })
    expect(said(quoteOf(files(1, 'DOCUMENT', 'application/vnd.ms-excel')))).toMatchObject({ text: 'File' })
    expect(said(quoteOf(files(1, 'CERTIFICATE', 'application/zip')), 'it')).toMatchObject({ text: 'File' })
    expect(said(quoteOf(files(2, 'PHOTO', 'image/jpeg')))).toMatchObject({ text: '2 files' })
    expect(said(quoteOf(files(2, 'PHOTO', 'image/jpeg')), 'it')).toMatchObject({ text: '2 file' })
    expect(quoteOf(files(2, 'PHOTO', 'image/jpeg'))).toMatchObject({ lines: 1, media: 'files' })
    expect(said(quoteOf({ ...files(1, 'PHOTO', 'image/png'), excerpt: 'The sleeve' }))).toMatchObject({ text: 'The sleeve' })
    // A file the reader may not open never counts (the server's fileCount): no files left, the words alone.
    expect(quoteMediaOf({ fileCount: 0, firstFile: null })).toBeNull()
  })

  it('erased: no name, a slate bar, "Message removed"; a hidden floor writer: "A person on the floor", slate', () => {
    const erased = quoteOf({ ...link, author: null, excerpt: '', erased: true, senderKey: 'PARTY:p1' })
    expect(erased).toMatchObject({ name: null, tone: 'slate', lines: 1, removed: true })
    expect(said(erased)).toEqual({ name: null, text: 'Message removed' })
    expect(said(erased, 'it')).toEqual({ name: null, text: 'Messaggio rimosso' })
    const floor = quoteOf({ ...link, author: null, authorKind: 'WORKER', excerpt: 'Collar cut' })
    expect(floor.tone).toBe('slate')
    expect(said(floor)).toEqual({ name: 'A person on the floor', text: 'Collar cut' })
    expect(said(floor, 'it').name).toBe('Una persona in reparto')
    // The server before tw-s sends no kind: a link with no writer is still the floor's, kept back.
    expect(said(quoteOf({ ...link, author: null })).name).toBe('A person on the floor')
  })

  it('a quoted office note shows a small lock (office reads only); a shared one none', () => {
    expect(quoteOf({ ...link, audience: 'OFFICE' }).lock).toBe(true)
    expect(quoteOf({ ...link, audience: 'PARTNER' }).lock).toBe(false)
    expect(quoteOf(link).lock).toBe(false)
  })

  it('never an amount: the quote is built of its link alone — the excerpt’s words, never a price field', () => {
    const quote = quoteOf({ ...link, excerpt: 'See the price below.' })
    expect(Object.keys(quote).sort()).toEqual(['at', 'id', 'lines', 'lock', 'media', 'name', 'removed', 'text', 'tone'])
    expect(JSON.stringify(quote)).not.toMatch(/amount|currency|€/i)
  })

  it('every quote word exists in both languages, the plurals in pairs', () => {
    for (const locale of ['en', 'it'] as const) {
      const catalogue = CATALOGUE[locale]['record-thread-card'] ?? {}
      for (const key of ['quote.you', 'quote.removed', 'quote.photos_one', 'quote.photos_other', 'quote.files_one', 'quote.files_other', 'quote.label', 'menu.replyPrivately']) expect(catalogue[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})

describe('tw- W1.1 — Reply keeps the audience of what it answers (D4), for every kind and reader', () => {
  const ALL = { note: true, email: true, portal: true }
  const at = '2026-11-19T08:20:00.000Z'
  const card = (kind: CardMessage['kind'], channel: CardMessage['channel'], more: Partial<CardMessage> = {}): CardMessage => ({ id: `${kind}-${channel}`, kind, channel, author: 'X', authorKind: kind === 'theirs' ? 'PARTY' : kind === 'floor' ? 'WORKER' : 'USER', at, body: 'x', mentions: [], files: [], ...more })
  const way = (message: CardMessage, ways: { note: boolean; email: boolean; portal: boolean } | undefined, canReply = true) => replyWay(message, { canReply, replyWays: ways })

  it('Owner / Sales (every way): the customer’s mail → email, their portal message → portal; ours the same way; a note → note', () => {
    expect(way(card('theirs', 'EMAIL'), ALL)).toBe('reply')
    expect(way(card('theirs', 'PORTAL'), ALL)).toBe('portal')
    expect(way(card('ours', 'EMAIL', { email: { to: ['a@example.com'], subject: 's', status: 'DELIVERED' } }), ALL)).toBe('reply')
    expect(way(card('ours', 'PORTAL'), ALL)).toBe('portal')
    expect(way(card('note', 'APP'), ALL)).toBe('note')
    expect(way(card('floor', 'APP', { authorHidden: true, author: null }), ALL)).toBe('note')
  })

  it('a Production manager with the portal way only: the customer’s mail is answered in the portal; a note stays a note', () => {
    const PM = { note: true, email: false, portal: true }
    expect(way(card('theirs', 'EMAIL'), PM)).toBe('portal')
    expect(way(card('ours', 'EMAIL'), PM)).toBe('portal')
    expect(way(card('note', 'APP'), PM)).toBe('note')
  })

  it('Z12: a reader with neither way answers the customer with an office note that quotes it — and no second "Reply privately" row', () => {
    const NONE = { note: true, email: false, portal: false }
    expect(way(card('theirs', 'EMAIL'), NONE)).toBe('note')
    expect(way(card('ours', 'EMAIL'), NONE)).toBe('note')
    expect(repliesPrivately(card('theirs', 'EMAIL'), { canReply: false, replyWays: NONE })).toBe(false)
    expect(cardActions(card('theirs', 'EMAIL'), { canReply: false, replyWays: NONE })).toEqual(['reply', 'copyText', 'link', 'emailDetails'])
  })

  it('Reply privately only on the customer’s message, beside a Reply that goes to the customer', () => {
    expect(cardActions(card('theirs', 'EMAIL'), { canReply: true, replyWays: ALL })).toEqual(['reply', 'replyPrivately', 'copyText', 'link', 'emailDetails'])
    expect(cardActions(card('ours', 'EMAIL'), { canReply: true, replyWays: ALL })).toEqual(['reply', 'copyText', 'link'])
    expect(cardActions(card('note', 'APP'), { canReply: true, replyWays: ALL })).toEqual(['reply', 'copyText', 'link'])
    expect(repliesPrivately(card('theirs', 'PORTAL'), { canReply: true, replyWays: { note: false, email: true, portal: true } })).toBe(false)
  })

  it('Read-only (no way at all): no Reply anywhere', () => {
    const NO = { note: false, email: false, portal: false }
    for (const message of [card('theirs', 'EMAIL'), card('ours', 'PORTAL'), card('note', 'APP'), card('floor', 'APP')]) expect(way(message, NO), message.id).toBeNull()
  })

  it('never on a message on its way, a mail in its 10 seconds or taken back, or the system’s own line', () => {
    expect(way(card('ours', 'EMAIL', { outbox: { state: 'sending' } }), ALL)).toBeNull()
    expect(way(card('ours', 'EMAIL', { email: { to: ['a@example.com'], subject: 's', status: 'QUEUED', undoUntil: at } }), ALL)).toBeNull()
    expect(way(card('ours', 'EMAIL', { email: { to: ['a@example.com'], subject: 's', status: 'WITHDRAWN' } }), ALL)).toBeNull()
    expect(way(card('note', 'APP', { authorKind: 'SYSTEM', author: null }), ALL)).toBeNull()
  })

  it('a host that does not say its ways: Reply on the customer’s message only, as before', () => {
    expect(way(card('theirs', 'EMAIL'), undefined)).toBe('reply')
    expect(way(card('theirs', 'EMAIL'), undefined, false)).toBeNull()
    expect(way(card('note', 'APP'), undefined)).toBeNull()
    expect(way(card('ours', 'EMAIL'), undefined)).toBeNull()
  })
})
// ---- end tw- W1.1

// ---- tw- W1.2 (10-design §2, §3; R1, R17; PR-15): the bubble's type wall, the quote's source, the run, the width rule ----------------
import type { BubbleModel } from './view/Bubble'

describe('tw- W1.2 — the bubble', () => {
  it('BubbleModel has no audience, note, author id or office field (the narrow shell a portal may reuse)', () => {
    expectTypeOf<keyof BubbleModel>().toEqualTypeOf<'side' | 'run' | 'name' | 'senderTone'>()
    const source = readFileSync(new URL('./view/Bubble.tsx', import.meta.url), 'utf8')
    const model = source.slice(source.indexOf('export interface BubbleModel {'), source.indexOf('\n}\n', source.indexOf('export interface BubbleModel {')))
    expect(model).not.toMatch(/\b(audience|note|office|authorId|author|kind|channel|amount)\??:/)
    expect(source).not.toMatch(/from '[^']*(areas|portal|shell|record-panels|lib\/api|lib\/session)\//)
  })

  it('a quote is drawn only from the message’s own replyTo / corrects (R1): the card never looks a quoted message up among loaded ones', () => {
    const card = readFileSync(new URL('./view/MessageCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain('<QuoteBlock link={message.replyTo} onJump={onJump} />')
    expect(card).toContain('<CorrectionLink link={message.corrects} onJump={onJump} />')
    for (const file of ['./view/MessageCard.tsx', './view/QuoteBlock.tsx', './quote.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).not.toMatch(/\.find\(|messages\.(filter|some)\(|\bmessages\b\s*[:=]/)
    }
    expect(readFileSync(new URL('./view/QuoteBlock.tsx', import.meta.url), 'utf8')).toContain('const quote = quoteOf(link)')
  })

  it('mine on the right with no tile and no name; someone else’s run starts with the tile, the name and the tail; inside a run neither', () => {
    const mine = render(createElement(MessageCard, { message: { ...NOTE, mine: true }, context: CONTEXT }))
    expect(mine).toContain('fw-rt-msg is-note is-mine is-start')
    expect(mine).not.toContain('fw-rt-av')
    expect(mine).not.toContain('class="fw-rt-name')
    expect(mine).toContain('class="fw-rt-bub is-mine is-tail"')
    const first = render(createElement(MessageCard, { message: NOTE, context: CONTEXT, run: { side: 'others', first: true, last: false, showName: true } }))
    expect(first).toContain('fw-rt-av is-run')
    expect(first).toContain('class="fw-rt-bub is-others is-tail"')
    expect(first).toContain('class="fw-rt-name fw-rt-tone-')
    const inside = render(createElement(MessageCard, { message: NOTE, context: CONTEXT, run: { side: 'others', first: false, last: true, showName: false } }))
    expect(inside).not.toContain('fw-rt-av')
    expect(inside).not.toContain('is-tail')
    expect(inside).not.toContain('class="fw-rt-name')
    expect(inside).toContain('fw-rt-msg is-note is-others"')
  })

  it('the hover arrow keeps fw-rt-msg-more (on hover AND focus), no hint rows under its items; a read-only card has none', () => {
    const html = card(MAIL)
    expect(html).toContain('fw-rt-msg-more')
    expect(html).toContain('class="fw-rt-tools"')
    const css = readFileSync(new URL('./card.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-rt-bub:hover \.fw-rt-tools,\s*\.fw-rt-bub:focus-within \.fw-rt-tools/)
    expect(readFileSync(new URL('./view/MessageCard.tsx', import.meta.url), 'utf8')).not.toContain('Hint`)')
    expect(render(createElement(MessageCard, { message: MAIL, context: CONTEXT, readOnly: true }))).not.toContain('fw-rt-msg-more')
  })

  it('the system’s own office line is one centred pill with its lock and time, and no menu', () => {
    const line: CardMessage = { ...NOTE, id: 'sys-1', author: null, authorKind: 'SYSTEM', body: 'On draft shipment SH-0012.', mentions: [] }
    const html = card(line)
    expect(html).toContain('fw-rt-msg is-note is-system')
    expect(html).toContain('class="fw-rt-sys"')
    expect(html).not.toContain('fw-rt-msg-more')
    expect(html).toContain('data-message-id="sys-1"')
  })

  it('one css rule for the width (on the list, P17); words at 72ch; corners 7; tokens only — no rgba, no color-mix, no raw colour', () => {
    const css = readFileSync(new URL('./card.css', import.meta.url), 'utf8')
    expect(css).toContain('max-width: min(var(--L, 100%) - 64px, max(var(--L, 100%) * 0.65, 340px));')
    expect(css).toMatch(/^\.fw-rt-bub \{[^}]*border-radius: var\(--nds-radius-md\);/m)
    expect(css).toMatch(/^\.fw-rt-body \{[^}]*max-width: 72ch;/m)
    for (const file of ['./card.css', '../parts/parts.css']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(text, file).not.toMatch(/rgba?\(|hsla?\(|color-mix\(|#[0-9a-f]{3,8}\b|box-shadow/i)
    }
  })

  it('every new word of the bubble draws in both languages, no key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['foot', 'quote', 'org', 'link', 'amount', 'undo']), `${locale} ${id}`).toEqual([])
  })
})
// ---- end tw- W1.2


// ---- tw- W2.2 (THE THREAD REBUILD; 10-design §9, S8; B7, Z2; W-060, W-061; R6–R9, R15, R16): ONE menu, ONE order, Email details ----
import { readdirSync, statSync } from 'node:fs'
import { copyTextOf, emailDetailsOf, MENU_ORDER } from './model'
import { opensOnRightClick } from './view/MessageMenu'
import { emailWindowOf } from '../RecordThread'
import { verdictOf } from '../popups/model'

describe('tw- W2.2 — the message menu per kind and per reader (10-design §9)', () => {
  const OWNER: CardContext = { partyName: BRAND_ALPHA.tradeName, canReadFiles: true, canReply: true, canTask: true, canPin: true, canRemind: true, canUseOn: true, canCorrect: { note: true, email: true, portal: true }, replyWays: { note: true, email: true, portal: true } }
  const PRODUCTION: CardContext = { ...OWNER, canUseOn: false, canCorrect: { note: true, email: false, portal: true }, replyWays: { note: true, email: false, portal: true } }
  const READ_ONLY: CardContext = { partyName: BRAND_ALPHA.tradeName, canReadFiles: true, canReply: false, canRemind: true, replyWays: { note: false, email: false, portal: false } }
  const at = '2026-11-19T08:20:00.000Z'
  const msg = (more: Partial<CardMessage>): CardMessage => ({ id: 'm1', kind: 'theirs', channel: 'EMAIL', author: 'Lia Modello', authorKind: 'PARTY', at, body: 'The final size split.', mentions: [], files: [{ id: 'f1', name: 'sizes.pdf', sizeBytes: 1, contentType: 'application/pdf', status: 'AVAILABLE' }], ...more })
  const THEIR_MAIL = msg({})
  const COLLEAGUE_NOTE = msg({ kind: 'note', channel: 'APP', author: 'Carlo Prova', authorKind: 'USER', files: [] })
  const MY_MAIL = msg({ kind: 'ours', author: 'Bea Esempio', authorKind: 'USER', mine: true, files: [], email: { to: ['lia@brand-alpha.example'], subject: 'Re: sizes', status: 'DELIVERED' } })
  const MY_PORTAL = msg({ kind: 'ours', channel: 'PORTAL', author: 'Bea Esempio', authorKind: 'USER', mine: true, files: [], email: null })
  const FLOOR = msg({ kind: 'floor', channel: 'APP', author: null, authorKind: 'WORKER', authorHidden: true, files: [] })
  const SYSTEM = msg({ kind: 'note', channel: 'APP', author: null, authorKind: 'SYSTEM', files: [] })

  it('Owner / Sales: the customer’s email · a colleague’s note · my email · my portal reply · a floor note · the system’s line', () => {
    expect(cardActions(THEIR_MAIL, OWNER)).toEqual(['reply', 'replyPrivately', 'copyText', 'link', 'pin', 'remind', 'task', 'emailDetails', 'useOn'])
    expect(cardActions(COLLEAGUE_NOTE, OWNER)).toEqual(['reply', 'copyText', 'link', 'pin', 'remind', 'task'])
    expect(cardActions(MY_MAIL, OWNER)).toEqual(['reply', 'copyText', 'link', 'pin', 'remind', 'task', 'correct', 'emailDetails'])
    expect(cardActions(MY_PORTAL, OWNER)).toEqual(['reply', 'copyText', 'link', 'pin', 'remind', 'task', 'correct'])
    expect(cardActions(FLOOR, OWNER)).toEqual(['reply', 'copyText', 'link', 'pin', 'remind', 'task'])
    // The system's own line is a pill: no menu at all.
    expect(cardActions(SYSTEM, OWNER)).toEqual([])
    // A message with the customer's ask the reader may answer now: + Answer…, in its place.
    expect(cardActions({ ...THEIR_MAIL, ask: { requestId: 'r1', state: 'OPEN', stillToDo: 0, answer: true } }, OWNER)).toEqual(['reply', 'replyPrivately', 'copyText', 'link', 'pin', 'remind', 'task', 'answer', 'emailDetails', 'useOn'])
  })

  it('a Production manager (portal way only): Reply goes to the portal; no Use on…; a Read-only reader: Copy text · Copy link · Remind me · Email details', () => {
    expect(cardActions(THEIR_MAIL, PRODUCTION)).toEqual(['reply', 'replyPrivately', 'copyText', 'link', 'pin', 'remind', 'task', 'emailDetails'])
    expect(cardActions(THEIR_MAIL, READ_ONLY)).toEqual(['copyText', 'link', 'remind', 'emailDetails'])
    expect(cardActions(COLLEAGUE_NOTE, READ_ONLY)).toEqual(['copyText', 'link', 'remind'])
    expect(cardActions(FLOOR, READ_ONLY)).toEqual(['copyText', 'link', 'remind'])
  })

  it('every row keeps its place in ONE order; a message with no words has no Copy text; one on its way no menu', () => {
    expect(MENU_ORDER).toEqual(['reply', 'replyPrivately', 'copyText', 'link', 'pin', 'unpin', 'remind', 'task', 'answer', 'correct', 'emailDetails', 'useOn'])
    for (const message of [THEIR_MAIL, COLLEAGUE_NOTE, MY_MAIL, MY_PORTAL, FLOOR]) {
      const rows = cardActions(message, OWNER)
      expect(rows, message.id).toEqual([...rows].sort((a, b) => MENU_ORDER.indexOf(a) - MENU_ORDER.indexOf(b)))
    }
    expect(copyTextOf({ body: '  ' })).toBeNull()
    expect(copyTextOf({ body: 'Collar cut', erased: true })).toBeNull()
    expect(copyTextOf({ body: ' Collar cut ' })).toBe('Collar cut')
    expect(cardActions({ ...THEIR_MAIL, body: '' }, OWNER)).not.toContain('copyText')
    expect(cardActions({ ...MY_MAIL, outbox: { state: 'sending' } }, OWNER)).toEqual([])
  })

  it('the menu words in both languages, one line each — no hint row under any row (B9)', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale]['record-thread-card'] ?? {}
      for (const key of ['menu.reply', 'menu.replyPrivately', 'menu.copyText', 'menu.link', 'menu.pin', 'menu.unpin', 'menu.remind', 'menu.task', 'ask.answer', 'menu.correct', 'menu.emailDetails', 'menu.useOn', 'menu.answerThere', 'foot.followUp']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
    expect(CATALOGUE.en['record-thread-card']?.['menu.link']).toBe('Copy link')
    expect(CATALOGUE.it['record-thread-card']?.['menu.emailDetails']).toBe('Dettagli email')
    const menu = readFileSync(new URL('./view/MessageMenu.tsx', import.meta.url), 'utf8')
    expect(menu).not.toMatch(/description:|Hint/)
  })

  it('the arrow sits inside the bubble’s top-right corner on hover and keyboard focus; a right-click opens the same menu (a link or selected text keep the browser’s)', () => {
    const withDoors = render(createElement(MessageCard, { message: THEIR_MAIL, context: OWNER, actions: { onReply: () => undefined, onCopyText: () => undefined, onRemind: () => undefined, onEmailDetails: () => undefined } }))
    expect(withDoors).toContain('class="fw-rt-tools"')
    expect(withDoors).toContain(`aria-label="More for the message of Lia Modello at`)
    const css = readFileSync(new URL('./card.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-rt-bub:hover \.fw-rt-tools,\s*\.fw-rt-bub:focus-within \.fw-rt-tools,/)
    const source = readFileSync(new URL('./view/MessageCard.tsx', import.meta.url), 'utf8')
    expect(source).toContain('onContextMenu={onContextMenu}')
    expect(opensOnRightClick({ target: { closest: () => null } as unknown as EventTarget }, '')).toBe(true)
    expect(opensOnRightClick({ target: { closest: () => ({}) } as unknown as EventTarget }, '')).toBe(false)
    expect(opensOnRightClick({ target: { closest: () => null } as unknown as EventTarget }, 'selected words')).toBe(false)
  })

  it('a row whose door the host does not give is not drawn (Copy text, Remind me, Email details, Answer…); read-only (All of) draws no menu', () => {
    const source = readFileSync(new URL('./view/MessageCard.tsx', import.meta.url), 'utf8')
    expect(source).toContain('cardActions(message, context).filter((action) => !DOOR_OF[action] || Boolean(actions?.[DOOR_OF[action]!]))')
    expect(render(createElement(MessageCard, { message: THEIR_MAIL, context: OWNER, actions: { onCopyLink: () => undefined }, readOnly: true }))).not.toContain('fw-rt-msg-more')
  })
})

describe('tw- W2.2 — Email details (B7, Z2): one window for our email and an inbound one', () => {
  const at = '2026-11-19T08:20:00.000Z'
  const base: CardMessage = { id: 'm1', kind: 'theirs', channel: 'EMAIL', author: 'Lia Modello', authorKind: 'PARTY', at, body: 'The final size split.', mentions: [], files: [] }
  const words = (key: string) => key

  it('our email: To, Cc, Subject, the date and its delivery state in words — never "read"', () => {
    const ours: CardMessage = { ...base, kind: 'ours', author: 'Bea Esempio', authorKind: 'USER', email: { to: ['lia@brand-alpha.example'], cc: ['bea@example.com'], subject: 'Re: sizes', status: 'DELIVERED' } }
    expect(emailDetailsOf(ours)).toEqual({ from: 'Bea Esempio', to: ['lia@brand-alpha.example'], cc: ['bea@example.com'], subject: 'Re: sizes', at, sent: true, status: 'DELIVERED', verdicts: null, text: 'The final size split.' })
    expect(emailWindowOf(ours, words)).toMatchObject({ sent: true, status: 'delivery.DELIVERED', verdicts: null, bodyHtml: null })
    expect(CATALOGUE.en['record-thread-card']?.['delivery.DELIVERED']).toBe('Delivered')
  })

  it('an inbound email: From with the address, To, Cc, Subject and the sender checks as it came; without its mail row the sender, the time and the words', () => {
    const mail = { from: { address: 'lia@brand-alpha.example', name: 'Lia Modello' }, to: ['orders@example.com'], cc: [], subject: 'Sizes', verdicts: { spf: 'PASS', dkim: 'FAIL', dmarc: 'SOMETHING_NEW' } }
    expect(emailDetailsOf({ ...base, mail })).toMatchObject({ from: 'Lia Modello <lia@brand-alpha.example>', to: ['orders@example.com'], subject: 'Sizes', sent: false, status: null })
    expect(emailWindowOf({ ...base, mail }, words)?.verdicts).toEqual({ spf: 'PASS', dkim: 'FAIL', dmarc: 'DISABLED' })
    expect(verdictOf('GRAY')).toBe('GRAY')
    expect(emailDetailsOf(base)).toEqual({ from: 'Lia Modello', to: [], cc: [], subject: null, at, sent: false, status: null, verdicts: null, text: 'The final size split.' })
    expect(emailDetailsOf({ ...base, mail: { ...mail, from: { address: 'lia@brand-alpha.example', name: null } } })?.from).toBe('Lia Modello <lia@brand-alpha.example>')
    // Not an email: no window. An erased one keeps no words.
    expect(emailDetailsOf({ ...base, channel: 'PORTAL' })).toBeNull()
    expect(emailDetailsOf({ ...base, erased: true })?.text).toBe('')
  })

  it('the window is the ONE OriginalEmail, mounted by RecordThread for every host (nothing fetched); its words in both languages', () => {
    const thread = readFileSync(new URL('../RecordThread.tsx', import.meta.url), 'utf8')
    expect(thread).toContain('{details && <OriginalEmail model={details} onClose={() => setDetailsOf(null)} />}')
    expect(thread).toContain('onEmailDetails: (messageId) => setDetailsOf(messageId), // tw- W2.2')
    for (const locale of ['en', 'it'] as const) {
      const popups = CATALOGUE[locale]['record-thread-popups'] ?? {}
      for (const key of ['original.title', 'original.subject', 'original.sent', 'original.status', 'original.asItCame', 'original.from', 'original.to', 'original.cc', 'original.received']) expect(popups[key], `${locale} ${key}`).toBeTruthy()
    }
    expect(CATALOGUE.en['record-thread-popups']?.['original.title']).toBe('Email details')
  })
})

describe('tw- W2.2 — the follow-up bell in the foot, for its sender only', () => {
  it('a bell with "Reminds you … if no answer" on the reader’s own message with a follow-up; none on another’s', () => {
    const mine: CardMessage = { ...OURS, mine: true, followUp: { at: '2026-11-22T08:00:00.000Z' } }
    for (const [locale, words] of [['en', 'Reminds you'], ['it', 'Te lo ricorda']] as const) {
      const html = card(mine, CONTEXT, locale)
      expect(html, locale).toContain('fw-rt-followup')
      expect(html, locale).toMatch(new RegExp(`title="${words}[^"]+"`))
    }
    expect(card({ ...mine, mine: false })).not.toContain('fw-rt-followup')
    expect(card({ ...OURS, mine: true })).not.toContain('fw-rt-followup')
  })
})

describe('tw- W2.2 — the walls of the face: never forward, star, delete, edit, info, report, react, previews, photos, read-by, typing', () => {
  const sources = (dir: URL): string[] => {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const at = new URL(name, dir)
      if (statSync(at).isDirectory()) out.push(...sources(new URL(`${name}/`, dir)))
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|fixtures\.ts$|Case\.tsx$|Gallery\.tsx$/.test(name)) out.push(readFileSync(at, 'utf8'))
    }
    return out
  }
  const rt = sources(new URL('../', import.meta.url))
  const srt = sources(new URL('../../../areas/_shared/record-thread/', import.meta.url))

  it('R15: no Forward, Star, Delete, Edit, Message info or Report row anywhere in rt/', () => {
    const menu = readFileSync(new URL('./view/MessageMenu.tsx', import.meta.url), 'utf8')
    expect(menu).not.toMatch(/\b(forward|star|delete|edit|info|report|react)\b\s*:/i)
    for (const action of MENU_ORDER) expect(action).not.toMatch(/forward|star|delete|edit|info|report|react/i)
    for (const words of Object.keys(CATALOGUE.en['record-thread-card'] ?? {}).filter((key) => key.startsWith('menu.'))) expect(words).not.toMatch(/forward|star|delete|edit|messageInfo|report|react/i)
  })

  it('R16: links open, nothing is fetched for them — no link preview in rt/ or srt/', () => {
    for (const source of [...rt, ...srt]) expect(source).not.toMatch(/linkPreview|og:image|unfurl/i)
  })

  it('R6–R9: no photo of a person, no reaction, no "seen by" / "read by" / "typing" field or word in rt/ + srt/', () => {
    for (const source of [...rt, ...srt]) {
      expect(source).not.toMatch(/\bavatarUrl\b|\bphotoUrl\b|\breactions?\s*[:=]/)
      expect(source).not.toMatch(/\b(seenBy|readBy|isTyping|typingNow)\b/)
    }
    for (const locale of ['en', 'it'] as const) {
      for (const name of ['record-thread', 'record-thread-card', 'record-thread-feed', 'record-thread-head']) {
        for (const [key, text] of Object.entries(CATALOGUE[locale][name] ?? {})) expect(text, `${locale} ${name} ${key}`).not.toMatch(/\b(seen by|read by|is typing|visto da|letto da|sta scrivendo)\b/i)
      }
    }
  })
})
// ---- end tw- W2.2
