import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { DEMO_NOW, demoCards, demoThread } from '../demo-data'
import type { CardContext, CardMessage } from './model'
import { CardGallery, type CardGalleryModel } from './view/CardGallery'

/**
 * SCR-006-card — the message card (B-TH-298, T3; picture 2, approved 2026-11-17). Made-up data only: the brand-wall helpers'
 * Brand Alpha and Brand Beta, the design kit's office people. Each case is a state the picture shows: every kind of card, a long
 * mail, sending and not sent, many files, a reader without the files right, and Brand Beta's copy (the brand wall: nothing of
 * Brand Alpha). Light / dark, 1440 / 1920 / phone from the design frame.
 */

const context = (partyName: string, more: Partial<CardContext> = {}): CardContext => ({ partyName, canReadFiles: true, canReply: true, canTask: true, ...more })
const alpha = (messages: readonly CardMessage[], more: Partial<CardContext> = {}): CardGalleryModel => ({ messages, context: context(BRAND_ALPHA.tradeName, more) })

const LONG = [
  'Hello Alex,',
  'before you cut, here is everything we agreed with our designer for the second run.',
  ...Array.from({ length: 30 }, (_, index) => `${index + 1}. Point ${index + 1} of the second run, as on the sample.`),
  'Thanks, Alma',
].join('\n')

const cards = demoCards(BRAND_ALPHA)
const mail = cards[0]
const ours = cards[3]

// ---- B-TH-236 (B-TH-048, B-TH-049, B-TH-050): Correct, "In reply to", the office amount, Undo — made-up messages of picture 2.
const NOW_MS = Date.parse(DEMO_NOW)
const corrected = { ...ours, mine: true, correctedBy: { id: 'correction-1', at: '2026-11-17T08:20:00.000Z' } }
const correction = {
  ...ours,
  id: 'correction-1',
  at: '2026-11-17T08:20:00.000Z',
  body: 'Sorry, one change: cutting starts on Thursday 19 Nov, not Wednesday.',
  files: [],
  mine: true,
  corrects: { id: ours.id, author: 'Alex Demo', excerpt: 'Good morning, here are the photos of the pre-production sample…', at: ours.at },
}
const replyToPortal = {
  ...ours,
  id: 'reply-portal-1',
  channel: 'PORTAL' as const,
  at: '2026-11-17T09:50:00.000Z',
  body: 'Yes: 3 cm from the hem on both sizes, 54 and 56. The old care label text stays.',
  files: [],
  email: null,
  mine: true,
  replyTo: { id: cards[0]!.id, author: BRAND_ALPHA.portalPerson.name, excerpt: 'Photos look good. On the PDF: is the label 3 cm from the hem on both sizes, 54 and 56?', at: '2026-11-17T09:41:00.000Z' },
}
const pricedNote = { ...cards[1]!, id: 'priced-1', body: 'Agreed with the buyer on the phone: the second run at the price below, delivery unchanged.', mentions: [], mine: true, amount: { value: 1_845_000, currency: 'EUR' } }
const sending = { ...ours, id: 'undo-1', at: DEMO_NOW, body: 'Good morning, the size chart follows.', files: [], mine: true, email: { to: [BRAND_ALPHA.contact.email], subject: 'Re: size chart', status: 'QUEUED' as const, id: 'mail-undo-1', undoUntil: new Date(NOW_MS + 7_000).toISOString() } }
// ---- end B-TH-236

// ---- B-TH-255 (B-TH-079; picture 2's erased card and "files not kept" line): made-up messages — a customer's mail whose writer was
// erased after a privacy request, a message of files only (empty words: NOT erased), and an inbound mail whose logo and clip were not kept.
const erased: CardMessage = { ...mail, id: 'erased-1', author: null, body: '', files: [], erased: true }
const filesOnly: CardMessage = { ...mail, id: 'files-only-1', at: '2026-11-17T09:20:00.000Z', body: '', files: [{ id: 'fo-1', name: 'collar-detail.jpg', sizeBytes: 820_000, contentType: 'image/jpeg', status: 'AVAILABLE' }, { id: 'fo-2', name: 'size-run-v2.pdf', sizeBytes: 140_000, contentType: 'application/pdf', status: 'AVAILABLE' }] }
const skippedMail: CardMessage = {
  ...mail,
  id: 'skipped-1',
  at: '2026-11-17T09:35:00.000Z',
  body: 'Here is the logo for the chest print and a short clip of the sample on the bike.',
  files: [],
  skipped: [
    { name: 'logo.ai', contentType: 'application/postscript', sizeBytes: 2_400_000, reason: 'type_not_allowed' },
    { name: 'clip.mov', contentType: 'video/quicktime', sizeBytes: 61_000_000, reason: 'too_large' },
  ],
}
// ---- end B-TH-255

