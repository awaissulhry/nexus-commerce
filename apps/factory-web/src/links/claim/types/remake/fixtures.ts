import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { ClaimCase, ClaimItem, ClaimPage } from '../../api'
import { EMPTY_FORM, type ClaimForm, type ClaimViewModel, type PhotoShot } from '../../model'
import { ReportProblemView } from '../../view/ReportProblemView'

/**
 * SCR-197 › Remake (B-W2b-346; SAL-298, follow-up RX2:01) — a review id of the same screen, as SCR-187-record is of
 * SCR-187. Made-up data only (PLAN §3.1): an invented factory ("Officina Demo"), invented shipments, orders, styles and
 * serial numbers. Every state a customer meets on the remake's path through the claim page: the third choice card, the
 * one item (picked, nothing picked, nothing to remake), the fit in words (typed, missing), the photos (none yet, the
 * front and the back added), the check, sending, refused by the server at the fit, and the end (photos sent, one failed).
 * Never a price: the link holds no price grain.
 */

const svg = (body: string, fill = '#eef1f4'): string => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320"><rect width="240" height="320" fill="${fill}"/>${body}</svg>`)}`
const FRONT = svg('<path d="M70 60 L120 80 L170 60 L200 120 L180 130 L176 290 L64 290 L60 130 L40 120 Z" fill="#2b2b2b"/><path d="M120 80 L120 290" stroke="#888" stroke-width="3"/><text x="120" y="312" font-size="12" text-anchor="middle" fill="#555">foto demo · davanti</text>')
const BACK = svg('<path d="M70 60 L120 72 L170 60 L200 120 L180 130 L176 270 L64 270 L60 130 L40 120 Z" fill="#3a3a3a"/><circle cx="120" cy="262" r="24" fill="none" stroke="#f59e0b" stroke-width="5"/><text x="120" y="312" font-size="12" text-anchor="middle" fill="#555">foto demo · dietro</text>')

const id = (n: number) => `0190f0e2-1970-7000-8000-${String(n).padStart(12, '0')}`

function item(n: number, overrides: Partial<ClaimItem> = {}): ClaimItem {
  return {
    key: `-|${id(n)}|52`,
    invoiceLineId: null,
    salesOrderLineId: id(n),
    size: '52',
    description: 'Tuta demo su misura, Nero',
    order: { id: id(900), number: 'SO-2026-0042', lineSeq: n * 10 },
    invoice: null,
    style: { code: 'DEMO-SUIT-01', name: 'Tuta in pelle su misura demo' },
    colourway: { code: 'NER', name: 'Nero' },
    ppe: true,
    received: 1,
    canReturn: 1,
    deliveredOn: '2026-11-03',
    windowWarning: null,
    ...overrides,
  }
}

const SUIT = item(1)
const JACKET = item(2, { key: `-|${id(2)}|50`, size: '50', style: { code: 'DEMO-JKT-01', name: 'Giacca in pelle demo' }, colourway: { code: 'GRF', name: 'Grafite' }, received: 2, canReturn: 2, description: 'Giacca demo, Grafite, size 50' })
const GLOVES = item(3, { key: `-|${id(3)}|S`, size: 'S', style: { code: 'DEMO-GLV-03', name: 'Guanti demo' }, received: 6, canReturn: 0, description: 'Guanti demo, Nero, size S' })

