import { describe, expect, it } from 'vitest'
import { lightboxCounter, lightboxHeld, lightboxKey, lightboxStep, lightboxThumbLabel, photoAlt } from './lightboxModel'

describe('moving between photos', () => {
  it('steps without wrapping', () => {
    expect(lightboxStep(1, 4, 1)).toBe(2)
    expect(lightboxStep(1, 4, -1)).toBe(0)
    expect(lightboxStep(0, 4, -1)).toBeNull()
    expect(lightboxStep(3, 4, 1)).toBeNull()
  })
  it('holds Previous on the first photo and Next on the last, in words', () => {
    expect(lightboxHeld(0, 4, -1)).toBe('This is the first photo.')
    expect(lightboxHeld(3, 4, 1)).toBe('This is the last photo.')
    expect(lightboxHeld(1, 4, 1)).toBeNull()
    expect(lightboxHeld(0, 1, 1)).toBe('This is the only photo.')
  })
  it('moves with the arrow keys only', () => {
    expect(lightboxKey('ArrowLeft')).toBe(-1)
    expect(lightboxKey('ArrowRight')).toBe(1)
    expect(lightboxKey('Escape')).toBeNull()
  })
})

describe('words', () => {
  it('counts', () => {
    expect(lightboxCounter(1, 4)).toBe('2 of 4')
  })
  it('names a photo', () => {
    expect(photoAlt(1, 4, 'Jonas K.')).toBe('Photo 2 of 4 from Jonas K.')
    expect(photoAlt(0, 2)).toBe('Photo 1 of 2')
  })
  it('names a thumbnail and the one shown', () => {
    expect(lightboxThumbLabel(2, 4, false)).toBe('Photo 3 of 4')
    expect(lightboxThumbLabel(1, 4, true)).toBe('Photo 2 of 4, shown now')
  })
})
