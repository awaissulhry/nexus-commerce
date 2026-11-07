import { samplePdf } from '../../../../_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { ProofVersion, QuoteProof, QuoteProofs } from './api'
import type { ProofsPanelModel } from './model'
import { ProofsPanel } from './view/ProofsPanel'

/**
 * SCR-035-proofs — the quote record's Documents › Proofs (B-W2b-165; SAL-199) — made-up data only: an invented artwork
 * proof (a PDF in its second version), a size chart and a placement sketch (pictures drawn here as SVG), invented people and
 * fingerprints. Each case is one state the office meets: a draft with proofs, an empty draft, an upload running, a proof
 * being checked or refused, a new version of a sent quote with the earlier proofs to carry over, a sent version (frozen),
 * an accepted one with what the acceptance named, a role that may not change them, a full version, the removal's
 * question, the viewer on a picture and on a PDF, loading, an error, a refused file.
 */

const svg = (body: string): string => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="#f4f1ea"/>${body}</svg>`)}`
const CHART = svg('<g font-family="sans-serif" font-size="14" fill="#333"><text x="20" y="34" font-weight="bold">Tabella taglie demo</text><text x="20" y="70">50 · torace 100 · manica 62</text><text x="20" y="96">52 · torace 104 · manica 63</text></g>')
const SKETCH = svg('<path d="M110 40 L210 40 L250 90 L230 200 L90 200 L70 90 Z" fill="none" stroke="#333" stroke-width="3"/><circle cx="185" cy="95" r="16" fill="#b22"/>')
const ARTWORK = samplePdf(['Prova grafica demo v2', 'Logo ricamato sul petto, 6 cm'])

