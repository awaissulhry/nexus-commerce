import { samplePdf } from '../../areas/_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../lib/design/design-screen'
import type { ApprovalFile, ApprovalPage } from './api'
import type { ApproveViewModel } from './model'
import { ApproveView } from './view/ApproveView'

/**
 * SCR-198 Approve — made-up data only (PLAN §3.1): an invented factory ("Officina Demo"), an invented customer and
 * person, invented orders, styles and amounts. One case per state a partner can meet: each kind's panel (sample, design
 * proof, concession, revised order old → new, a document to sign), the decision in each of its checks, the photo marked
 * and "Mark the photo" open (on a photo and on a PDF page), the viewer, busy, refused by the server, held (the record
 * moved on), decided (approved; refused), and the link's own states (loading, error, gone, the wrong person).
 */

const svg = (body: string, fill = '#f4f1ea'): string => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="${fill}"/>${body}</svg>`)}`
const JACKET = svg('<path d="M110 40 L160 60 L210 40 L250 90 L230 110 L220 100 L220 210 L100 210 L100 100 L90 110 L70 90 Z" fill="#2b2b2b"/><text x="160" y="232" font-size="12" text-anchor="middle" fill="#555">campione demo</text>')
const DETAIL = svg('<rect x="60" y="50" width="200" height="140" rx="12" fill="#8a5a3c"/><circle cx="160" cy="120" r="30" fill="#c79a6b"/><text x="160" y="226" font-size="12" text-anchor="middle" fill="#555">dettaglio cucitura</text>')
const STANDARD = svg('<rect x="40" y="40" width="240" height="160" fill="#7a1f3d"/><text x="160" y="226" font-size="12" text-anchor="middle" fill="#555">standard</text>')
const ACTUAL = svg('<rect x="40" y="40" width="240" height="160" fill="#5e1630"/><text x="160" y="226" font-size="12" text-anchor="middle" fill="#555">prodotto</text>')
const PAGE = svg('<rect x="30" y="20" width="260" height="200" fill="#ffffff" stroke="#999"/><text x="160" y="70" font-size="16" text-anchor="middle" fill="#222">ROSSI 46</text><circle cx="160" cy="140" r="34" fill="#0b5" /><text x="160" y="232" font-size="12" text-anchor="middle" fill="#555">bozza pagina 1</text>', '#e9e9e9')

const PROOF_PDF = samplePdf(['Bozza del design', 'SO-2026-0042 · riga 10', 'Tuta su misura demo', 'Nome: ROSSI · Numero: 46'])
const DVR_PDF = samplePdf(['Documento di valutazione dei rischi', 'Versione 3', 'Officina Demo'])

