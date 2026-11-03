import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import { HIDE_ROWS } from '../../demo/fixtures'
import { HIDE_PHOTOS } from '../../photos/fixtures'
import { newestFirst, photoCaption, photoFileProblem, photoPlaceKey, shownPhotos } from '../../photos/model'
import { GRADES, gradingOf, measuresOf, SHADES } from './fixtures'
import {
  applyHeldKey,
  audienceKey,
  changeCount,
  changeLines,
  correctHeldKey,
  draftOf,
  EMPTY_MEASURE,
  gradingCan,
  gradingRefusal,
  measureBodyOf,
  measureDraftHeldKey,
  measuredBy,
  measureHeldKey,
  measureRefusal,
  OUTCOME_TONE,
  patchOf,
  plainDecimal,
  readOnlyKey,
} from './grading-model'

const full = { ...HIDE_ROWS[0]!, reservedFor: null }
const partly = HIDE_ROWS[2]!
const consumed = HIDE_ROWS[4]!
const MANAGE = gradingCan(['inventory.hides.manage', 'inventory.adjust', 'files.read'])
const VIEW_ONLY = gradingCan(['inventory.stock.view'])
const words = (key: string) => key

describe('the correction a form sends (B-W2b-131, design hd-grade-form)', () => {
  const view = gradingOf(full)
  const base = draftOf(view, 'it')

  it('sends nothing while nothing changed, at the version the form started from', () => {
    expect(base).toMatchObject({ version: 4, gradeId: GRADES[1]!.id, shadeGroupId: SHADES[0]!.id, thicknessMm: '1,20', defects: '' })
    expect(patchOf(view, base, 'grade')).toBeNull()
    expect(patchOf(view, base, 'defects')).toBeNull()
    expect(changeCount(view, base, 'grade')).toBe(0)
  })

  it('sends only what changed; null clears a record; a decimal typed with a comma', () => {
    expect(patchOf(view, { ...base, gradeId: GRADES[0]!.id }, 'grade')).toEqual({ version: 4, gradeId: GRADES[0]!.id })
    expect(patchOf(view, { ...base, shadeGroupId: null, thicknessMm: '1,3' }, 'grade')).toEqual({ version: 4, shadeGroupId: null, thicknessMm: '1.3' })
    expect(patchOf(view, { ...base, thicknessMm: '1.2' }, 'grade')).toBeNull()
    expect(patchOf(view, { ...base, thicknessMm: '' }, 'grade')).toEqual({ version: 4, thicknessMm: null })
    expect(changeCount(view, { ...base, gradeId: null, thicknessMm: '1,3' }, 'grade')).toBe(2)
  })

  it('keeps each tab to its own fields, the reason with them when typed', () => {
    const draft = { ...base, gradeId: GRADES[0]!.id, defects: '  Vena sul collo  ', reason: ' Vista alla luce ' }
    expect(patchOf(view, draft, 'grade')).toEqual({ version: 4, gradeId: GRADES[0]!.id, reason: 'Vista alla luce' })
    expect(patchOf(view, draft, 'defects')).toEqual({ version: 4, defects: 'Vena sul collo', reason: 'Vista alla luce' })
    expect(patchOf(gradingOf(HIDE_ROWS[5]!), { ...draftOf(gradingOf(HIDE_ROWS[5]!), 'en'), defects: '' }, 'defects')).toMatchObject({ defects: null })
  })

  it('records a grade known only by its text when asked, the same grade as a record', () => {
    const byText = gradingOf(full, { grade: { ...gradingOf(full).grade!, byText: true } })
    const draft = draftOf(byText, 'en')
    expect(patchOf(byText, draft, 'grade')).toBeNull()
    expect(patchOf(byText, { ...draft, recordByText: true }, 'grade')).toEqual({ version: 4, gradeId: GRADES[1]!.id })
  })
})

