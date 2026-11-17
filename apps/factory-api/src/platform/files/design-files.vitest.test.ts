import { describe, expect, it } from 'vitest'
import { ARTWORK_TYPES, DESIGN_TYPE_BY_EXTENSION, DESIGN_TYPES, isDesignType, isPageType, PAGE_TYPES, ZIP_TYPES } from '@nexus/factory-domain/files/design'
import { measurementSheetProblem, MEASUREMENT_SHEET_KINDS } from '@nexus/factory-domain/files/measurements'
import { previewModeOf } from '@nexus/factory-domain/files/preview/rules'
import { isPicture, isStrippable } from '@nexus/factory-domain/files/thumbs/strip'
import { DESIGN_KIND_WORDS, FILE_KINDS, KIND_RULES, PAGE_TYPE_WORDS, uploadProblems } from './rules'

/**
 * B-TH-084 (threads plan TH-7, G12): design files from customers — Illustrator, EPS, Photoshop and ZIP — are accepted
 * download-only (an attachment or a document; a ZIP a document only, T6-F05), never previewed, never a picture to strip; SVG,
 * HTML and scripts never, in words that name the way out. The lists are the database's (…_files_measurements_th_guards), word for
 * word. B-TH-083: a measurement sheet's kinds and its floor rule (pure).
 */

const SHA = 'a'.repeat(64)
const ok = (kind: (typeof FILE_KINDS)[number], contentType: string) => uploadProblems({ kind, contentType, sizeBytes: 10, sha256: SHA })

describe('B-TH-084: design files are download-only', () => {
  it('takes Illustrator, EPS and Photoshop as an attachment or a document, a ZIP as a document only', () => {
    for (const type of ARTWORK_TYPES) {
      expect(ok('ATTACHMENT', type), type).toEqual([])
      expect(ok('DOCUMENT', type), type).toEqual([])
    }
    for (const type of ZIP_TYPES) {
      expect(ok('DOCUMENT', type), type).toEqual([])
      expect(ok('ATTACHMENT', type), type).toEqual([{ path: 'body/contentType', message: DESIGN_KIND_WORDS }])
    }
    expect(ok('ATTACHMENT', 'Application/Illustrator; version=27')).toEqual([])
  })

  it('never as a photo, a certificate, a fiscal copy or a voice note (the database refuses it too)', () => {
    for (const kind of ['PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE', 'AUDIO'] as const) {
      for (const type of DESIGN_TYPES) expect(ok(kind, type), `${kind} ${type}`).toEqual([{ path: 'body/contentType', message: DESIGN_KIND_WORDS }])
    }
  })

  it('a design file is never shown in place, never a picture to strip or to preview small', () => {
    for (const type of DESIGN_TYPES) {
      expect(previewModeOf(type), type).toBe('download')
      expect(isPicture(type), type).toBe(false)
      expect(isStrippable(type), type).toBe(false)
      expect(isDesignType(type)).toBe(true)
    }
    expect(isPicture('image/jpeg')).toBe(true)
    expect(isPicture('image/heic')).toBe(true)
  })

  it('a design file named but not typed by the browser gets a design type', () => {
    for (const extension of ['ai', 'eps', 'psd', 'zip']) expect(isDesignType(DESIGN_TYPE_BY_EXTENSION[extension]!), extension).toBe(true)
  })

  it('SVG, HTML and scripts: never, for any kind, in words that name the way out', () => {
    for (const kind of FILE_KINDS) {
      for (const type of [...PAGE_TYPES, 'Image/SVG+XML; charset=utf-8']) expect(ok(kind, type), `${kind} ${type}`).toEqual([{ path: 'body/contentType', message: PAGE_TYPE_WORDS }])
    }
    expect(PAGE_TYPE_WORDS).toMatch(/send a PDF or PNG/)
    for (const type of PAGE_TYPES) expect(isPageType(type)).toBe(true)
    // No kind lists a page type, and the design lists and the page list never meet.
    for (const kind of FILE_KINDS) for (const type of KIND_RULES[kind].contentTypes) expect(isPageType(type), `${kind} ${type}`).toBe(false)
    for (const type of DESIGN_TYPES) expect(isPageType(type)).toBe(false)
  })

  it('the lists are the database’s, word for word', () => {
    expect([...DESIGN_TYPES].sort()).toEqual(
      [
        'application/postscript', 'application/eps', 'application/x-eps', 'image/eps', 'image/x-eps', 'application/illustrator', 'application/vnd.adobe.illustrator',
        'image/vnd.adobe.photoshop', 'application/vnd.adobe.photoshop', 'application/photoshop', 'application/x-photoshop', 'image/photoshop', 'image/x-photoshop', 'image/psd',
        'application/zip', 'application/x-zip-compressed', 'application/x-zip',
      ].sort(),
    )
    expect([...PAGE_TYPES].sort()).toEqual(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/x-javascript', 'application/ecmascript', 'text/ecmascript'].sort())
  })
})

describe('B-TH-083: a measurement sheet (pure)', () => {
  it('is a document, an attachment or a photo of one, never for a floor', () => {
    expect([...MEASUREMENT_SHEET_KINDS]).toEqual(['ATTACHMENT', 'DOCUMENT', 'PHOTO'])
    expect(measurementSheetProblem({ kind: 'DOCUMENT', visibility: ['OFFICE', 'PARTNER'] })).toBeNull()
    expect(measurementSheetProblem({ kind: 'PHOTO', visibility: ['OFFICE'] })).toBeNull()
    expect(measurementSheetProblem({ kind: 'CERTIFICATE', visibility: ['OFFICE'] })).toMatch(/document, an attachment or a photo/)
    expect(measurementSheetProblem({ kind: 'DOCUMENT', visibility: ['OFFICE', 'FLOOR'] })).toMatch(/never shared with a floor/)
  })
})
