import { samplePdf } from '../../areas/_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../lib/design/design-screen'
import type { LinkDocument, LinkDocuments } from './api'
import type { DocumentLinkViewModel } from './model'
import { DocumentLinkView } from './view/DocumentLinkView'

/**
 * SCR-101 The shipment's documents by link (DOCUMENT_VIEW on a Shipment; design links.document, W1) — made-up data only
 * (PLAN §3.1): an invented shipment SH-26-0042 of a made-up style "DEMO-JKT-01 Giacca Demo" at revision 3, its DDT
 * 2026/0153, the Declaration of Conformity in Italian and English, the user information in English only (the buyer's
 * language is Italian: the fallback travels and the page says "available in English only"). Phone first (390): open
 * a case with `?width=phone`. Each case is one state the customer can meet.
 */

const DDT_PDF = samplePdf(['Documento di trasporto 2026/0153', 'Officina Demo S.r.l.', 'Destinatario: Cliente Demo S.r.l.', 'Colli 2 · Peso lordo 7,40 kg'])
const DOC_PDF = samplePdf(['Dichiarazione UE di conformita', 'DEMO-JKT-01 Giacca Demo · revisione 3', 'Regolamento (UE) 2016/425', 'EN 17092-4:2020 classe A'])

const uid = (n: number) => `0190f0e2-7101-7000-8000-${String(n).padStart(12, '0')}`

