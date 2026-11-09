import { defineDesignScreen } from '../../lib/design/design-screen'
import type { ClaimCase, ClaimItem, ClaimPage } from './api'
import { EMPTY_FORM, type ClaimForm, type ClaimViewModel, type PhotoShot } from './model'
import { ReportProblemView } from './view/ReportProblemView'

/**
 * SCR-197 Report a problem — made-up data only (PLAN §3.1): an invented factory ("Officina Demo"), an invented customer
 * reference, invented shipments, orders, styles and serial numbers. One case per state a customer can meet: each step
 * (empty, filled, refused by the page's own check), a return of several items and a quality complaint, nothing left to
 * send back, the photos (needed for a damage, added with marks, the photo dialog with markup), the label scan, the check,
 * sending, refused by the server, the link that takes no more reports, the draft kept with us (restored, saving, failed,
 * "Finish later"), this link's earlier reports, the end (photos sent, one failed, still sending) and the link's own
 * states (loading, error, gone, the wrong person). Never a price: the link holds no price grain.
 */

const svg = (body: string, fill = '#f4f1ea'): string => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="${fill}"/>${body}</svg>`)}`
const SEAM = svg('<path d="M110 40 L160 60 L210 40 L250 90 L230 110 L220 100 L220 210 L100 210 L100 100 L90 110 L70 90 Z" fill="#2b2b2b"/><circle cx="196" cy="70" r="22" fill="none" stroke="#f59e0b" stroke-width="5"/><text x="160" y="232" font-size="12" text-anchor="middle" fill="#555">foto demo · cucitura</text>')
const SLEEVE = svg('<rect x="70" y="50" width="180" height="140" rx="16" fill="#3d3d3d"/><path d="M90 160 L230 80" stroke="#c0392b" stroke-width="4"/><text x="160" y="226" font-size="12" text-anchor="middle" fill="#555">foto demo · manica</text>')
const LABEL = svg('<rect x="40" y="40" width="240" height="160" rx="8" fill="#ffffff" stroke="#999"/><text x="160" y="110" font-size="18" text-anchor="middle" fill="#222">DEMO-JKT-01</text><text x="160" y="140" font-size="14" text-anchor="middle" fill="#444">SN 0000-DEMO-48</text>', '#e9e9e9')

const id = (n: number) => `0190f0e2-1970-7000-8000-${String(n).padStart(12, '0')}`

function item(n: number, overrides: Partial<ClaimItem> = {}): ClaimItem {
  return {
    key: `-|${id(n)}|M`,
    invoiceLineId: null,
    salesOrderLineId: id(n),
    size: 'M',
    description: 'Giacca demo, Nero, size M',
    order: { id: id(900), number: 'SO-2026-0042', lineSeq: n * 10 },
    invoice: null,
    style: { code: 'DEMO-JKT-01', name: 'Giacca in pelle demo' },
    colourway: { code: 'NER', name: 'Nero' },
    ppe: false,
    received: 4,
    canReturn: 4,
    deliveredOn: '2026-11-03',
    windowWarning: null,
    ...overrides,
  }
}

const JACKET = item(1)
const PANTS = item(2, { key: `-|${id(2)}|L`, size: 'L', style: { code: 'DEMO-PNT-02', name: 'Pantalone tecnico demo' }, colourway: { code: 'GRF', name: 'Grafite' }, received: 2, canReturn: 2, description: 'Pantalone demo, Grafite, size L' })
const GLOVES = item(3, { key: `-|${id(3)}|S`, size: 'S', style: { code: 'DEMO-GLV-03', name: 'Guanti demo' }, colourway: { code: 'NER', name: 'Nero' }, received: 6, canReturn: 0, description: 'Guanti demo, Nero, size S' })
const OLD = item(4, { key: `-|${id(4)}|XL`, size: 'XL', style: { code: 'DEMO-GIL-04', name: 'Gilet demo' }, colourway: { code: 'BLU', name: 'Blu notte' }, received: 1, canReturn: 1, deliveredOn: '2026-08-20', windowWarning: 'Delivered 81 days ago (2026-08-20); the return window is 30 days.', description: 'Gilet demo, Blu notte, size XL' })

