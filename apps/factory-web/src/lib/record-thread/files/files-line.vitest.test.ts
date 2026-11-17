import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { designScreen } from './fixtures'
import { audienceMarks, fileSeries, filesChip, recordFiles, toViewerFile, versionMark, type ThreadFile } from './model'
import { fromApiFile } from './model' // B-TH-283
import { readStripOpen, writeStripOpen } from './use-strip-open'
import { FileStrip } from './view/FileStrip'

/**
 * B-TH-210 — the files line (T2): the audience marks (Customer / Supplier only for THIS record's party, W25), the held
 * file's words, the line absent with no files (T2-F09), only this record's files (W26), versions as one document, every
 * case drawn in it and en.
 */

const KEY_ON_SCREEN = /\b(chip|strip|kind|audience|design|version|held|loading)\.[a-zA-Z]/
const PARTY = { id: 'party-beta', role: 'customer' as const }

const file = (over: Partial<ThreadFile>): ThreadFile => ({
  id: 'f',
  recordType: 'SalesOrder',
  recordId: 'so-beta',
  name: BRAND_BETA.fileName,
  contentType: 'application/pdf',
  kind: 'DOCUMENT',
  sizeBytes: 1,
  status: 'AVAILABLE',
  quarantineReason: null,
  visibility: ['OFFICE'],
  partyId: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  previewUrl: null,
  ...over,
})

const draw = (locale: 'it' | 'en', files: readonly ThreadFile[] | null, open = true) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(FileStrip, { model: { files, party: PARTY, open } })))

