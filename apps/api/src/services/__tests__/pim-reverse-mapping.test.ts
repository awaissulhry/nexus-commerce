/**
 * MA.3 — reverse-map Amazon attribute reader verifier (pure readChannelValue).
 * prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { readChannelValue } from '../pim/reverse-mapping.service.js'

describe('readChannelValue', () => {
  it('unwraps a single wrapped value', () => {
    expect(readChannelValue({ item_name: [{ value: 'Jacket', marketplace_id: 'X' }] }, 'item_name')).toBe('Jacket')
  })
  it('returns an array for multi-value fields', () => {
    expect(readChannelValue({ bullet_point: [{ value: 'a' }, { value: 'b' }] }, 'bullet_point')).toEqual(['a', 'b'])
  })
  it('handles a bare { value } object', () => {
    expect(readChannelValue({ color: { value: 'Red' } }, 'color')).toBe('Red')
  })
  it('returns null for missing / empty / blank', () => {
    expect(readChannelValue({}, 'x')).toBeNull()
    expect(readChannelValue({ x: [] }, 'x')).toBeNull()
    expect(readChannelValue({ x: [{ value: '' }] }, 'x')).toBeNull()
  })
  it('returns a scalar as-is', () => {
    expect(readChannelValue({ x: 'plain' }, 'x')).toBe('plain')
  })
})
