import { describe, expect, it } from 'vitest'
import { events } from '../../product-images/events'
import { addPictureBody, galleryLooksBody, orderPicturesBody, patternFileVersionBody, updatePictureBody } from './contracts'
import {
  calloutProblems,
  calloutsOf,
  captionProblem,
  formatOfName,
  inGalleryOrder,
  inRangeOrder,
  isPictureType,
  mainAfterRemoval,
  nextCalloutNumber,
  noteProblem,
  orderedCallouts,
  orderProblems,
  patternContentTypeOf,
  patternEditKind,
  patternFrozen,
  patternRefusal,
  patternSizeProblems,
  pictureChangeRefusal,
  pictureEditKind,
  pictureFrozen,
  picturesToCopy,
  printableInTechPack,
  shareOf,
  type SourcePicture,
} from './rules'

const at = (n: number) => `2026-11-10T08:00:0${n}.000Z`
const picture = (id: string, seq: number, extra: Partial<SourcePicture> = {}): SourcePicture => ({
  id,
  seq,
  isMain: false,
  createdAt: at(seq),
  kind: 'PHOTO',
  revisionId: null,
  colourwayId: null,
  fileId: `f-${id}`,
  caption: null,
  callouts: [],
  ...extra,
})

describe('pictures (B-W2b-236, PRD-016)', () => {
  it('takes JPEG, PNG and WebP pictures, never HEIC', () => {
    expect(isPictureType('image/jpeg')).toBe(true)
    expect(isPictureType('Image/PNG; charset=binary')).toBe(true)
    expect(isPictureType('image/webp')).toBe(true)
    expect(isPictureType('image/heic')).toBe(false)
    expect(isPictureType('application/pdf')).toBe(false)
  })

  it("keeps the tech pack's PDF rule: available JPEG or PNG of at most 4 MiB", () => {
    expect(printableInTechPack({ contentType: 'image/jpeg', sizeBytes: 4 * 1024 * 1024, status: 'AVAILABLE' })).toBe(true)
    expect(printableInTechPack({ contentType: 'image/png', sizeBytes: 4 * 1024 * 1024 + 1, status: 'AVAILABLE' })).toBe(false)
    expect(printableInTechPack({ contentType: 'image/webp', sizeBytes: 10, status: 'AVAILABLE' })).toBe(false)
    expect(printableInTechPack({ contentType: 'image/png', sizeBytes: 10, status: 'QUARANTINED' })).toBe(false)
  })

  it('writes a share as the database keeps it: 0 to 1, at most 4 decimals, never a float', () => {
    expect(shareOf(0.421337)).toBe('0.4213')
    expect(shareOf('1')).toBe('1')
    expect(shareOf(0)).toBe('0')
    expect(shareOf(0.5)).toBe('0.5')
    expect(shareOf(1.2)).toBeNull()
    expect(shareOf(-0.1)).toBeNull()
    expect(shareOf('abc')).toBeNull()
  })

  it('checks callouts as the database does, at their place', () => {
    expect(calloutProblems([{ n: 1, x: '0.42', y: '0.18', text: 'Double stitch, 4 mm' }])).toEqual([])
    const problems = calloutProblems([
      { n: 1, x: '0.42', y: '0.18', text: 'ok' },
      { n: 1, x: '1.5', y: '0.1', text: 'two\nlines' },
      { n: 0, x: '0.12345', y: '0', text: '' },
    ])
    expect(problems.map((problem) => problem.path)).toEqual(['body/callouts/1/n', 'body/callouts/1/x', 'body/callouts/1/text', 'body/callouts/2/n', 'body/callouts/2/x', 'body/callouts/2/text'])
    expect(calloutProblems(Array.from({ length: 61 }, (_, index) => ({ n: index + 1, x: '0', y: '0', text: 't' })))[0]!.path).toBe('body/callouts')
  })

  it('numbers a new callout after the highest, orders them and reads a stored list loosely', () => {
    expect(nextCalloutNumber([])).toBe(1)
    expect(nextCalloutNumber([{ n: 4 }, { n: 2 }])).toBe(5)
    expect(orderedCallouts([{ n: 3, x: '0', y: '0', text: ' c ' }, { n: 1, x: '1', y: '1', text: 'a' }]).map((callout) => [callout.n, callout.text])).toEqual([
      [1, 'a'],
      [3, 'c'],
    ])
    expect(calloutsOf([{ n: 1, x: '0.5', y: '0.5', text: 'ok' }, { n: '2' }, null, 'x'])).toEqual([{ n: 1, x: '0.5', y: '0.5', text: 'ok' }])
    expect(calloutsOf(null)).toEqual([])
  })

  it('freezes a picture of a revision that is no longer a draft, and asks the edit rule by what it shows', () => {
    expect(pictureFrozen(null)).toBe(false)
    expect(pictureFrozen({ status: 'DRAFT' })).toBe(false)
    expect(pictureFrozen({ status: 'RELEASED' })).toBe(true)
    expect(pictureChangeRefusal({ id: 'r', revision: 2, status: 'RELEASED' })).toMatch(/revision 2, which is released/)
    expect(pictureChangeRefusal(null)).toBeNull()
    expect(pictureEditKind(null)).toBe('DETAILS')
    expect(pictureEditKind({ status: 'DRAFT' })).toBe('DRAFT')
    expect(pictureEditKind({ status: 'RELEASED' })).toBe('DETAILS')
  })

  it('keeps the gallery order (place, then oldest) and hands the main mark to the next picture', () => {
    const pictures = [picture('c', 2), picture('a', 0, { isMain: true }), picture('b', 1)]
    expect(inGalleryOrder(pictures).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(mainAfterRemoval(pictures, 'a')?.id).toBe('b')
    expect(mainAfterRemoval(pictures, 'b')).toBeNull()
    expect(mainAfterRemoval([picture('a', 0, { isMain: true })], 'a')).toBeNull()
  })

  it('takes a new order only when it names every picture once', () => {
    expect(orderProblems(['a', 'b'], ['b', 'a'])).toEqual([])
    expect(orderProblems(['a', 'b'], ['a', 'a'])[0]!.message).toMatch(/once/)
    expect(orderProblems(['a', 'b'], ['a'])[0]!.message).toMatch(/missing/)
    expect(orderProblems(['a'], ['a', 'z'])[0]!.message).toMatch(/not this style's/)
  })

  it('checks a caption and a note on one line', () => {
    expect(captionProblem('Front flat')).toBeNull()
    expect(captionProblem(null)).toBeNull()
    expect(captionProblem('x'.repeat(201))).toMatch(/200/)
    expect(noteProblem('Graded 46-58')).toBeNull()
    expect(noteProblem('a\nb')).toMatch(/one line/)
  })
})

describe('pattern files (B-W2b-236, PRD-218)', () => {
  const released = { id: 'r1', revision: 1, status: 'RELEASED' as const }
  const draft = { id: 'r2', revision: 2, status: 'DRAFT' as const }

  it('freezes PATTERN and CAD files with their revision, never a marker', () => {
    expect(patternFrozen('PATTERN', released)).toBe(true)
    expect(patternFrozen('CAD', released)).toBe(true)
    expect(patternFrozen('MARKER', released)).toBe(false)
    expect(patternFrozen('OTHER', released)).toBe(false)
    expect(patternFrozen('PATTERN', draft)).toBe(false)
    expect(patternRefusal('PATTERN', released)).toMatch(/Revision 1 is released: its pattern files/)
    expect(patternRefusal('MARKER', released)).toBeNull()
    expect(patternEditKind(draft)).toBe('DRAFT')
    expect(patternEditKind(released)).toBe('DETAILS')
  })

  it("takes sizes of the style's range, each once, and orders them by the range", () => {
    const range = ['46', '48', '50', '52']
    expect(patternSizeProblems(['48', '50'], range)).toEqual([])
    expect(patternSizeProblems([], range)).toEqual([])
    expect(patternSizeProblems(['48', '48'], range)[0]!.message).toMatch(/once/)
    expect(patternSizeProblems(['60'], range)[0]!.message).toMatch(/60 are not in the style's range/)
    expect(inRangeOrder(['52', '46'], range)).toEqual(['46', '52'])
  })

  it('sends a pattern file with the type the files platform takes, from its name first', () => {
    expect(patternContentTypeOf('GT-01 rev2.DXF', '')).toBe('application/dxf')
    expect(patternContentTypeOf('marker.plt', 'application/octet-stream')).toBe('application/vnd.hp-hpgl')
    expect(patternContentTypeOf('plot.pdf', '')).toBe('application/pdf')
    expect(patternContentTypeOf('native.mdl', 'application/octet-stream')).toBeNull()
    expect(formatOfName('a.dxf')).toBe('DXF_AAMA')
    expect(formatOfName('a.pdf')).toBe('PDF')
    expect(formatOfName('a.plt')).toBeNull()
  })
})

describe('Duplicate a style copies its pictures (SY3:01)', () => {
  it("takes the style's own, the copied colourways' and the source revision's pictures, keeping the main one", () => {
    const pictures = [
      picture('own', 0),
      picture('blk', 1, { colourwayId: 'cw-blk', isMain: true }),
      picture('old', 2, { colourwayId: 'cw-old' }),
      picture('rev1', 3, { revisionId: 'rev-1', kind: 'PAGE' }),
      picture('rev2', 4, { revisionId: 'rev-2' }),
    ]
    const { copied, left } = picturesToCopy(pictures, new Map([['cw-blk', 'copy-blk']]), 'rev-1', 'copy-rev-1')
    expect(copied.map((entry) => [entry.source.id, entry.colourwayId, entry.revisionId, entry.seq, entry.isMain])).toEqual([
      ['own', null, null, 0, false],
      ['blk', 'copy-blk', null, 1, true],
      ['rev1', null, 'copy-rev-1', 2, false],
    ])
    expect(left).toBe(2)
  })

  it('puts the source revision\'s pictures on the copy itself when it has no revision, and marks the first main when the main stays behind', () => {
    const { copied } = picturesToCopy([picture('rev1', 0, { revisionId: 'rev-1' }), picture('gone', 1, { colourwayId: 'cw-x', isMain: true })], new Map(), 'rev-1', null)
    expect(copied.map((entry) => [entry.source.id, entry.revisionId, entry.isMain])).toEqual([['rev1', null, true]])
  })
})

describe('contracts and events', () => {
  it('reads the bodies with their defaults and refuses floats and unknown fields', () => {
    const id = '0194d1a2-0000-7000-8000-000000000001'
    expect(addPictureBody.parse({ fileId: id, kind: 'SKETCH' })).toEqual({ fileId: id, kind: 'SKETCH', revisionId: null, colourwayId: null, caption: null, callouts: [] })
    expect(() => updatePictureBody.parse({ version: 1, callouts: [{ n: 1, x: 0.5, y: '0.5', text: 't' }] })).toThrow()
    expect(() => updatePictureBody.parse({ version: 1, isMain: true })).toThrow()
    expect(orderPicturesBody.safeParse({ ids: [] }).success).toBe(false)
    expect(galleryLooksBody.safeParse({ styleIds: Array.from({ length: 61 }, () => id) }).success).toBe(false)
    expect(patternFileVersionBody.parse({ version: 2, fileId: id })).toEqual({ version: 2, fileId: id })
  })

  it('declares two events with no person and no money', () => {
    expect(events.map((event) => event.type)).toEqual(['style.pictures_changed', 'style.pattern_files_changed'])
    for (const event of events) expect(JSON.stringify(event.live)).not.toMatch(/person|price|cost|amount/i)
  })
})