describe('the audience marks', () => {
  it('says Office only when nobody else sees it, and the party’s word by the record', () => {
    expect(audienceMarks(file({}), PARTY)).toEqual({ marks: ['office'], more: 0 })
    expect(audienceMarks(file({ visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id }), PARTY).marks).toEqual(['customer'])
    expect(audienceMarks(file({ visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id }), { ...PARTY, role: 'supplier' }).marks).toEqual(['supplier'])
  })

  it('never calls a file shared with another party this customer’s: it is flagged to the office (W25)', () => {
    expect(audienceMarks(file({ visibility: ['OFFICE', 'PARTNER'], partyId: 'party-alpha' }), PARTY).marks).toEqual(['otherParty'])
    expect(audienceMarks(file({ visibility: ['OFFICE', 'PARTNER'], partyId: null }), null).marks).toEqual(['otherParty'])
  })

  it('shows two marks then “+N”, a wrong party always among them', () => {
    expect(audienceMarks(file({ visibility: ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'], partyId: PARTY.id }), PARTY)).toEqual({ marks: ['floor', 'customer'], more: 1 })
    expect(audienceMarks(file({ visibility: ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'], partyId: 'x' }), PARTY).marks[0]).toBe('otherParty')
  })
})

describe('the line', () => {
  it('is absent with no files, and while uploads are only on their way', () => {
    for (const locale of LOCALES) {
      expect(draw(locale, [])).toBe('')
      expect(draw(locale, [file({ status: 'PENDING_UPLOAD' }), file({ id: 'd', status: 'DELETED' })])).toBe('')
    }
  })

  it('counts documents the reader can see (versions are one), newest first', () => {
    const series = fileSeries([
      file({ id: 'v1', versionNo: 1, seriesId: null, createdAt: '2026-11-01T09:00:00.000Z' }),
      file({ id: 'v2', versionNo: 2, seriesId: 'v1', createdAt: '2026-11-05T09:00:00.000Z' }),
      file({ id: 'o', name: 'Other.pdf', createdAt: '2026-11-03T09:00:00.000Z' }),
    ])
    expect(series.map((one) => one.latest.id)).toEqual(['v2', 'o'])
    expect(versionMark(series[0]!)).toBe(2)
    expect(versionMark(series[1]!)).toBeNull()
    expect(filesChip(series).count).toBe(2)
  })

  it('lists only this record’s files (W26)', () => {
    const own = file({ id: 'b' })
    const other = file({ id: 'a', recordId: 'so-alpha', name: BRAND_ALPHA.fileName })
    expect(recordFiles([own, other], { type: 'SalesOrder', id: 'so-beta' }).map((one) => one.id)).toEqual(['b'])
    const html = draw('en', recordFiles([own, other], { type: 'SalesOrder', id: 'so-beta' }))
    expect(scanText(html, BRAND_ALPHA)).toEqual([])
    expect(html).toContain(BRAND_BETA.fileName)
  })

  it('says a held file in words and gives the viewer no download for it', () => {
    const held = file({ id: 'h', name: 'Lining.jpg', contentType: 'image/jpeg', kind: 'PHOTO', status: 'QUARANTINED', quarantineReason: 'scan_pending' })
    const html = draw('en', [held])
    expect(html).toContain('Lining.jpg · Photo · held')
    expect(html).toContain('A file with a lock is held')
    expect(toViewerFile(held)).toMatchObject({ status: 'QUARANTINED', downloadHref: null })
  })

  it('names the line and every tile for screen readers', () => {
    const html = draw('en', [file({ id: 'x', visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id })])
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Files (1)')
    expect(html).toContain(`aria-label="${BRAND_BETA.fileName} · Document · Customer"`)
  })
})

describe('the strip’s state', () => {
  it('is remembered on this device per person; closed when unknown or storage is closed', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) }
    expect(readStripOpen(storage, 'p1')).toBe(false)
    writeStripOpen(storage, 'p1', true)
    expect(readStripOpen(storage, 'p1')).toBe(true)
    expect(readStripOpen(storage, 'p2')).toBe(false)
    expect(readStripOpen({ getItem: () => { throw new Error('closed') } }, 'p1')).toBe(false)
  })
})

describe('the words', () => {
  it('draws every case of SCR-006-filesline with no key on screen, in it and en', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
      }
    }
  })
})

// ---- B-TH-283 (B-TH-083): the files line marks a measurement sheet — locked (no name) for who may not open it, named for who may.
describe('B-TH-283: measurement sheets on the files line', () => {
  it('a locked sheet shows the lock and its words, never its name; an opened one says it is a measurement sheet', () => {
    const locked = draw('en', [file({ id: 'l', name: '', locked: 'MEASUREMENTS' })])
    expect(locked).toContain('Measurement sheet — you cannot open it')
    const opened = draw('en', [file({ id: 'o', name: 'Measurements Anna.pdf', sheet: true })])
    expect(opened).toContain('Measurements Anna.pdf · Measurement sheet')
    expect(draw('it', [file({ id: 'o', name: 'Misure.pdf', sheet: true })])).toContain('Misure.pdf · Scheda misure')
    expect(opened).not.toMatch(KEY_ON_SCREEN)
    expect(scanText(opened, BRAND_ALPHA)).toEqual([])
  })

  it('the API’s category reaches the file only for who opens it: MEASUREMENTS marks it, a locked one stays locked', () => {
    const base = { id: 'a', companyId: null, recordType: 'SalesOrder', recordId: 'so-beta', kind: 'ATTACHMENT' as const, originalName: 'Misure.pdf', contentType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE' as const, visibility: ['OFFICE' as const], retainUntil: null, quarantineReason: null, availableAt: null, createdAt: '2026-11-10T09:00:00.000Z', version: 1 }
    expect(fromApiFile({ ...base, category: 'MEASUREMENTS' }).sheet).toBe(true)
    expect(fromApiFile({ ...base, category: 'MEASUREMENTS', locked: 'MEASUREMENTS', originalName: '' }).sheet).toBeUndefined()
    expect(fromApiFile({ ...base, category: null }).sheet).toBeUndefined()
  })
})
// ---- end B-TH-283

// ---- B-TH-286 (B-TH-091; T2-F07 "2 pinned", T2-F09; wall W08) ----------------------------------------------------------------------
import { lineShown, pinLinesOf, pinText, type PinLine } from './model'
import { render as drawAll, textOf } from '../parts/testing'

describe('B-TH-286 — pins on the files line', () => {
  const apiPin = (n: number, over: { removed?: boolean; excerpt?: string; audience?: 'OFFICE' | 'PARTNER'; files?: number; by?: string | null } = {}) => ({
    messageId: `m-${n}`,
    pinnedAt: '2026-11-12T10:00:00.000Z',
    ...(over.by !== null ? { pinnedBy: { id: 'u-1', name: over.by ?? 'Alex Demo' } } : {}),
    message: { authorName: 'Dora Bianchi', excerpt: over.excerpt ?? 'Collar in yellow piping', at: '2026-11-10T09:12:00.000Z', ...(over.audience ? { audience: over.audience } : {}), attachmentCount: over.files ?? 0, removed: over.removed ?? false },
  })
  const pins: PinLine[] = pinLinesOf([apiPin(1, { audience: 'PARTNER', files: 1 }), apiPin(2, { audience: 'OFFICE' })])

  it('turns the API’s pins into lines: who wrote it, an office note marked, who pinned it (office only)', () => {
    expect(pins.map((pin) => [pin.messageId, pin.office, pin.pinnedBy])).toEqual([
      ['m-1', false, 'Alex Demo'],
      ['m-2', true, 'Alex Demo'],
    ])
    // A portal reader's answer has no pinnedBy and no audience: nothing is made up.
    expect(pinLinesOf([apiPin(3, { by: null })])[0]).toMatchObject({ pinnedBy: null, office: false })
  })

  it('a pin is a pointer: one line of its words, "2 files" for files only, "removed" for an erased message (never its words)', () => {
    expect(pinText(pins[0]!)).toEqual({ text: 'Collar in yellow piping' })
    expect(pinText(pinLinesOf([apiPin(4, { excerpt: '', files: 2 })])[0]!)).toEqual({ key: 'pins.filesOnly', params: { count: 2 } })
    const removed = pinLinesOf([apiPin(5, { removed: true })])[0]!
    expect(removed.author).toBeNull()
    expect(removed.excerpt).toBe('')
    expect(pinText(removed)).toEqual({ key: 'pins.removed' })
  })

  it('the line shows with pins or files, and is absent with neither (T2-F09)', () => {
    expect(lineShown([], [])).toBe(false)
    expect(lineShown([], null)).toBe(false)
    expect(lineShown([], pins)).toBe(true)
    expect(lineShown([file({})], [])).toBe(true)
    expect(lineShown(null, null)).toBe(true)
  })

  it('draws “2 pinned” before the files chip, in it and en, and a pins-only line', () => {
    for (const locale of LOCALES) {
      const html = drawAll(createElement(FileStrip, { model: { files: [file({})], party: PARTY, open: false, pins } }), locale)
      const text = textOf(html)
      expect(text).toContain(locale === 'en' ? '2 pinned' : '2 fissati')
      expect(text.indexOf(locale === 'en' ? '2 pinned' : '2 fissati')).toBeLessThan(text.indexOf(locale === 'en' ? 'Files (1)' : 'File (1)'))
      expect(text).not.toMatch(/\bpins\.[a-zA-Z]/)
      const only = textOf(drawAll(createElement(FileStrip, { model: { files: [], party: PARTY, open: false, pins: [pins[0]!] } }), locale))
      expect(only).toContain(locale === 'en' ? '1 pinned' : '1 fissato')
    }
    expect(drawAll(createElement(FileStrip, { model: { files: [], party: PARTY, open: false, pins: [] } }))).toBe('')
  })

  it('every pins design case draws in both languages without a key on screen', () => {
    for (const locale of LOCALES) {
      for (const item of designScreen.cases.filter((one) => one.id.startsWith('th9-286'))) {
        const html = drawAll(createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model }), locale)
        expect(textOf(html)).not.toMatch(/\bpins\.[a-zA-Z]/)
      }
    }
  })
})
// ---- end B-TH-286
