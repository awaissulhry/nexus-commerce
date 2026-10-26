import { describe, expect, it } from 'vitest'
import { metricKind, metricMinWidth } from './metricStripModel'

describe('metricKind', () => {
  it('is a link when the tile has an address', () => {
    expect(metricKind({ href: '/marketing/reviews/inbox' })).toBe('link')
  })
  it('is a button when the tile filters', () => {
    expect(metricKind({ onClick: () => {} })).toBe('button')
  })
  it('is a plain card otherwise', () => {
    expect(metricKind({})).toBe('static')
    expect(metricKind({ href: '' })).toBe('static')
    expect(metricKind({ href: null, onClick: undefined })).toBe('static')
  })
  it('lets the address win if a caller forces both', () => {
    expect(metricKind({ href: '/x', onClick: () => {} })).toBe('link')
  })
})

describe('metricMinWidth', () => {
  it('keeps a sensible width and falls back to 150', () => {
    expect(metricMinWidth(132)).toBe(132)
    expect(metricMinWidth(undefined)).toBe(150)
    expect(metricMinWidth(Number.NaN)).toBe(150)
    expect(metricMinWidth(10)).toBe(150)
  })
})
