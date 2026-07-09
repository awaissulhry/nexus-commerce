import { describe, it, expect } from 'vitest'
import { normalizeSyntheticCell } from './normalizeSyntheticCell'

describe('normalizeSyntheticCell — Amazon synthetic Follow column', () => {
  it('normalizes case-insensitive matches to canonical casing', () => {
    expect(normalizeSyntheticCell('follow', 'pinned', 'Follow')).toBe('Pinned')
    expect(normalizeSyntheticCell('follow', 'FOLLOW', 'Pinned')).toBe('Follow')
  })

  it('rejects junk, keeping the previous value', () => {
    expect(normalizeSyntheticCell('follow', 'garbage', 'Pinned')).toBe('Pinned')
    expect(normalizeSyntheticCell('follow', '123', 'Follow')).toBe('Follow')
  })

  it('allows clearing to empty', () => {
    expect(normalizeSyntheticCell('follow', '', 'Pinned')).toBe('')
  })
})

describe('normalizeSyntheticCell — Amazon synthetic Buffer column', () => {
  it('accepts valid numbers, including comma decimals', () => {
    expect(normalizeSyntheticCell('buffer', '5', '')).toBe('5')
    expect(normalizeSyntheticCell('buffer', '12,50', '')).toBe('12.50')
  })

  it('rejects non-numeric junk, keeping the previous value', () => {
    expect(normalizeSyntheticCell('buffer', 'abc', '3')).toBe('3')
    expect(normalizeSyntheticCell('buffer', '1.234,56', '7')).toBe('7')
  })

  it('clamps below-min up to 0', () => {
    expect(normalizeSyntheticCell('buffer', '-3', '2')).toBe('0')
    expect(normalizeSyntheticCell('buffer', '-3,5', '2')).toBe('0')
  })
})

describe('normalizeSyntheticCell — every other column passes through untouched', () => {
  it('manifest-derived columns are not altered (strict scope)', () => {
    expect(normalizeSyntheticCell('item_sku', 'anything', 'prev')).toBe('anything')
    expect(normalizeSyntheticCell('color_name', 'garbage', 'prev')).toBe('garbage')
    expect(normalizeSyntheticCell('fulfillment_availability__quantity', 'abc', '5')).toBe('abc')
  })

  it('non-string values pass through (undefined source cell on fill)', () => {
    expect(normalizeSyntheticCell('follow', undefined, 'Pinned')).toBeUndefined()
    expect(normalizeSyntheticCell('buffer', 3, '')).toBe(3)
  })
})
