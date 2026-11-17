import { defineDesignScreen } from '../../design/design-screen'
import { demoPdf } from '../../../shell/design-data'
import { BRAND_ALPHA } from '../../testing/two-brands'
import type { ThreadFile } from '../files/model'
import type { FilesViewModel } from './view/FilesView'
import { FilesViewCase, type FilesViewCaseModel } from './view/FilesViewCase'

/**
 * SCR-006-filesview — the Files view (B-TH-299, threads plan T9; picture 9, drawn to the approved pictures' look): one
 * record's files in a centred window — groups, versions, multi-select and the counted bulk bar, "Missing before Shipped",
 * the upload asked once (kind, audience starting on Office), the read-only keep lines, and every state; a full-screen
 * sheet on a phone. Groups by origin wait for WALL-G13 (B-TH-029): one case shows them as they will look. Made-up data only.
 */

const id = (n: number) => `0190f0e2-8000-7000-8000-${String(n).padStart(12, '0')}`
const ORDER = id(1)
const PARTY = { id: id(2), role: 'customer' as const, name: BRAND_ALPHA.tradeName }
const NOW = Date.UTC(2026, 10, 17, 10, 42)
const picture = (label: string, shade: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="${shade}"/><path d="M240 100h160l60 80-40 30-20-16v200H240V194l-20 16-40-30z" fill="#5b6573"/><text x="320" y="452" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#ffffff">${label}</text></svg>`)}`

function file(n: number, over: Partial<ThreadFile>): ThreadFile {
  return {
    id: id(n),
    recordType: 'SalesOrder',
    recordId: ORDER,
    name: `File ${n}.pdf`,
    contentType: 'application/pdf',
    kind: 'DOCUMENT',
    sizeBytes: 320_000,
    status: 'AVAILABLE',
    quarantineReason: null,
    visibility: ['OFFICE'],
    partyId: null,
    createdAt: `2026-11-${String(2 + n).padStart(2, '0')}T09:00:00.000Z`,
    retainUntil: null,
    previewUrl: null,
    ...over,
  }
}

const FRONT_V1 = file(1, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 2_100_000, versionNo: 1, supersededAt: '2026-11-08T09:00:00.000Z', previewUrl: picture('front v1', '#d3d7de') })
const FILES: ThreadFile[] = [
  FRONT_V1,
  file(2, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 2_200_000, versionNo: 2, seriesId: FRONT_V1.id, supersededAt: '2026-11-14T09:00:00.000Z', previewUrl: picture('front v2', '#c9ced6') }),
  file(12, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 2_300_000, versionNo: 3, seriesId: FRONT_V1.id, visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id, previewUrl: picture('front v3', '#b9c0ca'), origin: 'ours' }),
  file(3, { name: 'Collar detail.jpg', contentType: 'image/jpeg', kind: 'PHOTO', sizeBytes: 1_800_000, visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id, previewUrl: picture('collar', '#c3c9d2'), origin: 'party' }),
  file(4, { name: 'Lining photo.jpg', contentType: 'image/jpeg', kind: 'PHOTO', status: 'QUARANTINED', quarantineReason: 'scan_pending', origin: 'party' }),
  file(5, { name: BRAND_ALPHA.fileName, visibility: ['OFFICE', 'PARTNER', 'FLOOR'], partyId: PARTY.id, origin: 'party' }),
  file(6, { name: 'Cutting plan AX-100.pdf', visibility: ['OFFICE', 'FLOOR'], origin: 'floor' }),
  file(7, { name: 'Declaration of conformity.pdf', kind: 'CERTIFICATE', legalHold: true, visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: PARTY.id, origin: 'made' }),
  file(8, { name: 'Invoice FT-2026-0101.xml', contentType: 'application/xml', kind: 'FISCAL_ARCHIVE', retainUntil: '2036-12-31T23:00:00.000Z', origin: 'made' }),
  file(9, { name: 'Size chart AX-100.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'ATTACHMENT', sizeBytes: 64_000, retainUntil: '2026-11-01T00:00:00.000Z', origin: 'ours' }),
  // Another record's file (a tab with its own file API): never listed here.
  file(10, { name: 'Work order sheet.pdf', recordType: 'WorkOrder', recordId: id(77), origin: 'ours' }),
]
const WITHOUT_ORIGIN = FILES.map(({ origin: _origin, ...rest }) => rest)

const SOURCES: FilesViewCaseModel['sources'] = {
  [id(12)]: picture('AX-100 front v3 (made up)', '#b9c0ca'),
  [id(2)]: picture('AX-100 front v2 (made up)', '#c9ced6'),
  [id(1)]: picture('AX-100 front v1 (made up)', '#d3d7de'),
  [id(3)]: picture('Collar detail (made up)', '#c3c9d2'),
  [id(5)]: demoPdf(['Tech pack AX-100 (made up)', 'Collar: yellow piping']),
  [id(7)]: demoPdf(['Declaration of conformity (made up)', 'EN 17092-3']),
}

const view = (over: Partial<FilesViewModel> = {}): FilesViewModel => ({
  record: { type: 'SalesOrder', id: ORDER, label: 'SO-2026-0142' },
  party: PARTY,
  files: WITHOUT_ORIGIN,
  problem: null,
  can: { upload: true, share: true, delete: true },
  uploadHeld: null,
  selected: [],
  refused: [],
  missing: [],
  upload: null,
  now: NOW,
  ...over,
})
const c = (over: Partial<FilesViewModel> = {}): FilesViewCaseModel => ({ view: view(over), sources: SOURCES })

export const designScreen = defineDesignScreen<FilesViewCaseModel>({
  screen: 'SCR-006-filesview',
  title: 'Files view of one record (B-TH-299)',
  view: FilesViewCase,
  cases: [
    { id: 'files', label: 'All files of the order, by kind', model: c({ missing: [{ id: 'm1', document: 'Declaration of conformity (signed)', before: 'Shipped', level: 'WARN' }] }), note: 'Grouped by the system’s kinds until the API says each file’s origin (WALL-G13). The sample photo shows v3 in force with two earlier versions (Open, Restore); the held photo, the legal hold and the retention lines are read only. The work order’s own file is not listed (R-1 to R-4). ↑ / ↓ move, x chooses, Enter opens the viewer.' },
    { id: 'chosen', label: 'Three chosen: the counted bulk bar', model: c({ selected: [id(12), id(7), id(9)] }), note: 'Download 3 · Share with Brand Alpha (1: the others are shared already) · Make office only (2) · Delete 2 — the declaration is under a legal hold, said in words.' },
    { id: 'by-origin', label: 'By origin (once WALL-G13 lands)', model: c({ files: FILES }), note: 'From the customer · Ours · Made by us · Floor — drawn when every file says where it came from.' },
    { id: 'upload-ask', label: 'Add 2 files: kind and audience', model: c({ upload: { files: [{ name: 'Fit photo 1.jpg', sizeBytes: 2_400_000 }, { name: 'Fit photo 2.jpg', sizeBytes: 2_100_000 }], kind: 'PHOTO', audience: 'OFFICE', kinds: ['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE'], audiences: ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'] } }), note: 'Asked once in the system’s words; the audience starts on Office; "Office and Brand Alpha" reaches only this record’s customer.' },
    { id: 'refused', label: 'A refused upload', model: c({ refused: [{ name: 'Design.ai', reason: 'This kind of file is not taken: PDF, pictures and Office files only.' }] }), note: 'The file’s name and the reason.' },
    { id: 'no-upload', label: 'No right to upload', model: c({ can: { upload: false, share: false, delete: false }, uploadHeld: null }), note: 'The upload is held with the reason; the bulk actions say the right they need.' },
    { id: 'block', label: 'A required document refuses the move', model: c({ missing: [{ id: 'm2', document: 'Test report EN 17092-3', before: 'Shipped', level: 'BLOCK' }] }) },
    { id: 'empty', label: 'No files yet', model: c({ files: [] }), note: 'An empty view never looks like an error: the drop area says what to do.' },
    { id: 'loading', label: 'Loading', model: c({ files: null }) },
    { id: 'error', label: 'Could not load', model: c({ problem: 'read', files: null }) },
    { id: 'forbidden', label: 'No permission', model: c({ problem: 'forbidden', files: null }) },
  ],
})