describe('why Apply is held', () => {
  const view = gradingOf(full)
  const base = draftOf(view, 'it')
  it('nothing changed, saving, the thickness, the right, read only', () => {
    expect(applyHeldKey(view, base, 'grade', MANAGE, false)).toBe('hd.grading.held.nothing')
    expect(applyHeldKey(view, { ...base, gradeId: null }, 'grade', MANAGE, true)).toBe('hd.grading.held.saving')
    expect(applyHeldKey(view, { ...base, thicknessMm: '1,234' }, 'grade', MANAGE, false)).toBe('hd.grading.held.thickness')
    expect(applyHeldKey(view, { ...base, thicknessMm: '0' }, 'grade', MANAGE, false)).toBe('hd.grading.held.thickness')
    expect(applyHeldKey(view, { ...base, gradeId: null }, 'grade', VIEW_ONLY, false)).toBe('hd.grading.held.noRight')
    expect(applyHeldKey(view, { ...base, gradeId: null }, 'grade', MANAGE, false)).toBeNull()
    const used = gradingOf(consumed)
    expect(applyHeldKey(used, { ...draftOf(used, 'it'), gradeId: null }, 'grade', MANAGE, false)).toBe('hd.grading.held.readOnly')
  })

  it('a hide cut already asks why before it may go', () => {
    const cut = gradingOf(partly)
    const draft = { ...draftOf(cut, 'it'), gradeId: GRADES[2]!.id }
    expect(applyHeldKey(cut, draft, 'grade', MANAGE, false)).toBe('hd.grading.held.reason')
    expect(applyHeldKey(cut, { ...draft, reason: 'Vene sul fianco' }, 'grade', MANAGE, false)).toBeNull()
  })

  it('a read-only hide says why from its state, never the API sentence', () => {
    expect(readOnlyKey(gradingOf(consumed))).toBe('hd.grading.readOnly.CONSUMED')
    expect(readOnlyKey(gradingOf(full))).toBeNull()
    expect(readOnlyKey({ ...gradingOf(full), readOnly: 'Something else.' })).toBe('hd.grading.readOnly.other')
  })
})

describe('a refused correction or measure in our words', () => {
  const invalid = (path: string) => new ApiError('invalid', 400, 'invalid', 'The API sentence', null, [{ path, message: 'x' }])
  it('by the field named, a newer version, a read-only hide, else the shared words', () => {
    expect(gradingRefusal(invalid('body/reason'))).toEqual({ key: 'hd.grading.refused.reason' })
    expect(gradingRefusal(invalid('body/shadeGroupId'))).toEqual({ key: 'hd.grading.refused.shade' })
    expect(gradingRefusal(new ApiError('conflict', 409, 'invalid_state', 'used up'))).toEqual({ key: 'hd.grading.refused.readOnly' })
    expect(gradingRefusal(new ApiError('conflict', 409, 'conflict', 'stale'))).toEqual({ key: 'hd.grading.refused.stale' })
    expect(gradingRefusal(new ApiError('unavailable', 0, 'network', 'down'))).toEqual({ key: 'stock:problem.offline' })
    expect(measureRefusal(invalid('body/correctStock/reasonCode'))).toEqual({ key: 'hd.measure.refused.adjust' })
    expect(measureRefusal(new ApiError('conflict', 409, 'invalid_state', 'cut'))).toEqual({ key: 'hd.measure.refused.notWhole' })
    expect(measureRefusal(new ApiError('conflict', 409, 'conflict', 'not in one place'))).toEqual({ key: 'hd.measure.refused.notOnePlace' })
  })
})

