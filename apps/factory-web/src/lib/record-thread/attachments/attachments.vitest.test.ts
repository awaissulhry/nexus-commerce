import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { everyCase, leftKeys, render, textOf } from '../parts/testing'
import { designScreen } from './fixtures'
import {
  addDropped,
  contentTypeOf,
  draftOfRecordFile,
  FILE_MAX,
  kindOf,
  MAIL_MAX,
  MAX_FILES,
  officeInReply,
  PHOTO_MAX,
  pickerGroups,
  refusalOf,
  sendable,
  trayHeld,
  uploadAudience,
  type DraftFile,
  type RecordFile,
} from './model'
import { takesSheet } from './model' // B-TH-283
import { AttachmentLines, AttachmentTray } from './view/AttachmentTray'

/** B-TH-206 — files straight into the message (T6): progress, refusals, Send held while uploading, the message's audience. */

let n = 0
const key = () => `k${++n}`
const file = (more: Partial<DraftFile> = {}): DraftFile => ({ key: key(), name: 'a.pdf', sizeBytes: 1000, contentType: 'application/pdf', source: 'device', phase: 'done', audience: 'OFFICE', fileId: 'f', ...more })

describe('a refused file names the limit and the way out', () => {
  it('scripts and SVG, design files, unknown types, empty files, and sizes (15 MB a photo, 25 MB a file)', () => {
    // B-TH-084: SVG, HTML and scripts never (the words name the way out); design files are taken, download-only.
    expect(refusalOf({ name: 'logo.svg', type: 'image/svg+xml', size: 10 })).toEqual({ key: 'refused.page' })
    expect(refusalOf({ name: 'page.html', size: 10 })).toEqual({ key: 'refused.page' })
    expect(refusalOf({ name: 'artwork.ai', type: 'application/postscript', size: 10 })).toBeNull()
    expect(refusalOf({ name: 'logo.psd', size: 10 })).toBeNull()
    expect(refusalOf({ name: 'pack.zip', type: 'application/zip', size: 10 })).toBeNull()
    expect(refusalOf({ name: 'clip.mov', type: 'video/quicktime', size: 10 })).toEqual({ key: 'refused.type' })
    expect(refusalOf({ name: 'empty.pdf', type: 'application/pdf', size: 0 })).toEqual({ key: 'refused.empty' })
    expect(refusalOf({ name: 'big.jpg', type: 'image/jpeg', size: PHOTO_MAX + 1 })).toEqual({ key: 'refused.photoSize', params: { limit: 15 } })
    expect(refusalOf({ name: 'big.pdf', type: 'application/pdf', size: FILE_MAX + 1 })).toEqual({ key: 'refused.fileSize', params: { limit: 25 } })
    expect(refusalOf({ name: 'ok.pdf', type: 'application/pdf', size: FILE_MAX })).toBeNull()
    expect(refusalOf({ name: 'IMG_0001.HEIC', size: 2_000_000 })).toBeNull()
  })

  it('a phone photo without a type is read by its name; a picture files as PHOTO', () => {
    expect(contentTypeOf({ name: 'IMG_0001.HEIC' })).toBe('image/heic')
    expect(kindOf('image/jpeg')).toBe('PHOTO')
    expect(kindOf('application/pdf')).toBe('ATTACHMENT')
    // B-TH-084: a ZIP is a document; Illustrator, EPS, Photoshop a file.
    expect(kindOf('application/zip')).toBe('DOCUMENT')
    expect(kindOf('application/postscript')).toBe('ATTACHMENT')
  })

  it('a drop past 20 files leaves the rest out and says how many; a refused file keeps its reason', () => {
    const current = Array.from({ length: MAX_FILES - 1 }, () => file())
    const result = addDropped(current, [{ name: 'a.jpg', type: 'image/jpeg', size: 10 }, { name: 'b.jpg', type: 'image/jpeg', size: 10 }, { name: 'x.svg', type: 'image/svg+xml', size: 10 }], 'OFFICE', key)
    expect(result.leftOut).toBe(1)
    expect(result.added.map((item) => item.phase)).toEqual(['uploading', 'refused'])
    expect(result.added[1].problem).toEqual({ key: 'refused.page' }) // B-TH-084: an SVG names the way out
  })
})

