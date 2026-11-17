import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import type { ComposerContext } from '../composer/model'
import { OFFICE_PEOPLE } from '../demo-data'
import type { DraftFile, RecordFile } from './model'
import { AttachCase, type AttachCaseModel } from './view/AttachCase'

/**
 * SCR-006-attach — files straight into the message (B-TH-206, T6; picture 4, approved 2026-11-17). Made-up data (the brand-wall
 * helpers' brands). Each case is a state of the picture: two files uploading and one failed (Send waits), refused files with
 * their reason, over the e-mail limit, "From this record", an office-only file in a reply, a reply ready, and Brand Beta's copy
 * (the brand wall: only Brand Beta's files in the picker). The measurement-sheet tick waits for N11 (B-TH-083).
 */

const ORDER: ComposerContext = { recordType: 'SalesOrder', recordLabel: BRAND_ALPHA.numbers.order, party: { name: BRAND_ALPHA.tradeName }, can: { post: true, email: true, manage: false }, people: OFFICE_PEOPLE }
const file = (key: string, name: string, sizeBytes: number, contentType: string, more: Partial<DraftFile> = {}): DraftFile => ({ key, name, sizeBytes, contentType, source: 'device', phase: 'done', audience: 'OFFICE', fileId: `id-${key}`, ...more })

const RECORD_FILES = (brand = BRAND_ALPHA): RecordFile[] => [
  { id: 'r1', name: 'label-sketch.jpg', sizeBytes: 820_000, contentType: 'image/jpeg', shared: true, available: true },
  { id: 'r2', name: 'sample-front.jpg', sizeBytes: 2_400_000, contentType: 'image/jpeg', shared: true, available: true },
  { id: 'r3', name: brand.fileName, sizeBytes: 240_000, contentType: 'application/pdf', shared: true, available: true },
  { id: 'r4', name: 'cost-sheet-v3.xlsx', sizeBytes: 96_000, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', shared: false, available: true },
  { id: 'r5', name: 'cutting-plan.pdf', sizeBytes: 410_000, contentType: 'application/pdf', shared: false, available: true },
]

const base: AttachCaseModel = { context: ORDER, draft: { mode: 'note', body: 'Back view and the size chart for cutting.', forFloor: false }, files: [], recordFiles: RECORD_FILES(), canUpload: true, canShare: true }

export const designScreen = defineDesignScreen<AttachCaseModel>({
  screen: 'SCR-006-attach',
  title: 'Record thread · files in the message (T6)',
  view: AttachCase,
  cases: [
    {
      id: 'uploading',
      label: 'Two files uploading',
      model: { ...base, files: [file('a', 'sample-back.jpg', 3_200_000, 'image/jpeg', { phase: 'uploading', progress: 42 }), file('b', 'size-chart-SS27.pdf', 420_000, 'application/pdf', { phase: 'uploading' }), file('c', 'zip-detail.jpg', 2_100_000, 'image/jpeg', { phase: 'failed', problem: { key: 'failed.store' } })] },
      note: 'Send waits: “Waiting for 2 files”. A failed upload has Retry. In an Office note every file is office only. Drop a file from your computer on the box: a row is added.',
    },
    {
      id: 'refused',
      label: 'Refused files',
      model: { ...base, draft: { ...base.draft, body: 'Logo files for the embroidery.' }, files: [file('a', 'logo.svg', 40_000, 'image/svg+xml', { phase: 'refused', problem: { key: 'refused.page' } }), file('b', 'artwork.ai', 5_200_000, 'application/postscript'), file('c', 'logo-print.pdf', 900_000, 'application/pdf')] },
      note: 'Name and reason: SVG can carry scripts (send a PDF or PNG); design files are taken download-only (B-TH-084); a refused file holds nothing.',
    },
    {
      id: 'mail-limit',
      label: 'Over the e-mail limit',
      model: { ...base, draft: { mode: 'reply', body: 'The photos of the first pieces.', forFloor: false }, files: ['piece-front.jpg', 'piece-back.jpg', 'piece-label.jpg'].map((name, index) => file(String(index), name, 4_100_000, 'image/jpeg', { audience: 'PARTY' })) },
      note: 'Over 10 MB together a mail cannot carry them: Send waits with the reason. An Office note has no mail limit.',
    },
    { id: 'picker', label: 'From this record', model: { ...base, draft: { mode: 'reply', body: 'Here are the files again.', forFloor: false }, pickerOpen: true }, note: 'In a reply the files the customer may already see come first, then the office’s.' },
    {
      id: 'office-file',
      label: 'An office file in a reply',
      model: { ...base, draft: { mode: 'reply', body: 'The photos and the sheet.', forFloor: false }, files: [file('a', 'sample-front.jpg', 2_400_000, 'image/jpeg', { source: 'record', audience: 'PARTY' }), file('b', 'cost-sheet-v3.xlsx', 96_000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { source: 'record' })] },
      note: 'Named: Share with Brand Alpha (the files right) or Remove it. Send waits until then.',
    },
    { id: 'no-share', label: 'An office file, no right to share', model: { ...base, canShare: false, draft: { mode: 'reply', body: 'The sheet.', forFloor: false }, files: [file('b', 'cost-sheet-v3.xlsx', 96_000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { source: 'record' })] } },
    { id: 'reply-ready', label: 'A reply ready', model: { ...base, draft: { mode: 'reply', body: 'Hello Alma,\nthe photo of the first piece is attached.\nAlex', forFloor: false }, files: [file('a', 'first-piece.jpg', 1_800_000, 'image/jpeg', { audience: 'PARTY' })] } },
    { id: 'no-upload', label: 'No right to upload', model: { ...base, canUpload: false }, note: 'The clip offers From this record only, and says why.' },
    {
      id: 'brand-beta',
      label: 'Brand Beta’s copy (brand wall)',
      model: { ...base, context: { ...ORDER, recordLabel: BRAND_BETA.numbers.order, party: { name: BRAND_BETA.tradeName } }, draft: { mode: 'reply', body: 'Here are the files.', forFloor: false }, recordFiles: RECORD_FILES(BRAND_BETA), pickerOpen: true },
      note: '“From this record” lists only this record’s files: Brand Beta’s.',
    },
  ],
})
