import { describe, expect, it } from 'vitest'
import { deleteDayProblems, latestDeleteDay, photoNameOf, photoUploadProblems, viewOfPhotoName } from './rules'

/** Made-to-measure office photos (B-W2b-371): the stored name, what an upload lacks, the delete date's rule. */
describe('made-to-measure office photos', () => {
  it('names a photo by its category, view and revision, never the person’s own name; reads the view back', () => {
    expect(photoNameOf('MTM_PHOTO', 'FRONT', 'image/jpeg', 3)).toBe('mtm-front-r3.jpg')
    expect(photoNameOf('FITTING_PHOTO', 'DETAIL', 'image/png', null)).toBe('fitting-detail.png')
    expect(viewOfPhotoName('mtm-side-r12.jpg')).toBe('SIDE')
    expect(viewOfPhotoName('holiday.jpg')).toBe('DETAIL')
  })

  it('takes JPEG or PNG up to 15 MB, at most 12 a record', () => {
    expect(photoUploadProblems({ contentType: 'image/JPEG', sizeBytes: 10, held: 0 })).toEqual([])
    expect(photoUploadProblems({ contentType: 'image/heic', sizeBytes: 16 * 1_048_576, held: 12 })).toEqual(['TYPE', 'SIZE', 'FULL'])
  })

  it('a delete date: a day from today on, within two years, with why for a move; the same day is no change; a deleted photo keeps it', () => {
    expect(latestDeleteDay('2026-11-13')).toBe('2028-11-12')
    expect(deleteDayProblems({ day: '2026-11-13', today: '2026-11-13', reason: 'asked', current: null, deleted: false })).toEqual([])
    expect(deleteDayProblems({ day: '2026-11-12', today: '2026-11-13', reason: null, current: null, deleted: false })).toEqual(['PAST'])
    expect(deleteDayProblems({ day: '2029-01-01', today: '2026-11-13', reason: null, current: null, deleted: false })).toEqual(['TOO_LATE'])
    expect(deleteDayProblems({ day: '13/11/2026', today: '2026-11-13', reason: ' ', current: null, deleted: false })).toEqual(['DAY', 'REASON'])
    expect(deleteDayProblems({ day: '2026-12-01', today: '2026-11-13', reason: 'x', current: '2026-12-01', deleted: false })).toEqual(['SAME'])
    expect(deleteDayProblems({ day: '2026-12-01', today: '2026-11-13', reason: 'x', current: null, deleted: true })).toEqual(['DELETED'])
  })
})