describe('Send waits for the files', () => {
  it('“Waiting for 2 files” while uploading, then a failed one, then too many', () => {
    expect(trayHeld([file({ phase: 'uploading' }), file({ phase: 'uploading' }), file()], 'note')).toEqual({ key: 'held.waiting', params: { count: 2 } })
    expect(trayHeld([file({ phase: 'failed' })], 'note')).toEqual({ key: 'held.failed', params: { count: 1 } })
    expect(trayHeld(Array.from({ length: MAX_FILES + 1 }, () => file()), 'note')).toEqual({ key: 'held.tooMany', params: { max: MAX_FILES } })
    expect(trayHeld([file({ phase: 'refused' })], 'note')).toBeNull()
    expect(sendable([file(), file({ phase: 'uploading' }), file({ phase: 'refused' })])).toHaveLength(1)
  })

  it('over 10 MB together a mail waits; an Office note has no mail limit', () => {
    const big = [file({ sizeBytes: MAIL_MAX / 2 + 1, audience: 'PARTY' }), file({ sizeBytes: MAIL_MAX / 2 + 1, audience: 'PARTY' })]
    expect(trayHeld(big, 'reply')).toEqual({ key: 'held.mailLimit' })
    expect(trayHeld(big, 'note')).toBeNull()
  })
})

describe('a file takes the audience of its message (T6-F04, B-TH-003)', () => {
  it('office only in a note; shared with the customer in a reply, when the person may share and the record has a customer', () => {
    expect(uploadAudience('note', true, true)).toBe('OFFICE')
    expect(uploadAudience('reply', true, true)).toBe('PARTY')
    expect(uploadAudience('reply', false, true)).toBe('OFFICE')
    expect(uploadAudience('reply', true, false)).toBe('OFFICE')
  })

  it('an office-only file in a reply is named and holds Send until it is shared or taken off', () => {
    const files = [file({ name: 'cost-sheet-v3.xlsx' }), file({ audience: 'PARTY' })]
    expect(officeInReply(files, 'reply').map((item) => item.name)).toEqual(['cost-sheet-v3.xlsx'])
    expect(officeInReply(files, 'note')).toEqual([])
    expect(trayHeld(files, 'reply')).toEqual({ key: 'held.officeFile' })
    const lines = textOf(render(createElement(AttachmentLines, { files, mode: 'reply', partyName: BRAND_ALPHA.tradeName, canShare: true, overMailLimit: false, onShare: () => undefined, onRemove: () => undefined })))
    expect(lines).toContain(`cost-sheet-v3.xlsx is office only. Share with ${BRAND_ALPHA.tradeName} Remove it`)
    const noRight = textOf(render(createElement(AttachmentLines, { files, mode: 'reply', partyName: BRAND_ALPHA.tradeName, canShare: false, overMailLimit: false, onShare: () => undefined, onRemove: () => undefined })))
    expect(noRight).toContain('Sharing it needs the right to manage files.')
  })

  it('the tray says each file’s audience, its progress and why it was refused', () => {
    const tray = textOf(
      render(
        createElement(AttachmentTray, {
          files: [file({ name: 'back.jpg', contentType: 'image/jpeg', phase: 'uploading', progress: 42 }), file({ name: 'chart.pdf', audience: 'PARTY' }), file({ name: 'logo.svg', phase: 'refused', problem: { key: 'refused.type' } })],
          partyName: BRAND_ALPHA.tradeName,
          onRemove: () => undefined,
          onRetry: () => undefined,
        }),
      ),
    )
    expect(tray).toContain('back.jpg Photo · 1 KB Uploading 42 % Office only')
    expect(tray).toContain(`chart.pdf PDF · 1 KB Shared with ${BRAND_ALPHA.tradeName}`)
    expect(tray).toContain('logo.svg Not added: this type is not accepted')
  })
})

describe('From this record', () => {
  const files: RecordFile[] = [
    { id: '1', name: 'sketch.jpg', sizeBytes: 1, contentType: 'image/jpeg', shared: true, available: true },
    { id: '2', name: 'cost.xlsx', sizeBytes: 1, contentType: 'x', shared: false, available: true },
    { id: '3', name: 'held.pdf', sizeBytes: 1, contentType: 'application/pdf', shared: true, available: false },
  ]
  it('shared files first, then the office’s; only available ones; a search narrows by name', () => {
    expect(pickerGroups(files)).toEqual({ shared: [files[0]], office: [files[1]] })
    expect(pickerGroups(files, 'COST')).toEqual({ shared: [], office: [files[1]] })
    expect(draftOfRecordFile(files[1], 'x')).toMatchObject({ source: 'record', phase: 'done', fileId: '2', audience: 'OFFICE' })
    expect(draftOfRecordFile(files[0], 'x').audience).toBe('PARTY')
  })
})

