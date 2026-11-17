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
