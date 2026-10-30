import { defineDesignScreen } from '../../lib/design/design-screen'
import type { LinkOrder } from './api'
import { answerPreview, initialModel, type LineDraft, type PoConfirmViewModel } from './model'
import { PoConfirmView } from './view/PoConfirmView'

/**
 * SCR-100 Confirm a PO — made-up data only (PLAN §3.1): an invented buying company (Officina Demo) and its buyer, an
 * invented tannery's view of PO-2026-0101 (no price anywhere: Owner answer C2) with three lines — leather by the ft² with
 * its specs and the Cr VI report, a lining by the metre, protectors by the piece. Each case is one state the supplier can
 * meet: the open order, an answer line by line (a later date, two deliveries, a line it cannot deliver), every line it
 * cannot deliver, each answer's sheet (and its problems), the decline, the PDF upload, sending and refusals, the end
 * states (confirmed, sent to the buyer to decide, declined), an order answered before, a link that expired or no longer
 * opens, loading and an error.
 */

const TODAY = '2026-10-30'

function linkOrder(overrides: Omit<Partial<LinkOrder>, 'order'> & { order?: Partial<LinkOrder['order']> } = {}): LinkOrder {
  const { order, ...rest } = overrides
  return {
    lines: [
      {
        id: '0190f0e2-7777-7000-8000-000000000010',
        seq: 10,
        code: 'VACH-NAPPA-12',
        name: 'Vacchetta nappa demo',
        colour: { name: 'Nero', supplierCode: 'N01' },
        description: null,
        quantity: '1200.0000',
        uom: 'FT2',
        baseQuantity: '111.4836',
        baseUom: 'M2',
        needDate: '2026-11-14',
        grade: 'A',
        thicknessMinMm: '1.20',
        thicknessMaxMm: '1.40',
        oneDyeBatch: true,
        areaTolerancePct: '5.00',
        estimatedHides: 48,
        requiresCrViTest: true,
        note: null,
        confirmedQuantity: null,
        confirmedDate: null,
        version: 1,
      },
      {
        id: '0190f0e2-7777-7000-8000-000000000020',
        seq: 20,
        code: 'FOD-MESH-02',
        name: 'Fodera mesh demo',
        colour: { name: 'Grigio', supplierCode: null },
        description: null,
        quantity: '350.0000',
        uom: 'M',
        baseQuantity: '350.0000',
        baseUom: 'M',
        needDate: '2026-11-10',
        grade: null,
        thicknessMinMm: null,
        thicknessMaxMm: null,
        oneDyeBatch: false,
        areaTolerancePct: null,
        estimatedHides: null,
        requiresCrViTest: false,
        note: 'Rotoli da 50 m',
        confirmedQuantity: null,
        confirmedDate: null,
        version: 1,
      },
      {
        id: '0190f0e2-7777-7000-8000-000000000030',
        seq: 30,
        code: 'PROT-CE-L1',
        name: 'Protezione spalla demo (EN 1621-1)',
        colour: null,
        description: null,
        quantity: '120.0000',
        uom: 'PCS',
        baseQuantity: '120.0000',
        baseUom: 'PCS',
        needDate: '2026-11-21',
        grade: null,
        thicknessMinMm: null,
        thicknessMaxMm: null,
        oneDyeBatch: false,
        areaTolerancePct: null,
        estimatedHides: null,
        requiresCrViTest: false,
        note: null,
        confirmedQuantity: null,
        confirmedDate: null,
        version: 1,
      },
    ],
    from: { legalName: 'Officina Demo S.r.l.', tradeName: 'Officina Demo', buyerName: 'Paola Esempio' },
    deliverTo: { name: 'Officina Demo — Stabilimento A', line1: 'Via Fittizia 22', line2: null, postalCode: '20900', city: 'Monza', province: 'MB', country: 'IT' },
    canAnswer: true,
    message: null,
    answers: [
      { action: 'confirm', typedName: 'optional', email: false },
      { action: 'decline', typedName: 'optional', email: false },
    ],
    lineAnswers: ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER'],
    declineReasons: ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'OTHER'],
    document: 'The PDF of this order is in the e-mail we sent you.',
    expiresAt: '2026-11-13T22:59:59.000Z',
    ...rest,
    order: {
      id: '0190f0e2-7777-7000-8000-000000000001',
      number: 'PO-2026-0101',
      documentNumber: 'PO-2026-0101',
      status: 'SENT',
      revision: 1,
      orderDate: '2026-10-29',
      requestedDate: '2026-11-14',
      incoterms: 'DAP Monza',
      paymentTerms: 'Bonifico 60 gg d.f.f.m.',
      note: 'Per favore indicate il numero di bagno su ogni lotto.',
      sentAt: '2026-10-29T09:12:00.000Z',
      confirmedAt: null,
      confirmedVia: null,
      confirmedByName: null,
      supplierRef: null,
      confirmNote: null,
      declinedAt: null,
      declineReason: null,
      cancelledAt: null,
      version: 4,
      ...order,
    },
  }
}