const REASONS: ClaimPage['reasons'] = [
  { code: 'WRONG_SIZE', words: { it: 'Taglia errata', en: 'Wrong size' }, needsNote: false },
  { code: 'DEFECT', words: { it: 'Difetto', en: 'Defect' }, needsNote: true },
  { code: 'DAMAGED_IN_TRANSIT', words: { it: 'Danneggiato nel trasporto', en: 'Damaged in transit' }, needsNote: false },
  { code: 'WRONG_ITEM', words: { it: 'Articolo errato', en: 'Wrong item' }, needsNote: false },
  { code: 'OTHER', words: { it: 'Altro', en: 'Other' }, needsNote: true },
]

const EARLIER: ClaimCase[] = [
  {
    type: 'RETURN',
    id: id(500),
    number: 'RMA-2026-0007',
    yourRef: 'PO-DEMO-17',
    opened: '2026-11-04T09:12:00.000Z',
    status: 'AUTHORISED',
    state: 'SEND_IT_BACK',
    next: { forYou: true, code: 'SEND_IT_BACK', words: { it: 'Stampa le istruzioni di reso e rispedisci la merce entro il 18/11/2026.', en: 'Print the return instructions and send it back by 2026-11-18.' } },
    open: true,
    items: [{ description: 'Pantalone demo', size: 'L', serial: null, pieces: 1 }],
  },
  {
    type: 'COMPLAINT',
    id: id(501),
    number: 'CMP-2026-0003',
    yourRef: null,
    opened: '2026-11-02T15:40:00.000Z',
    status: 'ANSWERED',
    state: 'ANSWERED',
    next: { forYou: true, code: 'READ_ANSWER', words: { it: 'Abbiamo risposto: leggi la nostra lettera.', en: 'We answered: read our letter.' } },
    open: true,
    items: [{ description: 'Guanti demo', size: 'S', serial: null, pieces: null }],
  },
]

function page(overrides: Partial<ClaimPage> = {}): ClaimPage {
  return {
    sender: { companyName: 'Officina Demo' },
    record: { type: 'Shipment', id: id(800), label: 'SH-2026-0042 · PO-DEMO-17' },
    types: ['RETURN', 'COMPLAINT'],
    items: [JACKET, PANTS, GLOVES, OLD],
    reasons: REASONS,
    outcomes: [
      { code: 'REPLACE', words: { it: 'Una sostituzione', en: 'A replacement' } },
      { code: 'REPAIR', words: { it: 'Una riparazione', en: 'A repair' } },
      { code: 'CREDIT', words: { it: 'Una nota di credito', en: 'A credit note' } },
    ],
    cases: [],
    complaints: [],
    link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 5, live: true },
    locale: 'it',
    ...overrides,
  }
}

const RETURN_FORM: ClaimForm = {
  ...EMPTY_FORM,
  type: 'RETURN',
  picks: [
    { key: JACKET.key, quantity: 2, reasonCode: 'DEFECT', reasonNote: 'La cucitura della spalla destra si è aperta dopo due giorni.', serial: '0000-DEMO-48' },
    { key: PANTS.key, quantity: 1, reasonCode: 'WRONG_SIZE', reasonNote: '', serial: '' },
  ],
  outcomeWanted: 'REPLACE',
  note: 'Possiamo rispedire tutto lunedì.',
  customerRef: 'PO-DEMO-17',
}

const COMPLAINT_FORM: ClaimForm = {
  ...EMPTY_FORM,
  type: 'COMPLAINT',
  itemKey: JACKET.key,
  serial: '0000-DEMO-48',
  batchNumber: 'L-DEMO-311',
  description: 'Il colore della pelle si schiarisce dove sfrega lo zaino, dopo una settimana di uso normale in moto.',
  customerRef: 'PO-DEMO-17',
}

