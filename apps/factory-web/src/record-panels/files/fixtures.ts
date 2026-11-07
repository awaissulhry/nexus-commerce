import { createElement } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_SITES } from '../../shell/design-data'
import type { PanelFile, RecordPanelsViewModel } from '../model'
import { RecordPanelsView } from '../view/RecordPanelsView'
import type { DocumentsState, FileDepthModel, MarkupItem, VersionRow } from './model'

/**
 * SCR-006-files — the record panels' Files tab in depth (B-W2b-177; design shell.panels › Files, pop:file-versions
 * "Versions of JK-210-pattern.pdf", sec:guards; COL-048, COL-049, COL-055, COL-046) with made-up data only: a demo
 * purchase order whose move to Confirmed waits for the supplier's certificate, documents with their expiry, the Versions
 * pop-up (who, when, size, which records use it, restore, side by side of two pictures), what a file is and until when,
 * markup of a picture and of a PDF page, and the states: reading, unreadable, no right (held with the reason).
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const fid = (n: number) => `0190f0e2-7a7a-7000-8000-${String(n).padStart(12, '0')}`
const RECORD = { type: 'PurchaseOrder', id: '0190f0e2-5555-7000-8000-000000000177', companyId: DEMO_COMPANIES[0].id, siteId: DEMO_SITES[0].id }

const file = (n: number, name: string, extra: Partial<PanelFile> = {}): PanelFile => ({
  id: fid(n),
  name,
  kind: 'DOCUMENT',
  contentType: 'application/pdf',
  sizeBytes: 182_000 + n * 7_300,
  status: 'AVAILABLE',
  visibility: ['OFFICE'],
  partyId: null,
  retainUntil: null,
  legalHold: false,
  quarantineReason: null,
  availableAt: at(20 + n, 10),
  createdAt: at(20 + n, 10),
  versionNo: 1,
  seriesId: null,
  supersededAt: null,
  version: 2,
  ...extra,
})

const PATTERN_V1 = file(1, 'JK-210-pattern.pdf', { supersededAt: at(24, 9) })
const PATTERN_V2 = file(2, 'JK-210-pattern.pdf', { versionNo: 2, seriesId: fid(1), availableAt: at(24, 9), createdAt: at(24, 9) })
const REACH = file(3, 'REACH declaration 2026.pdf', { visibility: ['OFFICE', 'PARTNER'], partyId: '0190f0e2-6666-7000-8000-000000000177' })
const TEST = file(4, 'Cr VI test report.pdf')
const PHOTO_V1 = file(5, 'sample front.jpg', { kind: 'PHOTO', contentType: 'image/jpeg', supersededAt: at(27, 15) })
const PHOTO_V2 = file(6, 'sample front (marked).jpg', { kind: 'PHOTO', contentType: 'image/jpeg', versionNo: 2, seriesId: fid(5), availableAt: at(27, 15), createdAt: at(27, 15) })
const SHEET = file(7, 'sizes.csv', { kind: 'ATTACHMENT', contentType: 'text/csv' })
const FILES = [PATTERN_V1, PATTERN_V2, REACH, TEST, PHOTO_V1, PHOTO_V2, SHEET]

const DOCUMENTS: DocumentsState = {
  today: '2026-10-29',
  recordStatus: 'SENT',
  byFile: {
    [REACH.id]: { fileId: REACH.id, name: REACH.name, category: 'DECLARATION', expiresOn: '2026-11-12', expiryState: 'EXPIRING', daysLeft: 14, ofParty: false },
    [TEST.id]: { fileId: TEST.id, name: TEST.name, category: 'TEST_REPORT', expiresOn: '2026-10-20', expiryState: 'EXPIRED', daysLeft: -9, ofParty: false },
    [PATTERN_V2.id]: { fileId: PATTERN_V2.id, name: PATTERN_V2.name, category: null, expiresOn: null, expiryState: 'NONE', daysLeft: null, ofParty: false },
    [PHOTO_V2.id]: { fileId: PHOTO_V2.id, name: PHOTO_V2.name, category: 'SAMPLE_PHOTO', expiresOn: null, expiryState: 'NONE', daysLeft: null, ofParty: false },
  },
  partyDocuments: [{ fileId: fid(9), name: 'LWG certificate 2025.pdf', category: 'SUPPLIER_CERTIFICATE', expiresOn: '2026-10-28', expiryState: 'EXPIRED', daysLeft: -1, ofParty: true }],
  moves: [
    {
      toStatus: 'CONFIRMED',
      requirements: [
        { ruleId: fid(31), category: 'SUPPLIER_CERTIFICATE', level: 'BLOCK', reason: 'EXPIRED', fileId: fid(9), expiresOn: '2026-10-28' },
        { ruleId: fid(32), category: 'DECLARATION', level: 'WARN', reason: 'MET', fileId: REACH.id, expiresOn: '2026-11-12' },
      ],
    },
    { toStatus: 'RECEIVED', requirements: [{ ruleId: fid(33), category: 'TEST_REPORT', level: 'WARN', reason: 'EXPIRED', fileId: TEST.id, expiresOn: '2026-10-20' }] },
  ],
  mayTag: true,
}

/** A made-up picture as an inline SVG (the DS takes `data:image/…`): a jacket's outline. */
const picture = (stroke: string, mark: boolean) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#eef1f5"/><path d="M220 80 L320 120 L420 80 L520 160 L470 210 L440 190 L440 420 L200 420 L200 190 L170 210 L120 160 Z" fill="#c9d3df" stroke="${stroke}" stroke-width="6"/>${mark ? '<circle cx="360" cy="300" r="48" fill="none" stroke="#c92a2a" stroke-width="6"/>' : ''}</svg>`,
  )}`
const PAGE = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#ffffff"/><text x="48" y="80" font-family="Arial" font-size="28">JK-210 pattern - page 2</text><path d="M120 200 L480 200 L520 600 L80 600 Z" fill="none" stroke="#333" stroke-width="3"/><path d="M140 240 L460 240" stroke="#333" stroke-dasharray="8 6"/></svg>')}`

