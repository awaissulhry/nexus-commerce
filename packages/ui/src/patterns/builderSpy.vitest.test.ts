import { describe, expect, it } from 'vitest'
import { builderSectionId, scrolledToEnd, spyActiveSection } from './builderSpy'

const ORDER = ['basics', 'who', 'when', 'message']

describe('spyActiveSection', () => {
  it('marks the section that shows most in the band', () => {
    expect(spyActiveSection(ORDER, new Map([['who', 120], ['when', 300]]), 'basics')).toBe('when')
    expect(spyActiveSection(ORDER, [{ id: 'basics', visible: 40 }, { id: 'who', visible: 12 }], undefined)).toBe('basics')
  })
  it('takes the first of equals', () => {
    expect(spyActiveSection(ORDER, new Map([['when', 200], ['who', 200]]), undefined)).toBe('who')
  })
  it('keeps the last marked section when none shows', () => {
    expect(spyActiveSection(ORDER, new Map(), 'when')).toBe('when')
    expect(spyActiveSection(ORDER, new Map([['who', 0]]), 'when')).toBe('when')
    expect(spyActiveSection(ORDER, new Map(), undefined)).toBe('basics')
    expect(spyActiveSection(ORDER, new Map(), 'gone')).toBe('basics')
  })
  it('marks the last section at the end of the page', () => {
    expect(spyActiveSection(ORDER, new Map([['when', 300]]), 'when', true)).toBe('message')
  })
  it('has nothing to mark without sections', () => {
    expect(spyActiveSection([], new Map(), 'x')).toBeUndefined()
  })
})

describe('helpers', () => {
  it('knows the end of a scroller', () => {
    expect(scrolledToEnd(600, 400, 1000)).toBe(true)
    expect(scrolledToEnd(599.5, 400, 1000)).toBe(true)
    expect(scrolledToEnd(500, 400, 1000)).toBe(false)
    expect(scrolledToEnd(0, 400, 400)).toBe(false)
  })
  it('names a section element', () => {
    expect(builderSectionId('who')).toBe('bsec-who')
  })
})