const PHOTOS: PhotoShot[] = [
  { id: id(700), group: JACKET.key, src: SEAM, marks: 1 },
  { id: id(701), group: JACKET.key, src: SLEEVE, marks: 0 },
]
const COMPLAINT_PHOTOS: PhotoShot[] = [
  { id: id(710), group: 'case', src: SLEEVE, marks: 1 },
  { id: id(711), group: 'case', src: SEAM, marks: 0 },
]

function model(overrides: Partial<ClaimViewModel> = {}): ClaimViewModel {
  return {
    link: 'valid',
    page: page(),
    problem: null,
    form: EMPTY_FORM,
    step: 'type',
    checked: [],
    issues: [],
    photos: [],
    photoFor: null,
    scanFor: null,
    draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
    send: 'idle',
    done: null,
    opening: null,
    ...overrides,
  }
}

const SAVED = { status: { kind: 'saved' as const, at: '2026-11-09T10:42:00.000Z' }, restoredAt: null, later: false }

const SENT_RETURN = { type: 'RETURN' as const, id: id(600), number: 'RMA-2026-0012', answerBy: '2026-11-11' }
const NEW_CASE: ClaimCase = {
  type: 'RETURN',
  id: id(600),
  number: 'RMA-2026-0012',
  yourRef: 'PO-DEMO-17',
  opened: '2026-11-09T10:45:00.000Z',
  status: 'REQUESTED',
  state: 'REQUESTED',
  next: { forYou: false, code: 'WE_DECIDE', words: { it: 'Rispondiamo entro l’11/11/2026.', en: 'We answer by 2026-11-11.' } },
  open: true,
  items: [
    { description: 'Giacca demo', size: 'M', serial: '0000-DEMO-48', pieces: 2 },
    { description: 'Pantalone demo', size: 'L', serial: null, pieces: 1 },
  ],
}
const SENT_COMPLAINT = { type: 'COMPLAINT' as const, id: id(601), number: 'CMP-2026-0009', answerBy: null }
const NEW_COMPLAINT: ClaimCase = {
  type: 'COMPLAINT',
  id: id(601),
  number: 'CMP-2026-0009',
  yourRef: 'PO-DEMO-17',
  opened: '2026-11-09T10:50:00.000Z',
  status: 'NEW',
  state: 'RECEIVED',
  next: { forYou: false, code: 'WE_INVESTIGATE', words: { it: 'Lo stiamo esaminando: rispondiamo entro 2 giorni lavorativi.', en: 'We are looking into it: we answer within 2 working days.' } },
  open: true,
  items: [{ description: 'Giacca demo', size: 'M', serial: '0000-DEMO-48', pieces: null }],
}
const ANSWERED_DOCS: ClaimPage['complaints'] = [
  {
    id: id(501),
    number: 'CMP-2026-0003',
    investigation: {
      documents: [
        { id: id(520), role: 'ANSWER_LETTER', name: 'CMP-2026-0003-risposta.pdf', contentType: 'application/pdf', version: 2, current: true },
        { id: id(521), role: 'EIGHT_D', name: '8D-CAPA-2026-0004.pdf', contentType: 'application/pdf', version: 1, current: true },
      ],
    },
  },
]

