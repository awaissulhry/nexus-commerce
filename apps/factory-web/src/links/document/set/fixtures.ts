import { samplePdf } from '../../../areas/_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { LinkRenew, RenewState } from '../../../shell/links/renew/model'
import { emptyModel, type FilePage, type PageFile } from '../../file/model'
import { FileLinkView, type FileLinkDesignModel } from '../../file/view/FileLinkView'

/**
 * SCR-101-set — a share of several documents by link (design links.document W2b: sec:set, sec:password, sec:newer;
 * COL-051; B-W2b-169) — made-up data only: "Officina Demo" shares with a made-up customer the Declaration of
 * Conformity of DEMO-JKT-01 (version 3, replaced by version 4 — on this link too), the care leaflet, a photo of the
 * label and a ZIP of drawings, by a DOCUMENT_VIEW link of files (each open counts, downloads are logged only). The page
 * is links/file's (one page for every set of files); the shipment's documents stay SCR-101.
 */

const SENDER = 'Officina Demo'
const NOW = '2026-11-09T09:45:00.000Z'
const uid = (n: number) => `0190f0e2-7101-7169-8000-${String(n).padStart(12, '0')}`
const sha = (n: number) => `${n}`.padStart(4, '0') + 'a9c1e77b04d5e6a8c3b2f1e0d9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a3f2e1d0'

const DOC_PDF = samplePdf(['Dichiarazione UE di conformita (versione 3)', 'DEMO-JKT-01 Giacca Demo', 'Regolamento (UE) 2016/425', 'EN 17092-4:2020 classe A'])
const LABEL_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#f4efe8"/><rect x="40" y="40" width="400" height="220" rx="12" fill="#ffffff" stroke="#3b1a08" stroke-width="4"/><text x="70" y="110" font-family="Helvetica" font-size="28" font-weight="700" fill="#3b1a08">DEMO-JKT-01</text><text x="70" y="160" font-family="Helvetica" font-size="20" fill="#3b1a08">EN 17092-4 · AA</text><text x="70" y="200" font-family="Helvetica" font-size="18" fill="#3b1a08">Taglia 50</text></svg>',
)

const file = (n: number, over: Partial<PageFile> = {}): PageFile => ({
  id: uid(n),
  position: n,
  name: `document-${n}.pdf`,
  sizeBytes: 182_311,
  sha256: sha(n),
  contentType: 'application/pdf',
  preview: true,
  available: true,
  newer: null,
  payrollKind: null,
  ...over,
})

const DOC_V3 = file(1, { name: 'Dichiarazione di conformita DEMO-JKT-01 v3.pdf', newer: { versionNo: 4, replacedAt: '2026-11-12T10:00:00.000Z', sharedFileId: uid(2) } })
const DOC_V4 = file(2, { name: 'Dichiarazione di conformita DEMO-JKT-01 v4.pdf' })
const LEAFLET = file(3, { name: 'Nota informativa DEMO-JKT-01.pdf', sizeBytes: 611_002 })
const LABEL = file(4, { name: 'Etichetta DEMO-JKT-01.svg', sizeBytes: 2_310, contentType: 'image/svg+xml' })
const DRAWINGS = file(5, { name: 'Disegni DEMO-JKT-01.zip', sizeBytes: 5_812_004, contentType: 'application/zip', preview: false })

const shared = (over: Partial<FilePage> = {}): FilePage => ({
  kind: 'shared',
  sender: SENDER,
  expiresAt: '2026-12-09T17:00:00.000Z',
  usesLeft: 18,
  password: { asked: false, unlocked: false, heldUntil: null },
  receipt: { asked: false, at: null, name: null },
  count: 5,
  files: [DOC_V3, DOC_V4, LEAFLET, LABEL, DRAWINGS],
  payroll: null,
  ...over,
})

const renew = (state: RenewState = 'idle'): LinkRenew => ({ state, waitUntil: null, ask: () => undefined })
const model = (over: Partial<FileLinkDesignModel> = {}): FileLinkDesignModel => ({ ...emptyModel(), link: 'valid', page: shared(), now: NOW, renew: renew(), ...over })