const PAGE = linkOrder()
const [LEATHER, LINING, PROTECTORS] = PAGE.lines as [LinkOrder['lines'][number], LinkOrder['lines'][number], LinkOrder['lines'][number]]

const draft = (patch: Partial<LineDraft> & Pick<LineDraft, 'kind'>): LineDraft => ({
  quantity: '',
  date: '',
  deliveries: [
    { quantity: '', date: '' },
    { quantity: '', date: '' },
  ],
  reason: '',
  ...patch,
})

const LATER = draft({ kind: 'OTHER', quantity: '1200', date: '2026-11-28', reason: 'La concia del nero finisce il 25 novembre.' })
const SPLIT = draft({
  kind: 'SPLIT',
  deliveries: [
    { quantity: '700', date: '2026-11-14' },
    { quantity: '500', date: '2026-11-28' },
  ],
  reason: 'Metà del bagno è pronta, il resto dopo la rifinizione.',
})
const CANNOT = draft({ kind: 'CANNOT_DELIVER', reason: 'Articolo fuori produzione.' })

function model(overrides: Partial<PoConfirmViewModel> = {}): PoConfirmViewModel {
  return { ...initialModel(TODAY), link: 'valid', page: PAGE, timeZone: 'Europe/Rome', ...overrides }
}

const withSheet = (line: LinkOrder['lines'][number], sheetDraft: LineDraft, tried = false, answers: PoConfirmViewModel['answers'] = {}) =>
  model({ answers, sheet: { lineId: line.id, draft: sheetDraft, tried } })

const doneOf = (answers: PoConfirmViewModel['answers'], outcome: 'CONFIRMED' | 'PROPOSED' | 'DECLINED', status: LinkOrder['order']['status'], extra: Partial<PoConfirmViewModel['done']> = {}) => {
  const preview = answerPreview(PAGE, answers, TODAY, 'en')
  return model({
    answers,
    page: linkOrder({ canAnswer: false, order: { status, version: 5 } }),
    done: { outcome, counts: outcome === 'DECLINED' && !extra?.counts ? null : (preview?.counts ?? null), fileName: null, supplierRef: null, ...extra },
  })
}

const CONFIRMED_PAGE = linkOrder({
  canAnswer: false,
  order: { status: 'CONFIRMED', confirmedAt: '2026-10-30T08:40:00.000Z', confirmedVia: 'LINK', confirmedByName: 'Marco Conceria', supplierRef: 'OC-5521', version: 5 },
  lines: PAGE.lines.map((line) => ({ ...line, confirmedQuantity: line.quantity, confirmedDate: line.needDate })),
})

const answered = (status: LinkOrder['order']['status']) => model({ page: linkOrder({ canAnswer: false, order: { status, version: 6 } }) })

