/**
 * MA.4 — master completeness verifier (pure computeMasterCompleteness).
 * prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { computeMasterCompleteness } from '../pim/master-completeness.service.js'

const attr = (over: Record<string, unknown>) =>
  ({ key: 'x', label: 'X', type: 'text', required: false, group: 'Category attributes', source: 'schema', ...over }) as any

describe('computeMasterCompleteness', () => {
  it('counts overall + required + names the missing required', () => {
    const r = computeMasterCompleteness(
      [
        attr({ key: 'material', label: 'Material', required: true }),
        attr({ key: 'color', label: 'Color', required: true }),
        attr({ key: 'size', label: 'Size' }),
      ],
      { material: 'Leather' },
    )
    expect(r.overall).toEqual({ filled: 1, total: 3, pct: 33 })
    expect(r.required.filled).toBe(1)
    expect(r.required.total).toBe(2)
    expect(r.required.missing).toEqual([{ key: 'color', label: 'Color' }])
  })

  it('treats empty string / empty array as not filled', () => {
    const r = computeMasterCompleteness([attr({ key: 'a' }), attr({ key: 'b' }), attr({ key: 'c' })], { a: '', b: [], c: ['x'] })
    expect(r.overall.filled).toBe(1)
  })

  it('is 100% when there are no attributes', () => {
    expect(computeMasterCompleteness([], {}).overall.pct).toBe(100)
  })

  it('groups counts by group', () => {
    const r = computeMasterCompleteness(
      [attr({ key: 'a', group: 'G1' }), attr({ key: 'b', group: 'G1' }), attr({ key: 'c', group: 'G2' })],
      { a: 'x' },
    )
    expect(r.byGroup.find((g) => g.group === 'G1')).toEqual({ group: 'G1', filled: 1, total: 2 })
  })
})
