import { demoPdf } from '../../../shell/design-data'
import { BRAND_ALPHA } from '../../testing/two-brands'
import type { FilesParty, ThreadFile } from './model'

/**
 * Made-up files for the thread's design cases (SCR-006-thread, SCR-039, the print view): Brand Alpha's SO-2026-0142, its party and
 * small made-up pictures. tw- W2.1: the files line and its design screen went (the head's Files icon opens the Files window).
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

const SOURCES: Readonly<Record<string, string | Uint8Array>> = {
  [id(9)]: picture('AX-100 front v3 (made up)', '#b9c0ca'),
  [id(7)]: picture('Collar detail (made up)', '#c3c9d2'),
  [id(2)]: demoPdf(['Tech pack AX-100 (made up)', 'Collar: yellow piping']),
  [id(4)]: demoPdf(['Declaration of conformity (made up)', 'EN 17092-3']),
}

/** B-TH-300: the files the docked thread's design cases (SCR-006-thread, SCR-039) show, their party and made-up sources. */
export const DEMO_FILES: readonly ThreadFile[] = FILES
export const DEMO_FILES_PARTY: FilesParty = PARTY
export const DEMO_FILE_SOURCES: Readonly<Record<string, string | Uint8Array>> = SOURCES