export const designScreen = defineDesignScreen<CardGalleryModel>({
  screen: 'SCR-006-card',
  title: 'Record thread · the message card (T3)',
  view: CardGallery,
  cases: [
    {
      id: 'kinds',
      label: 'Every kind of card',
      model: alpha(cards),
      note: 'The customer’s mail (blue tint, organisation tile, “…” folds the quote and signature), an Office note (yellow, lock, Mentioned), a bounce with its task, our delivered mail with photos and a PDF, a note also on the floor, a station’s comment (“A person on the floor”).',
    },
    {
      id: 'long',
      label: 'Long message',
      model: alpha([{ ...mail, body: LONG, files: [] }]),
      note: 'Folds after 12 lines: “Show all (33 lines)”.',
    },
    {
      id: 'sending-failed',
      label: 'Sending and not sent',
      model: alpha([
        { ...ours, id: 'pending-1', body: 'The second size run follows on Monday.', files: [], email: null, outbox: { state: 'sending' } },
        { ...ours, id: 'failed-1', body: 'And the hang tags arrived, thank you.', files: [], email: null, outbox: { state: 'failed', reason: 'reason.network' } },
      ]),
      note: '“Sending…” until the server says so; “Not sent · Retry” keeps the text (one message on a double click: the same key).',
    },
    {
      id: 'many-files',
      label: 'Many files',
      model: alpha([
        {
          ...ours,
          files: Array.from({ length: 20 }, (_, index) => ({ id: `f-${index}`, name: `photo-${index + 1}.jpg`, sizeBytes: 1_200_000, contentType: 'image/jpeg', status: 'AVAILABLE' as const })),
        },
      ]),
      note: '20 files: the first 6 and “+14”.',
    },
    {
      id: 'held-files',
      label: 'Held and removed files',
      model: alpha([
        {
          ...mail,
          files: [
            { id: 'q-1', name: 'artwork-final.pdf', sizeBytes: 3_100_000, contentType: 'application/pdf', status: 'QUARANTINED' },
            { id: 'd-1', name: 'old-size-chart.pdf', sizeBytes: 90_000, contentType: 'application/pdf', status: 'DELETED' },
          ],
        },
      ]),
      note: 'Held for the virus scan (a lock) and removed: named, never opened.',
    },
    {
      id: 'no-files-right',
      label: 'A reader without the files right',
      model: alpha([mail, ours], { canReadFiles: false, canReply: false, canTask: false }),
      note: '“2 files you cannot open”: counted, never dropped. No Reply and no task without the rights.',
    },
    // ---- B-TH-236
    {
      id: 'corrected',
      label: 'Correct: the old message and its correction',
      model: alpha([corrected, correction], { canCorrect: { note: true, email: true, portal: true } }),
      note: 'Messages are never edited: Correct posts a new message linked to the old one. The old one says “Corrected below”; the new one “Correction of 09:12”. ⋯ › Correct on one’s own message only, by the way it went.',
    },
    {
      id: 'reply-link',
      label: 'A reply names the message it answers',
      model: alpha([replyToPortal], { canCorrect: { note: true, email: true, portal: true } }),
      note: '“In reply to …, 17 Nov: …” above the words opens the message it answers; our reply in the portal says “In the portal · Brand Alpha”.',
    },
    {
      id: 'amount',
      label: 'An office note with its amount (price readers)',
      model: alpha([pricedNote]),
      note: 'The price in its own field, never in the words: only people who see prices read it (the API drops it for everyone else; never the customer, a link or the floor).',
    },
    {
      id: 'undo',
      label: 'Sending… · Undo (10 seconds)',
      model: alpha([sending], { now: NOW_MS }),
      note: 'The sender’s mail waits 10 seconds: “Sending to Brand Alpha… · Undo (7)”. Taken back = the text is back in the box; then the honest words: Sent → Delivered.',
    },
    // ---- end B-TH-236
    // ---- B-TH-255
    {
      id: 'erased',
      label: 'Erased after a privacy request; a message of files only',
      model: alpha([erased, filesOnly]),
      note: '“Message removed after a privacy request” in place of the words (never an empty grey card). A message that only carries files shows its files and no empty body: it is NOT the erased card.',
    },
    {
      id: 'skipped',
      label: 'Files an e-mail brought that were not kept',
      model: alpha([skippedMail]),
      note: '“2 files in this e-mail were not kept: logo.ai (type not accepted), clip.mov (too large)” under the customer’s mail — the office only; a signature logo is never listed.',
    },
    // ---- end B-TH-255
    // ---- B-TH-286 (B-TH-091; T3-F12)
    {
      id: 'th9-286-pinned',
      label: 'Pinned for everyone; ⋯ Pin / Unpin',
      model: alpha([{ ...mail, pinned: true }, cards[1]!, ours], { canPin: true }),
      note: 'The pinned card shows its pin beside the time (said in words for a screen reader); the files line’s “2 pinned” lists it. Open “⋯”: “Pin for everyone” (not a personal bookmark) or “Unpin”. A mail in its 10 seconds to take it back is never pinned.',
    },
    // ---- end B-TH-286
    {
      id: 'brand-beta',
      label: 'Brand Beta’s copy (brand wall)',
      model: { messages: demoThread(BRAND_BETA).slice(-5), context: context(BRAND_BETA.tradeName) },
      note: 'The same cards on Brand Beta’s order: only Brand Beta’s names, contact and file — nothing of Brand Alpha (B-TH-203 scan).',
    },
  ],
})
