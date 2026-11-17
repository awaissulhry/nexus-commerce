import { defineDesignScreen } from '../../design/design-screen'
import { demoPdf } from '../../../shell/design-data'
import { BRAND_ALPHA } from '../../testing/two-brands'
import type { FilesParty, PinLine, ThreadFile } from './model'
import { FileStripCase, type FileStripCaseModel } from './view/FileStripCase'

/**
 * SCR-006-filesline — the thread's files line (B-TH-210, threads plan T2; picture 8, drawn to the approved pictures' look):
 * "Files (7)" with the three newest as small pictures, the strip open (kind, version and audience marks, a held file) and
 * the line absent with no files. B-TH-286 (B-TH-091): "2 pinned" leads the line — its popover, one line per pin (an office note,
 * a message of files only, one removed after a privacy request), Unpin for whoever may write. Made-up data only (Brand Alpha,
 * SO-2026-0142).
 */

const id = (n: number) => `0190f0e2-7f00-7000-8000-${String(n).padStart(12, '0')}`
const ORDER = id(1)
const PARTY: FilesParty = { id: id(2), role: 'customer' }
const picture = (label: string, shade: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="${shade}"/><path d="M120 50h80l30 40-20 15-10-8v100h-80V97l-10 8-20-15z" fill="#5b6573"/><text x="160" y="226" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#ffffff">${label}</text></svg>`)}`

function file(n: number, over: Partial<ThreadFile>): ThreadFile {
  return {
    id: id(n),
    recordType: 'SalesOrder',
    recordId: ORDER,
    name: `File ${n}.pdf`,
    contentType: 'application/pdf',
    kind: 'DOCUMENT',
    sizeBytes: 200_000,
    status: 'AVAILABLE',
    quarantineReason: null,
    visibility: ['OFFICE'],
    partyId: null,
    createdAt: `2026-11-${String(2 + n).padStart(2, '0')}T09:00:00.000Z`,
    previewUrl: null,
    ...over,
  }
}

const FRONT_V1 = file(1, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', versionNo: 1, seriesId: null, supersededAt: '2026-11-12T09:00:00.000Z', previewUrl: picture('front v1', '#d3d7de') })
const FILES: ThreadFile[] = [
  FRONT_V1,
  file(2, { name: BRAND_ALPHA.fileName, visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id, messageId: id(900) }),
  file(3, { name: 'Size chart AX-100.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'ATTACHMENT', visibility: ['OFFICE', 'FLOOR'] }),
  file(4, { name: 'Declaration of conformity.pdf', kind: 'CERTIFICATE', visibility: ['OFFICE', 'PARTNER', 'LINK', 'FLOOR'], partyId: PARTY.id }),
  file(5, { name: 'Invoice FT-2026-0101.xml', contentType: 'application/xml', kind: 'FISCAL_ARCHIVE' }),
  file(6, { name: 'Lining photo.jpg', contentType: 'image/jpeg', kind: 'PHOTO', status: 'QUARANTINED', quarantineReason: 'scan_pending' }),
  file(7, { name: 'Collar detail.jpg', contentType: 'image/jpeg', kind: 'PHOTO', visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id, previewUrl: picture('collar', '#c3c9d2') }),
  file(9, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', versionNo: 3, seriesId: FRONT_V1.id, visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id, createdAt: '2026-11-16T09:00:00.000Z', previewUrl: picture('front v3', '#b9c0ca') }),
  file(8, { name: 'AX-100 sample front.jpg', contentType: 'image/jpeg', kind: 'PHOTO', versionNo: 2, seriesId: FRONT_V1.id, supersededAt: '2026-11-16T09:00:00.000Z', previewUrl: picture('front v2', '#c9ced6') }),
]

const SOURCES: FileStripCaseModel['sources'] = {
  [id(9)]: picture('AX-100 front v3 (made up)', '#b9c0ca'),
  [id(7)]: picture('Collar detail (made up)', '#c3c9d2'),
  [id(2)]: demoPdf(['Tech pack AX-100 (made up)', 'Collar: yellow piping']),
  [id(4)]: demoPdf(['Declaration of conformity (made up)', 'EN 17092-3']),
}

/** B-TH-300: the files the docked thread's design cases (SCR-006-thread, SCR-039) show, their party and made-up sources. */
export const DEMO_FILES: readonly ThreadFile[] = FILES
export const DEMO_FILES_PARTY: FilesParty = PARTY
export const DEMO_FILE_SOURCES: FileStripCaseModel['sources'] = SOURCES

// ---- B-TH-286: made-up pins (who wrote it, when, one line of its words; the office alone reads who pinned it).
const PINS: readonly PinLine[] = [
  { messageId: id(900), author: 'Dora Bianchi', excerpt: 'Collar in yellow piping, as on the sample we approved.', at: '2026-11-10T09:12:00.000Z', office: false, files: 1, removed: false, pinnedBy: 'Alex Demo', pinnedAt: '2026-11-10T09:40:00.000Z' },
  { messageId: id(901), author: 'Alex Demo', excerpt: 'Deposit agreed at 30 %; ship in two parts.', at: '2026-11-12T15:02:00.000Z', office: true, files: 0, removed: false, pinnedBy: 'Alex Demo', pinnedAt: '2026-11-12T15:05:00.000Z' },
]
const PIN_FILES_ONLY: PinLine = { messageId: id(902), author: 'Dora Bianchi', excerpt: '', at: '2026-11-13T08:30:00.000Z', office: false, files: 2, removed: false, pinnedBy: 'Alex Demo', pinnedAt: '2026-11-13T09:00:00.000Z' }
const PIN_REMOVED: PinLine = { messageId: id(903), author: null, excerpt: '', at: '2026-11-08T11:00:00.000Z', office: false, files: 0, removed: true, pinnedBy: 'Alex Demo', pinnedAt: '2026-11-08T11:30:00.000Z' }
// ---- end B-TH-286

const c = (over: Partial<FileStripCaseModel> = {}): FileStripCaseModel => ({
  files: FILES,
  party: PARTY,
  open: false,
  sources: SOURCES,
  frames: [519, 711, 375],
  record: { type: 'SalesOrder', id: ORDER, label: 'SO-2026-0142' },
  partyName: BRAND_ALPHA.tradeName,
  now: Date.UTC(2026, 10, 17, 10, 42),
  ...over,
})

export const designScreen = defineDesignScreen<FileStripCaseModel>({
  screen: 'SCR-006-filesline',
  title: 'Thread files line (B-TH-210)',
  view: FileStripCase,
  cases: [
    { id: 'line', label: 'Files (7) with the three newest', model: c(), note: 'One 36 px line; the count is the documents this reader can see (a photo and its two earlier versions are one). Click the chip for the strip.' },
    { id: 'strip-open', label: 'The strip open', model: c({ open: true }), note: '64 px tiles, newest first: v3 on the sample photo, two audience marks then "+N", the held photo with its lock; ← / → walk the tiles, Enter opens the one file viewer; "All files" ends the row and opens the Files view (T9).' },
    { id: 'no-previews', label: 'Before small previews (kind icons)', model: c({ open: true, files: FILES.map((one) => ({ ...one, previewUrl: null })) }), note: 'Until B-TH-063 makes a small preview, a file shows its kind’s icon — never the 15 MB original.' },
    { id: 'supplier', label: 'On a purchase order: “Supplier”', model: c({ open: true, party: { ...PARTY, role: 'supplier' } }), note: 'The party mark follows the record: Supplier.' },
    { id: 'other-party', label: 'A file shared with another party (office flag)', model: c({ open: true, files: [file(20, { name: 'Old share.pdf', visibility: ['OFFICE', 'PARTNER'], partyId: id(99) }), ...FILES.slice(1, 3)] }), note: 'B-TH-003 refuses this now; an older one is flagged "Another party" to the office, never named as this customer’s.' },
    { id: 'loading', label: 'Loading', model: c({ files: null }) },
    { id: 'none', label: 'No files: the line is absent', model: c({ files: [] }), note: 'Nothing empty takes a band (T2-F09).' },
    // ---- B-TH-286 (B-TH-091; T2-F07)
    { id: 'th9-286-pinned', label: '“2 pinned” and Files (7)', model: c({ pins: PINS, canUnpin: true }), note: 'The pins lead the line; the chip opens one line per pin — who wrote it, when, an office note marked — and Enter on a line goes to the message. Unpin for whoever may write here. A pin points at its message; it is never a copy.' },
    { id: 'th9-286-pins-only', label: 'Pins without files', model: c({ files: [], pins: [PINS[0]!], canUnpin: true }), note: 'A line with pins and no files still shows (T2-F09: only a line with neither is absent).' },
    { id: 'th9-286-pins-edge', label: 'A message of files only, one removed', model: c({ pins: [...PINS, PIN_FILES_ONLY, PIN_REMOVED], canUnpin: true }), note: '“2 files” for a message of files only; “Message removed after a privacy request” for one erased — it stays pinned as a pointer.' },
    { id: 'th9-286-pins-read', label: 'Pins for a reader who may not write', model: c({ pins: PINS, canUnpin: false }), note: 'The lines and the jump only: no Unpin.' },
  ],
})
