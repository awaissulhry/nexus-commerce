import { samplePdf } from '../../areas/_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../lib/design/design-screen'
import type { LinkQuote } from './api'
import type { QuoteAcceptViewModel } from './model'
import { QuoteAcceptView } from './view/QuoteAcceptView'

/**
 * SCR-099 Accept a quote — made-up data only (PLAN §3.1): an invented seller and customer, invented prices (BLK 8 × 450,
 * RED 6 × 440: net 6,240.00, VAT 1,372.80, total 7,612.80, deposit 30 % 2,283.84), the IBAN registry's Italian example
 * number. Each case is one state the customer can meet: the open offer (business; consumer with the no-withdrawal
 * statement and the email check), accepted with the deposit instructions, declined, expired, being revised, replaced,
 * withdrawn, a link that no longer opens, the wrong person, loading, an error, the decline dialog, recording, a refusal.
 */

const PDF = samplePdf(['Preventivo Q-2026-0142 v1', 'Officina Demo S.r.l.', 'Squadra Corse Fittizia S.r.l.', 'Totale 7.612,80 EUR'])
const SHA = '3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a'

function linkQuote(overrides: Omit<Partial<LinkQuote>, 'quote'> & { quote?: Partial<LinkQuote['quote']> } = {}): LinkQuote {
  const { quote, ...rest } = overrides
  return {
    state: 'OPEN',
    message: '',
    answers: [
      { action: 'accept', typedName: 'required', email: false, noWithdrawal: false },
      { action: 'decline', typedName: 'optional', email: false, noWithdrawal: false },
    ],
    acceptance: null,
    deposit: null,
    expiresAt: '2026-12-12T22:59:59.000Z',
    privacy: { url: 'https://factory.example.com/privacy/0190f0e2-1111-7000-8000-000000000001', retention: '' },
    ...rest,
    quote: {
      number: 'Q-2026-0142 v1',
      quoteNumber: 'Q-2026-0142',
      versionId: '0190f0e2-9999-7000-8000-100000000001',
      revision: 1,
      seller: { legalName: 'Officina Demo S.r.l.', tradeName: 'Officina Demo' },
      customerRef: 'RFQ-0042',
      date: '2026-10-29',
      language: 'it',
      currency: 'EUR',
      priceBasis: 'NET',
      validUntil: '2026-11-28',
      firmOffer: false,
      promiseDate: '2027-02-15',
      paymentTerms: 'Bonifico 30 giorni data fattura',
      billTo: { legalName: 'Squadra Corse Fittizia S.r.l.', address: { line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' } },
      shipTo: { name: 'Magazzino', line1: 'Via Fittizia 22', postalCode: '20900', city: 'Monza', province: 'MB', country: 'IT' },
      lines: [
        { seq: 10, code: 'DEMO-JKT-01-BLK', description: 'DEMO-JKT-01 Giacca pelle demo — Nero', note: null, quantity: 8, unitPrice: '450', discountPct: null, netAmount: 360000, vatAmount: 79200, vatRatePct: '22.00', vatNature: null, sizesText: '50×2 · 52×4 · 54×2', optionsText: 'Opzioni: Imbottitura termica: Imbottitura removibile; Nome sul petto: Nome ricamato «ROSSI»' },
        { seq: 20, code: 'DEMO-JKT-01-RED', description: 'DEMO-JKT-01 Giacca pelle demo — Rosso', note: 'Logo ricamato sul petto', quantity: 6, unitPrice: '440', discountPct: null, netAmount: 264000, vatAmount: 58080, vatRatePct: '22.00', vatNature: null, sizesText: '50×1 · 52×3 · 54×2' },
      ],
      totals: { net: 624000, vat: [{ rate: '22.00', nature: null, taxable: 624000, vat: 137280 }], gross: 761280 },
      deposit: { pct: '30', kind: 'ACCONTO', amount: 228384 },
      noWithdrawal: false,
      terms: {
        termsVersion: '2026-1',
        clauses: [
          { code: 'VALIDITY', text: 'Il preventivo vale fino alla data indicata.' },
          { code: 'DEPOSIT', text: "L'acconto del 30 % si paga entro 7 giorni dall'accettazione; la produzione inizia al ricevimento." },
          { code: 'DELIVERY', text: 'La consegna avviene franco nostro magazzino, salvo accordi diversi.' },
        ],
      },
      document: { fileId: '0190f0e2-9999-7000-8000-300000000001', name: 'Preventivo Q-2026-0142 v1.pdf', sha256: SHA, sizeBytes: 48211 },
      proofs: [],
      ...quote,
    },
  }
}

// B-W2b-165 (SAL-199): made-up proofs — an artwork proof (PDF, its second version), a size chart and a placement sketch
// (pictures drawn here as SVG; the live page gets the stripped bytes of a JPEG, PNG or WebP).
const svg = (body: string): string => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="#f4f1ea"/>${body}</svg>`)}`
const CHART = svg('<g font-family="sans-serif" font-size="14" fill="#333"><text x="20" y="34" font-weight="bold">Tabella taglie demo</text><text x="20" y="70">50 · torace 100 · manica 62</text><text x="20" y="96">52 · torace 104 · manica 63</text><text x="20" y="122">54 · torace 108 · manica 64</text></g>')
const SKETCH = svg('<path d="M110 40 L210 40 L250 90 L230 200 L90 200 L70 90 Z" fill="none" stroke="#333" stroke-width="3"/><circle cx="185" cy="95" r="16" fill="#b22"/><text x="20" y="228" font-family="sans-serif" font-size="13" fill="#333">Logo demo sul petto, 6 cm</text>')
const ARTWORK_PDF = samplePdf(['Prova grafica demo v2', 'Logo ricamato sul petto, 6 cm', 'Colori: nero, rosso'])
const PROOFS: LinkQuote['quote']['proofs'] = [
  { fileId: '0190f0e2-9999-7000-8000-700000000001', name: 'Prova grafica logo.pdf', contentType: 'application/pdf', shape: 'PDF', sizeBytes: 184_320, sha256: '9fc5a7321a455e5a139aaac77b30a8add3b0ba0b56f6f822892af999c5a78243', versionNo: 2 },
  { fileId: '0190f0e2-9999-7000-8000-700000000002', name: 'Tabella taglie.png', contentType: 'image/png', shape: 'PICTURE', sizeBytes: 96_412, sha256: '8e8582ea34d58c671ab5d546e8d1a11c688d7b246a7fd9aee0316246094b3a0b', versionNo: 1 },
  { fileId: '0190f0e2-9999-7000-8000-700000000003', name: 'Posizione logo.jpg', contentType: 'image/jpeg', shape: 'PICTURE', sizeBytes: 1_311_744, sha256: '41d0c35b7e6a2f9184c0de57a3b19f2c6e8d40a7b5c3e1f9d2a6b8c0e4f17a35', versionNo: 1 },
]
const PROOFS_READ: QuoteAcceptViewModel['proofs'] = {
  [PROOFS[0]!.fileId]: { src: ARTWORK_PDF, problem: false },
  [PROOFS[1]!.fileId]: { src: CHART, problem: false },
  [PROOFS[2]!.fileId]: { src: SKETCH, problem: false },
}

const ACCEPTED = linkQuote({
  state: 'ACCEPTED',
  answers: [],
  acceptance: { signerName: 'Anna Esempio', acceptedAt: '2026-10-30T16:20:00.000Z', documentSha256: SHA, termsVersion: '2026-1' },
  deposit: {
    id: '0190f0e2-9999-7000-8000-600000000001',
    kind: 'ACCONTO',
    depositPct: '30',
    currency: 'EUR',
    amount: 228384,
    dueDate: '2026-11-06',
    fiscalDocument: 'TD02',
    status: 'OPEN',
    instructions: { method: 'BANK_TRANSFER', amount: 228384, currency: 'EUR', dueDate: '2026-11-06', reference: 'Acconto Q-2026-0142 v1', bank: { accountHolder: 'Officina Demo S.r.l.', iban: 'IT60X0542811101000000123456', bic: null, bankName: 'Banca Esempio' }, text: '' },
  },
})

function model(overrides: Partial<QuoteAcceptViewModel> = {}): QuoteAcceptViewModel {
  return { link: 'valid', quote: linkQuote(), pdf: { src: PDF, problem: false }, answer: 'idle', problem: null, declineOpen: false, newLinkAsked: false, ...overrides }
}

const consumer = linkQuote({
  answers: [
    { action: 'accept', typedName: 'required', email: true, noWithdrawal: true },
    { action: 'decline', typedName: 'optional', email: false, noWithdrawal: false },
  ],
  quote: {
    priceBasis: 'GROSS',
    billTo: { legalName: 'Mario Esempio', address: { line1: 'Via Prova 3', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT' } },
    lines: [{ seq: 10, code: 'DEMO-MTM-01', description: 'Tuta pelle su misura demo', note: 'Su misura: profilo misure del 12/10', quantity: 1, unitPrice: '1830', discountPct: null, netAmount: 150000, vatAmount: 33000, vatRatePct: '22.00', vatNature: null, sizesText: 'su misura × 1' }],
    totals: { net: 150000, vat: [{ rate: '22.00', nature: null, taxable: 150000, vat: 33000 }], gross: 183000 },
    deposit: { pct: '30', kind: 'CAPARRA', amount: 54900 },
    noWithdrawal: true,
    firmOffer: true,
    customerRef: null,
  },
})

export const designScreen = defineDesignScreen<QuoteAcceptViewModel>({
  screen: 'SCR-099',
  title: 'Accept a quote (the customer’s link)',
  view: QuoteAcceptView,
  cases: [
    { id: 'open', label: 'Open · a business', model: model(), note: 'The offer first, the lines, the exact PDF with its document code, the terms, then the SignBlock and Decline.' },
    { id: 'consumer', label: 'Open · a consumer (VAT included, no withdrawal)', model: model({ quote: consumer }), note: 'Total VAT included first (art. 49), the no-withdrawal tick (art. 59(c)), the email asked, a firm offer.' },
    { id: 'busy', label: 'Recording the acceptance', model: model({ answer: 'busy' }) },
    { id: 'refused', label: 'Refused: the quote changed meanwhile', model: model({ problem: 'problem.changed' }) },
    { id: 'accepted', label: 'Accepted · deposit by bank transfer', model: model({ quote: ACCEPTED, answer: 'done' }), note: 'What happens next, the receipt, and each bank field with Copy; card or SEPA held with the reason (B-W2b-199).' },
    { id: 'accepted-no-bank', label: 'Accepted · no bank details yet', model: model({ quote: { ...ACCEPTED, deposit: { ...ACCEPTED.deposit!, instructions: { ...ACCEPTED.deposit!.instructions, bank: null } } }, answer: 'done' }) },
    // B-W2b-199: the deposit's card step is held on this page (the accept used the link); a deposit received says so.
    { id: 'accepted-deposit-paid', label: 'Accepted · the deposit already received', model: model({ quote: { ...ACCEPTED, deposit: { ...ACCEPTED.deposit!, status: 'PAID' } }, answer: 'done' }) },
    { id: 'decline', label: 'Decline dialog', model: model({ declineOpen: true }) },
    { id: 'declined', label: 'Declined', model: model({ quote: linkQuote({ state: 'DECLINED', answers: [] }) }) },
    { id: 'expired', label: 'The offer ended', model: model({ quote: linkQuote({ state: 'EXPIRED', answers: [] }) }), note: 'Ask for a new link.' },
    { id: 'expired-asked', label: 'The offer ended · new link asked', model: model({ quote: linkQuote({ state: 'EXPIRED', answers: [] }), newLinkAsked: true }) },
    { id: 'revising', label: 'A new version is being prepared', model: model({ quote: linkQuote({ state: 'REVISING', answers: [] }) }) },
    { id: 'superseded', label: 'Replaced by a newer version', model: model({ quote: linkQuote({ state: 'SUPERSEDED', answers: [] }) }) },
    { id: 'withdrawn', label: 'Withdrawn by the seller', model: model({ quote: linkQuote({ state: 'CANCELLED', answers: [] }) }) },
    { id: 'pdf-problem', label: "The PDF can't be shown (answering still possible)", model: model({ pdf: { src: null, problem: true } }) },
    // B-W2b-165 (SAL-199): the proofs accepted with the quote.
    { id: 'proofs', label: 'Proofs · open, with an artwork PDF and two pictures', model: model({ quote: linkQuote({ quote: { proofs: PROOFS } }), proofs: PROOFS_READ }), note: 'Proofs you accept with it, between the PDF and the terms; the sign block says the proofs are accepted with it.' },
    { id: 'proofs-picture', label: 'Proofs · a picture open full size', model: model({ quote: linkQuote({ quote: { proofs: PROOFS } }), proofs: PROOFS_READ, proofOpen: PROOFS[1]!.fileId }), note: 'Previous / Next over every proof, ← →, Esc closes.' },
    { id: 'proofs-pdf', label: 'Proofs · the artwork PDF open', model: model({ quote: linkQuote({ quote: { proofs: PROOFS } }), proofs: PROOFS_READ, proofOpen: PROOFS[0]!.fileId }), note: 'Previous held at the first proof, with the reason.' },
    { id: 'proofs-loading', label: 'Proofs · still loading', model: model({ quote: linkQuote({ quote: { proofs: PROOFS } }), proofs: {} }) },
    { id: 'proofs-error', label: "Proofs · a picture can't be read (answering still possible)", model: model({ quote: linkQuote({ quote: { proofs: PROOFS } }), proofs: { ...PROOFS_READ, [PROOFS[2]!.fileId]: { src: null, problem: true } } }), note: 'That proof says so with Try again; the others open.' },
    { id: 'proofs-consumer', label: 'Proofs · a consumer, one proof', model: model({ quote: { ...consumer, quote: { ...consumer.quote, proofs: [PROOFS[0]!] } }, proofs: PROOFS_READ }) },
    { id: 'proofs-accepted', label: 'Proofs · accepted, named in the end state', model: model({ quote: { ...ACCEPTED, quote: { ...ACCEPTED.quote, proofs: PROOFS } }, proofs: PROOFS_READ, answer: 'done' }) },
    { id: 'unavailable', label: 'Link no longer opens (used, expired or withdrawn)', model: model({ link: 'unavailable', quote: null }) },
    { id: 'wrong-person', label: 'The wrong person', model: model({ link: 'wrong_person', quote: null }) },
    { id: 'loading', label: 'Opening the link', model: model({ link: 'loading', quote: null }) },
    { id: 'error', label: 'Error', model: model({ link: 'error', quote: null }) },
  ],
})