const row = (n: number, extra: Partial<VersionRow>): VersionRow => ({
  id: fid(n),
  versionNo: 1,
  current: false,
  status: 'AVAILABLE',
  name: 'JK-210-pattern.pdf',
  sizeBytes: 182_000 + n * 7_300,
  addedAt: at(20 + n, 10),
  addedBy: 'Bea Esempio',
  fromPartner: false,
  madeByMarkup: null,
  usedBy: [],
  markups: 0,
  picture: false,
  restoreHeld: null,
  ...extra,
})
const PATTERN_ROWS: VersionRow[] = [
  row(2, { versionNo: 2, current: true, addedAt: at(24, 9), addedBy: 'Carlo Prova', usedBy: [{ label: 'WO-000098', typeKey: 'WorkOrder', href: '/w/DEMO/records/WorkOrder/0190f0e2-5555-7000-8000-000000000098' }], restoreHeld: 'versions.held.current' }),
  row(1, { markups: 2, usedBy: [{ label: null, typeKey: 'Shipment', href: '/w/DEMO/records/Shipment/0190f0e2-5555-7000-8000-000000000041' }] }),
]
const PHOTO_ROWS: VersionRow[] = [
  row(6, { versionNo: 2, current: true, name: 'sample front (marked).jpg', picture: true, madeByMarkup: { note: 'Loose thread at the pocket', marks: 1 }, restoreHeld: 'versions.held.current' }),
  row(5, { name: 'sample front.jpg', picture: true, markups: 1, addedBy: 'Tannery Example', fromPartner: true }),
]

const MARKUPS: MarkupItem[] = [
  { id: fid(41), page: 2, versionNo: 2, note: 'Move the stitch line 3 mm inwards', by: 'Carlo Prova', fromPartner: false, at: at(28, 11), marks: [{ kind: 'arrow', from: { x: 0.2, y: 0.2 }, to: { x: 0.4, y: 0.3 } }, { kind: 'circle', center: { x: 0.5, y: 0.62 }, radius: 0.08 }], madeVersion: false },
  { id: fid(42), page: 1, versionNo: 1, note: null, by: 'Tannery Example', fromPartner: true, at: at(22, 16), marks: [{ kind: 'circle', center: { x: 0.3, y: 0.4 }, radius: 0.1 }], madeVersion: false },
]

const depth = (over: Partial<FileDepthModel> = {}): FileDepthModel => ({ documents: { status: 'ready', value: DOCUMENTS }, canUpload: true, versions: null, tag: null, markup: null, notice: null, ...over })

const base = (over: Partial<FileDepthModel> = {}, model: Partial<RecordPanelsViewModel> = {}): RecordPanelsViewModel => ({
  record: RECORD,
  title: 'Ordine di acquisto PO-000177',
  party: { id: '0190f0e2-6666-7000-8000-000000000177', name: 'Conceria Esempio S.r.l.', emails: ['ordini@conceria-esempio.example.com'] },
  can: { post: true, email: true, manage: true, readFiles: true, upload: true, share: true },
  thread: null,
  messages: { items: [], more: false },
  files: { items: FILES, more: false },
  uploads: [],
  timeline: { items: [], more: false },
  timelineFilter: 'all',
  people: [],
  tab: 'files',
  depth: depth(over),
  ...model,
})

function FilesDepthDesign({ model }: { model: RecordPanelsViewModel }) {
  return createElement(RecordPanelsView, { model })
}

