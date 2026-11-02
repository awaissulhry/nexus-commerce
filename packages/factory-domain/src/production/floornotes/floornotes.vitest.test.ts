import { describe, expect, it } from 'vitest'
import { isClip, NO_FACES_REMINDER, noteProblem, noteText } from './rules'

describe('a comment or a photo from the floor (MES-101, COL-017)', () => {
  it('says what differs, where, and the worker’s words', () => {
    expect(noteText({ tileCode: 'STITCHING_DIFFERS', note: null, bundleCode: null, operation: null })).toBe('Stitching differs')
    expect(noteText({ tileCode: 'DAMAGED', note: 'Left sleeve', bundleCode: 'B-000123', operation: { seq: 30, name: 'Collar' } })).toBe('Damaged (B-000123 at Op 30 Collar): Left sleeve')
    expect(noteText({ tileCode: 'DAMAGED', note: null, bundleCode: 'B-000123', operation: null })).toBe('Damaged (B-000123)')
  })

  it('"Other" says what in a few words, or shows it in a picture', () => {
    expect(noteProblem({ tileCode: 'OTHER', note: null, files: 0 })).toMatch(/few words/)
    expect(noteProblem({ tileCode: 'OTHER', note: 'Wrong thread', files: 0 })).toBeNull()
    expect(noteProblem({ tileCode: 'OTHER', note: null, files: 1 })).toBeNull()
    expect(noteProblem({ tileCode: 'DAMAGED', note: null, files: 0 })).toBeNull()
  })

  it('the photo step reminds: no faces, in the words of the floor', () => {
    expect(NO_FACES_REMINDER).toMatchObject({ code: 'NO_FACES', en: 'Keep faces out of the picture.' })
    expect(NO_FACES_REMINDER.it).toMatch(/volti/)
  })

  it('tells a clip from a picture by its type', () => {
    expect(isClip('video/mp4')).toBe(true)
    expect(isClip(' Video/WebM; codecs=vp9')).toBe(true)
    expect(isClip('image/jpeg')).toBe(false)
  })
})