const id = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`
const V1 = id(901)
const V2 = id(902)

function proof(n: number, extra: Partial<QuoteProof> = {}): QuoteProof {
  return {
    fileId: id(n),
    seriesId: id(n),
    name: `Proof ${n}.pdf`,
    contentType: 'application/pdf',
    shape: 'PDF',
    sizeBytes: 184_320,
    sha256: `${String(n).padStart(4, '0')}c5a7321a455e5a139aaac77b30a8add3b0ba0b56f6f822892af999c5a78243`.slice(0, 64),
    versionNo: 1,
    state: 'READY',
    currentFileId: id(n),
    sharedWithCustomer: false,
    sourceFileId: null,
    addedAt: '2026-11-03T09:12:00.000Z',
    addedBy: 'Sara Esempio',
    ...extra,
  }
}

const ARTWORK_PROOF = proof(1, { fileId: id(11), name: 'Prova grafica logo.pdf', versionNo: 2, currentFileId: id(11), seriesId: id(1) })
const CHART_PROOF = proof(2, { name: 'Tabella taglie.png', contentType: 'image/png', shape: 'PICTURE', sizeBytes: 96_412 })
const SKETCH_PROOF = proof(3, { name: 'Posizione logo.jpg', contentType: 'image/jpeg', shape: 'PICTURE', sizeBytes: 1_311_744, addedBy: 'Marco Demo' })

const version = (extra: Partial<ProofVersion> = {}): ProofVersion => ({ versionId: V1, revision: 1, status: 'DRAFT', current: true, sentAt: null, frozen: null, proofs: [ARTWORK_PROOF, CHART_PROOF, SKETCH_PROOF], accepted: null, ...extra })

function data(extra: Partial<QuoteProofs> = {}): QuoteProofs {
  return { quoteId: id(1000), versions: [version()], may: { change: true, held: null }, carry: null, limits: { max: 12, contentTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] }, at: '2026-11-03T10:00:00.000Z', ...extra }
}

function model(extra: Partial<ProofsPanelModel> = {}): ProofsPanelModel {
  return { state: 'ready', data: data(), busy: null, problem: null, notice: null, open: null, shown: { [id(11)]: { src: ARTWORK, problem: false }, [id(2)]: { src: CHART, problem: false }, [id(3)]: { src: SKETCH, problem: false } }, confirmRemove: null, ...extra }
}

const FROZEN = 'Version 1 was sent: its proofs went with it and are frozen. Make a new version to change them.'
const shared = (entry: QuoteProof): QuoteProof => ({ ...entry, sharedWithCustomer: true })
const SENT = version({ status: 'SENT', sentAt: '2026-11-03T11:00:00.000Z', frozen: FROZEN, proofs: [ARTWORK_PROOF, CHART_PROOF, SKETCH_PROOF].map(shared) })
const ACCEPTED = version({
  status: 'ACCEPTED',
  sentAt: '2026-11-03T11:00:00.000Z',
  frozen: 'Version 1 is accepted: its proofs are frozen with it.',
  proofs: [ARTWORK_PROOF, CHART_PROOF, SKETCH_PROOF].map(shared),
  accepted: {
    acceptanceId: id(950),
    signerName: 'Anna Esempio',
    acceptedAt: '2026-11-04T16:20:00.000Z',
    proofs: [ARTWORK_PROOF, CHART_PROOF, SKETCH_PROOF].map((entry) => ({ fileId: entry.currentFileId!, name: entry.name, sha256: entry.sha256, versionNo: entry.versionNo, sizeBytes: entry.sizeBytes, contentType: entry.contentType })),
  },
})
const MANY = Array.from({ length: 12 }, (_, n) => proof(100 + n, { name: `Scheda misure ${n + 1}.pdf` }))

export const designScreen = defineDesignScreen<ProofsPanelModel>({
  screen: 'SCR-035-proofs',
  title: 'Quote record · Documents › Proofs (accepted with the quote)',
  view: ProofsPanel,
  cases: [
    { id: 'draft', label: 'Draft · three proofs ready', model: model(), note: 'Add by drop or choice; each proof: Open, New version, Remove; not shared until the quote is sent.' },
    { id: 'empty', label: 'Draft · no proofs yet', model: model({ data: data({ versions: [version({ proofs: [] })] }) }) },
    { id: 'uploading', label: 'An upload running', model: model({ busy: { name: 'Scheda misure.pdf', step: 'sending' }, data: data({ versions: [version({ proofs: [ARTWORK_PROOF, proof(4, { name: 'Scheda misure.pdf', state: 'UPLOADING', currentFileId: null })] })] }) }), note: 'New version and the drop zone are held while it runs.' },
    { id: 'checking-refused', label: 'A proof being checked, one refused', model: model({ data: data({ versions: [version({ proofs: [ARTWORK_PROOF, proof(5, { name: 'Posizione.jpg', shape: 'PICTURE', contentType: 'image/jpeg', state: 'CHECKING', currentFileId: null }), proof(6, { name: 'Tabella.pdf', state: 'REFUSED', currentFileId: null })] })] }) }), note: 'The send is held until they are ready or removed (PROOF_NOT_READY).' },
    {
      id: 'carry',
      label: 'Version 2 · carry over the proofs of version 1',
      model: model({ data: data({ versions: [version({ versionId: V2, revision: 2, proofs: [] }), { ...SENT, current: false, status: 'SUPERSEDED', frozen: 'Version 1 is superseded: its proofs are frozen with it.' }], carry: { fromVersionId: V1, revision: 1, count: 3 } }) }),
      note: 'A new version starts without proofs; one click copies the earlier ones (each names its source).',
    },
    { id: 'sent', label: 'Sent · frozen with the version', model: model({ data: data({ versions: [SENT], may: { change: false, held: FROZEN } }) }), note: 'Shared with the customer, kept with the quote PDF; only Open.' },
    { id: 'accepted', label: 'Accepted · what the acceptance named', model: model({ data: data({ versions: [ACCEPTED], may: { change: false, held: FROZEN } }) }), note: 'Each proof accepted: name, version, SHA-256, size.' },
    { id: 'no-right', label: 'A role that may not change them', model: model({ data: data({ may: { change: false, held: 'Changing proofs needs quotes.manage for this customer.' } }) }) },
    { id: 'full', label: 'The version is full (12 proofs)', model: model({ data: data({ versions: [version({ proofs: MANY })] }) }), note: 'The drop zone says why it takes no more.' },
    { id: 'remove', label: 'Remove a proof · the question', model: model({ confirmRemove: CHART_PROOF.fileId }) },
    { id: 'viewer-picture', label: 'The viewer · a picture', model: model({ open: id(2) }), note: 'Previous / Next over the version’s proofs, ← →, Esc closes.' },
    { id: 'viewer-pdf', label: 'The viewer · the artwork PDF', model: model({ open: id(11) }), note: 'Previous held at the first proof, with the reason.' },
    { id: 'viewer-problem', label: "The viewer · a proof that can't be read", model: model({ open: id(3), shown: { [id(3)]: { src: null, problem: true } } }) },
    { id: 'refused-file', label: 'A file that is not a proof', model: model({ problem: { key: 'office.upload.type', params: { name: 'phone.heic' } } }) },
    { id: 'loading', label: 'Loading', model: model({ state: 'loading', data: null }) },
    { id: 'error', label: 'Error', model: model({ state: 'error', data: null }) },
  ],
})
