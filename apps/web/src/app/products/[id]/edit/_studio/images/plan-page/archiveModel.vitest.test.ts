import { describe, expect, it } from 'vitest'

import { archiveKindHint, archivePreviewSchema, archiveSummary, countryName, filesByAsin, languageName, type ArchivePreview } from './archiveModel'

const file = (asin: string, slot: string, skus: string[], photo = slot.toLowerCase()) => ({ name: `${asin}.${slot}.jpg`, asin, slot, skus, assetId: `a-${photo}`, photo })
const preview = (extra: Partial<ArchivePreview> = {}): ArchivePreview => ({ market: 'DE', kind: 'slots', language: 'de', apiLanguage: 'it', apiMarket: 'IT', digest: 'a'.repeat(64),
  filename: 'amazon-DE-photos-aaaaaaaaaa.zip', issues: [], warnings: [], skipped: [], files: [], ...extra })
const api = { language: 'it', market: 'IT' }

describe('Amazon ZIP window (P4d)', () => {
  it('counts files and ASINs, and says how many SKUs were left out', () => {
    const files = [file('B0FXPARNT1', 'MAIN', ['Parent']), file('B0FXNEROM1', 'MAIN', ['NERO-M', 'NERO-L']), file('B0FXNEROM1', 'PT01', ['NERO-M', 'NERO-L'])]
    expect(archiveSummary(preview({ files, skipped: ['GIALLO-M: not listed on Amazon DE — left out.'] }))).toBe('3 files · 2 ASINs · 1 SKU left out')
    expect(archiveSummary(preview({ files: files.slice(0, 1) }))).toBe('1 file · 1 ASIN')
  })
  it('an empty country ZIP says exactly why: the API already sends that language, or no photo has it', () => {
    expect(archiveSummary(preview({ kind: 'country', market: 'IT', language: 'it' }))).toBe('No photos for this ZIP: the API already sends the Italian versions to Amazon IT')
    expect(archiveSummary(preview({ kind: 'country' }))).toBe('No photos for this ZIP: no photo on these ASINs has a German version')
    expect(archiveSummary(preview({ kind: 'safety', skipped: ['a', 'b'] }))).toBe('No photos to put in this ZIP · 2 SKUs left out')
  })
  it('groups the files by ASIN in the preview order, with every SKU once', () => {
    const groups = filesByAsin([file('B0FXNEROM1', 'MAIN', ['NERO-M']), file('B0FXPARNT1', 'MAIN', ['Parent']), file('B0FXNEROM1', 'PT01', ['NERO-M', 'NERO-L'])])
    expect(groups.map(g => [g.asin, g.skus, g.files.map(f => f.slot)])).toEqual([['B0FXNEROM1', ['NERO-M', 'NERO-L'], ['MAIN', 'PT01']], ['B0FXPARNT1', ['Parent'], ['MAIN']]])
  })
  it('names the language each kind holds: All photos = the API\'s language, Country photos = the market\'s', () => {
    expect(archiveKindHint('slots', 'DE', 'de', api).holds).toBe('Every photo the plan gives Amazon (MAIN, PT01–PT08, SWCH), named ASIN.SLOT.jpg. A photo in several languages is in its Italian version: '
      + 'the API sends that version to every market of this account (its first market is Amazon IT). Other languages go in Country photos.')
    expect(archiveKindHint('country', 'DE', 'de', api).holds).toBe('Only the German versions of photos in several languages, such as a size chart. The API sends the Italian versions; the other photos do not change.')
    expect(archiveKindHint('country', 'IT', 'it', api).holds).toBe('The API already sends the Italian versions to every market of this account, so Amazon IT needs no country photos.')
  })
  it('names Seller Central\'s own tools; a country ZIP names the country and warns against the normal upload', () => {
    expect(archiveKindHint('slots', 'IT', null, api).upload).toBe('Upload it in Seller Central: Catalog → Upload images. Each file replaces the photo in the slot its name gives.')
    expect(archiveKindHint('safety', 'IT', null, api).upload).toMatch(/^Upload it in Seller Central: Catalog → Upload images\./)
    const country = archiveKindHint('country', 'DE', 'de', api).upload
    expect(country).toMatch(/^Upload it with the Country-Specific Upload in Image Manager: Catalog → Upload images, then choose Germany in the country list\./)
    expect(country).toMatch(/Amazon does not promise to show them instead of the global photos\./)
    expect(country).toMatch(/Do not use the normal upload for this ZIP: that changes the global photos\.$/)
    expect(countryName('UK')).toBe('United Kingdom')
    expect(languageName('not a language')).toBe('NOT A LANGUAGE')
  })
  it('refuses a preview answer without a digest (the download is bound to it)', () => {
    expect(archivePreviewSchema.safeParse({ ...preview(), digest: 'short' }).success).toBe(false)
    expect(archivePreviewSchema.safeParse(preview()).success).toBe(true)
  })
})