export const designScreen = defineDesignScreen<RecordPanelsViewModel>({
  screen: 'SCR-006-files',
  title: 'Record panels › Files in depth: required documents, expiry, versions, markup',
  view: FilesDepthDesign,
  cases: [
    {
      id: 'required',
      label: 'What the next moves need: Confirmed blocked by an expired supplier certificate, Received warned',
      model: base(),
      note: "The certificate counts from the supplier's own files. Each file says its kind and expiry; Versions, Mark up and What it is sit on each row.",
    },
    { id: 'all-met', label: 'Everything on file: no banner', model: base({ documents: { status: 'ready', value: { ...DOCUMENTS, moves: [], partyDocuments: [] } } }) },
    { id: 'documents-loading', label: 'Reading the documents: What it is waits with the reason', model: base({ documents: { status: 'loading' } }) },
    { id: 'documents-failed', label: "The record's documents could not be read", model: base({ documents: { status: 'failed', problem: 'depth.problem.unavailable' } }) },
    {
      id: 'no-right',
      label: 'Read only (files.read): Mark up and What it is held with the reason',
      model: base({ canUpload: false, documents: { status: 'ready', value: { ...DOCUMENTS, mayTag: false } } }, { can: { post: false, email: false, manage: false, readFiles: true, upload: false, share: false } }),
    },
    { id: 'versions-loading', label: 'Versions pop-up: reading', model: base({ versions: { fileId: PATTERN_V2.id, name: PATTERN_V2.name, read: { status: 'loading' }, picked: [], compare: null, busy: false, problem: null } }) },
    {
      id: 'versions',
      label: 'Versions of JK-210-pattern.pdf: who, when, size, which records use it, Restore',
      model: base({ versions: { fileId: PATTERN_V2.id, name: PATTERN_V2.name, read: { status: 'ready', value: PATTERN_ROWS }, picked: [], compare: null, busy: false, problem: null } }),
      note: 'Restore on the version in force is held with the reason; Side by side waits for two pictures.',
    },
    {
      id: 'versions-compare',
      label: 'Two pictures side by side (the marked version and the original)',
      model: base({
        versions: { fileId: PHOTO_V2.id, name: PHOTO_V2.name, read: { status: 'ready', value: PHOTO_ROWS }, picked: [fid(5), fid(6)], compare: { status: 'ready', value: [{ versionNo: 1, src: picture('#4a5568', false) }, { versionNo: 2, src: picture('#4a5568', true) }] }, busy: false, problem: null },
      }),
    },
    { id: 'versions-failed', label: 'Versions pop-up: could not be read', model: base({ versions: { fileId: PATTERN_V2.id, name: PATTERN_V2.name, read: { status: 'failed', problem: 'depth.problem.unavailable' }, picked: [], compare: null, busy: false, problem: null } }) },
    { id: 'tag', label: 'What it is and until when: a declaration valid until 12 Nov', model: base({ tag: { fileId: REACH.id, name: REACH.name, category: 'DECLARATION', expiresOn: '2026-11-12', busy: false, problem: null } }) },
    { id: 'tag-problem', label: 'What it is: a date the API would refuse', model: base({ tag: { fileId: TEST.id, name: TEST.name, category: 'TEST_REPORT', expiresOn: '2050-01-01', busy: false, problem: 'tag.problem.date' } }) },
    {
      id: 'markup-picture',
      label: 'Mark up a picture: arrows and circles, saved as the next version',
      model: base({ markup: { fileId: PHOTO_V2.id, name: PHOTO_V2.name, target: 'picture', page: 1, pages: null, image: { status: 'ready', value: { src: picture('#4a5568', false), width: 640, height: 480 } }, note: 'Loose thread at the pocket', markups: { status: 'ready', value: [] }, busy: false, problem: null } }),
    },
    {
      id: 'markup-pdf',
      label: 'Mark up a PDF page: an overlay, with the marks already on the page',
      model: base({ markup: { fileId: PATTERN_V2.id, name: PATTERN_V2.name, target: 'pdf', page: 2, pages: 4, image: { status: 'ready', value: { src: PAGE, width: 600, height: 800 } }, note: '', markups: { status: 'ready', value: MARKUPS }, busy: false, problem: null } }),
      note: 'The page is drawn in the browser from the PDF; the marks are kept beside it and drawn back over the page.',
    },
    { id: 'markup-loading', label: 'Mark up: drawing the page', model: base({ markup: { fileId: PATTERN_V2.id, name: PATTERN_V2.name, target: 'pdf', page: 1, pages: null, image: { status: 'loading' }, note: '', markups: { status: 'loading' }, busy: false, problem: null } }) },
    { id: 'markup-failed', label: 'Mark up: the picture could not be opened', model: base({ markup: { fileId: PHOTO_V2.id, name: PHOTO_V2.name, target: 'picture', page: 1, pages: null, image: { status: 'failed', problem: 'depth.problem.store' }, note: '', markups: { status: 'ready', value: [] }, busy: false, problem: null } }) },
    { id: 'saved', label: 'A marked picture saved: the notice', model: base({ notice: { key: 'depth.notice.marked', tone: 'success' } }) },
  ],
})