describe('SCR-006-attach in both languages', () => {
  it('every case draws, with no message key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['tray', 'audience', 'kind', 'refused', 'failed', 'held', 'clip', 'office', 'picker', 'notice']), `${locale} ${id}`).toEqual([])
  })

  it('the brand wall: Brand Beta’s copy lists only Brand Beta’s files (B-TH-203)', () => {
    for (const [, id, html] of everyCase(designScreen)) {
      if (id !== 'brand-beta') continue
      expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
      expect(textOf(html)).toContain(BRAND_BETA.tradeName)
    }
  })
})

// ---- B-TH-237: a message in the portal shares its files like a reply (no mail limit); B-TH-283 (B-TH-083): measurement sheets.
describe('B-TH-237 / B-TH-283: files of a portal message, and files that go up as measurement sheets', () => {
  it('a portal message’s files are shared with this record’s customer (files.manage), an office-only one is named, no mail limit', () => {
    expect(uploadAudience('portal', true, true)).toBe('PARTY')
    expect(uploadAudience('portal', false, true)).toBe('OFFICE')
    expect(uploadAudience('portal', true, false)).toBe('OFFICE')
    const big: DraftFile = { key: 'b', name: 'big.pdf', sizeBytes: MAIL_MAX + 1, contentType: 'application/pdf', source: 'device', phase: 'done', fileId: 'f-b', audience: 'PARTY' }
    expect(trayHeld([big], 'portal')).toBeNull()
    expect(trayHeld([big], 'reply')).toEqual({ key: 'held.mailLimit' })
    const office: DraftFile = { ...big, key: 'o', sizeBytes: 10, audience: 'OFFICE' }
    expect(officeInReply([office], 'portal')).toEqual([office])
    expect(trayHeld([office], 'portal')).toEqual({ key: 'held.officeFile' })
  })

  it('a PDF or a photo goes up as a measurement sheet; any other file is refused with why', () => {
    expect(takesSheet('application/pdf')).toBe(true)
    expect(takesSheet('image/jpeg')).toBe(true)
    expect(takesSheet('application/zip')).toBe(false)
    const added = addDropped([], [{ name: 'sizes-anna.pdf', type: 'application/pdf', size: 90_000 }, { name: 'logo.ai', type: 'application/postscript', size: 9_000 }], 'OFFICE', key, true)
    expect(added.added[0]).toMatchObject({ name: 'sizes-anna.pdf', phase: 'uploading', sheet: true })
    expect(added.added[1]).toMatchObject({ name: 'logo.ai', phase: 'refused', problem: { key: 'refused.sheetType' } })
    expect(added.added[1]!.sheet).toBeUndefined()
    expect(addDropped([], [{ name: 'a.pdf', type: 'application/pdf', size: 9 }], 'OFFICE', key).added[0]!.sheet).toBeUndefined()
  })

  it('the tray marks a sheet in words (it and en), never naming another customer', () => {
    const sheet: DraftFile = { key: 's', name: 'sizes-anna.pdf', sizeBytes: 90_000, contentType: 'application/pdf', source: 'device', phase: 'done', fileId: 'f-s', audience: 'OFFICE', sheet: true }
    const html = render(createElement(AttachmentTray, { files: [sheet], partyName: BRAND_BETA.tradeName, onRemove: () => undefined, onRetry: () => undefined }))
    expect(textOf(html)).toContain('Measurement sheet · only those with the measurements right open it')
    expect(textOf(render(createElement(AttachmentTray, { files: [sheet], partyName: BRAND_BETA.tradeName, onRemove: () => undefined, onRetry: () => undefined }), 'it'))).toContain('Scheda misure')
    expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
    expect(leftKeys(html, ['sheet', 'tray', 'audience', 'kind'])).toEqual([])
  })
})
// ---- end B-TH-237 / B-TH-283
