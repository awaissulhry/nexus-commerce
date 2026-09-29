import { describe, expect, it } from 'vitest'

import { ARCHIVE_LIMITS, archiveKindHint, archiveKindLabel, busyLabel, archivePreviewSchema, archiveSummary, countryName, filesByAsin, languageName, type ArchivePreview } from './archiveModel'

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
  it('an empty "Only" ZIP says why: the market shows what Publish photos already sends', () => {
    expect(archiveSummary(preview({ kind: 'country', market: 'IT', language: 'it', sameAsApi: true })))
      .toBe('No photos for this ZIP: Amazon IT shows the same photos as All Amazon markets, and Publish photos sends them')
    expect(archiveSummary(preview({ kind: 'country' }))).toBe('No photos to put in this ZIP')
    expect(archiveSummary(preview({ kind: 'safety', skipped: ['a', 'b'] }))).toBe('No photos to put in this ZIP · 2 SKUs left out')
    // An API from before 2026-09-29 does not send the two new answers: the preview still reads.
    expect(archivePreviewSchema.safeParse(preview()).success).toBe(true)
    expect(archivePreviewSchema.parse(preview({ ownPhotos: true, sameAsApi: false }))).toMatchObject({ ownPhotos: true, sameAsApi: false })
  })
  it('groups the files by ASIN in the preview order, with every SKU once', () => {
    const groups = filesByAsin([file('B0FXNEROM1', 'MAIN', ['NERO-M']), file('B0FXPARNT1', 'MAIN', ['Parent']), file('B0FXNEROM1', 'PT01', ['NERO-M', 'NERO-L'])])
    expect(groups.map(g => [g.asin, g.skus, g.files.map(f => f.slot)])).toEqual([['B0FXNEROM1', ['NERO-M', 'NERO-L'], ['MAIN', 'PT01']], ['B0FXPARNT1', ['Parent'], ['MAIN']]])
  })
  it('names each kind as the page\'s switch does, and what it holds: All Amazon markets = what Publish sends; Only DE = what DE shows', () => {
    expect(['slots', 'safety', 'country'].map(k => archiveKindLabel(k as 'slots', 'DE'))).toEqual(['All Amazon markets', 'Safety images', 'Only DE'])
    expect(archiveKindHint('slots', 'DE', 'de', api).holds).toBe('The All Amazon markets photos (MAIN, PT01–PT08, SWCH), named ASIN.SLOT.jpg: what Publish photos sends to every market of this account. '
      + 'A photo in several languages is in its Italian version (the first market is Amazon IT). A market’s own photos and languages go in its “Only” ZIP.')
    expect(archiveKindHint('country', 'DE', 'de', api).holds).toBe('Every photo Amazon DE shows (MAIN, PT01–PT08, SWCH), as the Media page shows it on “Only DE”: the All Amazon markets photos, '
      + 'the rows Amazon DE changed, and its German versions. It is the only way Amazon DE’s own photos reach Amazon.')
  })
  it('names Seller Central\'s own tools; a country ZIP names the country and warns against the normal upload', () => {
    expect(archiveKindHint('slots', 'IT', null, api).upload).toBe('Upload it in Seller Central: Catalog → Upload images. Each file replaces the photo in the slot its name gives. This changes the global photos.')
    expect(archiveKindHint('safety', 'IT', null, api).upload).toMatch(/^Upload it in Seller Central: Catalog → Upload images\./)
    const country = archiveKindHint('country', 'DE', 'de', api).upload
    expect(country).toMatch(/^Upload it with the Country-Specific Upload in Image Manager: Catalog → Upload images, then choose Germany in the country list\./)
    expect(country).toMatch(/Amazon does not promise to show them instead of the global photos\./)
    expect(country).toMatch(/Do not use the normal upload for this ZIP: that changes the global photos\.$/)
    expect(countryName('UK')).toBe('United Kingdom')
    expect(languageName('not a language')).toBe('NOT A LANGUAGE')
  })
  it('the button says what is happening: making the ZIP, then how much of it has arrived', () => {
    expect(busyLabel(null)).toBe('Making the ZIP…')
    expect(busyLabel({ received: 120_400_000, total: 504_375_802 })).toBe('Downloading the ZIP… 120 of 504 MB')
    expect(busyLabel({ received: 0, total: null })).toBe('Downloading the ZIP… 0 MB')
    expect(busyLabel({ received: 1_200_000_000, total: 1_300_000_000 })).toBe('Downloading the ZIP… 1,200 of 1,300 MB')
  })
  it('states the limits the server uses', () => {
    expect(ARCHIVE_LIMITS).toBe('Nexus makes a ZIP of at most 1,000 files and 1 GB. Making it can take up to 90 seconds.')
  })
  it('refuses a preview answer without a digest (the download is bound to it)', () => {
    expect(archivePreviewSchema.safeParse({ ...preview(), digest: 'short' }).success).toBe(false)
    expect(archivePreviewSchema.safeParse(preview()).success).toBe(true)
  })
})
