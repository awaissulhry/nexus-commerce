import { describe, expect, it } from 'vitest'

import { previewCoordinates } from './fixtures'
import { stripTag, stripTitle } from './columns'

/**
 * 2026-09-30 — a one-column channel group keeps its NAME readable (matrix.module.css moves the count tag off the
 * line at ≤160px). The counts must then still be somewhere a person can reach: the strip's tooltip carries them.
 */
const COORDS = [
  { channel: 'EBAY', market: 'IT', label: 'eBay · IT', connected: true, accountId: 'acc-e' },
]
const coord = (over: Record<string, unknown>) => ({ ...previewCoordinates(COORDS).find(c => c.key === 'EBAY:IT')!, listed: 20, draft: 0, ...over }) as never

describe('the channel group strip', () => {
  it('the tag counts listings, and adds drafts only when there are some', () => {
    expect(stripTag(coord({}))).toBe('20 listed')
    expect(stripTag(coord({ listed: 0, draft: 1 }))).toBe('0 listed · 1 not listed')
    expect(stripTag(undefined)).toBeNull()
  })
  it('the tooltip carries the whole name AND the counts a narrow group moves off its line', () => {
    expect(stripTitle(coord({}), 'eBay · IT')).toBe('eBay · IT — 7 cells · 20 listed')   // eBay serves no Sale cell: 7 of the 8 kinds
    expect(stripTitle(coord({ listed: 0, draft: 1 }), 'eBay · IT')).toBe('eBay · IT — 7 cells · 0 listed · 1 not listed')
    expect(stripTitle(undefined, 'Shared')).toBe('Shared')
  })
})
