import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { PortalPin } from '../../../lib/record-thread/partner/model'
import { PartnerCase, type PartnerCaseMessage, type PartnerCaseModel } from './view/PartnerCase'

/**
 * SCR-027-thread (pt-t T.1, lane pt-; ONE SHARED THREAD) — the portal's messages on the ONE partner face, MADE-UP data only: our company
 * "Example Works" (Bea Esempio, Carlo Prova; Dora Campione, the factory designer) and the customer's people (Lia Modello, the reader;
 * Ugo Test, her colleague) on "Your order 142". Read from outside the office (portal/: IT voi).
 */

const at = (day: 16 | 17, hour: number, minute = 0) => `2026-11-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
const ours = (name: string | null) => ({ side: 'company' as const, author: { name, mine: false } })
const mine = { side: 'partner' as const, author: { name: 'Lia Modello', mine: true } }
const colleague = { side: 'partner' as const, author: { name: 'Ugo Test', mine: false } }

const BUSY: readonly PartnerCaseMessage[] = [
  { id: 'm01', ...ours('Bea Esempio'), channel: 'portal', at: at(16, 8, 10), body: { en: 'Good morning: your order 142 is confirmed. The fabric arrives on Thursday.', it: 'Buongiorno: il vostro ordine 142 è confermato. Il tessuto arriva giovedì.' } },
  { id: 'm02', ...mine, channel: 'portal', at: at(16, 8, 40), body: { en: 'Thank you. Can the sleeves of size 52 be two centimetres longer?', it: 'Grazie. Le maniche della taglia 52 possono essere due centimetri più lunghe?' } },
  {
    id: 'm03',
    ...ours('Bea Esempio'),
    channel: 'email',
    at: at(16, 9, 5),
    body: { en: 'Yes: we add two centimetres. The new size chart is attached.', it: 'Sì: aggiungiamo due centimetri. La nuova tabella taglie è allegata.' },
    attachments: [{ id: 'f-chart', name: 'Size chart 142.pdf', sizeBytes: 86_016, contentType: 'application/pdf', href: '#size-chart' }],
  },
  { id: 'm04', ...colleague, channel: 'portal', at: at(16, 9, 30), body: { en: 'I check the chart with our warehouse.', it: 'Controllo la tabella con il nostro magazzino.' } },
  {
    id: 'm05',
    ...ours('Carlo Prova'),
    channel: 'portal',
    at: at(16, 11, 0),
    body: { en: 'Here is the first sleeve.', it: 'Ecco la prima manica.' },
    attachments: [
      { id: 'f-front', name: 'Sleeve 52 front.jpg', sizeBytes: 412_000, contentType: 'image/jpeg', href: '#front' },
      { id: 'f-back', name: 'Sleeve 52 back.jpg', sizeBytes: 398_000, contentType: 'image/jpeg', href: '#back' },
    ],
  },
  {
    id: 'm06',
    ...ours('Carlo Prova'),
    channel: 'portal',
    at: at(16, 11, 20),
    body: { en: 'The price of the longer sleeve is in the locked document.', it: 'Il prezzo della manica più lunga è nel documento bloccato.' },
    // A file that shows prices to a reader who does not see prices: counted "locked", never named, never opened.
    attachments: [{ id: 'f-price', name: '', locked: true }],
  },
  { id: 'm07', side: 'partner', author: { name: null, mine: false }, channel: 'portal', at: at(16, 15, 0), erased: true, body: { en: '', it: '' } },
  {
    id: 'm08',
    ...mine,
    channel: 'portal',
    at: at(17, 7, 50),
    body: { en: 'The photos look good.', it: 'Le foto vanno bene.' },
    replyTo: { id: 'm05', authorName: 'Carlo Prova', authorKind: 'USER', excerpt: 'Here is the first sleeve.', at: at(16, 11, 0), fileCount: 2, firstFile: { id: 'f-front', kind: 'PHOTO', contentType: 'image/jpeg' } },
  },
  { id: 'm09', ...ours('Bea Esempio'), channel: 'portal', at: at(17, 8, 15), body: { en: 'We start the cutting on Monday.', it: 'Iniziamo il taglio lunedì.' } },
  { id: 'm10', ...colleague, channel: 'portal', at: at(17, 8, 30), body: { en: 'Can you send us the delivery date?', it: 'Potete mandarci la data di consegna?' } },
  {
    id: 'm11',
    ...ours('Bea Esempio'),
    channel: 'portal',
    at: at(17, 9, 0),
    body: { en: 'The delivery is planned for 15 January.', it: 'La consegna è prevista per il 15 gennaio.' },
    replyTo: { id: 'm10', authorName: 'Ugo Test', authorKind: 'PARTY', excerpt: 'Can you send us the delivery date?', at: at(17, 8, 30) },
  },
  {
    id: 'm12',
    ...ours('Dora Campione'),
    channel: 'portal',
    at: at(17, 9, 20),
    body: { en: 'The piping stays yellow, as in the approved sample.', it: 'Il profilo resta giallo, come nel campione approvato.' },
    // A quote of the thread's first message: a click goes there (older rows) and lights it.
    replyTo: { id: 'm01', authorName: 'Bea Esempio', authorKind: 'USER', excerpt: 'Good morning: your order 142 is confirmed. The fabric arrives on Thursday.', at: at(16, 8, 10) },
  },
  { id: 'm13', ...mine, channel: 'portal', at: at(17, 9, 40), body: { en: 'Perfect, thank you.', it: 'Perfetto, grazie.' } },
]

const PINS: readonly PortalPin[] = [
  { messageId: 'm03', pinnedAt: at(16, 9, 6), authorName: 'Bea Esempio', excerpt: 'Yes: we add two centimetres. The new size chart is attached.', files: 1, removed: false },
  { messageId: 'm11', pinnedAt: at(17, 9, 1), authorName: 'Bea Esempio', excerpt: 'The delivery is planned for 15 January.', files: 0, removed: false },
]

const DESIGNER = { name: 'Dora Campione', on: false }

const busy = (over: Partial<PartnerCaseModel> = {}): PartnerCaseModel => ({
  frame: 'forty',
  messages: BUSY,
  reading: { firstNewId: 'm11', newCount: 3 },
  pins: PINS,
  designer: DESIGNER,
  more: true,
  ...over,
})

const SHORT: readonly PartnerCaseMessage[] = BUSY.filter((message) => ['m01', 'm02', 'm03', 'm04'].includes(message.id))

export const designScreen = defineDesignScreen<PartnerCaseModel>({
  screen: 'SCR-027-thread',
  title: 'Portal — the messages (the partner face on the office’s thread parts)',
  view: PartnerCase,
  cases: [
    { id: 'busy-forty', label: 'A busy thread, docked at 40 % (450 px at 1440)', model: busy(), note: 'Ours on the left with the person’s tile and name (Example Works beside our people), the reader’s own on the right, her colleague on the left by name. Quotes from each reply’s own link, the pinned bar (2 pins), photos as tiles, a file row, a locked file counted with no name, a removed message, the ONE unread band above the first new message, the designer chip, the ⓘ. Older messages load on scroll; the down button shows once scrolled up.' },
    { id: 'busy-third', label: 'Docked at a third (433 px: the first width at 1440)', model: busy({ frame: 'third' }), note: 'The head row and the composer with the designer chip fit; no sideways scroll.' },
    { id: 'busy-half', label: 'Docked at half (562 px)', model: busy({ frame: 'half' }) },
    { id: 'busy-wide', label: 'Docked at 40 % of 1920 (642 px)', model: busy({ frame: 'wide' }) },
    { id: 'main-column', label: 'A main column (a project, a request, a record page: ~865 px, bounded)', model: busy({ frame: 'main' }), note: 'Off a record frame the column is bounded: its own list scrolls (A6).' },
    { id: 'phone', label: 'The phone (375 px)', model: busy({ frame: 'phone' }), note: 'The column at the edge; the composer always on screen; the designer chip wraps in itself.' },
    { id: 'jump-flash', label: 'A quote’s jump: the first message lit', model: busy({ flash: 'm01' }), note: 'A click on Dora Campione’s quote goes to Bea Esempio’s first message (older pages read if needed, at most 1,000) and lights the whole row.' },
    { id: 'replying', label: 'Replying to our message (the reply bar)', model: busy({ replyTo: 'm09', draft: 'Monday is fine for us.' }), note: 'Reply on a message of ours: the bar names it (colour edge, name, one line, ×); Esc drops it. Send posts the reply with the message it answers.' },
    { id: 'designer-asked', label: 'The designer asked: "We asked Dora Campione."', model: busy({ designer: { ...DESIGNER, on: true }, said: 'asked' }) },
    { id: 'designer-typing', label: 'Typing "@": the chip completes the name', model: busy({ draft: 'Can the piping stay yellow? @Do', designer: { ...DESIGNER, completes: true } }) },
    { id: 'designer-held', label: 'The designer chip held (it may not be asked here)', model: busy({ designer: { ...DESIGNER, held: true } }), note: 'Focusable, its own colour, a lock; why in its tooltip and its description.' },
    { id: 'held-preview', label: 'Held: a preview', model: busy({ held: 'PREVIEW', designer: null }) },
    { id: 'held-no-comment', label: 'Held: the person may read, not write (ONE line, the admin named)', model: busy({ held: 'NO_COMMENT', admins: ['Ugo Test'], designer: null }) },
    { id: 'held-closed', label: 'Held: writing here is closed', model: busy({ held: 'CLOSED', designer: null }) },
    { id: 'failed-reply', label: 'A refused reply: the words say why, the text and the bar stay', model: busy({ replyTo: 'm09', draft: 'Monday is fine for us.', failed: 'reply' }) },
    { id: 'failed-closed', label: 'Writing closed meanwhile: the message was not sent', model: busy({ draft: 'One more question.', failed: 'conflict' }) },
    { id: 'empty', label: 'No messages yet', model: { frame: 'forty', messages: [], designer: DESIGNER } },
    { id: 'loading', label: 'Reading the messages', model: { frame: 'forty', state: 'loading', messages: [] } },
    { id: 'error', label: 'The messages could not be read', model: { frame: 'forty', state: 'error', messages: [] } },
    { id: 'width-menu', label: 'In the record frame with its width chooser: the ⋮', model: busy({ widthMenu: true }), note: 'The ⋮ holds the portal’s three widths, Hide the messages and Default width — only when the frame hands its chooser (A11).' },
    { id: 'supplier', label: 'A supplier’s order: price talk in the ⓘ', model: busy({ designer: null, priceTalk: true, pins: [] }) },
    { id: 'account', label: 'The account’s messages ("Ask us a question")', model: { frame: 'main', kind: 'account', messages: SHORT, designer: DESIGNER } },
    {
      id: 'link',
      label: 'A link’s guest: no Reply, no quote, the "+" of the record’s shared files',
      model: { frame: 'main', kind: 'link', messages: SHORT, attach: { files: [{ id: 'f-chart', name: 'Size chart 142.pdf' }, { id: 'f-front', name: 'Sleeve 52 front.jpg' }], attached: ['f-chart'] } },
      note: 'The invite page’s read carries no reply link: no Reply, no quote (A10).',
    },
  ],
})