const id = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`
const file = (n: number, originalName: string, contentType: string, sizeBytes = 184_320): ApprovalFile => ({ id: id(n), originalName, contentType, sizeBytes })

const PHOTOS = [file(1, 'campione-fronte.jpg', 'image/jpeg'), file(2, 'campione-cucitura.jpg', 'image/jpeg')]
const PHOTOS_READ = { [id(1)]: { src: JACKET, problem: false }, [id(2)]: { src: DETAIL, problem: false } }

function page(overrides: Partial<Omit<ApprovalPage, 'request'>> & { request?: Partial<ApprovalPage['request']> } = {}): ApprovalPage {
  const { request, ...rest } = overrides
  return {
    content: { facts: [{ label: 'Ordine', value: 'SO-2026-0042' }], revisedOrder: null },
    files: PHOTOS,
    may: { answer: true, withChanges: true, held: null },
    locale: 'it',
    link: { expiresAt: '2026-11-15T17:00:00.000Z', usesLeft: 1 },
    ...rest,
    request: {
      id: id(100),
      kind: 'SAMPLE',
      kindName: 'Campione',
      label: 'SO-2026-0042',
      question: 'Vi mandiamo le foto del campione della giacca in pelle nera, taglia 48. Va bene così per la produzione?',
      from: { companyName: 'Officina Demo' },
      dueAt: '2026-11-15T17:00:00.000Z',
      dueWords: 'Rispondere entro il 15 nov',
      status: 'OPEN',
      stateWords: 'In attesa di risposta',
      decided: null,
      answer: null,
      version: 1,
      ...request,
    },
  }
}

const NOW = Date.parse('2026-11-10T09:00:00.000Z')

function model(overrides: Partial<ApproveViewModel> = {}): ApproveViewModel {
  return { link: 'valid', page: page(), files: PHOTOS_READ, open: null, decision: null, comment: '', markup: null, marking: null, answer: 'idle', problem: null, field: null, now: NOW, ...overrides }
}

const PROOF_FILES = [file(10, 'bozza-ROSSI-46.pdf', 'application/pdf', 96_000), file(11, 'posizione-logo.png', 'image/png')]
const PROOF = page({
  request: { kind: 'PROOF', kindName: 'Bozza del design', label: 'SO-2026-0042 · riga 10', question: 'Ecco la bozza finale della tuta su misura: nome, numero e logo. Controllate prima che iniziamo il taglio.', dueWords: 'Rispondere entro il 13 nov', dueAt: '2026-11-13T17:00:00.000Z' },
  content: {
    facts: [
      { label: 'Ordine', value: 'SO-2026-0042 · riga 10' },
      { label: 'Modello', value: 'DEMO-MTM-01 Tuta su misura demo · BLU Blu notte' },
      { label: 'Cosa controllare', value: 'Nomi e numeri scritti giusti, colori, posizione dei loghi.' },
    ],
    revisedOrder: null,
  },
  files: PROOF_FILES,
})
const PROOF_READ = { [id(10)]: { src: PROOF_PDF, problem: false }, [id(11)]: { src: PAGE, problem: false } }

const CONCESSION_FILES = [file(20, 'standard-colore.jpg', 'image/jpeg'), file(21, 'prodotto-colore.jpg', 'image/jpeg')]
const CONCESSION = page({
  request: { kind: 'CONCESSION', kindName: 'Concessione', label: 'NCR-2026-0007 · concessione 1', question: 'La tonalità è leggermente più scura dello standard (ΔE 1,8) su 40 giacche del lotto L-0311. Vi chiediamo di accettarla.', dueWords: 'Rispondere entro il 14 nov', dueAt: '2026-11-14T17:00:00.000Z' },
  content: {
    facts: [
      { label: 'Non conformità', value: 'NCR-2026-0007 — Tonalità più scura' },
      { label: 'La deviazione', value: 'Tonalità leggermente più scura, ΔE 1,8; 40 pezzi del lotto L-0311.' },
      { label: 'Cosa proponiamo', value: 'Spediamo il lotto così com’è con uno sconto del 5 % sulla fattura.' },
    ],
    revisedOrder: null,
  },
  files: CONCESSION_FILES,
})
const CONCESSION_READ = { [id(20)]: { src: STANDARD, problem: false }, [id(21)]: { src: ACTUAL, problem: false } }

const REVISED = page({
  request: { kind: 'REVISED_ORDER', kindName: 'Ordine modificato', label: 'SO-2026-0042 · revisione 2', question: 'Abbiamo aggiornato l’ordine come richiesto: confermate la nuova versione?', dueWords: 'Rispondere entro il 14 nov', dueAt: '2026-11-14T17:00:00.000Z' },
  may: { answer: true, withChanges: false, held: null },
  files: [],
  content: {
    facts: [
      { label: 'Ordine', value: 'SO-2026-0042' },
      { label: 'Revisione', value: '2' },
      { label: 'Perché è cambiato', value: 'Richiesta del cliente: più taglie M, una variante in meno.' },
    ],
    revisedOrder: {
      orderNumber: 'SO-2026-0042',
      revision: 2,
      reason: 'Richiesta del cliente: più taglie M, una variante in meno.',
      currency: 'EUR',
      lines: [
        { change: 'CHANGED', lineId: id(30), seq: 10, style: { code: 'DEMO-JKT-01', name: 'Giacca demo' }, colour: { code: 'NER', name: 'Nero' }, piecesBefore: 20, piecesAfter: 26, sizes: [{ size: 'S', before: 4, after: 4 }, { size: 'M', before: 8, after: 14 }, { size: 'L', before: 8, after: 8 }], priceChanged: false },
        { change: 'REMOVED', lineId: id(31), seq: 20, style: { code: 'DEMO-JKT-01', name: 'Giacca demo' }, colour: { code: 'ROS', name: 'Rosso' }, piecesBefore: 6, piecesAfter: 0, sizes: [{ size: 'M', before: 3, after: 0 }, { size: 'L', before: 3, after: 0 }], priceChanged: false },
        { change: 'ADDED', lineId: id(32), seq: 30, style: { code: 'DEMO-PNT-02', name: 'Pantalone demo' }, colour: { code: 'NER', name: 'Nero' }, piecesBefore: 0, piecesAfter: 10, sizes: [{ size: 'M', before: 0, after: 5 }, { size: 'L', before: 0, after: 5 }], priceChanged: true },
      ],
      header: [{ field: 'requestedDate', before: '2026-12-01', after: '2026-12-10' }],
      prices: [
        { lineId: id(30), unitPrice: null, netBefore: 900000, netAfter: 1170000 },
        { lineId: id(31), unitPrice: null, netBefore: 264000, netAfter: 0 },
        { lineId: id(32), unitPrice: { before: null, after: '210.00' }, netBefore: 0, netAfter: 210000 },
      ],
      netAmountBefore: 1164000,
      netAmountAfter: 1380000,
      grossAmountBefore: 1420080,
      grossAmountAfter: 1683600,
    },
  },
})

const SIGNATURE = page({
  request: { kind: 'SIGNATURE', kindName: 'Firma', label: 'DVR Officina Demo — versione 3 · RSPP', question: 'Vi chiediamo di firmare come RSPP la versione 3 del documento di valutazione dei rischi.', dueWords: 'Rispondere entro il 24 nov', dueAt: '2026-11-24T17:00:00.000Z' },
  may: { answer: true, withChanges: false, held: null },
  content: {
    facts: [
      { label: 'Documento', value: 'Valutazione dei rischi — versione 3' },
      { label: 'Firmate come', value: 'Responsabile del servizio di prevenzione e protezione' },
      { label: 'Impronta SHA-256 del PDF', value: '9c1e4a7b2f0d3c5e8a6b1d4f7a2c9e0b3d5f8a1c4e7b0d2f5a8c1e3b6d9f2a4c' },
    ],
    revisedOrder: null,
  },
  files: [file(40, 'DVR-versione-3.pdf', 'application/pdf', 412_000)],
})

const MARKS = [
  { kind: 'circle', center: { x: 0.52, y: 0.42 }, radius: 0.08 },
  { kind: 'arrow', from: { x: 0.2, y: 0.8 }, to: { x: 0.45, y: 0.5 } },
] as const

const APPROVED = page({
  request: {
    status: 'APPROVED_WITH_CHANGES',
    stateWords: 'Approvato con modifiche',
    decided: 'Approvato con modifiche — firmato da Anna Esempio alle 10:42 del 10 nov. Procediamo con quanto approvato.',
    answer: { at: '2026-11-10T09:42:00.000Z', typedName: 'Anna Esempio', words: 'La cucitura sulla spalla va rifinita meglio, il resto va bene.', markupFileId: id(2) },
    version: 2,
  },
  may: { answer: false, withChanges: false, held: 'Questa richiesta ha già una risposta.' },
  receipt: 'SENT',
})

const REFUSED = page({
  request: {
    kind: 'PROOF',
    kindName: 'Bozza del design',
    label: 'SO-2026-0042 · riga 10',
    status: 'REFUSED',
    stateWords: 'Rifiutato',
    decided: 'Rifiutato — firmato da Anna Esempio alle 16:05 del 10 nov. Vi ricontattiamo per decidere insieme come procedere.',
    answer: { at: '2026-11-10T15:05:00.000Z', typedName: 'Anna Esempio', words: 'Il numero è 64, non 46.', markupFileId: null },
    version: 2,
  },
  content: PROOF.content,
  files: PROOF_FILES,
  may: { answer: false, withChanges: false, held: 'Questa richiesta ha già una risposta.' },
  receipt: 'FAILED',
})

export const designScreen = defineDesignScreen<ApproveViewModel>({
  screen: 'SCR-198',
  title: 'Approve (a partner’s approval link)',
  view: ApproveView,
  cases: [
    { id: 'sample', label: 'Sample · open', model: model(), note: 'What we ask (kind, record, due with its countdown, who asks, the question), the photos and spec, then your decision: Approve · Approve with changes · Refuse, the comment, Mark the photo, and the SignBlock (Enter signs).' },
    { id: 'sample-changes', label: 'Sample · approve with changes, a photo marked', model: model({ decision: 'APPROVED_WITH_CHANGES', comment: 'La cucitura sulla spalla va rifinita meglio.', markup: { fileId: id(2), page: null, marks: MARKS, note: 'Qui' } }), note: 'The comment is needed; the marked photo says how many marks, with Change and Remove.' },
    { id: 'mark-photo', label: 'Mark the photo · a picture', model: model({ marking: { fileId: id(2), name: 'campione-cucitura.jpg', target: 'picture', page: 1, pages: null, image: { status: 'ready', src: DETAIL, width: 320, height: 240 }, note: 'La cucitura qui', marks: MARKS } }), note: 'Arrows and circles (the keyboard draws too), the note, "Add to my comment" held until a mark is drawn. Esc closes.' },
    { id: 'mark-pdf', label: 'Mark the photo · a PDF page', model: model({ page: PROOF, files: PROOF_READ, marking: { fileId: id(10), name: 'bozza-ROSSI-46.pdf', target: 'pdf', page: 1, pages: 2, image: { status: 'ready', src: PAGE, width: 320, height: 240 }, note: '', marks: [] } }), note: 'Previous page held on page 1 with the reason; Next page goes on.' },
    { id: 'mark-loading', label: 'Mark the photo · loading', model: model({ marking: { fileId: id(1), name: 'campione-fronte.jpg', target: 'picture', page: 1, pages: null, image: { status: 'loading' }, note: '', marks: [] } }) },
    { id: 'viewer', label: 'A photo full size', model: model({ open: id(1) }), note: 'Previous held at the first file; Next, ← →, Mark the photo; Esc gives the focus back.' },
    { id: 'proof', label: 'Design proof · PDF with zoom and a picture', model: model({ page: PROOF, files: PROOF_READ }), note: 'The proof right in the page (zoom), what to check, the placement picture beside.' },
    { id: 'concession', label: 'Concession · the two photos side by side', model: model({ page: CONCESSION, files: CONCESSION_READ }), note: 'The deviation, what we propose, standard and actual side by side.' },
    { id: 'revised-order', label: 'Revised order · line by line, old → new', model: model({ page: REVISED, files: {} }), note: 'Only Approve and Refuse (a change is a new revision); sizes, unit price and line amount old → new; the totals; the note that the earlier acceptance ends.' },
    { id: 'signature', label: 'Signature · a document to sign', model: model({ page: SIGNATURE, files: { [id(40)]: { src: DVR_PDF, problem: false } } }) },
    { id: 'choose-first', label: 'Refused by the page: no answer chosen', model: model({ problem: 'decision.problem.choose', field: 'decision' }), note: 'Signing without a choice says so at the choices; the focus goes there.' },
    { id: 'refuse-why', label: 'Refused by the page: a refusal without a reason', model: model({ decision: 'REFUSED', problem: 'decision.problem.why', field: 'comment' }), note: 'The reason is needed: the comment field says so and takes the focus.' },
    { id: 'busy', label: 'Sending the answer', model: model({ decision: 'APPROVED', answer: 'busy' }) },
    { id: 'server-changed', label: 'Refused by the server: the request changed', model: model({ decision: 'APPROVED', problem: 'problem.changed' }) },
    { id: 'held', label: 'Held: the record moved on', model: model({ page: page({ may: { answer: false, withChanges: true, held: 'L’ordine SO-2026-0042 è stato annullato: questa richiesta non serve più.' } }) }), note: 'The reason on top; the sign button and Mark the photo held with it, never disabled.' },
    { id: 'file-problem', label: 'A photo can’t be read (answering still possible)', model: model({ files: { [id(1)]: { src: null, problem: true }, [id(2)]: { src: DETAIL, problem: false } } }) },
    { id: 'files-loading', label: 'The photos are still loading', model: model({ files: {} }) },
    { id: 'decided', label: 'Decided · approved with changes, receipt sent', model: model({ page: APPROVED, answer: 'done' }), note: 'EndState: the answer as signed, what happens next, the receipt by e-mail, the reference, whom to ask.' },
    { id: 'decided-refused', label: 'Decided · refused, the receipt did not go', model: model({ page: REFUSED, files: PROOF_READ, answer: 'done' }) },
    { id: 'loading', label: 'Loading the request', model: model({ page: null, files: {} }), note: 'Skeleton in the shape of the page; "Still loading…" after about a second.' },
    { id: 'error', label: 'Error reading the request', model: model({ page: null, files: {}, problem: 'problem.read' }), note: 'Our words and Try again; never an empty request.' },
    { id: 'gone', label: 'The link no longer opens (answered, withdrawn or past due)', model: model({ link: 'unavailable', page: null }) },
    { id: 'wrong-person', label: 'The wrong person', model: model({ link: 'wrong_person', page: null }) },
  ],
})