export const designScreen = defineDesignScreen<ClaimViewModel>({
  screen: 'SCR-197',
  title: 'Report a problem (a CLAIM link of a shipment or an order)',
  view: ReportProblemView,
  cases: [
    { id: 'start', label: 'What do you need? · nothing chosen', model: model(), note: 'Big choice cards (a return, a quality complaint), each with its own questions; repair, remake and safety go to the sender for now (W2b-5). The band: the steps, the draft status, Finish later (held until something is chosen).' },
    { id: 'type-check', label: 'What do you need? · Continue without a choice', model: model({ checked: ['type'] }), note: 'The page’s own check says what to fix at the choices; the focus goes there.' },
    { id: 'items-return', label: 'Which item · a return of two items', model: model({ form: RETURN_FORM, step: 'item', draft: SAVED }), note: 'Every item of the shipment; picked ones show pieces (at most what can come back) and the serial (scan the label or type). An item with nothing left is shown with why; a late one says the return period passed.' },
    { id: 'items-check', label: 'Which item · Continue with nothing picked', model: model({ form: { ...EMPTY_FORM, type: 'RETURN' }, step: 'item', checked: ['item'] }) },
    { id: 'items-nothing-back', label: 'Which item · nothing can come back', model: model({ page: page({ items: [GLOVES] }), form: { ...EMPTY_FORM, type: 'RETURN' }, step: 'item' }), note: 'Said plainly, with "Report a quality problem instead".' },
    { id: 'item-complaint', label: 'Which item · a quality complaint', model: model({ form: COMPLAINT_FORM, step: 'item', draft: SAVED }), note: 'One item (or the whole delivery), its serial and batch from the label.' },
    { id: 'scan', label: 'Scan the label', model: model({ form: COMPLAINT_FORM, step: 'item', scanFor: 'serial' }), note: 'The camera reads the label and fills the serial. No camera here (design case): it says so; typing still works.' },
    { id: 'details-return', label: 'Tell us more · a return', model: model({ form: RETURN_FORM, step: 'details', draft: SAVED }), note: 'Per item: the reason (the return list) and what is wrong (needed for a defect); what you would like; your reference; anything else.' },
    {
      id: 'details-check',
      label: 'Tell us more · a defect without words',
      model: model({ form: { ...RETURN_FORM, picks: [{ ...RETURN_FORM.picks[0]!, reasonNote: '' }, { ...RETURN_FORM.picks[1]!, reasonCode: null }] }, step: 'details', checked: ['item', 'details'] }),
      note: 'Each problem at its field: the reason missing, the defect’s words missing.',
    },
    { id: 'details-complaint', label: 'Tell us more · a quality complaint', model: model({ form: COMPLAINT_FORM, step: 'details', draft: SAVED }) },
    { id: 'photos-needed', label: 'Photos · a damage needs two', model: model({ form: RETURN_FORM, step: 'photos', checked: ['photos'] }), note: 'A defect or a transport damage needs at least two photos; a wrong size needs none.' },
    { id: 'photos-added', label: 'Photos · two added, one marked', model: model({ form: RETURN_FORM, step: 'photos', photos: PHOTOS, draft: SAVED }), note: 'Tiles with their marks; Remove under each; Add a photo held at 10.' },
    { id: 'photo-dialog', label: 'Add a photo · circle the problem', model: model({ form: RETURN_FORM, step: 'photos', photos: PHOTOS, photoFor: JACKET.key, photoSample: { src: LABEL, width: 320, height: 240 } }), note: 'The DS PhotoCapture with markup in a sheet: arrows and circles, the keyboard draws too; faces out of the picture.' },
    { id: 'review-return', label: 'Check and send · a return', model: model({ form: { ...RETURN_FORM, typedName: 'Anna Esempio' }, step: 'review', photos: PHOTOS, draft: SAVED }), note: 'One screen, each part with Change; your name (optional); how many reports the link still takes; Send.' },
    { id: 'review-complaint', label: 'Check and send · a quality complaint', model: model({ form: COMPLAINT_FORM, step: 'review', photos: COMPLAINT_PHOTOS, draft: SAVED }) },
    { id: 'sending', label: 'Sending', model: model({ form: RETURN_FORM, step: 'review', photos: PHOTOS, send: 'busy' }) },
    {
      id: 'refused-quantity',
      label: 'Refused by the server · more than can come back',
      model: model({ form: RETURN_FORM, step: 'item', photos: PHOTOS, problem: 'problem.aboveSold', issues: [{ step: 'item', field: `pick.${PANTS.key}.quantity`, key: 'refusal.quantity' }] }),
      note: 'The API refused: the page goes to the item and says it at the field; nothing was sent.',
    },
    { id: 'refused-server', label: 'Refused · the server could not be reached', model: model({ form: RETURN_FORM, step: 'review', photos: PHOTOS, problem: 'problem.unavailable' }), note: 'Try again keeps the same key: the report goes once.' },
    { id: 'held-used', label: 'Held · the link takes no more reports', model: model({ page: page({ link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 0, live: true } }), form: RETURN_FORM, step: 'review', photos: PHOTOS }), note: 'Send held with the reason, never disabled.' },
    { id: 'draft-restored', label: 'The draft kept with us · restored', model: model({ form: RETURN_FORM, step: 'details', draft: { status: { kind: 'saved', at: '2026-11-08T17:05:00.000Z' }, restoredAt: '2026-11-08T17:05:00.000Z', later: false } }), note: 'Go on, or Start again; photos are not kept in a draft.' },
    { id: 'draft-saving', label: 'The draft · saving', model: model({ form: RETURN_FORM, step: 'item', draft: { status: { kind: 'saving' }, restoredAt: null, later: false } }) },
    { id: 'draft-failed', label: 'The draft · not saved', model: model({ form: RETURN_FORM, step: 'item', draft: { status: { kind: 'failed', count: 1 }, restoredAt: null, later: false } }), note: 'SaveStatus with Retry; the form stays.' },
    { id: 'finish-later', label: 'Finish later · kept with us', model: model({ form: RETURN_FORM, step: 'details', draft: { ...SAVED, later: true } }), note: 'Open the same link again to finish, until the link expires.' },
    { id: 'earlier-reports', label: 'This link’s earlier reports', model: model({ page: page({ cases: EARLIER, complaints: ANSWERED_DOCS, link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 3, live: true } }) }), note: 'Where each stands and the next step; the return instructions to print; the answer letter and the 8D.' },
    {
      id: 'done-return',
      label: 'Sent · a return, the photos with it',
      model: model({ page: page({ cases: [NEW_CASE, ...EARLIER], complaints: ANSWERED_DOCS, link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 2, live: true } }), form: RETURN_FORM, photos: PHOTOS, done: { sent: SENT_RETURN, form: { ...RETURN_FORM, typedName: 'Anna Esempio' }, uploads: { [id(700)]: 'sent', [id(701)]: 'sent' } } }),
      note: 'EndState: the case number, when we answer, what happens next, the facts, Report another problem, whom to ask; the link’s reports under it.',
    },
    {
      id: 'done-photo-failed',
      label: 'Sent · a complaint, one photo did not go, no reports left',
      model: model({ page: page({ cases: [NEW_COMPLAINT], link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 0, live: true } }), form: COMPLAINT_FORM, photos: COMPLAINT_PHOTOS, done: { sent: SENT_COMPLAINT, form: COMPLAINT_FORM, uploads: { [id(710)]: 'sent', [id(711)]: 'failed' } } }),
      note: 'Try again for the photo; Report another problem held with why.',
    },
    { id: 'done-photos-sending', label: 'Sent · the photos still going', model: model({ page: page({ cases: [NEW_CASE] }), form: RETURN_FORM, photos: PHOTOS, done: { sent: SENT_RETURN, form: RETURN_FORM, uploads: { [id(700)]: 'sent', [id(701)]: 'sending' } } }) },
    { id: 'loading', label: 'Loading the page', model: model({ page: null }), note: 'Skeleton in the shape of the choice cards; "Still loading…" after about a second.' },
    { id: 'error', label: 'Error reading the page', model: model({ page: null, problem: 'problem.read' }), note: 'Our words and Try again; never an empty form.' },
    { id: 'gone', label: 'The link no longer opens', model: model({ link: 'unavailable', page: null }) },
    { id: 'wrong-person', label: 'The wrong person', model: model({ link: 'wrong_person', page: null }) },
  ],
})