export const designScreen = defineDesignScreen<FileLinkDesignModel>({
  screen: 'SCR-101-set',
  title: 'Shared documents (link): several files, a password, a newer version',
  view: FileLinkView,
  cases: [
    {
      id: 'set',
      label: 'Five documents: version 3 replaced by version 4 (on this link too), read in the page or download',
      model: model(),
      note: 'DOCUMENT_VIEW of files (POST /links/files): 18 opens left; downloads are logged, never counted.',
    },
    { id: 'reading-pdf', label: 'The leaflet read in the page (PDF viewer)', model: model({ preview: { fileId: LEAFLET.id, state: 'ready', data: DOC_PDF, contentType: 'application/pdf' } }) },
    { id: 'reading-picture', label: 'The label photo read in the page', model: model({ preview: { fileId: LABEL.id, state: 'ready', data: LABEL_SVG, contentType: 'image/svg+xml' } }) },
    { id: 'reading', label: 'Opening a document in the page', model: model({ preview: { fileId: LEAFLET.id, state: 'loading', data: null, contentType: 'application/pdf' } }) },
    { id: 'reading-failed', label: 'The document could not be shown: Try again or download', model: model({ preview: { fileId: LEAFLET.id, state: 'failed', data: null, contentType: 'application/pdf' } }) },
    { id: 'go-to-newer', label: '“Go to version 4” pressed: its row takes the focus', model: model({ focus: DOC_V4.id }) },
    {
      id: 'newer-ask',
      label: 'A newer version not on this link: ask the sender for it',
      model: model({ page: shared({ count: 2, files: [{ ...DOC_V3, newer: { versionNo: 4, replacedAt: '2026-11-12T10:00:00.000Z', sharedFileId: null } }, LEAFLET] }) }),
    },
    { id: 'newer-no-number', label: 'Replaced, the version number unknown', model: model({ page: shared({ count: 1, files: [{ ...DOC_V3, newer: { versionNo: null, replacedAt: '2026-11-12T10:00:00.000Z', sharedFileId: null } }] }) }) },
    { id: 'password', label: 'A password guards the share (sent apart)', model: model({ page: shared({ password: { asked: true, unlocked: false, heldUntil: null }, files: [] }) }) },
    { id: 'password-wrong', label: 'Wrong password: 4 tries left', model: model({ page: shared({ password: { asked: true, unlocked: false, heldUntil: null }, files: [] }), password: { value: 'wrong-guess', shown: false, busy: false, problem: { kind: 'wrong', triesLeft: 4 } } }) },
    { id: 'downloaded', label: 'Two downloaded (logged, no use counted)', model: model({ downloads: { [LEAFLET.id]: 'done', [DRAWINGS.id]: 'done' } }) },
    { id: 'one-document', label: 'One document (a single file shared by link)', model: model({ page: shared({ count: 1, files: [LEAFLET] }) }) },
    { id: 'file-gone', label: 'A document no longer available', model: model({ page: shared({ files: [DOC_V3, DOC_V4, { ...LEAFLET, available: false }, LABEL, DRAWINGS] }) }) },
    { id: 'none-left', label: 'Nothing to download any more', model: model({ page: shared({ count: 0, files: [] }) }) },
    { id: 'last-open', label: 'The last open: 1 open left', model: model({ page: shared({ usesLeft: 1 }) }) },
    { id: 'expired', label: 'Expired while open: Ask for a new link', model: model({ link: 'expired', expiredAt: '2026-12-09T17:00:00.000Z' }) },
    { id: 'unavailable', label: 'Withdrawn or used up (the one 404): Ask for a new link', model: model({ link: 'unavailable', page: null }) },
    { id: 'loading', label: 'Loading', model: model({ link: 'loading', page: null }) },
    { id: 'error', label: 'The documents could not be read: Try again', model: model({ link: 'error', page: null }) },
  ],
})
