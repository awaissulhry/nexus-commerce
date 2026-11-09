import type { PublicDocFile, PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { samplePdf } from '../../areas/_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { EMPTY_LOOKUP, frameSender, type PublicDocViewModel } from './model'
import { PublicDocView } from './view/PublicDocView'

/**
 * SCR-102 The public DoC (design links.doc, link-page; B-W2b-166; PRD-294, PRD-356) — made-up data only (PLAN §3.1): an
 * invented maker "Officina Demo S.r.l.", a made-up jacket DEMO-JKT-01 "Giacca Demo" (category II, EN 17092-4:2020 class
 * A), batch BA-26-0412 made to revision 3, revisions 2 and 1 still kept for the batches they cover, a made-up notified body
 * "Organismo Demo" no. 0000 and certificate DEMO-EU-0042. The page is public: there is no role case (anyone sees the same);
 * phone first: open a case with `?width=phone`.
 */

const DOC_PDF = samplePdf(['Dichiarazione UE di conformita', 'DEMO-JKT-01 Giacca Demo · revisione 3', 'Regolamento (UE) 2016/425', 'EN 17092-4:2020 classe A', 'Officina Demo S.r.l.'])
const SHA = (n: number) => `${n}`.repeat(64).slice(0, 64)
const fid = (n: number) => `0190f0e2-7101-7000-8000-${String(n).padStart(12, '0')}`

const file = (n: number, language: string, kind: 'doc' | 'info', revision: number, over: Partial<PublicDocFile> = {}): PublicDocFile => ({
  language,
  fileId: fid(n),
  name: kind === 'doc' ? `DoC DEMO-JKT-01 rev ${revision} (${language}).pdf` : `Nota informativa DEMO-JKT-01 rev ${revision} (${language}).pdf`,
  sizeBytes: kind === 'doc' ? 182_304 : 1_204_118,
  sha256: SHA(n % 9 || 1),
  number: kind === 'doc' ? `DOC-DEMO-01/${revision}` : null,
  issuedOn: revision === 3 ? '2026-09-10' : revision === 2 ? '2025-03-04' : '2024-02-05',
  ...over,
})

const SENDER: PublicDocPage['sender'] = { companyId: '0190f0e2-7101-7000-8000-0000000000aa', name: 'Officina Demo', companyName: 'Officina Demo S.r.l.', logoPath: null, logoDarkPath: null, accentColour: null }

const page = (over: Partial<PublicDocPage> = {}): PublicDocPage => ({
  code: '7K3Q-M2XA',
  path: '7K3QM2XA',
  kind: 'BATCH',
  sender: SENDER,
  contact: { email: 'qualita@officina-demo.example' },
  product: {
    style: { code: 'DEMO-JKT-01', name: 'Giacca Demo', names: { en: 'Demo Jacket' } },
    batch: { number: 'BA-26-0412', releasedOn: '2026-10-05' },
    maker: { name: 'Officina Demo S.r.l.', address: 'Via Esempio 1, 00000 Demoville (XX), Italia', role: 'COMPANY' },
    importer: null,
  },
  ppe: { category: 'CATEGORY_II', standard: 'EN 17092-4:2020', ppeClass: 'A', certificateRequired: true },
  declaration: {
    revision: 3,
    standing: 'CURRENT',
    before: null,
    batches: { first: '2026-09-15', last: '2026-11-02' },
    files: [file(31, 'it', 'doc', 3), file(32, 'en', 'doc', 3), file(33, 'de', 'doc', 3)],
  },
  missing: null,
  certificate: {
    number: 'DEMO-EU-0042',
    notifiedBody: { name: 'Organismo Demo', number: '0000' },
    standard: 'EN 17092-4:2020',
    ppeClass: 'A',
    validFrom: '2024-01-15',
    validTo: '2029-01-14',
    day: '2026-10-05',
    validOnDay: true,
  },
  instructions: {
    files: [file(34, 'it', 'info', 3), file(35, 'en', 'info', 3)],
    care: [
      { symbol: 'wash-not', text: { it: 'Non lavare', en: 'Do not wash' } },
      { symbol: 'iron-not', text: { it: 'Non stirare', en: 'Do not iron' } },
      { symbol: 'leather-clean', text: { it: 'Pulire la pelle con un panno umido', en: 'Clean the leather with a damp cloth' } },
    ],
  },
  versions: [
    { revision: 2, issuedOn: '2025-03-04', batches: { first: '2025-03-10', last: '2026-09-01' }, declarations: [file(21, 'it', 'doc', 2), file(22, 'en', 'doc', 2)], instructions: [file(24, 'it', 'info', 2)] },
    { revision: 1, issuedOn: '2024-02-05', batches: { first: '2024-02-12', last: '2024-02-12' }, declarations: [file(11, 'it', 'doc', 1)], instructions: [] },
  ],
  n: 0,
  others: [],
  ...over,
})

const READER = ['it', 'en']

const found = (shown: PublicDocPage = page(), over: Partial<PublicDocViewModel> = {}): PublicDocViewModel => {
  const language = shown.declaration?.files[0]?.language ?? null
  const first = shown.declaration?.files.find((entry) => entry.language === language) ?? null
  return {
    kind: 'found',
    sender: frameSender(shown),
    slow: false,
    page: shown,
    readerLanguages: READER,
    language,
    pdf: first ? { fileId: first.fileId, state: 'ready', data: DOC_PDF } : null,
    lookup: EMPTY_LOOKUP,
    ...over,
  }
}

const earlier = page({
  product: { ...page().product, batch: { number: 'BA-25-0187', releasedOn: '2025-06-02' } },
  declaration: { revision: 2, standing: 'EARLIER', before: '2026-09-15', batches: { first: '2025-03-10', last: '2026-09-01' }, files: [file(21, 'it', 'doc', 2), file(22, 'en', 'doc', 2)] },
  certificate: { ...page().certificate!, day: '2025-06-02' },
  instructions: { files: [file(24, 'it', 'info', 2)], care: page().instructions.care },
  versions: [page().versions[1]!],
})

const lookup = (over: Partial<PublicDocViewModel['lookup']> = {}): PublicDocViewModel => ({
  kind: 'lookup',
  sender: null,
  slow: false,
  page: null,
  readerLanguages: READER,
  language: null,
  pdf: null,
  lookup: { ...EMPTY_LOOKUP, ...over },
})

export const designScreen = defineDesignScreen<PublicDocViewModel>({
  screen: 'SCR-102',
  title: 'Public DoC (links.doc): the declaration valid for a batch by QR or code, the certificate summary, the instructions online, earlier versions',
  view: PublicDocView,
  cases: [
    {
      id: 'batch-current',
      label: 'A batch’s QR: its declaration (current) in Italian, also in English and German; certificate, instructions, earlier versions',
      model: found(),
      note: 'What the QR on the garment label opens, for anyone. Phone first: ?width=phone. The recall notice (W2b-4) and Report a problem (W2b-5) join later.',
    },
    {
      id: 'batch-earlier',
      label: 'An older batch: its own revision 2 declaration, “For batches before September 2026”',
      model: found(earlier, { language: 'it', pdf: { fileId: fid(21), state: 'ready', data: DOC_PDF } }),
    },
    {
      id: 'style-current',
      label: 'A style’s address (a store page, the printed instructions): the current declaration, no batch',
      model: found(page({ kind: 'STYLE', product: { ...page().product, batch: null }, certificate: { ...page().certificate!, day: '2026-11-09' } })),
    },
    {
      id: 'language-german',
      label: 'A German reader: the declaration in German (every published language one choice away)',
      model: found(page(), { readerLanguages: ['de', 'it', 'en'], language: 'de', pdf: { fileId: fid(33), state: 'ready', data: DOC_PDF } }),
    },
    {
      id: 'one-language',
      label: 'Published in one language only (no language list)',
      model: found(page({ declaration: { ...page().declaration!, files: [file(32, 'en', 'doc', 3)] } })),
    },
    {
      id: 'private-label',
      label: 'Private label: the brand is the legal manufacturer',
      model: found(page({ product: { ...page().product, maker: { name: 'Marchio Demo S.p.A.', address: 'Viale Esempio 99, 00000 Demopoli (YY), Italia', role: 'BRAND' } } })),
    },
    {
      id: 'category-one',
      label: 'Category I: self-certified, no notified body',
      model: found(page({ ppe: { category: 'CATEGORY_I', standard: 'EN 13594:2015', ppeClass: '1', certificateRequired: false }, certificate: null })),
    },
    {
      id: 'certificate-lapsed',
      label: 'A style whose certificate is no longer valid today (the summary says so)',
      model: found(page({ kind: 'STYLE', product: { ...page().product, batch: null }, certificate: { ...page().certificate!, validTo: '2026-10-31', day: '2026-11-09', validOnDay: false } })),
    },
    {
      id: 'no-certificate',
      label: 'Category II with no certificate on record: ask the sender',
      model: found(page({ certificate: null })),
    },
    {
      id: 'not-published',
      label: 'A released batch whose declaration is not published here yet',
      model: found(page({ declaration: null, missing: 'NOT_PUBLISHED', instructions: { files: [], care: page().instructions.care }, versions: [] })),
    },
    {
      id: 'not-ppe',
      label: 'Not personal protective equipment: no declaration needed',
      model: found(page({ ppe: { category: 'NOT_PPE', standard: null, ppeClass: null, certificateRequired: false }, declaration: null, missing: 'NOT_PPE', certificate: null, instructions: { files: [], care: page().instructions.care }, versions: [] })),
    },
    {
      id: 'first-version',
      label: 'The first declaration: no earlier version, no user information yet',
      model: found(page({ versions: [], instructions: { files: [], care: [] } })),
    },
    {
      id: 'two-products',
      label: 'Two records share this code (rare): pick the product on the label',
      model: found(page({ others: [{ n: 1, style: { code: 'DEMO-PNT-04', name: 'Pantalone Demo' }, batch: 'BA-26-0399' }] })),
    },
    { id: 'pdf-loading', label: 'The declaration’s PDF is being read', model: found(page(), { pdf: { fileId: fid(31), state: 'loading', data: null } }) },
    { id: 'pdf-failed', label: 'The PDF did not open: in words, with Try again (Download still works)', model: found(page(), { pdf: { fileId: fid(31), state: 'failed', data: null } }) },
    { id: 'loading', label: 'Loading: the shape of the content', model: { ...lookup(), kind: 'loading' } },
    { id: 'loading-slow', label: 'Still loading after a second', model: { ...lookup(), kind: 'loading', slow: true } },
    { id: 'error', label: 'The server did not answer (or the device is offline): in words, with Try again', model: { ...lookup(), kind: 'error' } },
    { id: 'lookup', label: 'Type the code (/doc): the QR is damaged', model: lookup() },
    { id: 'lookup-format', label: 'Type the code: not 8 letters and digits (refused before sending)', model: lookup({ text: '7K3Q-M2', problem: 'format' }) },
    { id: 'lookup-unknown', label: 'Unknown code: “We could not find this code. Check it on the label.”', model: lookup({ text: '7K3Q-M2XB', problem: 'unknown' }) },
    { id: 'lookup-wait', label: 'Too many requests: the button held, “Wait 4 minutes before asking again”', model: lookup({ text: '7K3Q-M2XB', wait: { unit: 'minutes', count: 4 } }) },
    { id: 'lookup-checking', label: 'Many requests from the network: a short check runs on the device', model: lookup({ text: '7K3Q-M2XA', busy: true, checking: true }) },
    { id: 'lookup-check-failed', label: 'The device check did not finish', model: lookup({ text: '7K3Q-M2XA', problem: 'checkFailed' }) },
  ],
})
