import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { demoCards, demoThread } from '../demo-data'
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
    {
      id: 'brand-beta',
      label: 'Brand Beta’s copy (brand wall)',
      model: { messages: demoThread(BRAND_BETA).slice(-5), context: context(BRAND_BETA.tradeName) },
      note: 'The same cards on Brand Beta’s order: only Brand Beta’s names, contact and file — nothing of Brand Alpha (B-TH-203 scan).',
    },
  ],
})
