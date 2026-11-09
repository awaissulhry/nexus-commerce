import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { COMPLAINT_STATE_WORDS, MILESTONE_WORDS, OUTCOME_WANTED_WORDS, RETURN_STATE_WORDS, type ComplaintCaseState, type ReturnCaseState } from '@nexus/factory-domain/sales/portal-returns/rules'
import { formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { PortalBand } from '../../shell/frame'
import { badgesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import type { CaseChip, CaseItem, CasesRead, ComplaintRecord, ComplaintsRead, ReturnableRead, ReturnRecord, Words } from './api'
import { NS } from './model'
import { returnWordsFor, type ReturnWords } from './words'

/**
 * SCR-187's made-up world (B-W2b-197; PLAN §3.1): an invented maker (Pelletteria Esempio) and an invented customer (Brand
 * Alpha S.r.l., its buyer Anna Esempio), their own references BA-RES-…, our cases R-2026-00… and C-2026-00…, a touring jacket
 * and trousers by size. Never a real company, person, address or number. No money anywhere on this page.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
export const PREFIX = '/p/BRAND-ALPHA'
export const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
export const returnWords = (locale: Locale): ReturnWords => returnWordsFor(words(locale), locale)

const id = (n: number) => `0190f0e2-1970-7000-8000-${String(n).padStart(12, '0')}`
export const RETURN_ID = id(1)
export const COMPLAINT_ID = id(51)

const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const
const ALL = (permission: string) => permission.startsWith('portal.') || permission === 'files.read' || permission === 'threads.read'

export function shellOf(locale: Locale, band: PortalBand, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return {
    brand: { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' },
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
    nav: portalNavFor({ can: ALL, kinds: ['CUSTOMER'], everyPage: true }),
    path: '/returns',
    prefix: PREFIX,
    badges: badgesOf([{ area: 'returns', count: 1, words: { it: '1 in attesa di te', en: '1 waiting for you' } }], locale),
    bell: { unread: 1, complete: true },
    notice: null,
    band,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: true,
    ...over,
  }
}

const day = (iso: string, locale: 'it' | 'en') => (locale === 'it' ? iso.split('-').reverse().join('/') : iso)
const both = (en: (lang: 'it' | 'en') => string, it: (lang: 'it' | 'en') => string): Words => ({ en: en('en'), it: it('it') })

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────────────
const JACKET = 'JKT-DEMO-01 Giacca Demo Touring'
const TROUSERS = 'PNT-DEMO-02 Pantalone Demo Touring'

function returnCase(n: number, state: ReturnCaseState, over: Partial<CaseItem> = {}): CaseItem {
  const status = { REQUESTED: 'REQUESTED', SEND_IT_BACK: 'AUTHORISED', BACK_WITH_US: 'RECEIVED', INSPECTED: 'INSPECTED', DONE: 'CLOSED', NOT_ACCEPTED: 'REJECTED', CANCELLED: 'CANCELLED' }[state]
  const open = ['REQUESTED', 'SEND_IT_BACK', 'BACK_WITH_US', 'INSPECTED'].includes(state)
  return {
    type: 'RETURN',
    id: id(n),
    number: `R-2026-00${30 + n}`,
    yourRef: `BA-RES-${10 + n}`,
    opened: at(-24 * (20 - n)),
    status,
    state,
    words: RETURN_STATE_WORDS[state],
    next: { forYou: false, code: 'DONE', words: { en: 'Closed.', it: 'Chiuso.' } },
    open,
    items: [{ description: JACKET, size: '52', serial: null, pieces: 2 }],
    lines: 1,
    pieces: 2,
    lastUpdate: at(-24 * (10 - n)),
    chips: open ? ['OPEN'] : ['CLOSED'],
    ...over,
  }
}

const due = dayAt(9)
const answer = dayAt(2)

export const CASES: readonly CaseItem[] = [
  returnCase(1, 'SEND_IT_BACK', {
    next: { forYou: true, code: 'SEND_IT_BACK', words: both((l) => `Print the return instructions and send it back by ${day(due, l)}.`, (l) => `Stampa le istruzioni di reso e rispediscilo entro il ${day(due, l)}.`) },
    items: [
      { description: JACKET, size: '52', serial: 'SN-DEMO-000123', pieces: 1 },
      { description: TROUSERS, size: '50', serial: null, pieces: 2 },
    ],
    lines: 2,
    pieces: 3,
    chips: ['OPEN', 'WAITING'],
  }),
  returnCase(2, 'REQUESTED', { yourRef: null, next: { forYou: false, code: 'WE_DECIDE', words: both((l) => `We look at your request and answer by ${day(answer, l)}.`, (l) => `Esaminiamo la richiesta e rispondiamo entro il ${day(answer, l)}.`) } }),
  {
    type: 'COMPLAINT',
    id: COMPLAINT_ID,
    number: 'C-2026-0019',
    yourRef: 'BA-QC-7',
    opened: at(-24 * 12),
    status: 'INVESTIGATING',
    state: 'INVESTIGATING',
    words: COMPLAINT_STATE_WORDS.INVESTIGATING,
    next: { forYou: false, code: 'WE_INVESTIGATE', words: both((l) => `We look into it and answer by ${day(dayAt(4), l)}.`, (l) => `Lo analizziamo e rispondiamo entro il ${day(dayAt(4), l)}.`) },
    open: true,
    items: [{ description: JACKET, size: '54', serial: 'SN-DEMO-000777', pieces: null }],
    lines: 1,
    pieces: null,
    lastUpdate: at(-30),
    chips: ['OPEN'],
  },
  returnCase(3, 'BACK_WITH_US', { next: { forYou: false, code: 'WE_INSPECT', words: { en: 'We received the goods and are inspecting them.', it: 'Abbiamo ricevuto la merce e la stiamo controllando.' } } }),
  returnCase(4, 'DONE', { items: [{ description: TROUSERS, size: '48', serial: null, pieces: 1 }] }),
  returnCase(5, 'NOT_ACCEPTED', { next: { forYou: false, code: 'NOT_ACCEPTED', words: { en: 'Not accepted: worn after the return window.', it: 'Non accettato: indossato oltre il periodo di reso.' } } }),
  returnCase(6, 'CANCELLED', { next: { forYou: false, code: 'CANCELLED', words: { en: 'Cancelled.', it: 'Annullato.' } } }),
]

const inChip = (chip: CaseChip, item: CaseItem) => chip === 'ALL' || item.chips.includes(chip)

export function casesRead(chip: CaseChip = 'OPEN', items: readonly CaseItem[] | null = null, over: Partial<CasesRead> = {}): CasesRead {
  const all = items ?? CASES
  return {
    chip,
    chips: (['OPEN', 'WAITING', 'CLOSED', 'ALL'] as const).map((entry) => ({ chip: entry, count: all.filter((item) => inChip(entry, item)).length })),
    items: all.filter((item) => inChip(chip, item)),
    mayRequest: true,
    readsComplaints: true,
    asOf: at(0),
    ...over,
  }
}

export function complaintsRead(over: Partial<ComplaintsRead> = {}): ComplaintsRead {
  return {
    asOf: at(0),
    items: [
      {
        id: COMPLAINT_ID,
        number: 'C-2026-0019',
        yourRef: 'BA-QC-7',
        subject: 'Cucitura della spalla sinistra aperta dopo due uscite',
        opened: at(-24 * 12),
        status: 'INVESTIGATING',
        words: COMPLAINT_STATE_WORDS.INVESTIGATING,
        stepReached: { en: 'D4 Root cause', it: 'D4 Causa radice' },
        answerDueOn: dayAt(4),
        answeredAt: null,
      },
      {
        id: id(52),
        number: 'C-2026-0011',
        yourRef: null,
        subject: 'La cerniera dei pantaloni taglia 50 si blocca',
        opened: at(-24 * 40),
        status: 'ANSWERED',
        words: COMPLAINT_STATE_WORDS.ANSWERED,
        stepReached: { en: 'D8 Closure — done', it: 'D8 Chiusura — fatto' },
        answerDueOn: dayAt(-30),
        answeredAt: at(-24 * 31),
      },
      {
        id: id(53),
        number: 'C-2026-0024',
        yourRef: 'BA-QC-9',
        subject: 'Il colore cambia tra due lotti',
        opened: at(-20),
        status: 'NEW',
        words: COMPLAINT_STATE_WORDS.RECEIVED,
        stepReached: null,
        answerDueOn: dayAt(2),
        answeredAt: null,
      },
    ],
    ...over,
  }
}

// ── what may come back ───────────────────────────────────────────────────────────────────────────────────────────────
export function returnableRead(over: Partial<ReturnableRead> = {}): ReturnableRead {
  const item = (n: number, size: string, canReturn: number, extra: Partial<ReturnableRead['items'][number]> = {}) => ({
    key: `line-${n}|${size}`,
    invoiceLineId: id(200 + n),
    salesOrderLineId: id(100 + n),
    size,
    description: n === 1 ? JACKET : TROUSERS,
    order: { id: id(90), number: 'SO-2026-0141', lineSeq: n },
    invoice: { id: id(91), number: 'FT-2026-0088', issueDate: dayAt(-25) },
    style: n === 1 ? { code: 'JKT-DEMO-01', name: 'Giacca Demo Touring' } : { code: 'PNT-DEMO-02', name: 'Pantalone Demo Touring' },
    colourway: { code: 'NER', name: n === 1 ? 'Nero' : 'Sabbia' },
    ppe: n === 1,
    received: 6,
    canReturn,
    deliveredOn: dayAt(-20),
    windowWarning: null,
    ...extra,
  })
  return {
    items: [item(1, '52', 4), item(1, '54', 0), item(2, '50', 2, { deliveredOn: dayAt(-70), windowWarning: 'Delivered 70 days ago.' })],
    reasons: [
      { code: 'WRONG_SIZE', words: { en: 'Wrong size', it: 'Taglia sbagliata' }, needsNote: false },
      { code: 'DAMAGED_IN_TRANSIT', words: { en: 'Damaged in transit', it: 'Danneggiato nel trasporto' }, needsNote: false },
      { code: 'DEFECT', words: { en: 'A defect', it: 'Un difetto' }, needsNote: true },
    ],
    outcomes: (['REPLACE', 'REPAIR', 'CREDIT'] as const).map((code) => ({ code, words: OUTCOME_WANTED_WORDS[code] })),
    mayRequest: true,
    mayUpload: true,
    ...over,
  }
}

// ── one return ───────────────────────────────────────────────────────────────────────────────────────────────────────
const photo = (n: number, name: string, hoursAgo: number) => ({ id: id(300 + n), role: 'PHOTO' as const, name, contentType: 'image/jpeg', sizeBytes: 1_480_000 + n * 7_000, addedAt: at(-hoursAgo) })

type Stage = 'REQUESTED' | 'AUTHORISED' | 'RECEIVED' | 'INSPECTED' | 'CLOSED' | 'REJECTED' | 'CANCELLED'
const STATE_OF: Readonly<Record<Stage, ReturnCaseState>> = { REQUESTED: 'REQUESTED', AUTHORISED: 'SEND_IT_BACK', RECEIVED: 'BACK_WITH_US', INSPECTED: 'INSPECTED', CLOSED: 'DONE', REJECTED: 'NOT_ACCEPTED', CANCELLED: 'CANCELLED' }

export function returnRecord(stage: Stage = 'AUTHORISED', over: Partial<ReturnRecord> = {}): ReturnRecord {
  const order: readonly Stage[] = ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED']
  const reached = order.indexOf(stage)
  const ended = stage === 'REJECTED' || stage === 'CANCELLED'
  const stepAt = [at(-24 * 8), at(-24 * 6), at(-24 * 2), at(-30), at(-2)]
  const milestones = (['ASKED', 'DECIDED', 'BACK_WITH_US', 'INSPECTED', 'OUTCOME'] as const).map((step, index) => {
    const done = stage === 'REJECTED' ? index <= 1 : stage === 'CANCELLED' ? index === 0 : index <= reached
    const state: 'DONE' | 'CURRENT' | 'TODO' | 'SKIPPED' = done ? 'DONE' : ended ? 'SKIPPED' : index === reached + 1 ? 'CURRENT' : 'TODO'
    return { step, state, at: done ? stepAt[index]! : null, words: MILESTONE_WORDS[step] }
  })
  const state = STATE_OF[stage]
  const takes = stage === 'REQUESTED' || stage === 'AUTHORISED' || stage === 'RECEIVED'
  const next = {
    REQUESTED: { forYou: false, code: 'WE_DECIDE', words: both((l) => `We look at your request and answer by ${day(answer, l)}.`, (l) => `Esaminiamo la richiesta e rispondiamo entro il ${day(answer, l)}.`) },
    AUTHORISED: { forYou: true, code: 'SEND_IT_BACK', words: both((l) => `Print the return instructions and send it back by ${day(due, l)}.`, (l) => `Stampa le istruzioni di reso e rispediscilo entro il ${day(due, l)}.`) },
    RECEIVED: { forYou: false, code: 'WE_INSPECT', words: { en: 'We received the goods and are inspecting them.', it: 'Abbiamo ricevuto la merce e la stiamo controllando.' } },
    INSPECTED: { forYou: false, code: 'WE_CARRY_OUT', words: { en: 'Inspected: a replacement; a credit note.', it: 'Controllato: una sostituzione; una nota di credito.' } },
    CLOSED: { forYou: false, code: 'DONE', words: { en: 'Closed.', it: 'Chiuso.' } },
    REJECTED: { forYou: false, code: 'NOT_ACCEPTED', words: { en: 'Not accepted: the jacket was worn after the return window.', it: 'Non accettato: la giacca è stata indossata oltre il periodo di reso.' } },
    CANCELLED: { forYou: false, code: 'CANCELLED', words: { en: 'Cancelled.', it: 'Annullato.' } },
  }[stage]
  const inspected = reached >= order.indexOf('INSPECTED')
  return {
    type: 'RETURN',
    id: RETURN_ID,
    number: 'R-2026-0031',
    yourRef: 'BA-RES-11',
    status: stage,
    state,
    words: RETURN_STATE_WORDS[state],
    next,
    version: 3,
    request: {
      opened: at(-24 * 8),
      via: 'PORTAL',
      outcomeWanted: { code: 'REPLACE', words: OUTCOME_WANTED_WORDS.REPLACE },
      note: 'Le due giacche taglia 52 sono arrivate con la cerniera rovinata. Preferiremmo una sostituzione prima della fiera.',
      photos: [photo(1, 'scatola-arrivata.jpg', 24 * 8)],
      lines: [
        { id: id(401), seq: 1, description: JACKET, size: '52', serial: 'SN-DEMO-000123', pieces: 1, reason: { code: 'DAMAGED_IN_TRANSIT', words: { en: 'Damaged in transit', it: 'Danneggiato nel trasporto' } }, reasonNote: null, photos: [photo(2, 'cerniera-1.jpg', 24 * 8), photo(3, 'cerniera-2.jpg', 24 * 7)] },
        { id: id(402), seq: 2, description: TROUSERS, size: '50', serial: null, pieces: 2, reason: { code: 'WRONG_SIZE', words: { en: 'Wrong size', it: 'Taglia sbagliata' } }, reasonNote: 'Ordinati 50, ci servivano 52.', photos: [] },
      ],
    },
    progress: {
      milestones,
      decision:
        stage === 'REJECTED'
          ? { en: 'Not accepted: the jacket was worn after the return window.', it: 'Non accettato: la giacca è stata indossata oltre il periodo di reso.' }
          : reached >= 1
            ? both((l) => `Approved: send it back by ${day(due, l)}.`, (l) => `Approvato: rispediscilo entro il ${day(due, l)}.`)
            : null,
      goodsDueBy: reached >= 1 ? due : null,
      sendTo: reached >= 1 ? 'Laboratorio Esempio, Firenze' : null,
      instructions: stage === 'AUTHORISED',
      parcels: reached >= 2 ? [{ receivedAt: at(-24 * 2), parcels: 1, carrier: 'Corriere Demo', trackingNumber: 'CD000000123IT' }] : [],
      inspection: inspected
        ? [
            { seq: 1, received: 1, grade: { code: 'DAMAGED', words: { en: 'Damaged', it: 'Danneggiato' } }, outcome: { code: 'REPLACE', words: { en: 'A replacement', it: 'Una sostituzione' } } },
            { seq: 2, received: 2, grade: { code: 'NEW', words: { en: 'As new', it: 'Come nuovo' } }, outcome: { code: 'CREDIT_ONLY', words: { en: 'A credit note', it: 'Una nota di credito' } } },
          ]
        : [],
      creditNotes: stage === 'CLOSED' ? [{ id: id(501), number: 'NC-2026-0007', issueDate: dayAt(-1), pdfFileId: id(502) }] : [],
      replacementOrder: stage === 'CLOSED' ? { id: id(503), number: 'SO-2026-0159' } : null,
    },
    actions: {
      cancel: { allowed: stage === 'REQUESTED' || stage === 'AUTHORISED', held: null },
      addPhotos: { allowed: takes, held: null },
    },
    ...over,
  }
}

// ── one complaint ────────────────────────────────────────────────────────────────────────────────────────────────────
export function complaintRecord(status: 'NEW' | 'INVESTIGATING' | 'ANSWERED' | 'CLOSED' = 'INVESTIGATING', over: Partial<ComplaintRecord> = {}): ComplaintRecord {
  const state: ComplaintCaseState = status === 'NEW' ? 'RECEIVED' : (status as ComplaintCaseState)
  const answered = status === 'ANSWERED' || status === 'CLOSED'
  const stages = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] as const
  const reachedAt = answered ? 8 : 3
  const stageWords: Readonly<Record<(typeof stages)[number], Words>> = {
    D1: { en: 'D1 Team', it: 'D1 Team' },
    D2: { en: 'D2 Problem described', it: 'D2 Descrizione del problema' },
    D3: { en: 'D3 Containment', it: 'D3 Contenimento' },
    D4: { en: 'D4 Root cause', it: 'D4 Causa radice' },
    D5: { en: 'D5 Corrective actions chosen', it: 'D5 Azioni correttive scelte' },
    D6: { en: 'D6 Corrective actions in place', it: 'D6 Azioni correttive attuate' },
    D7: { en: 'D7 Prevention', it: 'D7 Prevenzione' },
    D8: { en: 'D8 Closure', it: 'D8 Chiusura' },
  }
  return {
    type: 'COMPLAINT',
    id: COMPLAINT_ID,
    number: 'C-2026-0019',
    yourRef: 'BA-QC-7',
    status,
    state,
    words: COMPLAINT_STATE_WORDS[state],
    next: answered
      ? { forYou: true, code: 'READ_ANSWER', words: { en: 'We answered: read our letter.', it: 'Abbiamo risposto: leggi la nostra lettera.' } }
      : { forYou: false, code: 'WE_INVESTIGATE', words: both((l) => `We look into it and answer by ${day(dayAt(4), l)}.`, (l) => `Lo analizziamo e rispondiamo entro il ${day(dayAt(4), l)}.`) },
    version: 4,
    request: {
      opened: at(-24 * 12),
      via: 'PORTAL',
      description: 'La cucitura della spalla sinistra si è aperta dopo due uscite in moto. Succede su tre giacche dello stesso lotto.',
      item: { style: { code: 'JKT-DEMO-01', name: 'Giacca Demo Touring' }, size: '54', serial: 'SN-DEMO-000777', batchNumber: 'LOT-DEMO-26-04' },
      order: { id: id(90), number: 'SO-2026-0141', yourRef: 'BA-PO-771' },
      shipment: { id: id(92), number: 'SH-2026-0233' },
      photos: [photo(4, 'spalla-sinistra.jpg', 24 * 12)],
    },
    progress: { answerBy: dayAt(4), answeredAt: answered ? at(-24) : null },
    investigation: {
      capa: { number: '8D-2026-0005', type: 'EIGHT_D', stepReached: answered ? { en: 'D8 Closure — done', it: 'D8 Chiusura — fatto' } : stageWords.D4 },
      steps: stages.map((stage, index) => ({ stage, state: index < reachedAt ? ('DONE' as const) : index === reachedAt ? ('CURRENT' as const) : ('TODO' as const), on: index < reachedAt ? dayAt(-11 + index) : null, words: stageWords[stage] })),
      answeredAt: answered ? at(-24) : null,
      answeredVia: answered ? 'PORTAL' : null,
      documents: answered
        ? [
            { id: id(601), role: 'ANSWER_LETTER', name: 'risposta-C-2026-0019-v1.pdf', contentType: 'application/pdf', sizeBytes: 84_000, addedAt: at(-24), version: 1, current: true },
            { id: id(602), role: 'EIGHT_D', name: '8D-2026-0005.pdf', contentType: 'application/pdf', sizeBytes: 212_000, addedAt: at(-23), version: null, current: true },
          ]
        : [],
    },
    actions: { addPhotos: { allowed: !answered, held: null } },
    ...over,
  }
}

// ── the case's messages ──────────────────────────────────────────────────────────────────────────────────────────────
export function threadOf(locale: Locale): ThreadViewModel {
  const portal = words(locale, 'portal')
  const messages: PartnerMessage[] = [
    {
      id: 'm1',
      side: 'company',
      channel: 'portal',
      author: { name: 'Giulia Esempio', mine: false },
      body: locale === 'it' ? 'Buongiorno, abbiamo approvato il reso R-2026-0031: trova le istruzioni nella scheda Stato.' : 'Good morning, we approved return R-2026-0031: the instructions are on the Status tab.',
      attachments: [],
      at: at(-20),
      atText: formatDateTime(at(-20), { locale }),
    },
    {
      id: 'm2',
      side: 'partner',
      channel: 'portal',
      author: { name: 'Anna Esempio', mine: true },
      body: locale === 'it' ? 'Grazie, la spediamo domani con il nostro corriere.' : 'Thank you, we send it tomorrow with our carrier.',
      at: at(-4),
      atText: formatDateTime(at(-4), { locale }),
    },
  ]
  return { state: 'ready', record: null, companyName: 'Pelletteria Esempio', messages, composer: { value: '', busy: false, heldReason: null, hint: portal('thread.hint'), limit: 20_000 }, loadMore: null, accessLine: null, failed: null }
}