describe('measures against the tannery (SCM-249)', () => {
  it('only a whole hide is measured; the correction needs inventory.adjust', () => {
    expect(measureHeldKey(measuresOf(full), MANAGE)).toBeNull()
    expect(measureHeldKey(measuresOf(partly), MANAGE)).toBe('hd.measure.held.cut')
    expect(measureHeldKey(measuresOf(full), VIEW_ONLY)).toBe('hd.measure.held.noRight')
    expect(correctHeldKey(measuresOf(full), gradingCan(['inventory.hides.manage']))).toBe('hd.measure.held.noAdjust')
    expect(correctHeldKey(measuresOf(full), MANAGE)).toBeNull()
  })

  it('the body in the hide’s unit, the correction only when asked; Save held until an area is typed', () => {
    expect(measureDraftHeldKey(EMPTY_MEASURE, false)).toBe('hd.measure.held.measured')
    expect(measureDraftHeldKey({ ...EMPTY_MEASURE, measuredArea: '0' }, false)).toBe('hd.measure.held.measuredBad')
    expect(measureDraftHeldKey({ ...EMPTY_MEASURE, measuredArea: '51,2', declaredArea: 'x' }, false)).toBe('hd.measure.held.declaredBad')
    expect(measureDraftHeldKey({ ...EMPTY_MEASURE, measuredArea: '51,2' }, false)).toBeNull()
    expect(measureBodyOf({ ...EMPTY_MEASURE, measuredArea: '51,2', declaredArea: '52' }, 'FT2')).toEqual({ measuredArea: '51.2', areaUom: 'FT2', declaredArea: '52' })
    expect(measureBodyOf({ ...EMPTY_MEASURE, measuredArea: '48', correctStock: true }, 'FT2')).toEqual({ measuredArea: '48', areaUom: 'FT2', correctStock: { note: null } })
  })

  it('an outcome as a tone with its word; who measured, a floor worker unnamed where the site hides names', () => {
    expect(OUTCOME_TONE).toEqual({ WITHIN: 'success', SHORT: 'danger', OVER: 'info' })
    const [office, floor] = measuresOf(full).measures
    expect(measuredBy(office!, words)).toBe(office!.by.name)
    expect(measuredBy(floor!, words)).toBe('hd.measure.by.floorHidden')
  })

  it('a decimal as the person types it', () => {
    expect(plainDecimal(' 1,25 ')).toBe('1.25')
    expect(plainDecimal('1.234,5')).toBe('1234.5')
    expect(plainDecimal('1,234.5')).toBe('1234.5')
    expect(plainDecimal('')).toBe('')
  })
})

describe('changes and photos', () => {
  it('a change in its lines, where it was made', () => {
    expect(changeLines({ from: { grade: 'A', shade: null }, to: { grade: 'B', shade: '1' } })).toEqual([
      { field: 'grade', from: 'A', to: 'B' },
      { field: 'shade', from: null, to: '1' },
    ])
    expect(audienceKey('OFFICE')).toBe('hd.grading.changes.by.office')
    expect(audienceKey('link')).toBe('hd.grading.changes.by.other')
  })

  it('where a photo was taken, newest first, what the Lightbox can show, a file checked first', () => {
    expect(HIDE_PHOTOS.map(photoPlaceKey)).toEqual(['hd.photos.place.CUTTING_TABLE', 'hd.photos.place.INSPECTION', 'hd.photos.place.office'])
    expect(photoPlaceKey({ place: null, floor: true })).toBe('hd.photos.place.floor')
    expect(newestFirst([...HIDE_PHOTOS].reverse()).map((photo) => photo.fileId)).toEqual(HIDE_PHOTOS.map((photo) => photo.fileId))
    expect(shownPhotos([{ ...HIDE_PHOTOS[0]!, src: null }, HIDE_PHOTOS[1]!, { ...HIDE_PHOTOS[2]!, broken: true }])).toHaveLength(1)
    expect(photoCaption(HIDE_PHOTOS[0]!, words, { locale: 'en', timeZone: 'Europe/Rome' })).toMatch(/^hd\.photos\.place\.CUTTING_TABLE · WO-/)
    expect(photoFileProblem({ type: 'application/pdf', size: 10 }, 100)).toBe('hd.photos.problem.notImage')
    expect(photoFileProblem({ type: 'image/jpeg', size: 200 }, 100)).toBe('hd.photos.problem.tooBig')
    expect(photoFileProblem({ type: 'image/jpeg', size: 20 }, 100)).toBeNull()
  })
})
