import { describe, expect, it } from 'vitest'
import { metricDeltaClass, metricKind, metricMinWidth } from './metricStripModel'

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

describe('metricDeltaClass', () => {
  it('keeps positive as before: true is up, anything else down', () => {
    expect(metricDeltaClass({ positive: true })).toBe('up')
    expect(metricDeltaClass({ positive: false })).toBe('down')
    expect(metricDeltaClass({})).toBe('down')
  })
  it('lets tone win, and a neutral change is neither up nor down', () => {
    expect(metricDeltaClass({ tone: 'neutral' })).toBe('neutral')
    expect(metricDeltaClass({ tone: 'neutral', positive: true })).toBe('neutral')
    expect(metricDeltaClass({ tone: 'positive', positive: false })).toBe('up')
    expect(metricDeltaClass({ tone: 'negative' })).toBe('down')
  })
})