function page(overrides: Partial<ClaimPage> = {}): ClaimPage {
  return {
    sender: { companyName: 'Officina Demo' },
    record: { type: 'Shipment', id: id(800), label: 'SH-2026-0042 · PO-DEMO-17' },
    types: ['RETURN', 'COMPLAINT'],
    items: [SUIT, JACKET, GLOVES],
    reasons: [
      { code: 'WRONG_SIZE', words: { it: 'Taglia errata', en: 'Wrong size' }, needsNote: false },
      { code: 'DEFECT', words: { it: 'Difetto', en: 'Defect' }, needsNote: true },
      { code: 'OTHER', words: { it: 'Altro', en: 'Other' }, needsNote: true },
    ],
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

const REMAKE_FORM: ClaimForm = {
  ...EMPTY_FORM,
  type: 'REMAKE',
  picks: [{ key: SUIT.key, quantity: 1, reasonCode: null, reasonNote: '', serial: 'SN-DEMO-0482' }],
  fit: 'La schiena è corta di circa 4 cm quando sono in posizione sulla moto; le maniche tirano sui gomiti.',
  customerRef: 'PO-DEMO-17',
}

const PHOTOS: PhotoShot[] = [
  { id: id(700), group: SUIT.key, src: FRONT, marks: 0 },
  { id: id(701), group: SUIT.key, src: BACK, marks: 1 },
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

const SAVED = { status: { kind: 'saved' as const, at: '2026-11-12T10:42:00.000Z' }, restoredAt: null, later: false }
const SENT = { type: 'RETURN' as const, id: id(600), number: 'RMA-2026-0031', answerBy: '2026-11-16' }
const NEW_CASE: ClaimCase = {
  type: 'RETURN',
  id: id(600),
  number: 'RMA-2026-0031',
  yourRef: 'PO-DEMO-17',
  opened: '2026-11-12T10:45:00.000Z',
  status: 'REQUESTED',
  state: 'REQUESTED',
  next: { forYou: false, code: 'WE_DECIDE', words: { it: 'Esaminiamo la richiesta e rispondiamo entro il 16/11/2026.', en: 'We look at your request and answer by 2026-11-16.' } },
  open: true,
  items: [{ description: 'Tuta demo su misura', size: '52', serial: 'SN-DEMO-0482', pieces: 1 }],
}

export const designScreen = defineDesignScreen<ClaimViewModel>({
  screen: 'SCR-197-remake',
  title: 'Report a problem › Remake (made-to-measure fit)',
  view: ReportProblemView,
  cases: [
    { id: 'type', label: 'What do you need? · Remake chosen', model: model({ form: { ...EMPTY_FORM, type: 'REMAKE' }, draft: SAVED }), note: 'The third choice card beside a return: a garment made to measure that does not fit. Repair and safety still go to the sender (their steps come later).' },
    { id: 'item', label: 'Which item · one picked, its serial', model: model({ form: REMAKE_FORM, step: 'item', draft: SAVED }), note: 'One item, one piece, of what may come back; the serial scanned from the label or typed.' },
    { id: 'item-check', label: 'Which item · Continue with nothing picked', model: model({ form: { ...EMPTY_FORM, type: 'REMAKE' }, step: 'item', checked: ['item'] }), note: 'The page’s own check says what to fix at the choices.' },
    { id: 'item-none', label: 'Which item · nothing can be remade', model: model({ page: page({ items: [GLOVES] }), form: { ...EMPTY_FORM, type: 'REMAKE' }, step: 'item' }), note: 'Said plainly, with "Report a quality problem instead".' },
    { id: 'details', label: 'Tell us more · what is wrong with the fit', model: model({ form: REMAKE_FORM, step: 'details', draft: SAVED }), note: 'The fit in words (needed), your reference.' },
    { id: 'details-check', label: 'Tell us more · the fit left empty', model: model({ form: { ...REMAKE_FORM, fit: '' }, step: 'details', checked: ['item', 'details'] }) },
    { id: 'photos-needed', label: 'Photos · the front and the back still missing', model: model({ form: REMAKE_FORM, step: 'photos', checked: ['photos'] }), note: 'A remake needs two photos of the garment worn: one from the front, one from the back.' },
    { id: 'photos-added', label: 'Photos · front and back added', model: model({ form: REMAKE_FORM, step: 'photos', photos: PHOTOS, draft: SAVED }), note: 'Tiles labelled From the front / From the back; Remove under each.' },
    { id: 'review', label: 'Check and send · a remake', model: model({ form: { ...REMAKE_FORM, typedName: 'Anna Esempio' }, step: 'review', photos: PHOTOS, draft: SAVED }), note: 'One screen: the item, the fit, the photos, your name; Send the remake request.' },
    { id: 'sending', label: 'Sending', model: model({ form: REMAKE_FORM, step: 'review', photos: PHOTOS, send: 'busy' }) },
    { id: 'refused-fit', label: 'Refused by the server · the fit', model: model({ form: REMAKE_FORM, step: 'details', photos: PHOTOS, problem: 'problem.invalid', issues: [{ step: 'details', field: 'fit', key: 'returns-remake:claim.check.fit' }] }), note: 'The API refused at body/fit: the page goes to the field and says it; nothing was sent.' },
    {
      id: 'done',
      label: 'Sent · the remake request, its photos with it',
      model: model({ page: page({ cases: [NEW_CASE], link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 4, live: true } }), form: REMAKE_FORM, photos: PHOTOS, done: { sent: SENT, form: { ...REMAKE_FORM, typedName: 'Anna Esempio' }, uploads: { [id(700)]: 'sent', [id(701)]: 'sent' } } }),
      note: 'EndState: "Remake request … sent", when we answer, what happens next; the link’s reports under it (the remake is a return request there).',
    },
    {
      id: 'done-photo-failed',
      label: 'Sent · the back photo did not go',
      model: model({ page: page({ cases: [NEW_CASE] }), form: REMAKE_FORM, photos: PHOTOS, done: { sent: SENT, form: REMAKE_FORM, uploads: { [id(700)]: 'sent', [id(701)]: 'failed' } } }),
      note: 'Try again for the photo; the request itself was sent.',
    },
  ],
})