export const designScreen = defineDesignScreen<PoConfirmViewModel>({
  screen: 'SCR-100',
  title: 'Confirm a PO (the supplier’s link)',
  view: PoConfirmView,
  cases: [
    { id: 'open', label: 'Open · three lines, nothing changed yet', model: model(), note: 'The order without prices, the lines in the supplier’s terms, Confirm all as asked (Enter), Change per line, Decline.' },
    { id: 'filled', label: 'Open · their number, name and note typed', model: model({ supplierRef: 'OC-5521', typedName: 'Marco Conceria', note: 'Consegna con il nostro corriere.' }) },
    { id: 'later-date', label: 'Line by line · one later date', model: model({ answers: { [LEATHER.id]: LATER } }), note: 'The review line before sending; the buyer decides on the change (P2).' },
    { id: 'mixed', label: 'Line by line · two deliveries and a line they cannot deliver', model: model({ answers: { [LEATHER.id]: SPLIT, [PROTECTORS.id]: CANNOT } }) },
    { id: 'all-cannot', label: 'Every line one they cannot deliver (it declines the order)', model: model({ answers: { [LEATHER.id]: CANNOT, [LINING.id]: CANNOT, [PROTECTORS.id]: CANNOT } }) },
    { id: 'sheet-other', label: 'Line sheet · another date or quantity', model: withSheet(LEATHER, LATER) },
    { id: 'sheet-other-problems', label: 'Line sheet · Save pressed with problems', model: withSheet(LEATHER, draft({ kind: 'OTHER', quantity: '0', date: '2026-10-01', reason: '' }), true) },
    { id: 'sheet-same', label: 'Line sheet · what was asked again (choose As asked)', model: withSheet(LINING, draft({ kind: 'OTHER', quantity: '350', date: '2026-11-10', reason: 'Va bene.' }), true) },
    { id: 'sheet-split', label: 'Line sheet · two deliveries', model: withSheet(LEATHER, SPLIT) },
    { id: 'sheet-split-same-day', label: 'Line sheet · two deliveries on one day', model: withSheet(LEATHER, draft({ ...SPLIT, deliveries: [{ quantity: '700', date: '2026-11-14' }, { quantity: '500', date: '2026-11-14' }] }), true) },
    { id: 'sheet-cannot', label: 'Line sheet · cannot deliver', model: withSheet(PROTECTORS, CANNOT) },
    { id: 'sheet-as-asked', label: 'Line sheet · back to as asked', model: withSheet(LEATHER, draft({ kind: 'AS_ASKED' }), false, { [LEATHER.id]: LATER }) },
    { id: 'decline', label: 'Decline dialog', model: model({ declineOpen: true }) },
    { id: 'decline-other', label: 'Decline · another reason needs a note', model: model({ declineOpen: true, decline: { reason: 'OTHER', note: '', tried: true } }) },
    { id: 'upload-uploading', label: 'Their PDF · uploading', model: model({ upload: { state: 'uploading', name: 'Conferma OC-5521.pdf', size: 184_320 } }), note: 'Sending waits until it is uploaded.' },
    { id: 'upload-done', label: 'Their PDF · uploaded', model: model({ supplierRef: 'OC-5521', upload: { state: 'done', id: '0190f0e2-7777-7000-8000-0000000000f1', name: 'Conferma OC-5521.pdf', size: 184_320 } }) },
    { id: 'upload-quarantined', label: 'Their PDF · arrived different (choose it again)', model: model({ upload: { state: 'quarantined', name: 'Conferma OC-5521.pdf' } }) },
    { id: 'upload-rejected', label: 'Their PDF · not a PDF', model: model({ upload: { state: 'rejected', name: 'conferma.docx', problem: 'notPdf' } }) },
    { id: 'upload-failed', label: 'Their PDF · the upload failed', model: model({ upload: { state: 'failed', name: 'Conferma OC-5521.pdf' } }) },
    { id: 'sending', label: 'Sending the answer', model: model({ send: 'busy' }) },
    { id: 'refused-changed', label: 'Refused · the order changed meanwhile (read again)', model: model({ problem: 'changed', answers: { [LEATHER.id]: LATER } }) },
    { id: 'refused-unavailable', label: 'Refused · our system cannot be reached', model: model({ problem: 'unavailableNow' }) },
    { id: 'done-confirmed', label: 'End · confirmed', model: doneOf({}, 'CONFIRMED', 'CONFIRMED', { supplierRef: 'OC-5521', fileName: 'Conferma OC-5521.pdf' }) },
    { id: 'done-proposed', label: 'End · sent, the buyer decides', model: doneOf({ [LEATHER.id]: SPLIT, [PROTECTORS.id]: CANNOT }, 'PROPOSED', 'CHANGES_PROPOSED') },
    { id: 'done-declined', label: 'End · declined', model: doneOf({}, 'DECLINED', 'DECLINED') },
    { id: 'answered-confirmed', label: 'Answered before · confirmed', model: model({ page: CONFIRMED_PAGE }) },
    { id: 'answered-proposed', label: 'Answered before · changes with the buyer', model: answered('CHANGES_PROPOSED') },
    { id: 'answered-declined', label: 'Answered before · declined', model: answered('DECLINED') },
    { id: 'answered-received', label: 'Goods received already', model: answered('PARTLY_RECEIVED') },
    { id: 'answered-draft', label: 'The buyer is changing the order', model: answered('DRAFT') },
    { id: 'answered-cancelled', label: 'Cancelled', model: answered('CANCELLED') },
    { id: 'no-buyer', label: 'Open · no buyer name, no delivery address', model: model({ page: linkOrder({ from: { legalName: 'Officina Demo S.r.l.', tradeName: null, buyerName: null }, deliverTo: null }) }) },
    { id: 'expired', label: 'The link expired while open', model: model({ link: 'expired' }), note: 'Ask for a new link.' },
    { id: 'unavailable', label: 'The link no longer opens (used, withdrawn or expired)', model: model({ link: 'unavailable' }), note: 'The API’s one 404 for a used, withdrawn or expired link: Ask for a new link.' },
    { id: 'unavailable-asked', label: 'The link no longer opens · new link asked', model: model({ link: 'unavailable', newLinkAsked: true }) },
    { id: 'loading', label: 'Opening the order', model: { ...initialModel(TODAY), link: 'loading' } },
    { id: 'error', label: 'The order could not be read (Try again)', model: { ...initialModel(TODAY), link: 'error', readFailed: true } },
  ],
})
