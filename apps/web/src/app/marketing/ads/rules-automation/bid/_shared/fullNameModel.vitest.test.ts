import { describe, expect, it } from 'vitest'
import { isCut, type Measurable } from './fullNameModel'

const box = (scrollWidth: number, clientWidth: number, inner: Measurable[] = []): Measurable => ({
  scrollWidth, clientWidth, querySelectorAll: () => inner,
})

describe('is a name cut short', () => {
  it('the element itself is wider inside than shown', () => {
    expect(isCut(box(240, 180))).toBe(true)
    expect(isCut(box(180, 180))).toBe(false)
    // A rounding pixel is not an ellipsis.
    expect(isCut(box(181, 180))).toBe(false)
  })

  it('or an element inside it (a link that ellipsizes); a hidden one never counts', () => {
    expect(isCut(box(200, 200, [box(120, 120), box(300, 190)]))).toBe(true)
    expect(isCut(box(200, 200, [box(120, 120), box(300, 0)]))).toBe(false)
    expect(isCut({ scrollWidth: 10, clientWidth: 10 })).toBe(false)
  })
  it('or the element itself is taller inside than shown (a line clamp)', () => {
    expect(isCut({ scrollWidth: 200, clientWidth: 200, scrollHeight: 48, clientHeight: 32 })).toBe(true)
    expect(isCut({ scrollWidth: 200, clientWidth: 200, scrollHeight: 32, clientHeight: 32 })).toBe(false)
  })
})