const document = (n: number, over: Partial<LinkDocument>): LinkDocument => ({
  fileId: uid(n),
  kind: 'OTHER',
  title: 'Document',
  style: null,
  language: null,
  number: null,
  date: null,
  originalName: `document-${n}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 48_213,
  sha256: `${n}`.padStart(64, '0'),
  availableAt: '2026-11-12T15:05:00.000Z',
  ...over,
})

const STYLE = { code: 'DEMO-JKT-01', name: 'Giacca Demo', revision: 3 }
const DDT = document(1, { kind: 'DDT', title: 'DDT 2026/0153', number: '2026/0153', date: '2026-11-12', originalName: 'DDT 2026-0153.pdf' })
const DOC_IT = document(2, { kind: 'DECLARATION_OF_CONFORMITY', title: 'EU Declaration of Conformity, DEMO-JKT-01 revision 3 (it)', style: STYLE, language: 'it', originalName: 'Dichiarazione UE di conformita DEMO-JKT-01 rev. 3 (it).pdf' })
const DOC_EN = document(3, { kind: 'DECLARATION_OF_CONFORMITY', title: 'EU Declaration of Conformity, DEMO-JKT-01 revision 3 (en)', style: STYLE, language: 'en', originalName: 'EU Declaration of Conformity DEMO-JKT-01 rev. 3 (en).pdf' })
const INFO_EN = document(4, { kind: 'USER_INFORMATION', title: 'User information, DEMO-JKT-01 revision 3 (en)', style: STYLE, language: 'en', originalName: 'User information DEMO-JKT-01 rev. 3 (en).pdf' })

const linkDocuments = (over: Partial<LinkDocuments> = {}): LinkDocuments => ({
  shipment: { number: 'SH-26-0042', status: 'SHIPPED', shippedAt: '2026-11-12T15:05:00.000Z', deliveredAt: null },
  link: { expiresAt: '2027-11-12T15:05:00.000Z', usesLeft: 98 },
  documents: [DDT, DOC_IT, DOC_EN, INFO_EN],
  ...over,
})

const base = (over: Partial<DocumentLinkViewModel> = {}): DocumentLinkViewModel => ({
  link: 'valid',
  documents: linkDocuments(),
  chosen: DDT.fileId,
  pdf: { fileId: DDT.fileId, state: 'ready', data: DDT_PDF },
  slow: false,
  ask: 'idle',
  ...over,
})

const docChosen = (over: Partial<DocumentLinkViewModel> = {}) => base({ chosen: DOC_IT.fileId, pdf: { fileId: DOC_IT.fileId, state: 'ready', data: DOC_PDF }, ...over })

export const designScreen = defineDesignScreen<DocumentLinkViewModel>({
  screen: 'SCR-101',
  title: 'The shipment’s documents (link): DDT, Declaration of Conformity, user information',
  view: DocumentLinkView,
  cases: [
    {
      id: 'documents',
      label: 'Three documents: the DDT read in the page, the DoC in Italian and English, the user information in English only',
      model: base(),
      note: 'The customer’s page from the documents mail (DOCUMENT_VIEW of the shipment). Phone first: ?width=phone. Reading a document is its logged download.',
    },
    { id: 'doc-chosen', label: 'The Declaration of Conformity chosen: Italian, also in English', model: docChosen() },
    { id: 'doc-english', label: 'The Declaration of Conformity in English (the other language picked)', model: base({ chosen: DOC_EN.fileId, pdf: { fileId: DOC_EN.fileId, state: 'ready', data: DOC_PDF } }) },
    { id: 'info-fallback', label: 'The user information: available in English only (the buyer reads Italian)', model: base({ chosen: INFO_EN.fileId, pdf: { fileId: INFO_EN.fileId, state: 'ready', data: DOC_PDF } }) },
    { id: 'one-document', label: 'One document only (the DDT)', model: base({ documents: linkDocuments({ documents: [DDT] }) }) },
    { id: 'delivered', label: 'Delivered: the shipment says when', model: base({ documents: linkDocuments({ shipment: { number: 'SH-26-0042', status: 'DELIVERED', shippedAt: '2026-11-12T15:05:00.000Z', deliveredAt: '2026-11-14T09:40:00.000Z' } }) }) },
    { id: 'pdf-reading', label: 'The chosen document is being read (opening the PDF)', model: docChosen({ pdf: { fileId: DOC_IT.fileId, state: 'loading', data: null } }) },
    { id: 'pdf-failed', label: 'The PDF could not be read: in words, with Try again', model: docChosen({ pdf: { fileId: DOC_IT.fileId, state: 'failed', data: null } }) },
    { id: 'last-open', label: 'The last open: 1 open left (the pill warns)', model: base({ documents: linkDocuments({ link: { expiresAt: '2026-11-30T17:00:00.000Z', usesLeft: 1 } }) }) },
    { id: 'none-shared', label: 'No document shared on the link yet', model: base({ documents: linkDocuments({ documents: [] }), chosen: null, pdf: null }) },
    { id: 'expired', label: 'Expired while the page was open: Ask for a new link', model: base({ link: 'expired', expiredAt: '2026-11-30T17:00:00.000Z', pdf: null }) },
    { id: 'expired-asked', label: 'Expired · a new link asked (one answer, whatever the link was)', model: base({ link: 'expired', expiredAt: '2026-11-30T17:00:00.000Z', pdf: null, ask: 'done' }) },
    { id: 'withdrawn', label: 'Withdrawn or used up meanwhile (the one 404): Ask for a new link', model: base({ link: 'unavailable', documents: null, pdf: null }) },
    { id: 'withdrawn-asked', label: 'Withdrawn · a new link asked', model: base({ link: 'unavailable', documents: null, pdf: null, ask: 'done' }) },
    { id: 'ask-failed', label: 'Asking did not reach us (no network): Ask again', model: base({ link: 'unavailable', documents: null, pdf: null, ask: 'failed' }) },
    { id: 'loading', label: 'Loading: the shape of the content', model: base({ link: 'loading', documents: null, pdf: null }) },
    { id: 'loading-slow', label: 'Still loading after a second', model: base({ link: 'loading', documents: null, pdf: null, slow: true }) },
    { id: 'error', label: 'The documents could not be read: in words, with Try again (never drawn as empty)', model: base({ link: 'error', documents: null, pdf: null }) },
  ],
})
