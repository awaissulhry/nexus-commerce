import { describe, expect, it } from 'vitest'
import { PORTAL_FILES_PER_RECORD, PORTAL_UPLOAD_REFUSALS, PORTAL_UPLOAD_WORDS, portalFileKindOf, portalUploadWords } from './uploads'

/** B-TH-085 (TH-7, G1): the kind a portal upload is filed as, and the portal's words for a refused one. */
describe('B-TH-085 portal uploads', () => {
  it('a picture is a photo, a ZIP a document, a design file or anything else an attachment', () => {
    expect(portalFileKindOf('image/jpeg')).toBe('PHOTO')
    expect(portalFileKindOf('image/heic')).toBe('PHOTO')
    expect(portalFileKindOf('application/zip')).toBe('DOCUMENT')
    expect(portalFileKindOf('image/vnd.adobe.photoshop')).toBe('ATTACHMENT')
    expect(portalFileKindOf('application/postscript')).toBe('ATTACHMENT')
    expect(portalFileKindOf('application/pdf')).toBe('ATTACHMENT')
    // An SVG goes up as a photo and is refused there by the files module's words ("send a PDF or PNG").
    expect(portalFileKindOf('image/svg+xml')).toBe('PHOTO')
  })

  it('every refusal has its words in Italian and English, in the person’s language, naming no one', () => {
    for (const code of PORTAL_UPLOAD_REFUSALS) {
      expect(PORTAL_UPLOAD_WORDS[code].it.length).toBeGreaterThan(10)
      expect(PORTAL_UPLOAD_WORDS[code].en.length).toBeGreaterThan(10)
    }
    expect(portalUploadWords('TOO_MANY_FILES', 'en')).toContain(String(PORTAL_FILES_PER_RECORD))
    expect(portalUploadWords('NO_UPLOAD', 'it')).toBe(PORTAL_UPLOAD_WORDS.NO_UPLOAD.it)
    expect(portalUploadWords('NO_UPLOAD', 'de')).toBe(PORTAL_UPLOAD_WORDS.NO_UPLOAD.it)
  })
})
